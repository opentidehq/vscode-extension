// Webview helpers for features that need a panel (SPEC §10): strict CSP with a nonce, local resources
// only from dist/webview, the shared base CSS, and a typed, validated message channel.
import * as vscode from "vscode";
import { nonce, renderHtml } from "./html";
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
  readonly retainContextWhenHidden?: boolean;
  readonly enableFindWidget?: boolean;
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
  html(webview: vscode.Webview, entry: string, title: string): string;
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
    html(webview, entry, title) {
      if (!/^[a-z][a-z0-9-]*$/.test(entry)) throw new Error(`bad webview entry: ${entry}`);
      return renderHtml({
        cspSource: webview.cspSource,
        scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(root, `${entry}.js`)).toString(),
        styleUri: webview.asWebviewUri(vscode.Uri.joinPath(root, "base.css")).toString(),
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
      const panel = vscode.window.createWebviewPanel(
        options.viewType,
        options.title,
        {
          viewColumn: options.column ?? vscode.ViewColumn.Active,
          preserveFocus: options.preserveFocus ?? false,
        },
        {
          ...helpers.webviewOptions(),
          retainContextWhenHidden: options.retainContextWhenHidden ?? false,
          enableFindWidget: options.enableFindWidget ?? true,
        },
      );
      panel.webview.html = helpers.html(panel.webview, options.entry, options.title);
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
