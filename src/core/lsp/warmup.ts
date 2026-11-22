// Warming the language server before the first document: a synthetic rule is opened, analysed and closed once the server
// has initialized. vscode-free.
//
// Measured with the bundled module under Node 22 (docs/PACKAGING.md, "Cold start"): the server answers `initialize` in
// about 150 ms, but the first document it analyses takes about 500 ms in a small workspace and 1.1 s in one of 1,200
// objects, and a second one 25-40 ms and 0.5 s. The cost is the server's first analysis in a cold process, not the
// module's compile (about 50 ms), and it is paid even when the document opens seconds after the server started. Analysing
// a rule of our own while nobody is waiting moves it off the first document the person opens.

/** `opentide.languageServer.warmUp`. */
export function warmUpEnabled(setting: unknown): boolean {
  return setting !== false;
}

/** The server kinds that are warmed: opentide's own process or WASI module. The engine (WASM) starts warm enough. */
export function warmsUp(runtime: { readonly kind: string }): boolean {
  return runtime.kind === "opentide";
}

/** A small valid rule, with a uuid no workspace has. */
export const WARMUP_RULE = `name: opentide warm-up
metadata:
  uuid: 00000000-0000-4000-8000-0000000a11a5
  schema: rule::1.1
  tlp: clear
configurations:
  sentinel:
    query: |
      DeviceProcessEvents
      | where FileName =~ "opentide-warm-up.exe"
`;

const WARMUP_FILE = ".opentide-warmup.yaml";

/** Where the synthetic rule lives: where a rule does, in the first opentide folder (`objects/rules/`). */
export function warmupUri(folderUri: string): string {
  return `${folderUri.replace(/\/+$/, "")}/objects/rules/${WARMUP_FILE}`;
}

/** Whether `uri` is the synthetic rule's: its diagnostics are not for the Problems panel. */
export function isWarmupUri(uri: string): boolean {
  return uri.endsWith(`/${WARMUP_FILE}`);
}

/** The settling of one warm-up: done when its diagnostics arrive, or after `timeoutMs`. */
export interface Warmup {
  /** Called with the diagnostics of the synthetic rule (any document: only its own counts). */
  seen(uri: string): void;
  /** Resolves with how it ended. */
  readonly done: Promise<"analysed" | "timeout">;
}

export function warmupWatch(
  timeoutMs: number,
  setTimer: typeof setTimeout = setTimeout,
): Warmup & { cancel(): void } {
  let finish: (how: "analysed" | "timeout") => void = () => undefined;
  const done = new Promise<"analysed" | "timeout">((resolve) => {
    finish = resolve;
  });
  const timer = setTimer(() => finish("timeout"), timeoutMs);
  return {
    done,
    seen: (uri) => {
      if (isWarmupUri(uri)) {
        clearTimeout(timer);
        finish("analysed");
      }
    },
    cancel: () => clearTimeout(timer),
  };
}
