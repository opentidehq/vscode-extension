// The Relations view's bookkeeping, apart from VS Code: what it caches of the language server's index,
// and when it fetches again. vscode-free.
import type { ServerCatalog } from "../../core/catalog/serverCatalog";

/** What one `opentide/catalog` request came to. */
export type ServerFetch =
  | { readonly kind: "ok"; readonly catalog: ServerCatalog }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * One `opentide/catalog` answer per client, until the index changes or the client does. A failure is
 * not kept: the next render (a Retry) asks again.
 */
export class ServerCatalogCache<C> {
  private entry: { client: C; promise: Promise<ServerFetch> } | undefined;

  /** The client's answer, fetching it if there is none for this client. */
  get(client: C, fetch: () => Promise<ServerFetch>): Promise<ServerFetch> {
    if (this.entry?.client === client) return this.entry.promise;
    const entry = { client, promise: fetch() };
    this.entry = entry;
    void entry.promise.then((result) => {
      if (result.kind === "failed" && this.entry === entry) this.entry = undefined;
    });
    return entry.promise;
  }

  /** Whether an answer is kept (or on its way). */
  get held(): boolean {
    return this.entry !== undefined;
  }

  /** Forget the answer: the index or the client changed, or the user asked to retry. */
  drop(): void {
    this.entry = undefined;
  }
}

/**
 * The view follows the active editor, but not to an object one of its own rows just opened. A row
 * opening a file that is already active in that group changes no editor, so nothing is left to skip.
 */
export class FollowGuard {
  private opening: string | undefined;
  private changes = 0;

  /** The active editor changed (`onDidChangeActiveTextEditor`, before any debounce). */
  editorChanged(): void {
    this.changes += 1;
  }

  /** A row starts opening `file`; pass the token to `opened` when the editor shows it. */
  open(file: string): number {
    this.opening = file;
    return this.changes;
  }

  /** The row's editor shows; if no editor change came of it, there is none to skip. */
  opened(token: number): void {
    if (this.changes === token) this.opening = undefined;
  }

  /** Whether to follow the editor that now shows `file`. */
  shouldFollow(file: string): boolean {
    const skip = this.opening === file;
    this.opening = undefined;
    return !skip;
  }
}
