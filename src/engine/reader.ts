// How the engine's workspace feed reads a file. vscode-free and free of Node built-ins (the web extension shares the feed).

/** A file's bytes. */
export type ReadBytes<U> = (uri: U) => PromiseLike<Uint8Array>;

/**
 * A reader that reads `file:` files straight from the disk and everything else through the host. The host's
 * `workspace.fs.readFile` is one round trip to the editor's main process per file; for a thousand files that was most of
 * the engine's 1.1-1.6 s start-up. Only on desktop is `file:` the extension host's own file system (also in a remote
 * window, where the extension host runs beside the files); a virtual file system has another scheme and goes through the host.
 */
export function directThenHost<U extends { readonly scheme: string; readonly fsPath: string }>(
  direct: (fsPath: string) => PromiseLike<Uint8Array>,
  host: ReadBytes<U>,
): ReadBytes<U> {
  return (uri) => (uri.scheme === "file" ? direct(uri.fsPath) : host(uri));
}
