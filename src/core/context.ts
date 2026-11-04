// FeatureContext: everything the core gives a feature. docs/ARCHITECTURE.md documents it.
import type * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type { ActivityLog } from "./activity";
import type { Backend } from "./backend/backend";
import type { Capabilities } from "./capabilities/capabilities";
import type { CatalogStore } from "./catalog/store";
import type { CredentialStore } from "./credentials";
import type { CatalogChanged } from "./lsp";
import type { CliSpan } from "./positions";
import type { RepoPin } from "./runtime/pins";
import type { ResolveAttempt, Runtime } from "./runtime/types";
import type { ProblemCounts } from "./statusText";
import type { Event } from "./util/event";
import type { WebviewHelpers } from "./webview/panel";

export interface Logger {
  /** The `opentide` output channel (a LogOutputChannel). */
  readonly channel: vscode.LogOutputChannel;
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string | Error): void;
  /** Reveal the output channel. */
  show(): void;
}

export interface RuntimeService {
  /** The active runtime; undefined while resolving the first time, and when there is none. */
  readonly current: Runtime | undefined;
  /** How the last resolution went, tier by tier. */
  readonly attempts: readonly ResolveAttempt[];
  /** The primary folder's opentide pin, if the repository pins one. */
  readonly pin: RepoPin | undefined;
  /** Fires after each resolution (also when the runtime stays the same object: compare `current`). */
  readonly onDidChange: Event<Runtime | undefined>;
  /** Resolves once the first resolution finished. */
  ready(): Promise<Runtime | undefined>;
  /** Re-resolve the runtime and restart the language server and the backend ("opentide: Restart Server"). */
  restart(reason?: string): Promise<void>;
}

export interface LanguageClientService {
  /** The running client, or undefined (starting, stopped, no runtime). One per window. */
  readonly current: LanguageClient | undefined;
  /** `capabilities.experimental.opentide` from `initialize`, as the server sent it. */
  readonly serverInfo: OpentideServerInfo | undefined;
  /** Fires when a client finished starting (with it) or stopped (undefined). */
  readonly onDidChange: Event<LanguageClient | undefined>;
  /** The running client, waiting for a start in progress; undefined when none will run. */
  ready(): Promise<LanguageClient | undefined>;
  /**
   * The server's `opentide/catalogChanged` (a root's index changed; ask `opentide/catalog` again). Use
   * this, never `client.onNotification` for it: the client keeps one handler per notification.
   */
  readonly onCatalogChanged: Event<CatalogChanged>;
}

/** `capabilities.experimental.opentide` (language-server docs/EDITORS.md). */
export interface OpentideServerInfo {
  readonly host: { readonly name: string; readonly version: string } | null;
  readonly engine: string;
  readonly catalog: "host" | "workspace" | "bundled";
  readonly configurationChecks: boolean;
  readonly configurationSchemas: boolean;
  readonly [key: string]: unknown;
}

export interface TrustService {
  readonly isTrusted: boolean;
  /** Fires once when the user trusts the workspace (the core restarts on the best tier first). */
  readonly onDidGrant: Event<void>;
}

export interface OpentideFolder {
  readonly folder: vscode.WorkspaceFolder;
  /** `folder.uri.fsPath`: what `backend.run` and `catalog.get` take. */
  readonly path: string;
  /** Object folders from paths.toml, workspace-relative with a trailing slash, by kind. */
  readonly objectFolders: Readonly<Record<string, string>>;
}

export interface FolderService {
  /** Workspace folders with `.opentide/` or `objects/`, in workspace order. */
  readonly all: readonly OpentideFolder[];
  readonly onDidChange: Event<readonly OpentideFolder[]>;
  /** The opentide folder that contains `uri`. */
  folderOf(uri: vscode.Uri): OpentideFolder | undefined;
  /** The folder an action is about: the active editor's, else the only one, else ask. */
  pick(placeHolder?: string): Promise<OpentideFolder | undefined>;
  /** Is `uri` an object file (YAML under objects/ or a paths.toml object folder)? */
  isObjectFile(uri: vscode.Uri): boolean;
}

/** One problem-count source in the status bar (`opentide validate`, `opentide lint`, …). */
export type { ProblemCounts };

export interface StatusMenuItem {
  readonly label: string;
  readonly description?: string;
  readonly command: string;
  readonly args?: readonly unknown[];
  /** Lower first. Core items: Show output 100, Restart server 110, Switch runtime 120. */
  readonly order?: number;
}

export interface StatusService {
  /** Set the counts of one source; the status bar shows the sum of every source. */
  setCounts(source: string, counts: ProblemCounts | undefined): void;
  /** Add an entry to the status item's menu (Validate workspace, Run doctor, …). */
  addMenuItem(item: StatusMenuItem): vscode.Disposable;
}

/** CLI positions (1-based, code points) to editor positions (0-based, UTF-16), against a document. */
export interface PositionHelpers {
  toPosition(document: vscode.TextDocument, line1: number, column1?: number | null): vscode.Position;
  toRange(document: vscode.TextDocument, span: CliSpan): vscode.Range;
}

/** File changes under the opentide folders' object folders and `.opentide/`, batched. */
export interface FileChangeEvent {
  readonly folder: OpentideFolder;
  readonly uris: readonly vscode.Uri[];
}

export interface FeatureContext {
  readonly extension: vscode.ExtensionContext;
  /** Push disposables here; they are disposed when the extension deactivates. */
  readonly subscriptions: vscode.Disposable[];
  readonly log: Logger;
  readonly runtime: RuntimeService;
  readonly backend: Backend;
  readonly capabilities: Capabilities;
  readonly client: LanguageClientService;
  readonly catalog: CatalogStore;
  readonly activity: ActivityLog;
  readonly credentials: CredentialStore;
  readonly trust: TrustService;
  readonly folders: FolderService;
  readonly status: StatusService;
  readonly positions: PositionHelpers;
  readonly webview: WebviewHelpers;
  /** Object and configuration file changes (created, changed, deleted), debounced 300 ms. */
  readonly onDidChangeFiles: Event<FileChangeEvent>;
}
