// Query lenses and the query results panel (#17, SPEC §10.4).
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { findByUuid } from "../../core/catalog/rows";
import type { FeatureContext, OpentideFolder } from "../../core/context";
import { defineFeature } from "../../core/feature";
import {
  clampLimit,
  DEFAULT_LIMIT,
  isDuration,
  type QuerySource,
  type QueryWindow,
  validateLiveArgv,
} from "./argv";
import { type LensSpec, type LensTarget, lensesFor, platformLabel } from "./lenses";
import { QueryPanels, type RunSpec } from "./panel";
import { ensureCredentials, pickTenants, pickWindow } from "./pickers";
import { PlatformInfoCache } from "./platforms";
import {
  compiledMethod,
  elasticLanguage,
  type LspDocumentSymbol,
  QUERY_FILE_PLATFORMS,
  queryText,
  ruleQueryTargets,
  writesPreviewAlerts,
} from "./targets";

const QUERY_LANGUAGES = Object.keys(QUERY_FILE_PLATFORMS);
const COMPILED_SCHEME = "opentide-compiled";

export default defineFeature({
  id: "query",
  activate(ctx) {
    const info = new PlatformInfoCache({
      run: async (folder) => {
        const result = await ctx.backend.run(folder, ["info"]);
        return { document: result.document, exitCode: result.exitCode };
      },
    });
    const lensChanged = new vscode.EventEmitter<void>();
    const compiled = new CompiledDocuments();
    const last = new Map<string, { tenants?: readonly string[]; window: QueryWindow }>();

    const defaultWindow = (): QueryWindow => {
      const since = vscode.workspace.getConfiguration("opentide.query").get<string>("defaultWindow", "24h");
      return { kind: "since", since: isDuration(since) ? since : "24h" };
    };
    const defaultLimit = () =>
      clampLimit(
        vscode.workspace.getConfiguration("opentide.query").get<number>("defaultLimit", DEFAULT_LIMIT),
      );

    const panels = new QueryPanels(ctx, {
      pickTenants: (spec, choices) =>
        pickTenants(spec.options.platform, { choices, previous: spec.options.tenants ?? [] }),
      edit: async (spec) => {
        const caps = await info.caps(spec.folder.path, spec.options.platform);
        const tenants = caps.tenants
          ? await pickTenants(spec.options.platform, {
              known: caps.tenants,
              previous: spec.options.tenants ?? [],
            })
          : spec.options.tenants;
        if (caps.tenants && caps.tenants.length > 1 && !tenants) return undefined;
        const window = await pickWindow(spec.options.window);
        if (!window) return undefined;
        last.set(spec.options.platform, { ...(tenants ? { tenants } : {}), window });
        return { ...spec, options: { ...spec.options, window, ...(tenants ? { tenants } : {}) } };
      },
      action: async (spec, code) => {
        if (code === "untrusted") await vscode.commands.executeCommand("workbench.trust.manage");
        else await openPlatformConfig(spec.folder, spec.options.platform);
      },
    });

    const prepare = async (target: LensTarget): Promise<RunSpec | undefined> => {
      const uri = vscode.Uri.parse(target.uri);
      const document = await vscode.workspace.openTextDocument(uri);
      const folder = ctx.folders.folderOf(uri) ?? (await ctx.folders.pick("Run the query in which folder?"));
      if (!folder) return undefined;
      let source: QuerySource;
      if (target.kind === "rule") {
        if (document.isDirty) {
          const answer = await vscode.window.showWarningMessage(
            "opentide runs the saved rule. Save it first?",
            "Save and Run",
            "Run Saved Version",
          );
          if (!answer) return undefined;
          if (answer === "Save and Run" && !(await document.save())) return undefined;
        }
        const file = path.relative(folder.path, uri.fsPath).split(path.sep).join("/");
        source = {
          kind: "rule",
          file,
          ...(target.uuid ? { uuid: target.uuid } : {}),
          name: target.name ?? path.basename(file),
        };
      } else {
        const selection =
          vscode.window.activeTextEditor?.document === document
            ? vscode.window.activeTextEditor.selection
            : undefined;
        const name = path.basename(uri.fsPath);
        if (selection && !selection.isEmpty) {
          source = { kind: "text", text: document.getText(selection), name: `${name} (selection)` };
        } else if (document.isDirty || document.isUntitled) {
          source = { kind: "text", text: document.getText(), name };
        } else {
          source = { kind: "query-file", path: uri.fsPath, name };
        }
      }
      const caps = await info.caps(folder.path, target.platform);
      const previous = last.get(target.platform);
      const language =
        target.kind === "query-file" ? elasticLanguage(target.platform, target.language) : undefined;
      const base: RunSpec = {
        folder,
        title: `${source.name} · ${platformLabel(target.platform)}`,
        writesPreviewAlerts: writesPreviewAlerts(target.platform, target.language),
        options: {
          platform: target.platform,
          source,
          window: previous?.window ?? defaultWindow(),
          limit: defaultLimit(),
          ...(language ? { language } : {}),
        },
      };
      if (panels.hasRetained(base)) return base;
      let tenants: readonly string[] | undefined;
      if (caps.tenants) {
        if (caps.tenants.length === 0) {
          await offerConfigure(folder, target.platform);
          return undefined;
        }
        tenants = await pickTenants(target.platform, {
          known: caps.tenants,
          previous: previous?.tenants ?? [],
        });
        if (!tenants) return undefined;
        const chosen = tenants.includes("all")
          ? caps.tenants
          : caps.tenants.filter((t) => tenants?.includes(t.name));
        if (!(await ensureCredentials(ctx, folder.path, chosen))) return undefined;
      }
      const window = await pickWindow(base.options.window);
      if (!window) return undefined;
      last.set(target.platform, { ...(tenants ? { tenants } : {}), window });
      return { ...base, options: { ...base.options, window, ...(tenants ? { tenants } : {}) } };
    };

    const targetsOf = async (
      document: vscode.TextDocument,
      token?: vscode.CancellationToken,
    ): Promise<LensTarget[]> => {
      if (document.languageId === "opentide-yaml") {
        const client = ctx.client.current;
        if (!client) return [];
        let symbols: LspDocumentSymbol[] | null = null;
        try {
          symbols = (await client.sendRequest(
            "textDocument/documentSymbol",
            { textDocument: { uri: client.code2ProtocolConverter.asUri(document.uri) } },
            token,
          )) as LspDocumentSymbol[] | null;
        } catch {
          return [];
        }
        return ruleQueryTargets(symbols).map((t) => ({
          uri: document.uri.toString(),
          range: t.range,
          platform: t.platform,
          language: t.language,
          kind: "rule",
          ...(t.uuid ? { uuid: t.uuid } : {}),
          name: t.ruleName,
        }));
      }
      const candidates = QUERY_FILE_PLATFORMS[document.languageId];
      if (!candidates) return [];
      const folder = ctx.folders.folderOf(document.uri);
      const all = folder && ctx.backend.availability().available ? await info.get(folder.path) : undefined;
      // Platforms the workspace enables first; every candidate when none is known.
      const enabled = candidates.filter((p) => all?.get(p)?.enabled);
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
      return (enabled.length > 0 ? enabled : candidates.slice(0, 1)).map((platform) => ({
        uri: document.uri.toString(),
        range,
        platform,
        language: document.languageId,
        kind: "query-file",
      }));
    };

    const provider: vscode.CodeLensProvider = {
      onDidChangeCodeLenses: lensChanged.event,
      async provideCodeLenses(document, token) {
        if (!vscode.workspace.getConfiguration("opentide.query").get<boolean>("lenses", true)) return [];
        const targets = await targetsOf(document, token);
        const folder = ctx.folders.folderOf(document.uri);
        const canRun = ctx.trust.isTrusted && ctx.backend.availability().available && folder !== undefined;
        const lenses: vscode.CodeLens[] = [];
        let compiledShown = false;
        for (const target of targets) {
          if (token.isCancellationRequested) return [];
          const caps = canRun && folder ? await info.caps(folder.path, target.platform) : undefined;
          for (const spec of lensesFor(target, { canRun, ...(caps ? { caps } : {}) })) {
            // A query file has one compiled lens, however many platforms run it.
            if (spec.command === "opentide.query.showCompiled") {
              if (target.kind === "query-file" && compiledShown) continue;
              compiledShown = true;
            }
            lenses.push(toCodeLens(spec));
          }
        }
        return lenses;
      },
    };

    ctx.subscriptions.push(
      lensChanged,
      panels,
      compiled,
      vscode.workspace.registerTextDocumentContentProvider(COMPILED_SCHEME, compiled),
      vscode.languages.registerCodeLensProvider(
        [{ language: "opentide-yaml", scheme: "file" }, ...QUERY_LANGUAGES.map((language) => ({ language }))],
        provider,
      ),
      ctx.onDidChangeFiles(({ folder, uris }) => {
        if (uris.some((uri) => uri.path.includes("/.opentide/configurations/"))) {
          info.invalidate(folder.path);
          lensChanged.fire();
        }
      }),
      ctx.runtime.onDidChange(() => {
        info.invalidate();
        lensChanged.fire();
      }),
      ctx.client.onDidChange(() => lensChanged.fire()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("opentide.query.lenses")) lensChanged.fire();
        if (event.affectsConfiguration("opentide.query.retainResults")) panels.dropRetained();
      }),

      vscode.commands.registerCommand("opentide.query.run", async (arg?: unknown) => {
        const target = await resolveTarget(ctx, arg, targetsOf);
        if (!target) return;
        const caps = await capsFor(ctx, info, target);
        if (caps && !caps.canQuery) {
          void vscode.window.showInformationMessage(
            `opentide has no query runner for ${platformLabel(target.platform)}, so it cannot run this query.`,
          );
          return;
        }
        const spec = await prepare(target);
        if (spec) panels.run(spec);
      }),

      vscode.commands.registerCommand("opentide.query.validateLive", async (arg?: unknown) => {
        const target = await resolveTarget(ctx, arg, targetsOf, "rule");
        if (target?.kind !== "rule") return;
        const uri = vscode.Uri.parse(target.uri);
        const folder = ctx.folders.folderOf(uri);
        if (!folder) return;
        const caps = await info.caps(folder.path, target.platform);
        if (!caps.canValidate) {
          void vscode.window.showInformationMessage(
            `opentide cannot validate ${platformLabel(target.platform)} queries on a tenant.`,
          );
          return;
        }
        if (caps.tenants && !(await ensureCredentials(ctx, folder.path, caps.tenants))) return;
        const file = path.relative(folder.path, uri.fsPath).split(path.sep).join("/");
        await validateLive(ctx, folder, target, file);
      }),

      vscode.commands.registerCommand("opentide.query.showCompiled", async (arg?: unknown) => {
        const target = await resolveTarget(ctx, arg, targetsOf);
        if (!target) return;
        const method = compiledMethod(target.language);
        const client = ctx.client.current;
        if (!method) {
          void vscode.window.showInformationMessage(`${target.language} queries run as written.`);
          return;
        }
        if (!client) {
          void vscode.window.showWarningMessage("The opentide language server is not running.");
          return;
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
        const text =
          target.kind === "rule"
            ? queryText(document.getText().split(/\r?\n/), target.range)
            : document.getText();
        try {
          const result = (await client.sendRequest(method, { query: text, tenant: "" })) as {
            compiled?: unknown;
          };
          if (typeof result?.compiled !== "string") throw new Error("the server sent no compiled query");
          const name = `${target.name ?? path.basename(document.uri.fsPath)} · ${platformLabel(target.platform)}`;
          const uri = compiled.add(name, target.language, result.compiled);
          const shown = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(shown, {
            preview: true,
            viewColumn: vscode.ViewColumn.Beside,
          });
        } catch (error) {
          void vscode.window.showWarningMessage(
            `Could not compile the query: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),

      vscode.commands.registerCommand("opentide.query.configureTenant", async (arg?: unknown) => {
        const target = arg as LensTarget | undefined;
        const folder = target ? ctx.folders.folderOf(vscode.Uri.parse(target.uri)) : await ctx.folders.pick();
        if (folder && target) await openPlatformConfig(folder, target.platform);
      }),
    );
  },
});

function toCodeLens(spec: LensSpec): vscode.CodeLens {
  const { start, end } = spec.range;
  return new vscode.CodeLens(new vscode.Range(start.line, start.character, end.line, end.character), {
    title: spec.title,
    tooltip: spec.tooltip,
    command: spec.command,
    arguments: [spec.target],
  });
}

function isLensTarget(value: unknown): value is LensTarget {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<LensTarget>;
  return (
    typeof v.uri === "string" && typeof v.platform === "string" && typeof v.language === "string" && !!v.range
  );
}

/**
 * The query a command is about: a lens target; a `{ uuid, platform? }` from the catalogue; a file URI;
 * or the active editor's query under the cursor (asking when several are there).
 */
async function resolveTarget(
  ctx: FeatureContext,
  arg: unknown,
  targetsOf: (document: vscode.TextDocument) => Promise<LensTarget[]>,
  only?: "rule",
): Promise<LensTarget | undefined> {
  if (isLensTarget(arg)) return arg;
  let uri: vscode.Uri | undefined;
  let platform: string | undefined;
  if (arg instanceof vscode.Uri) uri = arg;
  else if (typeof arg === "object" && arg !== null && typeof (arg as { uuid?: unknown }).uuid === "string") {
    const { uuid, folder } = arg as { uuid: string; folder?: string; platform?: string };
    platform = (arg as { platform?: string }).platform;
    const folders = folder ? ctx.folders.all.filter((f) => f.path === folder) : ctx.folders.all;
    for (const f of folders) {
      const object = findByUuid(ctx.catalog.get(f.path).catalog?.objects ?? [], uuid);
      if (object?.file_path) uri = vscode.Uri.file(object.file_path);
    }
    if (!uri) {
      void vscode.window.showWarningMessage(`No rule with UUID ${uuid} in the catalogue.`);
      return undefined;
    }
  } else {
    uri = vscode.window.activeTextEditor?.document.uri;
  }
  if (!uri) {
    void vscode.window.showInformationMessage(
      "Open a rule or a query file (.kql, .spl, .esql, …) to run its query.",
    );
    return undefined;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.languageId === "opentide-yaml" && !ctx.client.current) await ctx.client.ready();
  let targets = await targetsOf(document);
  if (only) targets = targets.filter((t) => t.kind === only);
  if (platform) targets = targets.filter((t) => t.platform === platform);
  if (targets.length === 0) {
    void vscode.window.showInformationMessage(
      document.languageId === "opentide-yaml"
        ? "This rule has no platform query, or the language server is still starting."
        : "This file is not a query opentide can run.",
    );
    return undefined;
  }
  const editor = vscode.window.activeTextEditor;
  if (targets.length > 1 && editor?.document === document) {
    const line = editor.selection.active.line;
    const under = targets.find((t) => t.range.start.line <= line && line <= t.range.end.line);
    if (under) return under;
  }
  if (targets.length === 1) return targets[0];
  const picked = await vscode.window.showQuickPick(
    targets.map((t) => ({ label: platformLabel(t.platform), description: t.language, target: t })),
    { placeHolder: "Which query?" },
  );
  return picked?.target;
}

async function capsFor(ctx: FeatureContext, info: PlatformInfoCache, target: LensTarget) {
  const folder = ctx.folders.folderOf(vscode.Uri.parse(target.uri));
  return folder && ctx.backend.availability().available ? info.caps(folder.path, target.platform) : undefined;
}

async function openPlatformConfig(folder: OpentideFolder, platform: string): Promise<void> {
  const file = path.join(folder.path, ".opentide", "configurations", "platforms", `${platform}.toml`);
  if (!fs.existsSync(file)) {
    void vscode.window.showWarningMessage(
      `${platform}.toml does not exist yet. Enable the platform with opentide setup platforms.`,
    );
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

async function offerConfigure(folder: OpentideFolder, platform: string): Promise<void> {
  const answer = await vscode.window.showInformationMessage(
    `${platformLabel(platform)} has no tenant: add a [[tenants]] entry to ${platform}.toml.`,
    "Open configuration",
  );
  if (answer) await openPlatformConfig(folder, platform);
}

async function validateLive(
  ctx: FeatureContext,
  folder: OpentideFolder,
  target: LensTarget,
  file: string,
): Promise<void> {
  const argv = validateLiveArgv(target.platform, { file, ...(target.uuid ? { uuid: target.uuid } : {}) });
  const where = platformLabel(target.platform);
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Validating on ${where} tenants`,
        cancellable: true,
      },
      (_progress, token) => ctx.backend.run(folder.path, argv, { cancellation: token }),
    );
    if (result.cancelled) return;
    const document = result.document;
    if (result.exitCode === 0 && document.status === "passed") {
      void vscode.window.showInformationMessage(`$(pass) ${document.message}`);
      return;
    }
    const advice = typeof document.advice === "string" ? ` ${document.advice}` : "";
    const show = await (result.exitCode === 0
      ? vscode.window.showInformationMessage
      : vscode.window.showWarningMessage)(`${document.message}${advice}`, "Show Output");
    if (show) ctx.log.show();
  } catch (error) {
    void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
  }
}

/** Read-only `opentide-compiled:` documents, kept in memory while open. */
class CompiledDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private next = 1;
  readonly onDidChange = this.emitter.event;
  private readonly closing = vscode.workspace.onDidCloseTextDocument((document) => {
    if (document.uri.scheme === COMPILED_SCHEME) this.contents.delete(document.uri.toString());
  });

  add(name: string, language: string, text: string): vscode.Uri {
    const safe = name.replace(/[\\/?#%]/g, "-");
    const uri = vscode.Uri.from({
      scheme: COMPILED_SCHEME,
      path: `/${safe}.${language}`,
      query: String(this.next++),
    });
    this.contents.set(uri.toString(), text);
    this.emitter.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.closing.dispose();
    this.emitter.dispose();
    this.contents.clear();
  }
}
