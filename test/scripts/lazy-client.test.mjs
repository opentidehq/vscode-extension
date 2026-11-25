// The language client package is dist/lsp.js, loaded on the first client start (src/core/lsp/load.ts), not part of
// dist/extension.js, which every window loads at startup: about 53 ms of the 77 ms `require(dist/extension.js)` took
// was vscode-languageclient. Built in memory from the same options as `npm run build`.
import * as assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import * as esbuild from "esbuild";

import { backendOptions, commonOptions, extensionOptions, lspOptions } from "../../scripts/build-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The package names of the `node_modules` inputs of one bundle. */
async function packages(options) {
  const { metafile } = await esbuild.build({
    ...options,
    write: false,
    logLevel: "silent",
    entryPoints: options.entryPoints,
  });
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (match) names.add(match[1]);
  }
  return names;
}

const CLIENT_PACKAGES = [
  "vscode-languageclient",
  "vscode-languageserver-protocol",
  "vscode-languageserver-types",
  "vscode-languageserver-textdocument",
  "vscode-jsonrpc",
  "@vscode/wasm-wasi",
];

describe("the language client is loaded lazily", function () {
  this.timeout(60_000);
  const common = commonOptions(true);

  it("dist/extension.js holds none of vscode-languageclient and what it brings", async () => {
    const names = await packages(extensionOptions(root, common));
    for (const name of CLIENT_PACKAGES) assert.ok(!names.has(name), `${name} is in dist/extension.js`);
  });

  it("dist/lsp.js holds them, once", async () => {
    const names = await packages(lspOptions(root, common));
    for (const name of CLIENT_PACKAGES) assert.ok(names.has(name), `${name} is not in dist/lsp.js`);
  });

  it("the extension names its bundle: the build defines OPENTIDE_LSP_FILE as lsp.js", () => {
    assert.equal(extensionOptions(root, common).define.OPENTIDE_LSP_FILE, '"lsp.js"');
    assert.deepEqual(Object.keys(lspOptions(root, common).entryPoints), ["lsp"]);
  });
});

describe("Effect is loaded lazily, with the serve supervisor", function () {
  this.timeout(60_000);
  const common = commonOptions(true);

  it("dist/extension.js and dist/lsp.js hold no Effect", async () => {
    for (const options of [extensionOptions(root, common), lspOptions(root, common)])
      assert.ok(!(await packages(options)).has("effect"), `effect is in ${Object.keys(options.entryPoints)}`);
  });

  it("dist/mcp-wasi.js, the MCP bridge, holds no Effect", async () => {
    const names = await packages({
      entryPoints: { "mcp-wasi": join(root, "src", "mcp-wasi", "main.ts") },
      outdir: join(root, "dist"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      mainFields: ["module", "main"],
      metafile: true,
    });
    assert.ok(!names.has("effect"));
  });

  it("dist/backend.js holds it, and stays within 50 KB gzipped", async () => {
    const options = backendOptions(root, common);
    assert.ok((await packages(options)).has("effect"));
    const { outputFiles } = await esbuild.build({ ...options, write: false, logLevel: "silent" });
    const [output] = outputFiles.filter((file) => file.path.endsWith("backend.js"));
    const gzipped = gzipSync(output.contents, { level: 9 }).length;
    assert.ok(gzipped <= 50 * 1024, `dist/backend.js is ${gzipped} bytes gzipped`);
  });

  it("the extension names the bundle: the build defines OPENTIDE_BACKEND_FILE as backend.js", () => {
    assert.equal(extensionOptions(root, common).define.OPENTIDE_BACKEND_FILE, '"backend.js"');
    assert.deepEqual(Object.keys(backendOptions(root, common).entryPoints), ["backend"]);
  });
});
