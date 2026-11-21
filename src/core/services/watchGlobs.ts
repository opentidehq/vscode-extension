// The files the opentide language server reads from disk, as the globs its client watches (`synchronize.fileEvents`).
// vscode-free.

/**
 * What the server reads from disk, as the server's authors say (opentide#1744): the object files, everything under
 * `.opentide/configurations` and the deployment state shards `.opentide/states/deployment/*.json`. Not `.opentide/schemas`,
 * and not the rest of `.opentide/` (exports, inflight, lsp, templates, hooks), which the extension's own runs write by the
 * thousand. Object folders that `paths.toml` moves elsewhere are the server's to watch (it registers them dynamically).
 */
export const SERVER_WATCH_GLOBS = [
  "**/objects/**",
  "**/.opentide/configurations/**",
  "**/.opentide/states/deployment/*.json",
] as const;

/** The directories under `.opentide/` that no server watch covers. */
export const UNWATCHED_OPENTIDE_DIRECTORIES = [
  "exports",
  "inflight",
  "schemas",
  "lsp",
  "templates",
  "hooks",
] as const;
