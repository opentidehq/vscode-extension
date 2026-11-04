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
