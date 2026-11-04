// The opentide sidebar (SPEC §9, #15): Catalogue, Coverage, Platforms & tenants, Health, Activity.
// Glue only: the models are the vscode-free modules next to this file.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { RunResult } from "../../core/backend/backend";
import { BackendError } from "../../core/backend/types";
import type { FeatureContext } from "../../core/context";
import { defineFeature } from "../../core/feature";
import {
  type Handover,
  newObjectHandover,
  PREVIEW_DEPLOY,
  RUN_QUERY,
  ruleHandover,
  SHARE_PREVIEW,
  VALIDATE_FILE,
} from "./actions";
import { activityNodes, rerunPlan, runningCount } from "./activity";
import {
  buildCatalogue,
  GROUP_BY_LABELS,
  type GroupBy,
  isEmptyRepository,
  type ProblemCount,
} from "./catalogue";
import { buildCoverageView } from "./coverage";
import { type FolderResult, folderViewModel } from "./folderView";
import {
  type DoctorCheck,
  healthNodes,
  parseChecks,
  planFix,
  report,
  summarize,
  summaryText,
} from "./health";
import { debounce, Loader } from "./loader";
import type { NodeRef, TreeNode } from "./node";
import { platformFlag, platformName, platformToml } from "./platformNames";
import {
  type PlatformInfo,
  parsePlatforms,
  platformNodes,
  presenceEnv,
  tenantCheck,
  tenantVariableNames,
} from "./platforms";
import { RELATIONS_VIEW, RelationsView } from "./relationsView";
import { NodeTree, openTargetUri } from "./tree";

export const VIEWS = {
  catalogue: "opentide.sidebar.catalogue",
  relations: RELATIONS_VIEW,
  coverage: "opentide.sidebar.coverage",
  platforms: "opentide.sidebar.platforms",
  health: "opentide.sidebar.health",
  activity: "opentide.sidebar.activity",
} as const;

const GROUP_BY_KEY = "opentide.sidebar.groupBy";

const setContext = (key: string, value: unknown) =>
  void vscode.commands.executeCommand("setContext", key, value);

/** The node a command was invoked on: a tree element, or a ref passed as an argument. */
function refOf(arg: unknown): NodeRef | undefined {
  if (typeof arg !== "object" || arg === null) return undefined;
  if ("ref" in arg) return (arg as TreeNode).ref;
  if ("kind" in arg) return arg as NodeRef;
  return undefined;
}

/** `opentide.sidebar.filter`'s argument: `{query}` or a string; undefined asks. */
function filterArg(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (typeof arg === "object" && arg !== null && !("ref" in arg)) {
    const query = (arg as { query?: unknown }).query;
    if (typeof query === "string") return query;
  }
  return undefined;
}

/** Run another feature's command with the handover's arguments. */
function handOver(handover: Handover | undefined): Thenable<unknown> | undefined {
  if (!handover) return undefined;
  if ("args" in handover) return vscode.commands.executeCommand(handover.command, handover.args);
  return vscode.commands.executeCommand(handover.command);
}

interface PlatformsValue {
  readonly platforms: readonly PlatformInfo[];
  readonly stored: readonly string[];
}

export default defineFeature({
  id: "sidebar",
  activate(ctx) {
    const sidebar = new Sidebar(ctx);
    ctx.subscriptions.push(sidebar);
  },
});

class Sidebar implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly catalogue = new NodeTree(VIEWS.catalogue);
  private readonly coverage = new NodeTree(VIEWS.coverage);
  private readonly platforms = new NodeTree(VIEWS.platforms);
  private readonly health = new NodeTree(VIEWS.health);
  private readonly activity = new NodeTree(VIEWS.activity);
  private groupBy: GroupBy;
  private filter: string | undefined;
  private healthOnline = false;
  private readonly platformsLoader: Loader<readonly FolderResult<PlatformsValue>[]>;
  private readonly healthLoader: Loader<readonly FolderResult<readonly DoctorCheck[]>[]>;

  constructor(private readonly ctx: FeatureContext) {
    const stored = ctx.extension.workspaceState.get<string>(GROUP_BY_KEY);
    this.groupBy = stored && stored in GROUP_BY_LABELS ? (stored as GroupBy) : "chain";
    this.platformsLoader = new Loader<readonly FolderResult<PlatformsValue>[]>({
      isVisible: () => this.platforms.view.visible,
      load: () => this.forEachFolder((folder) => this.loadPlatforms(folder)),
    });
    this.healthLoader = new Loader<readonly FolderResult<readonly DoctorCheck[]>[]>({
      isVisible: () => this.health.view.visible,
      load: () => this.forEachFolder((folder) => this.loadHealth(folder)),
    });
    this.disposables.push(
      new RelationsView(ctx),
      this.catalogue,
      this.coverage,
      this.platforms,
      this.health,
      this.activity,
      this.platformsLoader,
      this.healthLoader,
    );
    this.wire();
    this.registerCommands();
    // Activation does no I/O: the first render reads in-memory state only. The catalogue store starts
    // loading the first time a folder is asked for, which `renderCatalogue` does on the next tick.
    setTimeout(() => this.renderAll(), 0);
  }

  // ── data ────────────────────────────────────────────────────────────────────────────────────────────

  private availability() {
    return this.ctx.backend.availability();
  }

  private async forEachFolder<T>(load: (folder: string) => Promise<T>): Promise<FolderResult<T>[]> {
    return Promise.all(
      this.ctx.folders.all.map(async (f): Promise<FolderResult<T>> => {
        try {
          return { folder: f.path, name: f.folder.name, value: await load(f.path) };
        } catch (error) {
          return { folder: f.path, name: f.folder.name, error: errorMessage(error) };
        }
      }),
    );
  }

  private async loadPlatforms(folder: string): Promise<PlatformsValue> {
    // `info`'s `set` counts what VS Code stores and the env file sets, by name: it gets placeholders.
    const result = await this.ctx.backend.run(folder, ["info"], await this.presence(folder));
    const platforms = parsePlatforms(result.document);
    if (platforms.length === 0 && result.exitCode !== 0) throw new Error(failureText(result));
    return { platforms, stored: await this.ctx.credentials.names(folder) };
  }

  private async loadHealth(folder: string): Promise<readonly DoctorCheck[]> {
    const argv = this.healthOnline ? ["doctor"] : ["doctor", "--offline"];
    // Online, doctor contacts the tenants and gets the values; offline it only counts them by name.
    const result = await this.ctx.backend.run(
      folder,
      argv,
      this.healthOnline ? { credentials: true } : await this.presence(folder),
    );
    const checks = parseChecks(result.document);
    if (checks.length === 0) throw new Error(failureText(result));
    return checks;
  }

  private problems(): (file: string) => ProblemCount | undefined {
    const cache = new Map<string, ProblemCount>();
    return (file) => {
      let count = cache.get(file);
      if (!count) {
        const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(file));
        count = {
          errors: diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
          warnings: diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length,
        };
        cache.set(file, count);
      }
      return count;
    };
  }

  private catalogFolders() {
    return this.ctx.folders.all.map((f) => ({
      path: f.path,
      name: f.folder.name,
      state: this.ctx.catalog.get(f.path),
    }));
  }

  // ── rendering ───────────────────────────────────────────────────────────────────────────────────────

  private renderAll(): void {
    this.renderCatalogue();
    this.renderPlatforms();
    this.renderHealth();
    this.renderActivity();
    this.updateRuntimeKeys();
  }

  private renderCatalogue(): void {
    const folders = this.catalogFolders();
    const model = buildCatalogue({
      folders,
      groupBy: this.groupBy,
      filter: this.filter,
      problems: this.problems(),
    });
    this.catalogue.set(model);
    setContext(
      "opentide.sidebar.catalogueEmpty",
      folders.length === 1 && folders.every((f) => isEmptyRepository(f.state)),
    );
    const coverage = buildCoverageView(folders, this.filter);
    this.coverage.set(coverage);
    setContext("opentide.sidebar.coverageEmpty", coverage.empty);
    setContext("opentide.sidebar.needsCatalog", coverage.needsCatalog && folders.length === 1);
  }

  private renderPlatforms(): void {
    this.platforms.set(
      folderViewModel({
        view: "platforms",
        state: this.platformsLoader.state,
        availability: this.availability(),
        folders: this.ctx.folders.all.map((f) => ({ path: f.path, name: f.folder.name })),
        loadingLabel: "Reading the platforms…",
        nodes: (value, folder, prefix) =>
          platformNodes(value.platforms, new Set(value.stored), folder, prefix),
        extra: (results) => {
          const enabled = results.flatMap((r) => r.value?.platforms.filter((p) => p.enabled) ?? []);
          return { description: `${enabled.length} enabled` };
        },
      }),
    );
  }

  private renderHealth(): void {
    this.health.set(
      folderViewModel({
        view: "health",
        state: this.healthLoader.state,
        availability: this.availability(),
        folders: this.ctx.folders.all.map((f) => ({ path: f.path, name: f.folder.name })),
        loadingLabel: "Running opentide doctor…",
        nodes: (checks, folder, prefix) => healthNodes(checks, folder, prefix),
        extra: (results) => {
          const summary = summarize(results.flatMap((r) => r.value ?? []));
          const attention = summary.failed + summary.warnings;
          return {
            description: summaryText(summary),
            ...(attention > 0
              ? {
                  badge: {
                    value: attention,
                    tooltip: `${summary.failed} failed, ${summary.warnings} warnings`,
                  },
                }
              : {}),
          };
        },
      }),
    );
  }

  private renderActivity(): void {
    const entries = this.ctx.activity.list();
    const names = new Map(this.ctx.folders.all.map((f) => [f.path, f.folder.name]));
    const running = runningCount(entries);
    this.activity.set({
      nodes: activityNodes(
        entries,
        Date.now(),
        (argv) => this.ctx.capabilities.classify(argv),
        (f) => names.get(f) ?? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(f))?.name,
      ),
      ...(running > 0 ? { badge: { value: running, tooltip: `${running} running` } } : {}),
    });
  }

  private updateRuntimeKeys(): void {
    const availability = this.availability();
    // After the first resolution only, so the welcome view does not flash while resolving.
    const resolved = this.ctx.runtime.attempts.length > 0 || this.ctx.runtime.current !== undefined;
    setContext(
      "opentide.sidebar.noRuntime",
      resolved && !availability.available && availability.code !== "untrusted",
    );
    setContext("opentide.sidebar.filtered", Boolean(this.filter));
  }

  // ── events ──────────────────────────────────────────────────────────────────────────────────────────

  private wire(): void {
    const ctx = this.ctx;
    const catalogue = debounce(() => this.renderCatalogue(), 50);
    const diagnostics = debounce(() => this.renderCatalogue(), 500);
    const activity = debounce(() => this.renderActivity(), 100);
    const configurationChanged = (uris: readonly vscode.Uri[]) =>
      uris.some((uri) => /[\\/]\.opentide[\\/]configurations[\\/]/.test(uri.fsPath));
    // Activity's "2 min ago" ages while the view shows.
    const ticker = setInterval(() => {
      if (this.activity.view.visible) this.renderActivity();
    }, 30_000);
    this.disposables.push(
      { dispose: () => clearInterval(ticker) },
      { dispose: () => catalogue.cancel() },
      { dispose: () => diagnostics.cancel() },
      { dispose: () => activity.cancel() },
      ctx.catalog.onDidChange(() => catalogue()),
      ctx.folders.onDidChange(() => {
        catalogue();
        this.platformsLoader.request({ immediate: true });
        this.healthLoader.request({ immediate: true });
        this.updateRuntimeKeys();
      }),
      ctx.onDidChangeFiles(({ folder, uris }) => {
        void ctx.catalog.refresh(folder.path);
        if (configurationChanged(uris)) {
          this.platformsLoader.request();
          this.healthLoader.request();
        }
      }),
      vscode.languages.onDidChangeDiagnostics(() => diagnostics()),
      ctx.activity.onDidChange(() => activity()),
      ctx.credentials.onDidChange(() => {
        this.platformsLoader.request({ immediate: true });
        this.healthLoader.request({ immediate: true });
      }),
      ctx.runtime.onDidChange(() => {
        this.updateRuntimeKeys();
        this.platformsLoader.request({ immediate: true });
        this.healthLoader.request({ immediate: true });
        this.renderAll();
      }),
      ctx.capabilities.onDidChange(() => catalogue()),
      ctx.trust.onDidGrant(() => this.renderAll()),
      this.platformsLoader.onDidChange(() => this.renderPlatforms()),
      this.healthLoader.onDidChange(() => this.renderHealth()),
      this.platforms.view.onDidChangeVisibility(({ visible }) => visible && this.platformsLoader.shown()),
      this.health.view.onDidChangeVisibility(({ visible }) => visible && this.healthLoader.shown()),
      this.activity.view.onDidChangeVisibility(({ visible }) => visible && this.renderActivity()),
      ctx.backend.onDidRun((run) => {
        // `setup platforms` and friends change what `info` and `doctor` say.
        if (run.status !== "running" && run.classification.writes && run.argv[0] === "setup") {
          this.platformsLoader.request();
          this.healthLoader.request();
        }
      }),
      ctx.status.addMenuItem({
        label: "$(heart) Show health (doctor)",
        command: `${VIEWS.health}.focus`,
        order: 60,
      }),
    );
  }

  // ── commands ────────────────────────────────────────────────────────────────────────────────────────

  private registerCommands(): void {
    const ctx = this.ctx;
    const command = (id: string, fn: (...args: unknown[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(id, fn));

    command("opentide.sidebar.open", (arg) => this.open(arg as TreeNode));
    command("opentide.sidebar.refresh", (view) =>
      this.refresh(typeof view === "string" ? view : "catalogue"),
    );
    command("opentide.sidebar.refreshCatalogue", () => this.refresh("catalogue"));
    command("opentide.sidebar.refreshPlatforms", () => this.refresh("platforms"));
    command("opentide.sidebar.refreshHealth", () => this.refresh("health"));
    command("opentide.sidebar.checkOnline", async () => {
      this.healthOnline = true;
      try {
        await this.withViewProgress(VIEWS.health, () => this.healthLoader.reload());
      } finally {
        this.healthOnline = false;
      }
    });
    command("opentide.sidebar.groupBy", () => this.pickGroupBy());
    // From the view title: ask. From Find Detection: `{query}` (or a string) filters and shows the view.
    command("opentide.sidebar.filter", async (arg) => {
      const query = filterArg(arg);
      if (query === undefined) return this.pickFilter();
      this.setFilter(query.trim() || undefined);
      await vscode.commands.executeCommand(`${VIEWS.catalogue}.focus`);
    });
    command("opentide.sidebar.clearFilter", () => this.setFilter(undefined));

    command("opentide.sidebar.validate", (arg) => this.validate(refOf(arg)));
    command("opentide.sidebar.copyUuid", async (arg) => {
      const ref = refOf(arg);
      if ((ref?.kind !== "object" && ref?.kind !== "signal") || !ref.uuid) return;
      await vscode.env.clipboard.writeText(ref.uuid);
      void vscode.window.setStatusBarMessage(`Copied ${ref.uuid}`, 3000);
    });
    command("opentide.sidebar.revealInExplorer", (arg) => {
      const ref = refOf(arg);
      if (ref?.kind === "object")
        void vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(ref.file));
    });
    // The object's own folder's graph, focused on it (a multi-root window may have the UUID twice).
    command("opentide.sidebar.showInGraph", (arg) => {
      const ref = refOf(arg);
      if (ref?.kind === "object" || ref?.kind === "signal")
        return vscode.commands.executeCommand("opentide.graph.open", {
          uuids: [ref.uuid],
          folder: ref.folder,
        });
      return undefined;
    });
    command("opentide.sidebar.newObject", (arg) => this.newObject(refOf(arg)));
    command("opentide.sidebar.runQuery", (arg) => handOver(ruleHandover(refOf(arg), RUN_QUERY)));
    command("opentide.sidebar.previewDeploy", (arg) => handOver(ruleHandover(refOf(arg), PREVIEW_DEPLOY)));
    command("opentide.sidebar.newRuleForObjective", (arg) => this.newObject(refOf(arg)));
    command("opentide.sidebar.newObjectiveForThreat", (arg) => this.newObject(refOf(arg)));
    command("opentide.sidebar.sharePreview", (arg) => {
      const ref = refOf(arg);
      if (ref?.kind === "object")
        return vscode.commands.executeCommand(SHARE_PREVIEW, vscode.Uri.file(ref.file));
      return undefined;
    });
    command("opentide.sidebar.openMatrix", (arg) => {
      const ref = refOf(arg);
      return vscode.commands.executeCommand(
        "opentide.matrix.open",
        ...(ref?.kind === "technique" ? [{ folder: ref.folder, technique: ref.id }] : []),
      );
    });

    command("opentide.sidebar.enablePlatform", (arg) => this.enablePlatform(refOf(arg)));
    command("opentide.sidebar.openPlatformToml", (folderOrNode, id) => {
      const ref = refOf(folderOrNode);
      if (ref?.kind === "platform") return this.openPlatformToml(ref.folder, ref.id);
      if (typeof folderOrNode === "string" && typeof id === "string")
        return this.openPlatformToml(folderOrNode, id);
      return undefined;
    });
    command("opentide.sidebar.setCredential", (arg) => this.setCredential(refOf(arg)));
    command("opentide.sidebar.clearCredential", (arg) => this.clearCredential(refOf(arg)));
    command("opentide.sidebar.checkCredentials", (arg) => this.checkCredentials(refOf(arg)));

    command("opentide.sidebar.runFix", (arg) => this.runFix(refOf(arg)));
    command("opentide.sidebar.copyFix", async (arg) => {
      const ref = refOf(arg);
      if (ref?.kind === "check" && ref.check.fix) await vscode.env.clipboard.writeText(ref.check.fix);
    });
    command("opentide.sidebar.copyReport", () => this.copyReport());

    command("opentide.sidebar.rerun", (arg) => this.rerun(refOf(arg)));
    command("opentide.sidebar.copyCommand", async (arg) => {
      const ref = refOf(arg);
      if (ref?.kind === "run") {
        await vscode.env.clipboard.writeText(ref.entry.argvDisplay);
        void vscode.window.setStatusBarMessage("Copied the command line", 3000);
      }
    });
    command("opentide.sidebar.clearActivity", () => ctx.activity.clear());
  }

  private async open(node: TreeNode | undefined): Promise<void> {
    const uri = node ? openTargetUri(node) : undefined;
    if (!uri || !node?.open) return;
    const position = new vscode.Position(node.open.line, node.open.character ?? 0);
    await vscode.window.showTextDocument(uri, {
      selection: new vscode.Range(position, position),
      preview: true,
      preserveFocus: false,
    });
  }

  private async withViewProgress<T>(viewId: string, task: () => Promise<T>): Promise<T> {
    return vscode.window.withProgress({ location: { viewId } }, task);
  }

  private async refresh(view: string): Promise<void> {
    if (view === "platforms")
      await this.withViewProgress(VIEWS.platforms, () => this.platformsLoader.reload());
    else if (view === "health") await this.withViewProgress(VIEWS.health, () => this.healthLoader.reload());
    else {
      const viewId = view === "coverage" ? VIEWS.coverage : VIEWS.catalogue;
      await this.withViewProgress(viewId, () =>
        Promise.all(this.ctx.folders.all.map((f) => this.ctx.catalog.refresh(f.path, { immediate: true }))),
      );
    }
  }

  private async pickGroupBy(): Promise<void> {
    const items = (Object.keys(GROUP_BY_LABELS) as GroupBy[]).map((key) => ({
      label: GROUP_BY_LABELS[key],
      description: key === this.groupBy ? "current" : undefined,
      key,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Group the catalogue by" });
    if (!picked) return;
    this.groupBy = picked.key;
    await this.ctx.extension.workspaceState.update(GROUP_BY_KEY, picked.key);
    this.renderCatalogue();
  }

  private async pickFilter(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: "Filter the catalogue and coverage",
      prompt: "A name, UUID, path or ATT&CK technique (T1003). Empty clears the filter.",
      value: this.filter ?? "",
    });
    if (value !== undefined) this.setFilter(value.trim() || undefined);
  }

  private setFilter(filter: string | undefined): void {
    this.filter = filter;
    setContext("opentide.sidebar.filtered", Boolean(filter));
    this.renderCatalogue();
  }

  /**
   * Run options for a status command: every credential by name, with a placeholder, no value; the env
   * file's configuration (`OPENTIDE_REPO_ROOT`, proxies) as it is.
   */
  private async presence(folder: string): Promise<{ credentials: false; env: Record<string, string> }> {
    // The variables the last `info` listed under the folder's tenants are credentials too.
    const last = this.platformsLoader.state.value?.find((r) => r.folder === folder)?.value;
    const credentials = new Set([
      ...(await this.ctx.credentials.names(folder)),
      ...tenantVariableNames(last?.platforms ?? []),
    ]);
    return {
      credentials: false,
      env: presenceEnv(await this.ctx.backend.credentialEnv(folder), credentials),
    };
  }

  private async run(
    folder: string,
    argv: string[],
    title: string,
    options: { credentials?: boolean; env?: Readonly<Record<string, string>> } = {},
  ): Promise<RunResult | undefined> {
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_progress, token) => this.ctx.backend.run(folder, argv, { cancellation: token, ...options }),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
      return undefined;
    }
  }

  private async validate(ref: NodeRef | undefined): Promise<void> {
    if (ref?.kind !== "object") return;
    // The diagnostics feature puts the findings in Problems; hand over when it is there.
    if ((await vscode.commands.getCommands(true)).includes(VALIDATE_FILE)) {
      await vscode.commands.executeCommand(VALIDATE_FILE, vscode.Uri.file(ref.file));
      return;
    }
    const result = await this.run(ref.folder, ["validate", "--file", ref.file], `Validating ${ref.name}…`);
    if (!result || result.cancelled) return;
    const summary = result.document.summary as { errors?: unknown; warnings?: unknown };
    const errors = typeof summary.errors === "number" ? summary.errors : 0;
    const warnings = typeof summary.warnings === "number" ? summary.warnings : 0;
    if (result.exitCode === 0 && errors === 0 && warnings === 0) {
      void vscode.window.showInformationMessage(`${ref.name}: valid.`);
      return;
    }
    if (result.exitCode !== 0 && errors === 0) {
      void this.showFailure(result);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `${ref.name}: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`,
      "Show Problems",
      "Copy Command",
    );
    if (choice === "Show Problems") await vscode.commands.executeCommand("workbench.actions.view.problems");
    if (choice === "Copy Command") await vscode.env.clipboard.writeText(result.argvDisplay);
  }

  private async newObject(ref: NodeRef | undefined): Promise<unknown> {
    const handover = newObjectHandover(ref);
    if ("args" in handover) return handOver(handover);
    if ("folder" in handover)
      return vscode.commands.executeCommand(handover.command, vscode.Uri.file(handover.folder));
    const folder = this.ctx.folders.all.length === 1 ? this.ctx.folders.all[0] : undefined;
    return vscode.commands.executeCommand(handover.command, ...(folder ? [folder.folder.uri] : []));
  }

  private async enablePlatform(ref: NodeRef | undefined): Promise<void> {
    if (ref?.kind !== "platform") return;
    const flag = platformFlag(ref.id);
    if (!this.ctx.capabilities.hasOption("setup platforms", flag)) {
      void vscode.window.showWarningMessage(
        `This opentide's \`setup platforms\` has no ${flag}. Switch to a newer opentide to enable ${platformName(ref.id).long}.`,
      );
      return;
    }
    const result = await this.run(
      ref.folder,
      ["setup", "platforms", flag, "--yes"],
      `Enabling ${platformName(ref.id).long}…`,
    );
    if (!result || result.cancelled) return;
    if (result.exitCode !== 0) {
      void this.showFailure(result);
      return;
    }
    this.platformsLoader.request({ immediate: true });
    const choice = await vscode.window.showInformationMessage(
      `${platformName(ref.id).long} is enabled. Add a tenant in its configuration to deploy and query.`,
      "Open Configuration",
    );
    if (choice) await this.openPlatformToml(ref.folder, ref.id);
  }

  private async openPlatformToml(folder: string, id: string): Promise<void> {
    const file = path.join(folder, platformToml(id));
    try {
      await fs.promises.access(file);
    } catch {
      void vscode.window.showInformationMessage(
        `${platformToml(id)} does not exist yet. Enable ${platformName(id).long} first.`,
      );
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  private tenantVariables(folder: string, platform: string, tenant: string) {
    const value = this.platformsLoader.state.value?.find((r) => r.folder === folder)?.value;
    const stored = new Set(value?.stored ?? []);
    const variables =
      value?.platforms.find((p) => p.name === platform)?.tenants?.find((t) => t.name === tenant)?.variables ??
      [];
    return variables.map((v) => ({ ...v, stored: stored.has(v.name) }));
  }

  private async setCredential(ref: NodeRef | undefined): Promise<void> {
    if (ref?.kind !== "tenant" && ref?.kind !== "variable") return;
    const where = `${ref.platform}/${ref.tenant}`;
    let name: string | undefined = ref.kind === "variable" ? ref.name : undefined;
    if (!name) {
      const variables = this.tenantVariables(ref.folder, ref.platform, ref.tenant);
      const picked = await vscode.window.showQuickPick(
        variables.map((v) => ({
          label: v.name,
          description: v.stored ? "stored in VS Code" : v.set ? "set in the environment" : "not set",
          iconPath: new vscode.ThemeIcon(v.stored || v.set ? "key" : "circle-slash"),
        })),
        { title: `Set a credential of ${where}`, placeHolder: "The variable its configuration names" },
      );
      name = picked?.label;
    }
    if (!name) return;
    const value = await vscode.window.showInputBox({
      title: `$${name} for ${where}`,
      prompt:
        "Stored in VS Code's secret storage for this folder, and passed only to commands that contact a tenant. Never written to a file.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (text) => (text.length === 0 ? "Enter a value, or press Escape" : undefined),
    });
    if (value === undefined) return;
    await this.ctx.credentials.set(ref.folder, name, value);
    // Re-check at once, so the tenant and doctor's credentials check turn green (#15).
    this.platformsLoader.request({ immediate: true });
    this.healthLoader.request({ immediate: true });
    void vscode.window.setStatusBarMessage(`$(key) Stored $${name} for ${where}`, 4000);
  }

  private async clearCredential(ref: NodeRef | undefined): Promise<void> {
    if (ref?.kind !== "variable") return;
    const choice = await vscode.window.showWarningMessage(
      `Remove $${ref.name} from VS Code's secret storage for this folder?`,
      { modal: true },
      "Remove",
    );
    if (choice !== "Remove") return;
    await this.ctx.credentials.delete(ref.folder, ref.name);
  }

  private async checkCredentials(ref: NodeRef | undefined): Promise<void> {
    if (ref?.kind !== "tenant") return;
    const where = `${ref.platform}/${ref.tenant}`;
    const result = await this.run(
      ref.folder,
      ["doctor", "--offline"],
      `Checking the credentials of ${where}…`,
      await this.presence(ref.folder),
    );
    if (!result || result.cancelled) return;
    const check = tenantCheck(parseChecks(result.document), ref.platform, ref.tenant);
    this.healthLoader.request({ immediate: true });
    if (!check) {
      void this.showFailure(result, `doctor reported nothing for ${where}.`);
      return;
    }
    if (check.status === "pass") {
      void vscode.window.showInformationMessage(`${where}: ${check.message}`);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `${check.message}${check.fix ? `. ${check.fix}` : ""}`,
      ...(ref.variables.length ? ["Set Credential…"] : []),
    );
    if (choice) await this.setCredential(ref);
  }

  private async runFix(ref: NodeRef | undefined): Promise<void> {
    if (ref?.kind !== "check") return;
    const tree = this.ctx.capabilities.current;
    const plan = planFix(ref.check.fix, {
      pathOf: (argv) => tree?.commandPathOf(argv).path ?? "",
      classify: (argv) => this.ctx.capabilities.classify(argv),
      hasOption: (path, flag) => tree?.hasOption(path, flag) ?? false,
    });
    if (!plan) return;
    if (plan.kind === "replaced") {
      void vscode.window.showInformationMessage(plan.message);
      return;
    }
    if (plan.kind === "copy") {
      // Only commands this opentide has, and nothing that reaches a tenant from a click on a fix.
      await vscode.env.clipboard.writeText(ref.check.fix ?? "");
      void vscode.window.showInformationMessage(`Copied the fix to run it in a terminal: ${ref.check.fix}`);
      return;
    }
    const shown = `opentide ${plan.argv.join(" ")}`;
    if (plan.confirm) {
      const choice = await vscode.window.showWarningMessage(
        `Run \`${shown}\`? It writes files in ${path.basename(ref.folder)}.`,
        { modal: true },
        "Run",
      );
      if (choice !== "Run") return;
    }
    const result = await this.run(ref.folder, [...plan.argv], `Running ${shown}…`);
    if (!result || result.cancelled) return;
    if (result.exitCode !== 0) void this.showFailure(result);
    else
      void vscode.window.showInformationMessage(
        `${result.document.message || "Done"}: ${result.argvDisplay}`,
      );
    this.healthLoader.request({ immediate: true });
  }

  private async copyReport(): Promise<void> {
    const results = this.healthLoader.state.value ?? [];
    if (results.length === 0) {
      void vscode.window.showInformationMessage("Run doctor first: the Health view has no results yet.");
      return;
    }
    const texts: string[] = [];
    for (const result of results) {
      const secrets = Object.values(await this.ctx.credentials.env(result.folder));
      texts.push(
        report(result.value ?? [], {
          opentide: this.ctx.runtime.current?.version,
          editor: `${vscode.env.appName} ${vscode.version}`,
          os: `${process.platform} ${os.release()}`,
          home: os.homedir(),
          folder: result.folder,
          secrets,
        }),
      );
    }
    await vscode.env.clipboard.writeText(texts.join("\n\n"));
    void vscode.window.showInformationMessage(
      "Copied the doctor report, with paths and stored secrets redacted.",
    );
  }

  private async rerun(ref: NodeRef | undefined): Promise<void> {
    if (ref?.kind !== "run") return;
    const { entry } = ref;
    const plan = rerunPlan(this.ctx.capabilities.classify(entry.argv), entry.argvDisplay);
    if (plan.kind === "refuse") return;
    if (plan.kind === "confirm") {
      const choice = await vscode.window.showWarningMessage(plan.message, { modal: true }, plan.action);
      if (choice !== plan.action) return;
    }
    const result = await this.run(entry.folder, [...entry.argv], `Running ${entry.argv.join(" ")}…`);
    if (!result || result.cancelled) return;
    if (result.exitCode !== 0) void this.showFailure(result);
    else void vscode.window.setStatusBarMessage(`$(pass) ${result.argvDisplay}`, 4000);
  }

  private async showFailure(result: RunResult, prefix?: string): Promise<void> {
    const failure = result.document.failure;
    const text = [prefix, failure?.message ?? result.document.message, failure?.suggestion]
      .filter(Boolean)
      .join(" ");
    const choice = await vscode.window.showErrorMessage(
      text || `exit ${result.exitCode}`,
      "Show Output",
      "Copy Command",
    );
    if (choice === "Show Output") this.ctx.log.show();
    if (choice === "Copy Command") await vscode.env.clipboard.writeText(result.argvDisplay);
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0).reverse()) disposable.dispose();
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof BackendError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function failureText(result: RunResult): string {
  return result.document.failure?.message ?? result.document.message ?? `exit ${result.exitCode}`;
}
