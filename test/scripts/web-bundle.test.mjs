// The web extension (package.json `browser`) runs in a web worker: no Node built-in, no child process,
// no file system. Build it the way scripts/build.mjs does and check what it pulls in.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { webExtensionOptions } from "../../scripts/build-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

describe("web bundle", function () {
  this.timeout(30_000);
  let built;

  before(async () => {
    built = await esbuild.build({ ...webExtensionOptions(root), write: false, logLevel: "silent" });
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

  it("bundles only src/web/, never the core", () => {
    const sources = Object.keys(built.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
    assert.ok(sources.length > 0);
    for (const source of sources) assert.match(source, /^src\/web\//, `${source} is not in src/web/`);
  });

  it("is package.json's browser entry", () => {
    assert.equal(pkg.browser, "./dist/web/extension.js");
    assert.equal(join(root, pkg.browser), join(webExtensionOptions(root).outdir, "extension.js"));
  });

  it("works in virtual workspaces, where only it runs", () => {
    assert.equal(pkg.capabilities.virtualWorkspaces.supported, "limited");
  });
});
