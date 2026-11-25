// Webview helpers for features that need a panel (SPEC §10): strict CSP with a nonce, local resources
// only from dist/webview, the shared base CSS, and a typed, validated message channel.
import { performance } from "node:perf_hooks";

import * as vscode from "vscode";

import { nonce, renderHtml } from "./html";
import { pickResult, pickToHost, quickPickEntries, type PickRequest, type QuickPickEntry } from "./pick";
import { placement } from "./placement";
import { acceptMessage, type Protocol, type Validators } from "./protocol";
import { LoadWatchdog, SILENT_PAGE_MS } from "./watchdog";

/** The host's end of a webview's message channel. */
export interface HostChannel<P extends Protocol> extends vscode.Disposable {
  post<K extends Extract<keyof P["toWebview"], string>>(
    type: K,
    payload: P["toWebview"][K],
  ): Thenable<boolean>;
  on<K extends Extract<keyof P["toHost"], string>>(
    type: K,
    handler: (payload: P["toHost"][K]) => void | Promise<void>,
  ): vscode.Disposable;
}

export interface PanelOptions<P extends Protocol> {
  /** `opentide.<feature>`; also the webview's `viewType`. */
  readonly viewType: string;
  readonly title: string;
  /** The webview entry: webview/<entry>/main.ts, bundled to dist/webview/<entry>.js. */
  readonly entry: string;
  /** Validates every message from the webview; invalid ones are dropped and logged. */
  readonly validators: Validators<P["toHost"]>;
  readonly column?: vscode.ViewColumn;
  readonly preserveFocus?: boolean;
  /**
   * A panel about an object: invoked from an editor, it opens beside it without taking the focus, so the
   * object stays in view (`column` and `preserveFocus` win when given).
   */
  readonly beside?: boolean;
  /** Link the panels kit (`kit.css`, the `ot-kit` page class): tokens, components, focus rings. */
  readonly kit?: boolean;
  readonly retainContextWhenHidden?: boolean;
  readonly enableFindWidget?: boolean;
}

export interface PageOptions {
  /** Link the panels kit stylesheet and give the body its class. */
  readonly kit?: boolean;
}

/** Where a panel about an object goes now: beside the active text editor, else the active group. */
export function objectPanelColumn(): { viewColumn: vscode.ViewColumn; preserveFocus: boolean } {
  const where = placement(vscode.window.activeTextEditor !== undefined);
  return where.beside
    ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: where.preserveFocus }
    : { viewColumn: vscode.ViewColumn.Active, preserveFocus: where.preserveFocus };
}

export interface OpentidePanel<P extends Protocol> extends vscode.Disposable {
  /**
   * The panel, as the core keeps it: if its page never runs, the core replaces the VS Code panel underneath with a new
   * one in the same place (watchdog.ts). Its title, reveal, view state and `onDidDispose` follow; `onDidDispose`
   * fires when the panel is closed, not when it is replaced.
   */
  readonly panel: vscode.WebviewPanel;
  /** The page's channel: its handlers stay when the panel is replaced, and hear the new page (which says `ready`). */
  readonly channel: HostChannel<P>;
}

/** What the webview last saved with `setState`, as VS Code hands it back after a reload; undefined if it saved none. */
export type SavedState = unknown;

/** The message every opentide page sends once it has loaded. */
interface ReadyProtocol extends Protocol {
  readonly toHost: { readonly ready: undefined };
  readonly toWebview: Record<string, never>;
}

/** A panel's page as the core sees it: whether it has loaded and said it is ready (its `ready` message). */
export interface PageState {
  readonly viewType: string;
  readonly ready: boolean;
  /** Which page this is, in the order the helpers wired them (the lifecycle names it). */
  readonly id: number;
  /** Every message the page sent, valid or not: none means its script never ran (or never reached the channel). */
  readonly messages: number;
  /** The type of the first message it sent, if any (the graph's is `log`: "script started"). */
  readonly firstType?: string;
}

/**
 * What happened to the pages, in order (for tests): a page wired, its first message, `ready`, its panel disposed.
 * It says whether a closed panel's dispose came before or after the next panel was wired, and whether a page that
 * never said `ready` sent anything at all.
 */
export interface PageEvent {
  readonly at: number;
  readonly id: number;
  readonly viewType: string;
  /** `recreated`: its page said nothing, and a new panel took its place (`detail` names the new page). */
  readonly event: "wired" | "first message" | "ready" | "recreated" | "disposed";
  readonly detail?: string;
}

export interface WebviewHelpers {
  /** Open a panel showing `entry`, wired to a validated channel. */
  createPanel<P extends Protocol>(options: PanelOptions<P>): OpentidePanel<P>;
  /**
   * Wire a panel VS Code made (one revived after a reload) as `createPanel` wires its own: the webview's options, its
   * page and the validated channel. The caller then sends what the page shows, as for a new panel.
   */
  adoptPanel<P extends Protocol>(panel: vscode.WebviewPanel, options: PanelOptions<P>): OpentidePanel<P>;
  /**
   * Bring back the panels of `options.viewType` after a window reload: VS Code keeps their place and, with
   * `setState`, the page's own state, but the extension host starts without them. `restore` gets each revived panel
   * wired (`adoptPanel`) and what the page saved. Register it when the feature activates, and add
   * `onWebviewPanel:<viewType>` to its activation events so a reload activates the extension for it.
   */
  registerPanelSerializer<P extends Protocol>(
    options: PanelOptions<P>,
    restore: (opened: OpentidePanel<P>, saved: SavedState) => void | Thenable<void>,
  ): vscode.Disposable;
  /** Only for tests: every panel opened or revived and not yet closed, with whether its page said it is ready. */
  readonly pages: ReadonlyMap<vscode.WebviewPanel, PageState>;
  /** Only for tests: the pages' lifecycle, in order (the last 200 events). */
  readonly lifecycle: readonly PageEvent[];
  /** Only for tests: what VS Code calls to revive a panel of a view type, by view type (a reload cannot be driven from a test). */
  readonly restorers: ReadonlyMap<string, (panel: vscode.WebviewPanel, saved: SavedState) => Thenable<void>>;
  /** The options every opentide webview uses: scripts on, resources only from dist/webview. */
  webviewOptions(): vscode.WebviewOptions;
  /** The page for `entry` with its CSP and nonce (for a WebviewView too). */
  html(webview: vscode.Webview, entry: string, title: string, options?: PageOptions): string;
  /** A channel over any webview (panel or view). */
  connect<P extends Protocol>(
    webview: vscode.Webview,
    validators: Validators<P["toHost"]>,
    /** Hears every message before it is validated (the core counts a page's messages, for tests). */
    onRaw?: (raw: unknown) => void,
  ): HostChannel<P>;
}

export function createWebviewHelpers(
  extensionUri: vscode.Uri,
  log: (message: string) => void,
  /** Tests only: how long a visible page may say nothing before its panel is replaced (watchdog.ts). */
  silentPageMs = SILENT_PAGE_MS,
): WebviewHelpers {
  const root = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const restorers = new Map<string, (panel: vscode.WebviewPanel, saved: SavedState) => Thenable<void>>();
  const pages = new Map<vscode.WebviewPanel, { -readonly [K in keyof PageState]: PageState[K] }>();
  const lifecycle: PageEvent[] = [];
  let nextPage = 1;
  const record = (page: PageState, event: PageEvent["event"], detail?: string): void => {
    lifecycle.push({
      at: performance.now(),
      id: page.id,
      viewType: page.viewType,
      event,
      ...(detail ? { detail } : {}),
    });
    if (lifecycle.length > 200) lifecycle.shift();
  };
  const helpers: WebviewHelpers = {
    restorers,
    pages,
    lifecycle,
    webviewOptions: () => ({ enableScripts: true, localResourceRoots: [root] }),
    html(webview, entry, title, options = {}) {
      if (!/^[a-z][a-z0-9-]*$/.test(entry)) throw new Error(`bad webview entry: ${entry}`);
      const asset = (...segments: string[]) =>
        webview.asWebviewUri(vscode.Uri.joinPath(root, ...segments)).toString();
      return renderHtml({
        cspSource: webview.cspSource,
        scriptUri: asset(`${entry}.js`),
        styleUri: asset("base.css"),
        // The codicon font ships in the extension (dist/webview/codicons), under the page's CSP.
        extraStyleUris: [asset("codicons", "codicon.css"), ...(options.kit ? [asset("kit.css")] : [])],
        ...(options.kit ? { bodyClass: "ot-kit" } : {}),
        title,
        nonce: nonce(),
      });
    },
    connect<P extends Protocol>(
      webview: vscode.Webview,
      validators: Validators<P["toHost"]>,
      onRaw?: (raw: unknown) => void,
    ): HostChannel<P> {
      return channelOver<P>(webview, validators, log, onRaw);
    },
    adoptPanel<P extends Protocol>(panel: vscode.WebviewPanel, options: PanelOptions<P>): OpentidePanel<P> {
      const live = new LivePanel(panel);
      // The page in the panel now (a replacement has its own), its lifecycle and the listeners on its VS Code panel.
      let page: { -readonly [K in keyof PageState]: PageState[K] };
      let wiring: vscode.Disposable[] = [];
      let closed = false;
      const channel = channelOver<P>(panel.webview, options.validators, log, (raw) => {
        watchdog.heard();
        page.messages += 1;
        if (page.messages === 1) {
          const type = (raw as { type?: unknown } | undefined)?.type;
          page.firstType = typeof type === "string" ? type : typeof raw;
          const payload = (raw as { payload?: unknown } | undefined)?.payload;
          record(
            page,
            "first message",
            `${page.firstType}${typeof payload === "string" ? `: ${payload}` : ""}`,
          );
        }
      });
      // Through the validated channel (no second listener on the page): every opentide page says `ready` once loaded.
      const loaded = (channel as unknown as HostChannel<ReadyProtocol>).on("ready", () => {
        page.ready = true;
        record(page, "ready");
      });
      /** Wire `current`: its options, its page, and the listeners that follow its view state and its close. */
      const wire = (current: vscode.WebviewPanel): void => {
        // A revived panel has no options of its own: scripts and resource roots are set again, as for a new one.
        current.webview.options = helpers.webviewOptions();
        current.webview.html = helpers.html(current.webview, options.entry, options.title, {
          kit: options.kit ?? false,
        });
        page = { viewType: options.viewType, ready: false, id: nextPage++, messages: 0 };
        pages.set(current, page);
        record(page, "wired");
        wiring = [
          current.onDidChangeViewState(() => {
            watchdog.visibilityChanged();
            live.viewStateChanged.fire({ webviewPanel: live });
          }),
          current.onDidDispose(() => close()),
        ];
      };
      const unwire = (current: vscode.WebviewPanel): void => {
        for (const listener of wiring) listener.dispose();
        wiring = [];
        pages.delete(current);
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        watchdog.dispose();
        loaded.dispose();
        channel.dispose();
        unwire(live.current);
        record(page, "disposed");
        live.closed();
      };
      // A page that says nothing while visible gets a new panel in its place, once (watchdog.ts: a VS Code webview
      // behaviour; setting its HTML again does not wake it). The new one opens before the silent one closes, in its
      // column, with its title: closing a page that is loading just before opening the next is what loses the page.
      const replace = (): void => {
        const silent = live.current;
        let next: vscode.WebviewPanel;
        try {
          next = vscode.window.createWebviewPanel(
            options.viewType,
            silent.title,
            { viewColumn: silent.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: !silent.active },
            {
              ...helpers.webviewOptions(),
              retainContextWhenHidden: options.retainContextWhenHidden ?? false,
              enableFindWidget: options.enableFindWidget ?? true,
            },
          );
        } catch (error) {
          // The silent panel stays as it is: no worse than before.
          log(`webview: could not open ${options.viewType} again: ${String(error)}`);
          return;
        }
        if (silent.iconPath) next.iconPath = silent.iconPath;
        const was = page;
        unwire(silent);
        live.current = next;
        channel.rebind(next.webview);
        wire(next);
        record(was, "recreated", `by #${page.id}`);
        silent.dispose();
      };
      const watchdog = new LoadWatchdog(
        options.viewType,
        {
          visible: () => live.current.visible,
          replace,
          log: (_level, message) => log(`webview: ${message}`),
        },
        silentPageMs,
      );
      wire(panel);
      return {
        panel: live,
        channel,
        dispose: () => {
          const current = live.current;
          close();
          current.dispose();
        },
      };
    },
    createPanel<P extends Protocol>(options: PanelOptions<P>): OpentidePanel<P> {
      const where = options.beside
        ? objectPanelColumn()
        : { viewColumn: vscode.ViewColumn.Active, preserveFocus: false };
      const panel = vscode.window.createWebviewPanel(
        options.viewType,
        options.title,
        {
          viewColumn: options.column ?? where.viewColumn,
          preserveFocus: options.preserveFocus ?? where.preserveFocus,
        },
        {
          ...helpers.webviewOptions(),
          retainContextWhenHidden: options.retainContextWhenHidden ?? false,
          enableFindWidget: options.enableFindWidget ?? true,
        },
      );
      return helpers.adoptPanel(panel, options);
    },
    registerPanelSerializer<P extends Protocol>(
      options: PanelOptions<P>,
      restore: (opened: OpentidePanel<P>, saved: SavedState) => void | Thenable<void>,
    ): vscode.Disposable {
      const deserialize = async (panel: vscode.WebviewPanel, saved: SavedState): Promise<void> => {
        const opened = helpers.adoptPanel<P>(panel, options);
        try {
          await restore(opened, saved);
        } catch (error) {
          // A panel that cannot be brought back is closed: the alternative is a blank page that never fills.
          log(`webview: could not restore ${options.viewType}: ${String(error)}`);
          opened.dispose();
        }
      };
      restorers.set(options.viewType, deserialize);
      const registered = vscode.window.registerWebviewPanelSerializer(options.viewType, {
        deserializeWebviewPanel: deserialize,
      });
      return new vscode.Disposable(() => {
        restorers.delete(options.viewType);
        registered.dispose();
      });
    },
  };
  return helpers;
}

/** A channel that can move to another webview (a replaced panel's), keeping its handlers. */
interface MovableChannel<P extends Protocol> extends HostChannel<P> {
  rebind(webview: vscode.Webview): void;
}

function channelOver<P extends Protocol>(
  first: vscode.Webview,
  validators: Validators<P["toHost"]>,
  log: (message: string) => void,
  onRaw?: (raw: unknown) => void,
): MovableChannel<P> {
  const handlers = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
  let webview = first;
  const listen = (target: vscode.Webview): vscode.Disposable =>
    target.onDidReceiveMessage((raw: unknown) => {
      onRaw?.(raw);
      // A pick from a list is answered here for every webview: VS Code's QuickPick, not a <select>.
      const pick = acceptMessage(raw, pickToHost);
      if (pick) {
        void answerPick(target, pick.payload as PickRequest, log);
        return;
      }
      const message = acceptMessage(raw, validators);
      if (!message) {
        log(`webview: dropped an invalid message ${JSON.stringify(raw)?.slice(0, 200)}`);
        return;
      }
      for (const handler of handlers.get(message.type) ?? []) {
        Promise.resolve(handler(message.payload)).catch((error: unknown) =>
          log(`webview handler failed: ${String(error)}`),
        );
      }
    });
  let subscription = listen(webview);
  return {
    post: (type, payload) => webview.postMessage({ type, payload }),
    on(type, handler) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      const entry = handler as (payload: unknown) => void | Promise<void>;
      set.add(entry);
      return new vscode.Disposable(() => set.delete(entry));
    },
    rebind(next) {
      subscription.dispose();
      webview = next;
      subscription = listen(next);
    },
    dispose: () => {
      subscription.dispose();
      handlers.clear();
    },
  };
}

/**
 * The panel a feature holds: VS Code's panel underneath can be replaced (when its page never runs), and this one
 * follows it. Its `onDidDispose` is the panel being closed, by the user or the feature, never the replacement.
 */
class LivePanel implements vscode.WebviewPanel {
  readonly disposed = new vscode.EventEmitter<void>();
  readonly viewStateChanged = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
  readonly onDidDispose = this.disposed.event;
  readonly onDidChangeViewState = this.viewStateChanged.event;

  constructor(public current: vscode.WebviewPanel) {}

  get viewType(): string {
    return this.current.viewType;
  }
  get title(): string {
    return this.current.title;
  }
  set title(value: string) {
    this.current.title = value;
  }
  get iconPath(): vscode.WebviewPanel["iconPath"] {
    return this.current.iconPath;
  }
  set iconPath(value: vscode.WebviewPanel["iconPath"]) {
    this.current.iconPath = value;
  }
  get webview(): vscode.Webview {
    return this.current.webview;
  }
  get options(): vscode.WebviewPanelOptions {
    return this.current.options;
  }
  get viewColumn(): vscode.ViewColumn | undefined {
    return this.current.viewColumn;
  }
  get active(): boolean {
    return this.current.active;
  }
  get visible(): boolean {
    return this.current.visible;
  }
  reveal(viewColumn?: vscode.ViewColumn, preserveFocus?: boolean): void {
    this.current.reveal(viewColumn, preserveFocus);
  }
  dispose(): void {
    this.current.dispose();
  }
  /** The panel was closed: say so once, then let go of the listeners. */
  closed(): void {
    this.disposed.fire();
    this.disposed.dispose();
    this.viewStateChanged.dispose();
  }
}

/** Show a webview's list in VS Code's QuickPick and post what was chosen (null when it was dismissed). */
async function answerPick(webview: vscode.Webview, request: PickRequest, log: (message: string) => void) {
  let result = pickResult(request, undefined);
  try {
    const options = {
      ...(request.title ? { title: request.title } : {}),
      ...(request.placeHolder ? { placeHolder: request.placeHolder } : {}),
      matchOnDescription: true,
      matchOnDetail: true,
    };
    const entries = quickPickEntries(request);
    const chosen = request.canPickMany
      ? await vscode.window.showQuickPick<QuickPickEntry>(entries, { ...options, canPickMany: true })
      : await vscode.window.showQuickPick<QuickPickEntry>(entries, options);
    result = pickResult(request, chosen);
  } catch (error) {
    log(`webview: the pick failed: ${String(error)}`);
  }
  await webview.postMessage({ type: "picked", payload: result });
}
