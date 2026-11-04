// "opentide: Find Detection…" (SPEC §10.3): a quick pick over the cached catalogue with filter tokens.
// Glue only; parsing is query.ts, matching match.ts, the rows present.ts, the index searchIndex.ts.
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { FeatureContext } from "../../core/context";
import { defineFeature } from "../../core/feature";
import { type ItemProblems, search } from "./match";
import { asksPlaceholders, PlaceholderCounts } from "./placeholders";
import {
  catalogueFilterOf,
  countProblems,
  graphSelection,
  insertHint,
  parseSearchArgs,
  present,
  type Row,
  type SearchArgs,
} from "./present";
import { parseQuery } from "./query";
import { IndexCache, type SearchItem } from "./searchIndex";
import { SettledWindow, UnreviewedCache } from "./unreviewed";

/** The sidebar's Catalogue filter; it takes `{query: string}` (a substring, see `catalogueFilterOf`). */
export const CATALOGUE_FILTER_COMMAND = "opentide.sidebar.filter";

type Item = vscode.QuickPickItem & { readonly row?: Row; readonly action?: () => Thenable<unknown> };

const GRAPH_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("type-hierarchy"),
  tooltip: "Show in graph",
};
const COPY_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("copy"), tooltip: "Copy UUID" };
const SIDE_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("split-horizontal"),
  tooltip: "Open to the side",
};
const REFRESH_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("refresh"),
  tooltip: "Reload the catalogue",
};

/** Problems panel counts per file path, read once per quick pick (and again when diagnostics change). */
/** One per window: a file is read again only when it changes. */
const placeholderCounts = new PlaceholderCounts({
  openText: (file) =>
    vscode.workspace.textDocuments
      .find((document) => document.uri.scheme === "file" && document.uri.fsPath === file)
      ?.getText(),
  stamp: (file) => {
    try {
      const stat = fs.statSync(file);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return undefined;
    }
  },
  read: (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
});

function problemCounts(): Map<string, ItemProblems> {
  const counts = new Map<string, ItemProblems>();
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme === "file" && diagnostics.length > 0) counts.set(uri.fsPath, countProblems(diagnostics));
  }
  return counts;
}

async function openItem(item: SearchItem, side: boolean): Promise<void> {
  const uri = item.filePath
    ? vscode.Uri.file(item.filePath)
    : item.uri
      ? vscode.Uri.parse(item.uri)
      : undefined;
  if (!uri) return;
  const line = Math.max(0, item.line - 1);
  const character = item.character ?? 0;
  await vscode.window.showTextDocument(uri, {
    selection: new vscode.Range(line, character, line, character),
    preview: !side,
    ...(side ? { viewColumn: vscode.ViewColumn.Beside } : {}),
  });
}

/** What `opentide.search.open` opened: the quick pick's title and query (integration tests read it). */
export interface SearchShown {
  readonly title: string;
  readonly value: string;
}

function openSearch(
  ctx: FeatureContext,
  indexCache: IndexCache,
  unreviewed: UnreviewedCache,
  args: SearchArgs,
): SearchShown {
  const pick = vscode.window.createQuickPick<Item>();
  pick.title = "Find Detection";
  pick.placeholder = "Name, or filters: t:T1003 p:sentinel s:production tactic:credential-access has:errors";
  pick.matchOnDescription = false;
  pick.matchOnDetail = false;
  pick.buttons = [REFRESH_BUTTON];
  pick.value = args.query ?? "";

  // `{folder}` (the matrix, the graph) searches that folder only, when it is one of the window's.
  const scoped = () => {
    const only = ctx.folders.all.filter((folder) => folder.path === args.folder);
    return only.length > 0 ? only : ctx.folders.all;
  };
  const folders = () => scoped().map((folder) => folder.path);
  const folderNames = new Map(
    scoped().length > 1 ? scoped().map((folder) => [folder.path, folder.folder.name] as const) : [],
  );
  if (args.folder && scoped().length === 1 && ctx.folders.all.length > 1)
    pick.title = `Find Detection in ${scoped()[0]?.folder.name ?? args.folder}`;
  let problems = problemCounts();
  // `has:placeholders` counts the files' own `# opentide:placeholder` lines, not only lint's findings.
  let countPlaceholders = false;
  const problemsOf = (item: SearchItem): ItemProblems | undefined => {
    if (!item.filePath) return undefined;
    const file = vscode.Uri.file(item.filePath).fsPath;
    const counted = problems.get(file);
    if (!countPlaceholders) return counted;
    const placeholders = Math.max(counted?.placeholders ?? 0, placeholderCounts.count(file));
    return { errors: counted?.errors ?? 0, warnings: counted?.warnings ?? 0, placeholders };
  };

  // On 0.21.0 the store falls back to workspace symbols; ask again once the language server runs.
  for (const folder of folders()) {
    const state = ctx.catalog.get(folder);
    if (state.status === "unavailable" && !state.symbols && ctx.client.current)
      void ctx.catalog.refresh(folder, { immediate: true });
  }

  // The window the pick opened with runs at once; one being typed waits until it stops changing.
  const settledWindow = new SettledWindow(parseQuery(pick.value).unreviewed, 400, () => update());
  const update = (): void => {
    const started = Date.now();
    const states = folders().map((folder) => ctx.catalog.get(folder));
    const index = indexCache.build(states);
    const query = parseQuery(pick.value);
    countPlaceholders = asksPlaceholders(query.filters);
    const unreviewedPaths =
      query.unreviewed && settledWindow.ready(query.unreviewed)
        ? unreviewed.get(query.unreviewed, folders(), update)
        : undefined;
    const outcome = search(index, query, {
      now: Date.now(),
      problems: problemsOf,
      ...(unreviewedPaths ? { unreviewed: unreviewedPaths } : {}),
    });
    const rows = present(query, index, outcome, { folderNames, problems: problemsOf });
    const items: Item[] = [];
    const selection = graphSelection(outcome.results);
    if (outcome.results.length > 0 && pick.value.trim()) {
      if (selection && selection.uuids.length > 0) {
        items.push({
          label: `$(type-hierarchy) Show ${selection.uuids.length === 1 ? "it" : `all ${selection.uuids.length}`} in the graph`,
          alwaysShow: true,
          action: () =>
            vscode.commands.executeCommand("opentide.graph.open", {
              uuids: selection.uuids,
              folder: selection.folder,
              mode: "focus",
            }),
        });
      }
      const value = catalogueFilterOf(query);
      if (catalogueFilter && value) {
        items.push({
          label: "$(list-filter) Filter the Catalogue",
          description: value,
          alwaysShow: true,
          action: () => vscode.commands.executeCommand(CATALOGUE_FILTER_COMMAND, { query: value }),
        });
      }
    }
    for (const row of rows) {
      switch (row.kind) {
        case "separator":
          items.push({ label: row.label, kind: vscode.QuickPickItemKind.Separator, row });
          break;
        case "notice":
          items.push({
            label: row.label,
            ...(row.detail ? { detail: row.detail } : {}),
            alwaysShow: true,
            row,
          });
          break;
        case "hint":
          items.push({ label: row.hint.token, description: row.hint.description, alwaysShow: true, row });
          break;
        case "result":
          items.push({
            label: `$(${row.icon}) ${row.label}`,
            description: row.description,
            detail: row.detail,
            alwaysShow: true,
            buttons:
              row.result.item.source === "catalog" && row.result.item.uuid
                ? [SIDE_BUTTON, GRAPH_BUTTON, COPY_BUTTON]
                : [SIDE_BUTTON],
            row,
          });
          break;
      }
    }
    const active = pick.activeItems[0]?.row;
    pick.items = items;
    // Keep the highlighted result when the list is rebuilt for the same query.
    if (active?.kind === "result") {
      const same = items.find(
        (item) => item.row?.kind === "result" && item.row.result.item.id === active.result.item.id,
      );
      if (same) pick.activeItems = [same];
    }
    pick.busy = index.loading.length > 0 || outcome.pending;
    const elapsed = Date.now() - started;
    if (elapsed > 50)
      ctx.log.debug(`search: ${index.items.length} items, "${pick.value}" took ${elapsed} ms`);
  };

  let catalogueFilter = false;
  void Promise.resolve(vscode.commands.getCommands(true)).then((commands) => {
    catalogueFilter = commands.includes(CATALOGUE_FILTER_COMMAND);
    if (catalogueFilter) update();
  });

  let diagnosticsTimer: NodeJS.Timeout | undefined;
  const subscriptions: vscode.Disposable[] = [
    pick.onDidChangeValue(() => update()),
    pick.onDidAccept(async () => {
      const selected = pick.selectedItems[0];
      if (!selected) return;
      if (selected.action) {
        pick.hide();
        await selected.action();
        return;
      }
      const row = selected.row;
      if (row?.kind === "hint") {
        pick.value = insertHint(pick.value, row.hint);
        update();
      } else if (row?.kind === "result") {
        pick.hide();
        await openItem(row.result.item, false);
      }
    }),
    pick.onDidTriggerItemButton(async ({ item, button }) => {
      const row = item.row;
      if (row?.kind !== "result") return;
      const target = row.result.item;
      if (button === SIDE_BUTTON) await openItem(target, true);
      else if (button === COPY_BUTTON && target.uuid) {
        await vscode.env.clipboard.writeText(target.uuid);
        void vscode.window.setStatusBarMessage(`Copied ${target.uuid}`, 2000);
      } else if (button === GRAPH_BUTTON && target.uuid) {
        pick.hide();
        await vscode.commands.executeCommand("opentide.graph.open", {
          uuids: [target.uuid],
          folder: target.folder,
          mode: "focus",
        });
      }
    }),
    pick.onDidTriggerButton((button) => {
      if (button !== REFRESH_BUTTON) return;
      unreviewed.clear();
      pick.busy = true;
      for (const folder of folders()) void ctx.catalog.refresh(folder, { immediate: true });
    }),
    { dispose: ctx.catalog.onDidChange(() => update()).dispose },
    vscode.languages.onDidChangeDiagnostics(() => {
      if (diagnosticsTimer) clearTimeout(diagnosticsTimer);
      diagnosticsTimer = setTimeout(() => {
        problems = problemCounts();
        update();
      }, 300);
    }),
  ];
  pick.onDidHide(() => {
    if (diagnosticsTimer) clearTimeout(diagnosticsTimer);
    settledWindow.dispose();
    for (const subscription of subscriptions) subscription.dispose();
    pick.dispose();
  });
  update();
  pick.show();
  return { title: pick.title ?? "", value: pick.value };
}

export default defineFeature({
  id: "search",
  activate(ctx) {
    const indexCache = new IndexCache((folder, uri) => {
      const parsed = vscode.Uri.parse(uri);
      const root = vscode.Uri.file(folder).fsPath;
      const file = parsed.fsPath;
      return file.startsWith(root)
        ? file
            .slice(root.length)
            .replace(/^[\\/]+/, "")
            .replaceAll("\\", "/")
        : file;
    });
    const unreviewed = new UnreviewedCache({
      hasCommand: () => (ctx.capabilities.current ? ctx.capabilities.hasCommand("rules unreviewed") : true),
      run: async (folder, window) => {
        const tree = await ctx.capabilities.ready();
        if (!tree?.hasCommand("rules unreviewed")) return undefined;
        const result = await ctx.backend.run(folder, ["rules", "unreviewed", "--older-than", window]);
        if (result.exitCode !== 0) ctx.log.warn(`rules unreviewed exited ${result.exitCode} in ${folder}`);
        return result.document;
      },
      log: (message) => ctx.log.warn(message),
    });
    // A new catalogue document means the rules may have changed: ask `rules unreviewed` again.
    const documents = new Map<string, unknown>();
    ctx.subscriptions.push(
      {
        dispose: ctx.catalog.onDidChange((state) => {
          const document = state.catalog ?? state.symbols;
          if (documents.get(state.folder) === document) return;
          documents.set(state.folder, document);
          unreviewed.clear();
        }).dispose,
      },
      { dispose: ctx.runtime.onDidChange(() => unreviewed.clear()).dispose },
      vscode.commands.registerCommand("opentide.search.open", (args?: unknown): SearchShown | undefined => {
        const parsed = parseSearchArgs(args);
        if (ctx.folders.all.length === 0) {
          void vscode.window.showInformationMessage(
            "Open a folder with an opentide workspace to find detections.",
          );
          return undefined;
        }
        return openSearch(ctx, indexCache, unreviewed, parsed);
      }),
    );
  },
});
