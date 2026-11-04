import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureIds, render } from "../../scripts/features-index.mjs";

describe("features index", () => {
  it("lists src/features/<id>/index.ts, sorted, as imports", () => {
    const dir = mkdtempSync(join(tmpdir(), "otide-features-"));
    for (const id of ["sidebar", "deploy-plan", "agents"]) {
      mkdirSync(join(dir, id));
      writeFileSync(join(dir, id, "index.ts"), "");
    }
    mkdirSync(join(dir, "no-index"));
    assert.deepEqual(featureIds(dir), ["agents", "deploy-plan", "sidebar"]);
    const text = render(featureIds(dir));
    assert.match(text, /import feature_deploy_plan from "\.\/deploy-plan\/index";/);
    assert.ok(text.indexOf("feature_agents") < text.indexOf("feature_sidebar"));
    assert.match(text, /export const features: readonly Feature\[\] = \[\n {2}feature_agents,/);
  });

  it("rejects a folder name that is not a feature id", () => {
    assert.throws(() => render(["Bad_Name"]), /must match/);
  });
});

describe("webview entries", () => {
  it("bundles webview/<name>/main.ts, skipping shared/ and folders without main.ts", async () => {
    const { webviewEntries } = await import("../../scripts/build-lib.mjs");
    const dir = mkdtempSync(join(tmpdir(), "otide-webview-"));
    for (const name of ["graph", "shared", "empty"]) mkdirSync(join(dir, name));
    writeFileSync(join(dir, "graph", "main.ts"), "");
    writeFileSync(join(dir, "shared", "main.ts"), "");
    assert.deepEqual(Object.keys(webviewEntries(dir)), ["graph"]);
    assert.deepEqual(webviewEntries(join(dir, "missing")), {});
  });
});

describe("third-party notices", () => {
  it("lists each bundled package once, with its licence text", async () => {
    const { bundledPackages, thirdPartyNotices } = await import("../../scripts/build-lib.mjs");
    const root = mkdtempSync(join(tmpdir(), "otide-notices-"));
    mkdirSync(join(root, "node_modules", "@scope", "pkg"), { recursive: true });
    writeFileSync(
      join(root, "node_modules", "@scope", "pkg", "package.json"),
      JSON.stringify({ version: "1.2.3", license: "MIT" }),
    );
    writeFileSync(join(root, "node_modules", "@scope", "pkg", "LICENSE"), "MIT text");
    const metafile = {
      inputs: {
        "node_modules/@scope/pkg/lib/a.js": {},
        "node_modules/@scope/pkg/lib/b.js": {},
        "src/extension.ts": {},
      },
    };
    const packages = bundledPackages(metafile, root);
    assert.deepEqual([...packages.keys()], ["@scope/pkg"]);
    const { readFileSync } = await import("node:fs");
    const text = thirdPartyNotices(packages, (file) => readFileSync(file, "utf8"));
    assert.match(text, /@scope\/pkg 1\.2\.3 \(MIT\)\n-+\nMIT text/);
  });

  it("carries every licence file of a package (codicons: the icons' and the code's)", async () => {
    const { thirdPartyNotices } = await import("../../scripts/build-lib.mjs");
    const dir = mkdtempSync(join(tmpdir(), "otide-notices-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.45", license: "CC-BY-4.0" }));
    writeFileSync(join(dir, "LICENSE"), "CC-BY text");
    writeFileSync(join(dir, "LICENSE-CODE"), "MIT text");
    writeFileSync(join(dir, "README.md"), "not a licence");
    const { readFileSync } = await import("node:fs");
    const text = thirdPartyNotices(new Map([["@vscode/codicons", dir]]), (file) =>
      readFileSync(file, "utf8"),
    );
    assert.match(text, /CC-BY text\n\nMIT text/);
    assert.doesNotMatch(text, /not a licence/);
  });

  it("covers the webview bundles too", async () => {
    const { mergeMetafiles } = await import("../../scripts/build-lib.mjs");
    const merged = mergeMetafiles([
      { inputs: { "node_modules/a/index.js": {} } },
      undefined,
      { inputs: { "node_modules/cytoscape/dist/cytoscape.esm.mjs": {} } },
    ]);
    assert.deepEqual(Object.keys(merged.inputs), [
      "node_modules/a/index.js",
      "node_modules/cytoscape/dist/cytoscape.esm.mjs",
    ]);
  });
});
