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

/**
 * The folder rules live in, relative to the opentide folder: `paths.toml`'s `rule` object folder when it names a safe
 * relative one (`detections/rules/`), else the default `objects/rules`. A document outside the object folders is not
 * analysed as a rule, so the warm-up would warm nothing.
 */
export function ruleFolderOf(objectFolders: Readonly<Record<string, string>> | undefined): string {
  const named = objectFolders?.rule?.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!named || named.startsWith("/") || /^[A-Za-z]:/.test(named) || named.split("/").includes(".."))
    return "objects/rules";
  return named;
}

/** Where the synthetic rule lives: in the first opentide folder's rule folder. */
export function warmupUri(folderUri: string, objectFolders?: Readonly<Record<string, string>>): string {
  return `${folderUri.replace(/\/+$/, "")}/${ruleFolderOf(objectFolders)}/${WARMUP_FILE}`;
}

/** Whether `uri` is the synthetic rule's: its diagnostics are not for the Problems panel. */
export function isWarmupUri(uri: string): boolean {
  return uri.endsWith(`/${WARMUP_FILE}`);
}

/** How a warm-up ended. */
export type WarmupEnd = "analysed" | "timeout" | "cancelled";

/** The settling of one warm-up: done when its diagnostics arrive, a real document opens, or after `timeoutMs`. */
export interface Warmup {
  /** Called with the diagnostics of the synthetic rule (any document: only its own counts). */
  seen(uri: string): void;
  /** A real document opened: stop waiting (the synthetic rule is closed at once). */
  cancelled(): void;
  /** Resolves with how it ended. */
  readonly done: Promise<WarmupEnd>;
  /** Drop the timer (the warm-up failed to start). */
  cancel(): void;
}

export function warmupWatch(timeoutMs: number, setTimer: typeof setTimeout = setTimeout): Warmup {
  let finish: (how: WarmupEnd) => void = () => undefined;
  const done = new Promise<WarmupEnd>((resolve) => {
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
    cancelled: () => {
      clearTimeout(timer);
      finish("cancelled");
    },
    cancel: () => clearTimeout(timer),
  };
}

/** Whether a document counts as a real opentide document the person is waiting for. */
export function isRealRule(document: {
  readonly languageId: string;
  readonly uri: { readonly scheme: string; readonly path: string };
}): boolean {
  return (
    document.languageId === "opentide-yaml" &&
    document.uri.scheme === "file" &&
    !isWarmupUri(document.uri.path)
  );
}
