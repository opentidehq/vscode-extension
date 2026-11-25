// The language client package, loaded on first use from dist/lsp.js (client.ts), next to dist/extension.js. It is a
// require of a computed path, so esbuild leaves it alone: the bundle of the extension holds no copy of the package
// (test/scripts/lazy-client.test.mjs). Under tsc and mocha the module is its compiled source, client.js, next to this file.
import * as path from "node:path";

/** What dist/lsp.js exports: the values of vscode-languageclient the extension uses. */
export type LspModule = typeof import("./client");

/** Set by the build (scripts/build-lib.mjs): the bundle's file name. Unset under tsc, where the module is client.js. */
declare const OPENTIDE_LSP_FILE: string | undefined;

let loaded: LspModule | undefined;

/** vscode-languageclient's runtime values, read from dist/lsp.js the first time. */
export function loadLsp(): LspModule {
  loaded ??= require(
    path.join(__dirname, typeof OPENTIDE_LSP_FILE === "string" ? OPENTIDE_LSP_FILE : "client.js"),
  ) as LspModule;
  return loaded;
}
