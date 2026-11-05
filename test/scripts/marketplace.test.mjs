// tools/publish/marketplace.mjs: after vsce publish, the Marketplace must list every package of the
// Release. 0.1.0 kept one package of eight and said the extension was unavailable everywhere else.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePublished, expectedPackages, missingTargets } from "../../tools/publish/marketplace.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const RELEASE = [
  "SHA256SUMS",
  "opentide-alpine-arm64-0.1.0.vsix",
  "opentide-darwin-arm64-0.1.0.vsix",
  "opentide-linux-x64-0.1.0.vsix",
  "opentide-universal-0.1.0.vsix",
  "opentide-win32-arm64-0.1.0.vsix",
  "opentide-win32-x64-0.0.9.vsix",
];

describe("the Marketplace lists every package of a release", () => {
  it("reads each package's target from its file name, for that version only", () => {
    assert.deepEqual(
      expectedPackages(RELEASE, "opentide", "0.1.0").map((p) => p.target),
      ["alpine-arm64", "darwin-arm64", "linux-x64", "universal", "win32-arm64"],
    );
  });

  it("finds what 0.1.0 lost: every target but the first", () => {
    const expected = expectedPackages(RELEASE, "opentide", "0.1.0");
    const gallery = [{ version: "0.1.0", targetPlatform: "alpine-arm64" }];
    assert.deepEqual(
      missingTargets(gallery, "0.1.0", expected).map((p) => p.target),
      ["darwin-arm64", "linux-x64", "universal", "win32-arm64"],
    );
  });

  it("counts a gallery entry without targetPlatform as the universal package, and ignores other versions", () => {
    const expected = expectedPackages(["opentide-universal-0.1.1.vsix"], "opentide", "0.1.1");
    assert.deepEqual(missingTargets([{ version: "0.1.1" }], "0.1.1", expected), []);
    assert.equal(missingTargets([{ version: "0.1.0" }], "0.1.1", expected).length, 1);
  });

  it("publishes the missing packages again until the gallery lists them", async () => {
    const expected = expectedPackages(RELEASE, "opentide", "0.1.0");
    const listed = new Set(["alpine-arm64"]);
    const published = [];
    const missing = await ensurePublished({
      id: "opentidehq.opentide",
      version: "0.1.0",
      expected,
      publish: ({ target }) => {
        published.push(target);
        listed.add(target);
      },
      versions: async () => [...listed].map((target) => ({ version: "0.1.0", targetPlatform: target })),
      polls: 2,
      intervalMs: 0,
      log: () => {},
    });
    assert.deepEqual(missing, []);
    assert.deepEqual(published, ["darwin-arm64", "linux-x64", "universal", "win32-arm64"]);
  });

  it("gives up after its rounds, naming what is still missing, and survives a failing query", async () => {
    const expected = expectedPackages(RELEASE, "opentide", "0.1.0");
    let calls = 0;
    const missing = await ensurePublished({
      id: "opentidehq.opentide",
      version: "0.1.0",
      expected,
      publish: () => {},
      versions: async () => {
        calls += 1;
        if (calls === 1) throw new Error("503");
        return [{ version: "0.1.0", targetPlatform: "alpine-arm64" }];
      },
      rounds: 2,
      polls: 2,
      intervalMs: 0,
      log: () => {},
    });
    assert.deepEqual(
      missing.map((p) => p.target),
      ["darwin-arm64", "linux-x64", "universal", "win32-arm64"],
    );
  });

  it("publish.yml checks the listing after vsce publish, in the Marketplace job", () => {
    const text = readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8");
    const job = text.slice(text.indexOf("  publish-marketplace:"), text.indexOf("  publish-openvsx:"));
    const publish = job.indexOf("vsce publish");
    const check = job.indexOf("node tools/publish/marketplace.mjs opentidehq.opentide");
    assert.ok(publish > 0 && check > publish, "the listing check runs after vsce publish");
  });
});
