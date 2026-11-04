// The deploy plan (#18, SPEC §10.5): a `deploy --dry-run` preview, never a real deploy (D6).
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { BackendError } from "../../core/backend/types";
import { findByUuid, loadedObjects } from "../../core/catalog/rows";
import type { FeatureContext, OpentideFolder } from "../../core/context";
import { defineFeature } from "../../core/feature";
import { displayArgv } from "../../core/runtime/env";
import { ensureSaved } from "../../core/util/saved";
import type { OpentidePanel } from "../../core/webview/panel";
import { fileColumnFrom, PanelPool, panelTitle } from "../../core/webview/placement";
import { platformName } from "../sidebar/platformNames";
import { parsePlatforms } from "../sidebar/platforms";
import {
  ciStep,
  ciVariables,
  DeployPlanner,
  type DeployPlanOptions,
  type DeployScope,
  deployCommand,
  dryRunArgv,
  dryRunCommand,
  type Strategy,
} from "./argv";
import { type PlanView, payloadDocuments, planView } from "./plan";
import {
  cancelledState,
  type DeployPanelState,
  type DeployPlanProtocol,
  hostValidators,
  type ScopeKind,
} from "./protocol";

const PAYLOAD_SCHEME = "opentide-payload";
const PLATFORMS = [
  "sentinel",
  "defender_for_endpoint",
  "elastic",
  "splunk",
  "sentinel_one",
  "carbon_black_cloud",
  "crowdstrike",
  "harfanglab",
  "sysdig",
];
const LAST_KEY = "opentide.deployPlan.last";

/** The rules a preview is about. */
export interface DeployTarget {
  readonly folder: string;
  readonly uuids: readonly string[];
  readonly files: readonly string[];
}

/** One key per set of rules in a folder: the pool's "same object". */
export function targetKey(target: DeployTarget): string {
  const rules = [...target.uuids.map((u) => `u:${u.toLowerCase()}`), ...target.files.map((f) => `f:${f}`)];
  return `${target.folder}\u0000${rules.sort().join("|") || "changed"}`;
}

/** The plan's tab title: "Deploy Plan · Suspicious LSASS… " for rules, "Deploy Plan" for the changed set. */
export function deployPanelTitle(selection: string | null): string {
  return panelTitle("Deploy Plan", selection);
}

/**
 * `opentide.deployPlan.open`'s arguments: an explorer URI (and the selected URIs), a `{ uuids?, files?,
 * uuid?, file?, folder? }` from the catalogue or search, or nothing (the active rule, else the changed set).
 */
export function parseTargetArgs(
  first: unknown,
  second: unknown,
): { uris: string[]; uuids: string[]; files: string[]; folder?: string } {
  const uris: string[] = [];
  const isUri = (v: unknown): v is { fsPath: string; scheme: string } =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { fsPath?: unknown }).fsPath === "string" &&
    typeof (v as { scheme?: unknown }).scheme === "string";
  if (Array.isArray(second) && second.every(isUri) && second.length > 0) {
    for (const uri of second) uris.push(uri.fsPath);
    return { uris, uuids: [], files: [] };
  }
  if (isUri(first)) return { uris: [first.fsPath], uuids: [], files: [] };
  if (typeof first === "object" && first !== null) {
    const arg = first as {
      uuids?: unknown;
      files?: unknown;
      uuid?: unknown;
      file?: unknown;
      folder?: unknown;
    };
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const uuids = [...list(arg.uuids), ...(typeof arg.uuid === "string" ? [arg.uuid] : [])];
    const files = [...list(arg.files), ...(typeof arg.file === "string" ? [arg.file] : [])];
    return { uris, uuids, files, ...(typeof arg.folder === "string" ? { folder: arg.folder } : {}) };
  }
  return { uris, uuids: [], files: [] };
}

export default defineFeature({
  id: "deploy-plan",
  activate(ctx) {
    const payloads = new PayloadDocuments();
    const diagnostics = vscode.languages.createDiagnosticCollection("opentide deploy");
    // One plan panel, retargeted to the rules asked for; a locked one keeps its rules and the next
    // preview opens a panel of its own.
    const pool = new PanelPool<string, DeployPanel>((a, b) => a === b);

    const open = async (first?: unknown, second?: unknown, changedOnly = false) => {
      if (!ctx.trust.isTrusted) {
        void vscode.window.showInformationMessage("Trust this folder to preview deploys.");
        return;
      }
      const target = changedOnly ? await changedTarget(ctx) : await resolveTarget(ctx, first, second);
      if (!target) return;
      // `deploy --dry-run --file` compiles the rule files on disk: offer to save the edits first.
      const files = new Set(target.files.map((file) => path.resolve(target.folder, file)));
      const documents = vscode.workspace.textDocuments.filter(
        (document) => document.uri.scheme === "file" && files.has(path.resolve(document.uri.fsPath)),
      );
      const preview = { verb: "previews", action: "Preview" };
      if (!(await ensureSaved(documents, preview, warn))) return;
      const choice = pool.choose(targetKey(target));
      if (choice.kind !== "create") {
        pool.touch(choice.entry);
        choice.entry.show(target);
        return;
      }
      const panel: DeployPanel = new DeployPanel(ctx, payloads, diagnostics, target, {
        disposed: () => pool.remove(panel),
        active: () => pool.touch(panel),
      });
      pool.add(panel);
    };

    ctx.subscriptions.push(
      payloads,
      diagnostics,
      vscode.workspace.registerTextDocumentContentProvider(PAYLOAD_SCHEME, payloads),
      vscode.commands.registerCommand("opentide.deployPlan.open", (first?: unknown, second?: unknown) =>
        open(first, second),
      ),
      vscode.commands.registerCommand("opentide.deployPlan.openChanged", () =>
        open(undefined, undefined, true),
      ),
      {
        dispose: () => {
          for (const panel of [...pool.all()]) panel.dispose();
        },
      },
    );
  },
});

async function changedTarget(ctx: FeatureContext): Promise<DeployTarget | undefined> {
  const folder = await ctx.folders.pick("Preview the deploy of which folder?");
  return folder ? { folder: folder.path, uuids: [], files: [] } : undefined;
}

async function resolveTarget(
  ctx: FeatureContext,
  first: unknown,
  second: unknown,
): Promise<DeployTarget | undefined> {
  const args = parseTargetArgs(first, second);
  const relative = (folder: OpentideFolder, file: string) =>
    (path.isAbsolute(file) ? path.relative(folder.path, file) : file).split(path.sep).join("/");
  if (args.uris.length > 0) {
    const first = vscode.Uri.file(args.uris[0] ?? "");
    const folder = ctx.folders.folderOf(first);
    if (!folder) {
      void vscode.window.showWarningMessage("That file is not in an opentide folder.");
      return undefined;
    }
    return { folder: folder.path, uuids: [], files: args.uris.map((file) => relative(folder, file)) };
  }
  if (args.uuids.length > 0 || args.files.length > 0) {
    const folder =
      ctx.folders.all.find((f) => f.path === args.folder) ??
      (args.files[0] && path.isAbsolute(args.files[0])
        ? ctx.folders.folderOf(vscode.Uri.file(args.files[0]))
        : undefined) ??
      (await ctx.folders.pick("Preview the deploy of which folder?"));
    if (!folder) return undefined;
    return {
      folder: folder.path,
      uuids: args.uuids,
      files: args.files.map((file) => relative(folder, file)),
    };
  }
  const editor = vscode.window.activeTextEditor;
  if (
    editor &&
    ctx.folders.isObjectFile(editor.document.uri) &&
    editor.document.languageId === "opentide-yaml"
  ) {
    const folder = ctx.folders.folderOf(editor.document.uri);
    if (folder)
      return { folder: folder.path, uuids: [], files: [relative(folder, editor.document.uri.fsPath)] };
  }
  return changedTarget(ctx);
}

let nextPanelId = 1;

class DeployPanel implements vscode.Disposable {
  private readonly view: OpentidePanel<DeployPlanProtocol>;
  /** This panel's payload documents' namespace. */
  private readonly id = nextPanelId++;
  /** Pinned to its rules: another preview opens its own panel. */
  locked = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly planner: DeployPlanner<
    { cancellation: vscode.CancellationToken; onProgress: (step: string) => void },
    Awaited<ReturnType<FeatureContext["backend"]["run"]>>
  >;
  private rules: DeployTarget;
  private state: DeployPanelState | undefined;
  private plan: PlanView | null = null;
  private document: unknown;
  private cts: vscode.CancellationTokenSource | undefined;
  private runId = 0;

  constructor(
    private readonly ctx: FeatureContext,
    private readonly payloads: PayloadDocuments,
    private readonly diagnostics: vscode.DiagnosticCollection,
    target: DeployTarget,
    events: { disposed: () => void; active: () => void },
  ) {
    this.rules = target;
    this.planner = new DeployPlanner((folder, argv, extra) =>
      ctx.backend.run(folder, argv, {
        cancellation: extra.cancellation,
        // A dry run needs no credentials (SPEC §10.5).
        credentials: false,
        onProgress: (event) => {
          if (event.event === "progress" && typeof event.step === "string") {
            const of =
              typeof event.done === "number" && typeof event.total === "number"
                ? ` ${event.done}/${event.total}`
                : "";
            extra.onProgress(`${event.step}${of}`);
          }
        },
      }),
    );
    this.view = ctx.webview.createPanel<DeployPlanProtocol>({
      viewType: "opentide.deployPlan",
      title: deployPanelTitle(null),
      entry: "deploy-plan",
      validators: hostValidators,
      // Beside the rule it previews, keeping the focus in its editor.
      beside: true,
      kit: true,
      retainContextWhenHidden: false,
    });
    const { channel, panel } = this.view;
    this.disposables.push(
      panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.active) events.active();
      }),
      channel.on("lock", (locked) => {
        this.locked = locked;
        if (this.state) this.state = { ...this.state, locked };
        this.post();
      }),
      channel.on("ready", () => {
        if (this.state) void channel.post("state", this.state);
      }),
      channel.on("run", (request) =>
        this.run({ strategies: request.strategies, scope: request.scope, platform: request.platform }),
      ),
      channel.on("cancel", () => this.cts?.cancel()),
      channel.on("payload", (key) => this.openPayload(key)),
      channel.on("diff", (key) => this.diffPayload(key)),
      channel.on("open", (ref) => this.openRule(ref)),
      channel.on("copy", (what) => this.copy(what)),
      channel.on("action", async (id) => {
        if (id === "output") ctx.log.show();
        else if (id === "switchRuntime") await vscode.commands.executeCommand("opentide.switchRuntime");
        else if (id.startsWith("configure:")) await this.openPlatformConfig(id.slice("configure:".length));
      }),
      panel.onDidDispose(() => {
        this.cts?.cancel();
        if (diagnosticsOwner === this.id) this.diagnostics.clear();
        this.payloads.clear(this.id);
        for (const d of this.disposables) d.dispose();
        events.disposed();
      }),
    );
    this.show(target);
  }

  private get canSelect(): boolean {
    return (
      this.ctx.capabilities.hasOption("deploy", "--uuid") &&
      this.ctx.capabilities.hasOption("deploy", "--file")
    );
  }

  /** The rules this panel shows (its pool key). */
  get target(): string {
    return targetKey(this.rules);
  }

  show(target: DeployTarget): void {
    this.rules = target;
    this.view.panel.title = deployPanelTitle(this.selectionLabel());
    // Forward where it is; the focus stays in the editor the preview came from.
    this.view.panel.reveal(undefined, true);
    const last = this.ctx.extension.workspaceState.get<{
      strategies?: Strategy[];
      scope?: ScopeKind;
      platform?: string;
    }>(LAST_KEY);
    const selected = target.uuids.length + target.files.length > 0;
    const scope: ScopeKind = selected ? "selected" : last?.scope === "all" ? "all" : "changed";
    void this.run({
      strategies: last?.strategies?.length ? last.strategies : ["PREVIEW"],
      scope,
      platform: last?.platform ?? null,
    });
  }

  /** The options for a scope; `selected` without `deploy --uuid` falls back to the changed rules. */
  private options(request: { strategies: readonly Strategy[]; scope: ScopeKind; platform: string | null }): {
    options: DeployPlanOptions;
    scope: ScopeKind;
    note: string | null;
  } {
    const selected = this.rules.uuids.length + this.rules.files.length > 0;
    let scope = request.scope;
    let note: string | null = null;
    if (scope === "selected" && (!selected || !this.canSelect)) {
      if (selected)
        note =
          "Previewing one rule needs an opentide whose deploy has --uuid and --file. This plan shows the changed rules; choose All rules to include every rule.";
      scope = "changed";
    }
    const deployScope: DeployScope =
      scope === "selected"
        ? { kind: "selected", uuids: this.rules.uuids, files: this.rules.files }
        : { kind: scope };
    return {
      options: {
        strategies: request.strategies,
        scope: deployScope,
        ...(request.platform ? { platform: request.platform } : {}),
      },
      scope,
      note,
    };
  }

  private selectionLabel(): string | null {
    const files = this.rules.files;
    const total = this.rules.uuids.length + files.length;
    if (total === 0) return null;
    if (total === 1) {
      const uuid = this.rules.uuids[0];
      const catalog = this.ctx.catalog.get(this.rules.folder).catalog;
      const byUuid = uuid && catalog ? findByUuid(catalog.objects, uuid)?.name : undefined;
      const byFile = files[0] ? catalog?.objects.find((o) => o.path === files[0])?.name : undefined;
      return byUuid ?? byFile ?? (files[0] ? path.basename(files[0]) : (uuid ?? ""));
    }
    return `${total} rules`;
  }

  private focusUuids(): string[] {
    const catalog = this.ctx.catalog.get(this.rules.folder).catalog;
    const fromFiles = this.rules.files.flatMap((file) =>
      loadedObjects(catalog?.objects ?? [])
        .filter((o) => o.path === file)
        .map((o) => o.uuid),
    );
    return [...this.rules.uuids, ...fromFiles];
  }

  private post(): void {
    if (this.state) void this.view.channel.post("state", this.state);
  }

  async run(request: {
    strategies: readonly Strategy[];
    scope: ScopeKind;
    platform: string | null;
  }): Promise<void> {
    // Whether `deploy --uuid` exists is known once the command tree loaded.
    await this.ctx.capabilities.ready();
    this.cts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    const id = ++this.runId;
    const { options, scope, note } = this.options(request);
    void this.ctx.extension.workspaceState.update(LAST_KEY, {
      strategies: request.strategies,
      scope: request.scope === "selected" ? undefined : request.scope,
      platform: request.platform ?? undefined,
    });
    const folder = this.rules.folder;
    const startedAt = Date.now();
    this.view.panel.title = deployPanelTitle(this.selectionLabel());
    this.state = {
      phase: "running",
      locked: this.locked,
      folderName: path.basename(folder),
      platformLabels: Object.fromEntries(PLATFORMS.map((p) => [p, platformName(p).long])),
      folder,
      strategies: [...request.strategies],
      scope,
      platform: request.platform,
      selection: this.selectionLabel(),
      canSelect: this.canSelect,
      focus: this.focusUuids(),
      platforms: PLATFORMS,
      argvDisplay: displayArgv(dryRunArgv(options)),
      dryRunCommand: dryRunCommand(options),
      deployCommand: deployCommand(options),
      plan: this.state?.plan ?? null,
      failure: null,
      progress: null,
      note,
      startedAt,
      durationMs: null,
    };
    this.post();
    try {
      const result = await this.planner.plan(folder, options, {
        cancellation: cts.token,
        onProgress: (step) => {
          if (this.runId !== id || !this.state) return;
          // Kept in the state too, so a panel shown again says where the plan is.
          this.state = { ...this.state, progress: step };
          void this.view.channel.post("progress", step);
        },
      });
      if (this.runId !== id) return;
      if (result.cancelled) {
        // The cancelled envelope has no plan: the plan shown, its payloads and Problems stay.
        this.state = cancelledState(this.state, result.durationMs);
      } else {
        const plan = planView(result.document);
        this.plan = plan;
        this.document = result.document;
        this.payloads.replace(this.id, payloadDocuments(result.document));
        this.publishDiagnostics(plan);
        const unusable =
          result.exitCode === 2 ||
          (result.exitCode !== 0 && plan.platforms.length === 0 && plan.unmatched.length === 0);
        this.state = {
          ...this.state,
          argvDisplay: result.argvDisplay,
          phase: unusable ? "failed" : "done",
          plan,
          failure: unusable
            ? { code: result.document.failure?.code ?? "failed", message: result.document.message }
            : null,
          durationMs: result.durationMs,
        };
      }
    } catch (error) {
      if (this.runId !== id) return;
      this.state = {
        ...this.state,
        phase: "failed",
        failure: {
          code: error instanceof BackendError ? error.code : "error",
          message: error instanceof Error ? error.message : String(error),
        },
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (this.cts === cts) this.cts = undefined;
      cts.dispose();
    }
    this.post();
  }

  private publishDiagnostics(plan: PlanView): void {
    // The Problems view shows the plan previewed last.
    diagnosticsOwner = this.id;
    this.diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of plan.diagnostics) {
      const file = d.filePath ?? (d.path ? path.join(this.rules.folder, d.path) : undefined);
      if (!file) continue;
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        `${d.message}${d.help ? `\nhelp: ${d.help}` : ""}`,
        d.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = "opentide deploy";
      diagnostic.code = d.code;
      const list = byFile.get(file) ?? [];
      list.push(diagnostic);
      byFile.set(file, list);
    }
    for (const [file, list] of byFile) this.diagnostics.set(vscode.Uri.file(file), list);
  }

  private async openPayload(key: string): Promise<void> {
    const uri = this.payloads.uri(this.id, key, "request");
    if (!uri) return;
    const document = await vscode.workspace.openTextDocument(uri);
    // Beside the plan, in preview (the next payload replaces it); the plan keeps the focus.
    await vscode.window.showTextDocument(document, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    });
  }

  private async diffPayload(key: string): Promise<void> {
    const deployed = this.payloads.uri(this.id, key, "deployed");
    const request = this.payloads.uri(this.id, key, "request");
    if (!deployed || !request) return;
    await vscode.commands.executeCommand(
      "vscode.diff",
      deployed,
      request,
      `${this.payloads.name(this.id, key)}: deployed ↔ planned`,
      {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
      },
    );
  }

  private async openRule(ref: string): Promise<void> {
    const catalog = this.ctx.catalog.get(this.rules.folder).catalog;
    const object = catalog ? findByUuid(catalog.objects, ref) : undefined;
    const fromPlan =
      this.plan?.platforms.flatMap((p) => p.payloads).find((p) => p.uuid === ref)?.file ??
      this.plan?.diagnostics.find((d) => d.uuid === ref)?.filePath ??
      undefined;
    const file =
      object?.file_path ??
      fromPlan ??
      (ref.endsWith(".yaml") || ref.endsWith(".yml") ? path.join(this.rules.folder, ref) : undefined);
    if (!file) {
      void vscode.window.showInformationMessage("The rule's file is not known until the catalogue loads.");
      return;
    }
    const line = Math.max(0, (object?.line ?? 1) - 1);
    // The group left of the plan (where the rule's editor is), else beside it: the plan stays in view.
    await vscode.window.showTextDocument(vscode.Uri.file(file), {
      selection: new vscode.Range(line, 0, line, 0),
      viewColumn: fileColumnFrom(this.view.panel.viewColumn) ?? vscode.ViewColumn.Beside,
      preview: true,
    });
  }

  private async copy(what: "dryRun" | "deploy" | "ci"): Promise<void> {
    const s = this.state;
    if (!s) return;
    const strategies = s.strategies;
    const { options } = this.options({ strategies, scope: s.scope, platform: s.platform });
    const text =
      what === "dryRun"
        ? dryRunCommand(options)
        : what === "deploy"
          ? deployCommand(options)
          : ciStep(options, await this.ciVariables(options));
    await vscode.env.clipboard.writeText(text);
    if (what === "dryRun") vscode.window.setStatusBarMessage("$(check) Copied the dry-run command", 2500);
    else
      void vscode.window.showInformationMessage(
        what === "deploy"
          ? "Copied the deploy command. Run it in a terminal or in CI: the editor only previews."
          : "Copied a GitHub Actions step for the deploy. Add the secrets it names to the repository.",
      );
  }

  /** The CI step's secrets: the plan's tenants' variables from `info`, and what its warnings name. */
  private async ciVariables(options: DeployPlanOptions): Promise<string[]> {
    const folder = this.rules.folder;
    // `info` reports each tenant's variable names; it needs no credential to name them.
    const info = await this.ctx.backend.run(folder, ["info"], { credentials: false }).then(
      (result) => parsePlatforms(result.document),
      (error: unknown) => {
        this.ctx.log.warn(`opentide info for the CI step's secrets: ${String(error)}`);
        return [];
      },
    );
    return ciVariables(options, info, this.plan?.platforms ?? [], this.plan?.warnings ?? []);
  }

  private async openPlatformConfig(platform: string): Promise<void> {
    if (!/^[a-z_]+$/.test(platform)) return;
    const file = path.join(this.rules.folder, ".opentide", "configurations", "platforms", `${platform}.toml`);
    if (fs.existsSync(file))
      await vscode.window.showTextDocument(vscode.Uri.file(file), {
        viewColumn: fileColumnFrom(this.view.panel.viewColumn) ?? vscode.ViewColumn.Beside,
      });
  }

  /** For tests: the last plan's document. */
  get lastDocument(): unknown {
    return this.document;
  }

  dispose(): void {
    this.view.dispose();
  }
}

type PayloadEntry = { request: unknown; deployed?: unknown; name: string; platform: string };

/** Read-only `opentide-payload:` JSON documents of each open plan panel's last plan. */
class PayloadDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly plans = new Map<number, Map<string, PayloadEntry>>();
  private generation = 0;
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  replace(panel: number, entries: Map<string, PayloadEntry>): void {
    this.plans.set(panel, entries);
    this.generation++;
  }

  clear(panel: number): void {
    this.plans.delete(panel);
  }

  name(panel: number, key: string): string {
    return this.plans.get(panel)?.get(key)?.name ?? key;
  }

  uri(panel: number, key: string, kind: "request" | "deployed"): vscode.Uri | undefined {
    const entry = this.plans.get(panel)?.get(key);
    if (!entry || (kind === "deployed" && entry.deployed === undefined)) return undefined;
    const name = entry.name.replace(/[\\/?#%]/g, "-");
    return vscode.Uri.from({
      scheme: PAYLOAD_SCHEME,
      path: `/${entry.platform}/${name}${kind === "deployed" ? ".deployed" : ""}.json`,
      query: new URLSearchParams({
        panel: String(panel),
        key,
        kind,
        generation: String(this.generation),
      }).toString(),
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const query = new URLSearchParams(uri.query);
    const entry = this.plans.get(Number(query.get("panel")))?.get(query.get("key") ?? "");
    if (!entry) return "// This payload belongs to a plan that is no longer open. Run the preview again.\n";
    const value = query.get("kind") === "deployed" ? entry.deployed : entry.request;
    return `${JSON.stringify(value ?? null, null, 2)}\n`;
  }

  dispose(): void {
    this.emitter.dispose();
    this.plans.clear();
  }
}

/** The panel whose plan the Problems view shows (the one previewed last). */
let diagnosticsOwner = 0;

/** A warning with buttons, as `ensureSaved` asks. */
function warn(message: string, ...items: string[]): Thenable<string | undefined> {
  return vscode.window.showWarningMessage(message, ...items);
}
