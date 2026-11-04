// The bundles keep the licence notices of code their packages inline (MIT requires them to ship with the
// code): Cytoscape.js carries four, which THIRD-PARTY-NOTICES, built from package licence files, lacks.
import * as assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { commonOptions } from "../../scripts/build-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("legal comments in the bundles", function () {
  this.timeout(30_000);

  it("keeps the MIT notices Cytoscape.js inlines in the minified graph bundle", async () => {
    const built = await esbuild.build({
      ...commonOptions(true),
      stdin: { contents: 'import cytoscape from "cytoscape"; globalThis.cy = cytoscape;', resolveDir: root },
      platform: "browser",
      format: "iife",
      target: "es2022",
      write: false,
      logLevel: "silent",
    });
    const text = built.outputFiles.map((file) => file.text).join("\n");
    for (const notice of ["Ralf S. Engelschall", "based on jQuery events", "Gaetan Renaudeau", "Koen Bok"])
      assert.ok(text.includes(notice), `the bundle lost the notice naming ${notice}`);
  });
});
