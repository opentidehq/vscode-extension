// The web extension (package.json `browser`) runs in a web worker: no Node built-in, no child process,
// no file system. Build it, and the engine's Web Worker, the way scripts/build.mjs does and check what
// they pull in.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { webEngineWorkerOptions, webExtensionOptions } from "../../scripts/build-lib.mjs";
import { engineCacheDir, GLUE, prepareEngine } from "../../scripts/engine-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const pkgPins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));

describe("web bundle", function () {
  this.timeout(30_000);
  let built;
  let worker;

  before(async () => {
    built = await esbuild.build({ ...webExtensionOptions(root), write: false, logLevel: "silent" });
    await prepareEngine(root, pkgPins.engine);
    worker = await esbuild.build({
      ...webEngineWorkerOptions(root, join(engineCacheDir(root, pkgPins.engine), GLUE)),
      write: false,
      logLevel: "silent",
    });
  });

  it("imports no Node built-in and nothing external but vscode", () => {
    const imports = Object.values(built.metafile.inputs).flatMap((input) => input.imports);
    const external = imports.filter((entry) => entry.external).map((entry) => entry.path);
    assert.deepEqual([...new Set(external)], ["vscode"]);
    assert.deepEqual(
      imports.filter((entry) => builtins.has(entry.path)).map((entry) => entry.path),
      [],
    );
    const [output] = built.outputFiles.filter((file) => file.path.endsWith(".js"));
    const required = [...output.text.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(required)], ["vscode"]);
  });

  it("bundles src/web/, the shared src/engine/ and npm packages, never the core", () => {
    const sources = Object.keys(built.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
    assert.ok(sources.some((source) => source.startsWith("src/web/")));
    assert.ok(sources.some((source) => source.startsWith("src/engine/")));
    for (const source of sources)
      assert.match(source, /^(src\/web\/|src\/engine\/|node_modules\/)/, `${source} is not web-safe`);
    assert.ok(
      sources.some((source) => source.startsWith("node_modules/vscode-languageclient/lib/browser/")),
      "the browser language client",
    );
    assert.equal(
      sources.some((source) => source.includes("/lib/node/")),
      false,
      "no node build of an npm package",
    );
  });

  it("builds the engine's Web Worker as a classic script with the glue, and no Node built-in", () => {
    const imports = Object.values(worker.metafile.inputs).flatMap((input) => input.imports);
    assert.deepEqual(
      imports.filter((entry) => builtins.has(entry.path) || entry.external).map((entry) => entry.path),
      [],
    );
    const sources = Object.keys(worker.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
    assert.ok(sources.includes("src/web/engineWorker.ts"));
    assert.ok(
      sources.some((source) => source.endsWith(`/${GLUE}`)),
      "the wasm-bindgen glue is bundled",
    );
    for (const source of sources)
      assert.match(source, /^(src\/web\/|src\/engine\/|\.cache\/engine-)/, `${source} is not web-safe`);
    const [output] = worker.outputFiles.filter((file) => file.path.endsWith(".js"));
    assert.equal(/^\s*(import|export)\s/m.test(output.text), false, "a classic script: no import or export");
    assert.equal(/\brequire\(/.test(output.text), false);
  });

  it("is package.json's browser entry", () => {
    assert.equal(pkg.browser, "./dist/web/extension.js");
    assert.equal(join(root, pkg.browser), join(webExtensionOptions(root).outdir, "extension.js"));
  });

  it("works in virtual workspaces, where only it runs, and says what does", () => {
    assert.equal(pkg.capabilities.virtualWorkspaces.supported, "limited");
    assert.match(pkg.capabilities.virtualWorkspaces.description, /engine \(WASM\)/);
  });
});
