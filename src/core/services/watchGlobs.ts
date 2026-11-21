// The files the opentide language server reads from disk, as the globs its client watches (`synchronize.fileEvents`).
// vscode-free.

/**
 * The object files, and `.opentide/configurations` (paths.toml, platforms, visibility) and `.opentide/schemas`. Not the
 * rest of `.opentide/`: exports, inflight, states, lsp, templates and hooks are written by the extension's own runs, by the
 * thousand, and the server never reads them.
 */
export const SERVER_WATCH_GLOBS = [
  "**/objects/**",
  "**/.opentide/configurations/**",
  "**/.opentide/schemas/**",
] as const;

/** The directories under `.opentide/` that no server watch covers. */
export const UNWATCHED_OPENTIDE_DIRECTORIES = [
  "exports",
  "inflight",
  "states",
  "lsp",
  "templates",
  "hooks",
] as const;
