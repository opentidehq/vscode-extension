// The deploy plan (#18, SPEC §10.5): a `deploy --dry-run` preview, never a real deploy (D6), shown as a
// native tree in the panel area (platform → tenant → change), whose changes open in VS Code's diff editor.
import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { BackendError } from "../../core/backend/types";
import { findByUuid } from "../../core/catalog/rows";
import type { FeatureContext, OpentideFolder } from "../../core/context";
import { defineFeature } from "../../core/feature";
import { displayArgv } from "../../core/runtime/env";
import { ensureSaved } from "../../core/util/saved";
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
  type ScopeKind,
  type Strategy,
} from "./argv";
import { type PlanView, payloadDocuments, planView } from "./plan";
import { filterChoices, type PlanFilter, type PlanTree, planMessage, planTree, type TreeNode } from "./tree";

const PAYLOAD_SCHEME = "opentide-payload";
const VIEW_ID = "opentide.deployPlan.view";
const PLATFORMS = [
  "sentinel",
  "microsoft_defender",
  "elastic",
  "splunk",
  "sentinel_one",
  "carbon_black_cloud",
  "crowdstrike",
  "harfanglab",
  "sysdig",
];
const LAST_KEY = "opentide.deployPlan.last";
/** The payload documents' namespace: the view holds one plan at a time. */
const PLAN_ID = 1;

/** The rules a preview is about. */
export interface DeployTarget {
  readonly folder: string;
  readonly uuids: readonly string[];
  readonly files: readonly string[];
}

/** What a run was asked: the strategies, which rules, and perhaps one platform. */
export interface RunRequest {
  readonly strategies: readonly Strategy[];
  readonly scope: ScopeKind;
  readonly platform: string | null;
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
    const view = new DeployPlanView(ctx, payloads, diagnostics);

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
      await view.show(target);
    };
    const node = (arg: unknown) => view.nodeOf(arg);

    ctx.subscriptions.push(
      view,
      payloads,
      diagnostics,
      vscode.workspace.registerTextDocumentContentProvider(PAYLOAD_SCHEME, payloads),
      vscode.commands.registerCommand("opentide.deployPlan.open", (first?: unknown, second?: unknown) =>
        open(first, second),
      ),
      vscode.commands.registerCommand("opentide.deployPlan.openChanged", () =>
        open(undefined, undefined, true),
      ),
      vscode.commands.registerCommand("opentide.deployPlan.refresh", () => view.rerun()),
      vscode.commands.registerCommand("opentide.deployPlan.cancel", () => view.cancel()),
      vscode.commands.registerCommand("opentide.deployPlan.filter", () => view.chooseFilter()),
      vscode.commands.registerCommand("opentide.deployPlan.options", () => view.chooseOptions()),
      vscode.commands.registerCommand("opentide.deployPlan.openChange", (arg?: unknown) =>
        view.openChange(node(arg)),
      ),
      vscode.commands.registerCommand("opentide.deployPlan.openRule", (arg?: unknown) =>
        view.openRule(node(arg)),
      ),
      vscode.commands.registerCommand("opentide.deployPlan.copyRequest", (arg?: unknown) =>
        view.copyRequest(node(arg)),
      ),
      vscode.commands.registerCommand("opentide.deployPlan.openConfiguration", (arg?: unknown) =>
        view.openConfiguration(node(arg)),
      ),
      vscode.commands.registerCommand("opentide.deployPlan.copyDryRun", () => view.copy("dryRun")),
      vscode.commands.registerCommand("opentide.deployPlan.copyDeploy", () => view.copy("deploy")),
      vscode.commands.registerCommand("opentide.deployPlan.copyCiStep", () => view.copy("ci")),
    );
    // For the integration tests (ExtensionMode.Test): a plan document given instead of a dry run, and
    // what the view shows. Not contributed, so no menu or palette lists them.
    if (ctx.extension.extensionMode === vscode.ExtensionMode.Test)
      ctx.subscriptions.push(
        vscode.commands.registerCommand("opentide.deployPlan._load", (document: unknown, folder?: string) =>
          view.load(document, folder),
        ),
        vscode.commands.registerCommand("opentide.deployPlan._state", () => view.snapshot()),
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

type Phase = "idle" | "running" | "done" | "failed" | "cancelled";

/** The plan's tree view: one plan at a time, re-run in place, filtered by platform and tenant. */
class DeployPlanView implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly treeView: vscode.TreeView<TreeNode>;
  private readonly planner: DeployPlanner<
    { cancellation: vscode.CancellationToken; onProgress: (step: string) => void },
    Awaited<ReturnType<FeatureContext["backend"]["run"]>>
  >;
  private rules: DeployTarget | undefined;
  private request: RunRequest = { strategies: ["PREVIEW"], scope: "changed", platform: null };
  private phase: Phase = "idle";
  private plan: PlanView | null = null;
  private document: unknown;
  private filter: PlanFilter = {};
  private tree: PlanTree | undefined;
  private note: string | null = null;
  private progress: string | null = null;
  private failure: string | null = null;
  private cts: vscode.CancellationTokenSource | undefined;
  private runId = 0;

  constructor(
    private readonly ctx: FeatureContext,
    private readonly payloads: PayloadDocuments,
    private readonly diagnostics: vscode.DiagnosticCollection,
  ) {
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
    this.treeView = vscode.window.createTreeView<TreeNode>(VIEW_ID, {
      treeDataProvider: this,
      showCollapseAll: true,
    });
  }

  // --- the tree ---

  getChildren(element?: TreeNode): TreeNode[] {
    return [...(element ? element.children : (this.tree?.roots ?? []))];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : node.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = node.id;
    if (node.description !== undefined) item.description = node.description;
    if (node.tooltip !== undefined) item.tooltip = node.tooltip;
    item.iconPath = new vscode.ThemeIcon(
      node.icon.id,
      node.icon.color ? new vscode.ThemeColor(node.icon.color) : undefined,
    );
    item.contextValue = node.context;
    if (node.kind === "change" && node.payloadKey)
      item.command = { command: "opentide.deployPlan.openChange", title: "Open", arguments: [node] };
    return item;
  }

  /** A command's argument: the tree node, or its id (the tests). */
  nodeOf(arg: unknown): TreeNode | undefined {
    if (typeof arg === "string") return this.tree?.byId.get(arg);
    return typeof arg === "object" && arg !== null && "id" in arg && "kind" in arg
      ? (arg as TreeNode)
      : undefined;
  }

  private refreshView(): void {
    this.tree = this.plan ? planTree(this.plan, this.filter) : undefined;
    const changes = this.tree?.changes ?? 0;
    this.treeView.badge =
      this.plan && changes > 0
        ? { value: changes, tooltip: `${changes} change${changes === 1 ? "" : "s"} in the plan` }
        : undefined;
    this.treeView.description = this.rules ? this.describeRules() : undefined;
    this.treeView.message = this.message();
    this.changed.fire(undefined);
  }

  private message(): string | undefined {
    if (this.phase === "running") return `Planning…${this.progress ? ` ${this.progress}` : ""}`;
    if (this.phase === "failed") return `The preview failed: ${this.failure ?? "unknown error"}`;
    const lines: string[] = [];
    if (this.plan) lines.push(planMessage(this.plan, this.request.strategies, this.filter));
    if (this.phase === "cancelled")
      lines.unshift(
        this.plan
          ? "Cancelled; the plan shown is the previous one."
          : "Cancelled. Preview again to plan the deploy.",
      );
    if (this.note) lines.push(this.note);
    return lines.length > 0 ? lines.join(" ") : undefined;
  }

  private describeRules(): string {
    const rules = this.rules;
    if (!rules) return "";
    const what = this.selectionLabel() ?? (this.request.scope === "all" ? "all rules" : "changed rules");
    return `${path.basename(rules.folder)} · ${what}`;
  }

  private async setContext(running: boolean, hasPlan: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", "opentide.deployPlan.running", running);
    await vscode.commands.executeCommand("setContext", "opentide.deployPlan.hasPlan", hasPlan);
  }

  // --- running ---

  private get canSelect(): boolean {
    return (
      this.ctx.capabilities.hasOption("deploy", "--uuid") &&
      this.ctx.capabilities.hasOption("deploy", "--file")
    );
  }

  /** Preview these rules: the view opens (the plan tab appears), and a dry run starts. */
  async show(target: DeployTarget): Promise<void> {
    const retargeted = JSON.stringify(target) !== JSON.stringify(this.rules);
    this.rules = target;
    if (retargeted) this.forgetPlan();
    await vscode.commands.executeCommand("setContext", "opentide.deployPlan.active", true);
    const last = this.ctx.extension.workspaceState.get<{
      strategies?: Strategy[];
      scope?: ScopeKind;
      platform?: string;
    }>(LAST_KEY);
    const selected = target.uuids.length + target.files.length > 0;
    const scope: ScopeKind = selected ? "selected" : last?.scope === "all" ? "all" : "changed";
    // The view comes forward; the dry run continues in it.
    void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.run({
      strategies: last?.strategies?.length ? last.strategies : ["PREVIEW"],
      scope,
      platform: last?.platform ?? null,
    });
  }

  /** Run the last request again (the toolbar's refresh, the context menu's "Run the dry run again"). */
  async rerun(): Promise<void> {
    if (!this.rules) {
      void vscode.window.showInformationMessage("Preview a deploy first: opentide: Preview Deploy.");
      return;
    }
    await this.run(this.request);
  }

  cancel(): void {
    this.cts?.cancel();
  }

  /** Another set of rules: their plan, payloads and Problems entries are not the previous rules'. */
  private forgetPlan(): void {
    this.plan = null;
    this.document = undefined;
    this.filter = {};
    this.failure = null;
    this.payloads.clear(PLAN_ID);
    this.diagnostics.clear();
  }

  /** The options for a scope; `selected` without `deploy --uuid` falls back to the changed rules. */
  private options(request: RunRequest): {
    options: DeployPlanOptions;
    scope: ScopeKind;
    note: string | null;
  } {
    const rules = this.rules ?? { folder: "", uuids: [], files: [] };
    const selected = rules.uuids.length + rules.files.length > 0;
    let scope = request.scope;
    let note: string | null = null;
    if (scope === "selected" && (!selected || !this.canSelect)) {
      if (selected)
        note =
          "Previewing one rule needs an opentide whose deploy has --uuid and --file. This plan shows the changed rules; choose All rules in the options to include every rule.";
      scope = "changed";
    }
    const deployScope: DeployScope =
      scope === "selected" ? { kind: "selected", uuids: rules.uuids, files: rules.files } : { kind: scope };
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
    const rules = this.rules;
    if (!rules) return null;
    const files = rules.files;
    const total = rules.uuids.length + files.length;
    if (total === 0) return null;
    if (total === 1) {
      const uuid = rules.uuids[0];
      const catalog = this.ctx.catalog.get(rules.folder).catalog;
      const byUuid = uuid && catalog ? findByUuid(catalog.objects, uuid)?.name : undefined;
      const byFile = files[0] ? catalog?.objects.find((o) => o.path === files[0])?.name : undefined;
      return byUuid ?? byFile ?? (files[0] ? path.basename(files[0]) : (uuid ?? ""));
    }
    return `${total} rules`;
  }

  async run(request: RunRequest): Promise<void> {
    const rules = this.rules;
    if (!rules) return;
    // Whether `deploy --uuid` exists is known once the command tree loaded.
    await this.ctx.capabilities.ready();
    this.cts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    const id = ++this.runId;
    const { options, scope, note } = this.options(request);
    this.request = { ...request, scope };
    this.note = note;
    void this.ctx.extension.workspaceState.update(LAST_KEY, {
      strategies: request.strategies,
      scope: request.scope === "selected" ? undefined : request.scope,
      platform: request.platform ?? undefined,
    });
    this.phase = "running";
    this.progress = null;
    this.failure = null;
    this.refreshView();
    await this.setContext(true, this.plan !== null);
    const startedAt = Date.now();
    try {
      const result = await this.planner.plan(rules.folder, options, {
        cancellation: cts.token,
        onProgress: (step) => {
          if (this.runId !== id) return;
          this.progress = step;
          this.treeView.message = this.message();
        },
      });
      if (this.runId !== id) return;
      if (result.cancelled) {
        // The cancelled envelope has no plan: the plan shown, its payloads and Problems stay.
        this.phase = "cancelled";
      } else {
        const plan = planView(result.document);
        const unusable =
          result.exitCode === 2 ||
          (result.exitCode !== 0 && plan.platforms.length === 0 && plan.unmatched.length === 0);
        this.apply(result.document, plan);
        if (unusable) {
          this.phase = "failed";
          this.failure = result.document.failure?.message ?? result.document.message;
          void this.reportFailure(result.document.failure?.code ?? "failed", this.failure);
        }
        this.ctx.log.info(`deploy plan: ${displayArgv(dryRunArgv(options))} (${Date.now() - startedAt} ms)`);
      }
    } catch (error) {
      if (this.runId !== id) return;
      this.phase = "failed";
      this.failure = error instanceof Error ? error.message : String(error);
      void this.reportFailure(error instanceof BackendError ? error.code : "error", this.failure);
    } finally {
      if (this.cts === cts) this.cts = undefined;
      cts.dispose();
    }
    this.refreshView();
    await this.setContext(false, this.plan !== null);
  }

  /** Take a plan document as the plan shown (a finished run, or a test's). */
  private apply(document: unknown, plan: PlanView): void {
    this.plan = plan;
    this.document = document;
    this.phase = "done";
    this.failure = null;
    this.payloads.replace(PLAN_ID, payloadDocuments(document));
    this.publishDiagnostics(plan);
  }

  private async reportFailure(code: string, message: string): Promise<void> {
    const choice = await vscode.window.showErrorMessage(
      `The deploy preview failed (${code}): ${message}`,
      "Show Output",
      "Switch Runtime…",
    );
    if (choice === "Show Output") this.ctx.log.show();
    else if (choice === "Switch Runtime…") await vscode.commands.executeCommand("opentide.switchRuntime");
  }

  /** For the tests: show this plan document as if a dry run returned it. */
  async load(document: unknown, folder?: string): Promise<unknown> {
    this.rules ??= { folder: folder ?? this.ctx.folders.all[0]?.path ?? "", uuids: [], files: [] };
    await vscode.commands.executeCommand("setContext", "opentide.deployPlan.active", true);
    this.apply(document, planView(document));
    this.refreshView();
    await this.setContext(false, true);
    return this.snapshot();
  }

  /** For the tests: what the view shows. */
  snapshot(): unknown {
    const rows = (nodes: readonly TreeNode[]): unknown[] =>
      nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        label: n.label,
        description: n.description,
        context: n.context,
        children: rows(n.children),
      }));
    return {
      phase: this.phase,
      message: this.treeView.message ?? null,
      badge: this.treeView.badge?.value ?? 0,
      changes: this.tree?.changes ?? 0,
      roots: rows(this.tree?.roots ?? []),
    };
  }

  private publishDiagnostics(plan: PlanView): void {
    this.diagnostics.clear();
    const folder = this.rules?.folder ?? "";
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of plan.diagnostics) {
      const file = d.filePath ?? (d.path ? path.join(folder, d.path) : undefined);
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

  // --- choices ---

  /** The toolbar's filter: all, one platform, or one tenant of one. */
  async chooseFilter(): Promise<void> {
    if (!this.plan) {
      void vscode.window.showInformationMessage("There is no plan to filter yet.");
      return;
    }
    const choices = filterChoices(this.plan);
    type Item = vscode.QuickPickItem & { filter: PlanFilter };
    const items: Item[] = [{ label: "$(clear-all) All platforms and tenants", filter: {} }];
    for (const platform of choices.platforms) {
      items.push({ label: platform, description: "platform", filter: { platform } });
      for (const t of choices.tenants.filter((c) => c.platform === platform))
        items.push({
          label: `${platform} / ${t.tenant ?? "no tenant"}`,
          description: "tenant",
          filter: { platform, tenant: t.tenant },
        });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: "Filter the deploy plan",
      placeHolder: "Show one platform, or one tenant of it",
    });
    if (!picked) return;
    this.filter = picked.filter;
    this.refreshView();
  }

  /** The strategies, which rules and which platform of the next run, one picker each. */
  async chooseOptions(): Promise<void> {
    if (!this.rules) {
      void vscode.window.showInformationMessage("Preview a deploy first: opentide: Preview Deploy.");
      return;
    }
    await this.ctx.capabilities.ready();
    const selected = this.rules.uuids.length + this.rules.files.length > 0;
    type Scope = vscode.QuickPickItem & { scope: ScopeKind };
    const scopes: Scope[] = [
      { label: "Changed rules", description: "the CLI's default, from the git diff", scope: "changed" },
      { label: "All rules", description: "--all", scope: "all" },
      ...(selected && this.canSelect
        ? [
            {
              label: this.selectionLabel() ?? "Selected rules",
              description: "--uuid / --file",
              scope: "selected" as const,
            },
          ]
        : []),
    ];
    const scope = await vscode.window.showQuickPick(
      scopes.map((s) => ({ ...s, picked: s.scope === this.request.scope })),
      { title: "Deploy plan: which rules", placeHolder: "The rules the dry run plans" },
    );
    if (!scope) return;
    type Strat = vscode.QuickPickItem & { strategy: Strategy };
    const strategies = await vscode.window.showQuickPick<Strat>(
      (["PREVIEW", "RELEASE"] as const).map((strategy) => ({
        label: strategy,
        strategy,
        picked: this.request.strategies.includes(strategy),
      })),
      { title: "Deploy plan: strategies", placeHolder: "The rule statuses to plan", canPickMany: true },
    );
    if (!strategies) return;
    type Plat = vscode.QuickPickItem & { platform: string | null };
    const platform = await vscode.window.showQuickPick<Plat>(
      [
        { label: "All platforms", platform: null },
        ...PLATFORMS.map((p) => ({ label: platformName(p).long, description: p, platform: p })),
      ],
      { title: "Deploy plan: platform", placeHolder: "Plan one platform, or all of them" },
    );
    if (!platform) return;
    await this.run({
      strategies: strategies.length > 0 ? strategies.map((s) => s.strategy) : ["PREVIEW"],
      scope: scope.scope,
      platform: platform.platform,
    });
  }

  // --- a change ---

  /** A change: a diff of what is deployed and what the plan would send, else the request alone. */
  async openChange(node: TreeNode | undefined): Promise<void> {
    const key = node?.payloadKey;
    if (!key) return;
    const request = this.payloads.uri(PLAN_ID, key, "request");
    const deployed = this.payloads.uri(PLAN_ID, key, "deployed");
    if (deployed && request) {
      await vscode.commands.executeCommand(
        "vscode.diff",
        deployed,
        request,
        `${this.payloads.name(PLAN_ID, key)}: deployed ↔ planned`,
        { preview: true },
      );
    } else if (request) {
      const document = await vscode.workspace.openTextDocument(request);
      await vscode.window.showTextDocument(document, { preview: true });
    } else {
      void vscode.window.showInformationMessage(
        "This change has no request to show: the rule did not compile.",
      );
    }
  }

  async openRule(node: TreeNode | undefined): Promise<void> {
    const rules = this.rules;
    const ref = node?.uuid;
    if (!rules || !ref) return;
    const catalog = this.ctx.catalog.get(rules.folder).catalog;
    const object = catalog ? findByUuid(catalog.objects, ref) : undefined;
    const file =
      object?.file_path ??
      node?.file ??
      this.plan?.platforms.flatMap((p) => p.payloads).find((p) => p.uuid === ref)?.file ??
      this.plan?.diagnostics.find((d) => d.uuid === ref)?.filePath ??
      undefined;
    if (!file) {
      void vscode.window.showInformationMessage("The rule's file is not known until the catalogue loads.");
      return;
    }
    const line = Math.max(0, (object?.line ?? 1) - 1);
    await vscode.window.showTextDocument(
      vscode.Uri.file(path.isAbsolute(file) ? file : path.join(rules.folder, file)),
      {
        selection: new vscode.Range(line, 0, line, 0),
        preview: true,
      },
    );
  }

  async copyRequest(node: TreeNode | undefined): Promise<void> {
    const key = node?.payloadKey;
    const request = key ? this.payloads.uri(PLAN_ID, key, "request") : undefined;
    if (!request) {
      void vscode.window.showInformationMessage("This change has no request to copy.");
      return;
    }
    const document = await vscode.workspace.openTextDocument(request);
    await vscode.env.clipboard.writeText(document.getText());
    vscode.window.setStatusBarMessage("$(check) Copied the request", 2500);
  }

  async openConfiguration(node: TreeNode | undefined): Promise<void> {
    const platform = node?.platform;
    const rules = this.rules;
    if (!platform || !rules || !/^[a-z_]+$/.test(platform)) return;
    const file = path.join(rules.folder, ".opentide", "configurations", "platforms", `${platform}.toml`);
    if (fs.existsSync(file)) await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  async copy(what: "dryRun" | "deploy" | "ci"): Promise<void> {
    if (!this.rules) {
      void vscode.window.showInformationMessage("Preview a deploy first: opentide: Preview Deploy.");
      return;
    }
    const { options } = this.options(this.request);
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
    const folder = this.rules?.folder ?? "";
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

  /** For tests: the last plan's document. */
  get lastDocument(): unknown {
    return this.document;
  }

  dispose(): void {
    this.cts?.cancel();
    this.changed.dispose();
    this.treeView.dispose();
    this.diagnostics.clear();
    this.payloads.clear(PLAN_ID);
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

/** A warning with buttons, as `ensureSaved` asks. */
function warn(message: string, ...items: string[]): Thenable<string | undefined> {
  return vscode.window.showWarningMessage(message, ...items);
}
