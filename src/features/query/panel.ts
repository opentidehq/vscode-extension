// The query results panel's host side: runs `opentide query`, streams tenant progress, and keeps the
// rows in memory only (SPEC §10.4 privacy).
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { BackendError } from "../../core/backend/types";
import type { FeatureContext, OpentideFolder } from "../../core/context";
import { displayArgv } from "../../core/runtime/env";
import type { OpentidePanel } from "../../core/webview/panel";
import { MAX_LIMIT, type QueryOptions, queryArgv, sourceKey, tenantChoices, windowLabel } from "./argv";
import { platformLabel, tenantPhrase } from "./lenses";
import { hostValidators, type QueryPanelState, type QueryProtocol } from "./protocol";
import {
  applyProgress,
  choosingState,
  keepable,
  pendingTabs,
  progressFromEvent,
  tabsFromDocument,
} from "./results";

/** One run's inputs: what to send, and where. */
export interface RunSpec {
  readonly folder: OpentideFolder;
  readonly options: QueryOptions;
  readonly title: string;
  readonly writesPreviewAlerts: boolean;
}

export interface PanelHooks {
  /** Ask for tenants again (the CLI's exit-2 `choices`); undefined when dismissed. */
  pickTenants(spec: RunSpec, choices: readonly string[]): Promise<readonly string[] | undefined>;
  /** "Tenants and window…": a new spec, or undefined when dismissed. */
  edit(spec: RunSpec): Promise<RunSpec | undefined>;
  /** A failure's next action (`configure`, `trust`, …). */
  action(spec: RunSpec, code: string): Promise<void>;
}

export function retainResults(): boolean {
  return vscode.workspace.getConfiguration("opentide.query").get<boolean>("retainResults", false) === true;
}

/** The open results panels, one per query and platform. */
export class QueryPanels implements vscode.Disposable {
  private readonly open = new Map<string, QueryPanel>();
  /** `opentide.query.retainResults`: the last state of closed panels, in memory, for this session. */
  private readonly retained = new Map<string, { spec: RunSpec; state: QueryPanelState }>();

  constructor(
    private readonly ctx: FeatureContext,
    private readonly hooks: PanelHooks,
  ) {}

  /**
   * Show the panel for `spec` and run it. With `opentide.query.retainResults`, a query whose panel was
   * closed this session reopens with its last results instead (Re-run runs it again).
   */
  run(spec: RunSpec): void {
    const key = sourceKey(spec.options.platform, spec.options.source);
    const existing = this.open.get(key);
    if (existing) {
      existing.reveal();
      void existing.execute(spec);
      return;
    }
    const retained = retainResults() ? this.retained.get(key) : undefined;
    const kept = keepable(retained?.state) ? retained : undefined;
    this.retained.delete(key);
    const panel: QueryPanel = new QueryPanel(
      this.ctx,
      this.hooks,
      kept?.spec ?? spec,
      () => {
        this.open.delete(key);
        if (retainResults() && keepable(panel.state))
          this.retained.set(key, { spec: panel.spec, state: panel.state });
      },
      kept?.state,
    );
    this.open.set(key, panel);
    if (!kept) void panel.execute(spec);
  }

  /** Whether a query has results kept from a closed panel. */
  hasRetained(spec: RunSpec): boolean {
    return retainResults() && this.retained.has(sourceKey(spec.options.platform, spec.options.source));
  }

  /** Drop every kept result (the setting was turned off). */
  dropRetained(): void {
    this.retained.clear();
  }

  /** Whether any panel is open (tests and the retain setting). */
  get size(): number {
    return this.open.size;
  }

  dispose(): void {
    for (const panel of [...this.open.values()]) panel.dispose();
    this.open.clear();
    this.retained.clear();
  }
}

class QueryPanel implements vscode.Disposable {
  private readonly view: OpentidePanel<QueryProtocol>;
  private readonly disposables: vscode.Disposable[] = [];
  private cts: vscode.CancellationTokenSource | undefined;
  private disposed = false;
  state: QueryPanelState | undefined;

  constructor(
    private readonly ctx: FeatureContext,
    private readonly hooks: PanelHooks,
    public spec: RunSpec,
    onDispose: () => void,
    initial?: QueryPanelState,
  ) {
    this.state = initial;
    this.view = ctx.webview.createPanel<QueryProtocol>({
      viewType: "opentide.query",
      title: `Query: ${spec.title}`,
      entry: "query",
      validators: hostValidators,
      // Rows are re-sent when the panel shows again; nothing lives in webview state.
      retainContextWhenHidden: false,
    });
    const { channel, panel } = this.view;
    this.disposables.push(
      channel.on("ready", () => this.post()),
      channel.on("cancel", () => this.cts?.cancel()),
      channel.on("rerun", (payload) =>
        this.execute(payload?.limit ? withLimit(this.spec, payload.limit) : this.spec),
      ),
      channel.on("edit", async () => {
        const next = await this.hooks.edit(this.spec);
        if (next) await this.execute(next);
      }),
      channel.on("copy", async ({ format, text }) => {
        await vscode.env.clipboard.writeText(text);
        const what =
          format === "cell"
            ? "cell"
            : format === "row"
              ? "row"
              : `rows as ${format === "markdown" ? "Markdown" : format.toUpperCase()}`;
        vscode.window.setStatusBarMessage(`$(check) Copied ${what}`, 2500);
      }),
      channel.on("export", ({ format, text, name }) => this.export(format, text, name)),
      channel.on("action", async (code) => {
        if (code === "output") this.ctx.log.show();
        else await this.hooks.action(this.spec, code);
      }),
      panel.onDidDispose(() => {
        this.disposed = true;
        this.cts?.cancel();
        this.cts?.dispose();
        for (const d of this.disposables) d.dispose();
        onDispose();
        // Drop the rows: nothing keeps them unless the retain setting copied the state first.
        this.state = undefined;
      }),
    );
  }

  reveal(): void {
    this.view.panel.reveal(undefined, false);
  }

  private post(): void {
    if (this.state) void this.view.channel.post("state", this.state);
  }

  async execute(spec: RunSpec): Promise<void> {
    this.cts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.cts = cts;
    this.spec = spec;
    const { folder, options } = spec;
    const argv = queryArgv(options);
    const tenants = options.tenants?.filter((t) => t !== "all") ?? [];
    const contacts = options.tenants?.includes("all")
      ? `every ${platformLabel(options.platform)} tenant`
      : tenants.length > 0
        ? tenantPhrase(tenants)
        : `the ${platformLabel(options.platform)} tenant`;
    const startedAt = Date.now();
    this.state = {
      title: spec.title,
      platform: platformLabel(options.platform),
      windowLabel: windowLabel(options.window),
      limit: options.limit,
      maxLimit: MAX_LIMIT,
      contacts,
      phase: "running",
      startedAt,
      durationMs: null,
      argvDisplay: displayArgv(argv),
      message: "",
      failure: null,
      tabs: pendingTabs(tenants),
      writesPreviewAlerts: spec.writesPreviewAlerts,
      cancelMayLeaveSearch: process.platform === "win32",
      query: options.source.kind === "text" ? options.source.text : null,
    };
    this.view.panel.title = `Query: ${spec.title}`;
    this.post();
    try {
      const result = await this.ctx.backend.run(folder.path, argv, {
        cancellation: cts.token,
        onProgress: (event) => {
          const progress = progressFromEvent(event);
          if (!progress || this.cts !== cts || !this.state) return;
          // Kept in the host's state too: a panel shown again gets the chips as they are, not "running…".
          this.state = { ...this.state, tabs: applyProgress(this.state.tabs, progress) };
          void this.view.channel.post("progress", progress);
        },
      });
      if (this.cts !== cts || this.disposed || !this.state) return;
      const document = result.document;
      const choices = result.cancelled ? undefined : tenantChoices(document);
      if (choices) {
        // The picker opens now: the panel says so, instead of "Running…" with a timer and a Cancel.
        this.state = choosingState(this.state, result.durationMs);
        this.post();
        const picked = await this.hooks.pickTenants(spec, choices);
        // While the picker was open the panel may have closed, or a Re-run or a new spec started a
        // newer run: this one is over, and neither runs again nor overwrites that run's state.
        if (this.disposed || this.cts !== cts || !this.state) return;
        if (picked) return this.execute({ ...spec, options: { ...options, tenants: picked } });
      }
      const tabs = tabsFromDocument(document);
      const failed = result.exitCode !== 0 && tabs.length === 0;
      this.state = {
        ...this.state,
        argvDisplay: result.argvDisplay,
        phase: result.cancelled ? "cancelled" : failed ? "failed" : "done",
        durationMs: result.durationMs,
        message: result.cancelled ? "Cancelled" : document.message,
        tabs,
        query: typeof document.query === "string" ? document.query : this.state.query,
        failure: result.cancelled
          ? { code: "cancelled", message: "Cancelled. Nothing was kept." }
          : failed
            ? {
                code: document.failure?.code ?? "failed",
                message: document.message,
                ...(failureAction(document.failure?.code, document.failure?.argument) ?? {}),
              }
            : null,
      };
    } catch (error) {
      if (this.cts !== cts || this.disposed || !this.state) return;
      const code = error instanceof BackendError ? error.code : "error";
      this.state = {
        ...this.state,
        phase: "failed",
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        failure: {
          code,
          message: error instanceof Error ? error.message : String(error),
          ...(code === "untrusted" ? { action: "Trust this folder…" } : {}),
        },
      };
    } finally {
      if (this.cts === cts) {
        this.cts = undefined;
        cts.dispose();
      }
    }
    this.post();
  }

  private async export(format: "csv" | "jsonl", text: string, name: string): Promise<void> {
    const safe =
      `${this.spec.title}-${name}`.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "results";
    const target = await vscode.window.showSaveDialog({
      title: "Export query results",
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `${safe}.${format}`)),
      filters: format === "csv" ? { CSV: ["csv"] } : { "JSON Lines": ["jsonl"] },
      saveLabel: "Export",
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    const open = await vscode.window.showInformationMessage(
      `Exported to ${target.fsPath}. It may hold personal data.`,
      "Open",
    );
    if (open) await vscode.window.showTextDocument(target);
  }

  dispose(): void {
    this.view.dispose();
  }
}

function withLimit(spec: RunSpec, limit: number): RunSpec {
  return { ...spec, options: { ...spec.options, limit: Math.min(MAX_LIMIT, limit) } };
}

/** What a whole-run failure offers next. */
export function failureAction(
  code: string | undefined,
  argument: string | null | undefined,
): { action: string } | undefined {
  if (code === "usage_invalid_value" && argument === "--tenant") return { action: "Configure tenants…" };
  if (code === "usage_invalid_value" && argument === "--platform")
    return { action: "Open platform configuration" };
  return undefined;
}
