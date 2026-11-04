// Webview helpers for features that need a panel (SPEC §10): strict CSP with a nonce, local resources
// only from dist/webview, the shared base CSS, and a typed, validated message channel.
import * as vscode from "vscode";
import { nonce, renderHtml } from "./html";
import { placement } from "./placement";
import { acceptMessage, type Protocol, type Validators } from "./protocol";

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
  readonly panel: vscode.WebviewPanel;
  readonly channel: HostChannel<P>;
}

export interface WebviewHelpers {
  /** Open a panel showing `entry`, wired to a validated channel. */
  createPanel<P extends Protocol>(options: PanelOptions<P>): OpentidePanel<P>;
  /** The options every opentide webview uses: scripts on, resources only from dist/webview. */
  webviewOptions(): vscode.WebviewOptions;
  /** The page for `entry` with its CSP and nonce (for a WebviewView too). */
  html(webview: vscode.Webview, entry: string, title: string, options?: PageOptions): string;
  /** A channel over any webview (panel or view). */
  connect<P extends Protocol>(webview: vscode.Webview, validators: Validators<P["toHost"]>): HostChannel<P>;
}

export function createWebviewHelpers(
  extensionUri: vscode.Uri,
  log: (message: string) => void,
): WebviewHelpers {
  const root = vscode.Uri.joinPath(extensionUri, "dist", "webview");
  const helpers: WebviewHelpers = {
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
    ): HostChannel<P> {
      const handlers = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
      const subscription = webview.onDidReceiveMessage((raw: unknown) => {
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
        dispose: () => {
          subscription.dispose();
          handlers.clear();
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
      panel.webview.html = helpers.html(panel.webview, options.entry, options.title, {
        kit: options.kit ?? false,
      });
      const channel = helpers.connect<P>(panel.webview, options.validators);
      const disposeChannel = panel.onDidDispose(() => channel.dispose());
      return {
        panel,
        channel,
        dispose: () => {
          disposeChannel.dispose();
          channel.dispose();
          panel.dispose();
        },
      };
    },
  };
  return helpers;
}
