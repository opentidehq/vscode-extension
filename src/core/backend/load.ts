// The serve supervisor (supervisor.ts) and Effect with it, loaded on first use from dist/backend.js, next to
// dist/extension.js, as src/core/lsp/load.ts loads the language client: a require of a computed path, which esbuild
// leaves alone, so the extension's bundle holds no Effect (test/scripts/lazy-client.test.mjs). Under tsc and mocha
// the module is its compiled source, supervisor.js, next to this file.
import * as path from "node:path";

/** What dist/backend.js exports. */
export type SupervisorModule = typeof import("./supervisor");

/** Set by the build (scripts/build-lib.mjs): the bundle's file name. Unset under tsc, where the module is supervisor.js. */
declare const OPENTIDE_BACKEND_FILE: string | undefined;

let loaded: SupervisorModule | undefined;

/** The supervisor, read from dist/backend.js the first time a command runs. */
export function loadSupervisor(): SupervisorModule {
  loaded ??= require(
    path.join(__dirname, typeof OPENTIDE_BACKEND_FILE === "string" ? OPENTIDE_BACKEND_FILE : "supervisor.js"),
  ) as SupervisorModule;
  return loaded;
}
