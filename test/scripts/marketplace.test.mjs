// tools/publish/marketplace.mjs: after vsce publish, the Marketplace must list every package of the
// Release. 0.1.0 kept one package of eight and said the extension was unavailable everywhere else.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STORES, storeExtensionId } from "../../scripts/package-lib.mjs";
import {
  ensurePublished,
  expectedPackages,
  FIRST_MARKETPLACE_VERSION,
  MARKETPLACE_ID,
  missingTargets,
  publishProblem,
} from "../../tools/publish/marketplace.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** What 0.1.0 published: eight packages, one per target (the release has had one per store since 0.3.1). */
const OLD_RELEASE = ["alpine-arm64", "darwin-arm64", "linux-x64", "universal", "win32-arm64"].map(
  (target) => ({
    file: `opentide-${target}-0.1.0.vsix`,
    target,
  }),
);

describe("the Marketplace lists the package of a release", () => {
  it("expects the one universal package it publishes, from its path", () => {
    assert.deepEqual(expectedPackages("release/opentide-marketplace-0.3.1.vsix"), [
      { file: "opentide-marketplace-0.3.1.vsix", target: "universal" },
    ]);
  });

  it("finds what 0.1.0 lost: every target but the first", () => {
    const gallery = [{ version: "0.1.0", targetPlatform: "alpine-arm64" }];
    assert.deepEqual(
      missingTargets(gallery, "0.1.0", OLD_RELEASE).map((p) => p.target),
      ["darwin-arm64", "linux-x64", "universal", "win32-arm64"],
    );
  });

  it("counts a gallery entry without targetPlatform as the universal package, and ignores other versions", () => {
    const expected = expectedPackages("release/opentide-marketplace-0.3.1.vsix");
    assert.deepEqual(missingTargets([{ version: "0.3.1" }], "0.3.1", expected), []);
    assert.equal(missingTargets([{ version: "0.3.0" }], "0.3.1", expected).length, 1);
  });

  it("publishes the missing packages again until the gallery lists them", async () => {
    const expected = OLD_RELEASE;
    const listed = new Set(["alpine-arm64"]);
    const published = [];
    const missing = await ensurePublished({
      id: "opentide.opentide",
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
    const expected = OLD_RELEASE;
    let calls = 0;
    const missing = await ensurePublished({
      id: "opentide.opentide",
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

  it("publishes only this release's own Marketplace package, 0.3.1 or later: never an older version", () => {
    assert.equal(MARKETPLACE_ID, storeExtensionId(STORES.find((store) => store.store === "marketplace")));
    assert.equal(FIRST_MARKETPLACE_VERSION, "0.3.1");
    const file = "release/opentide-marketplace-0.3.1.vsix";
    assert.equal(publishProblem("opentide.opentide", "0.3.1", file), undefined);
    assert.equal(
      publishProblem("opentide.opentide", "0.4.0", "release/opentide-marketplace-0.4.0.vsix"),
      undefined,
    );
    assert.match(
      publishProblem("opentide.opentide", "0.3.0", "release/opentide-marketplace-0.3.0.vsix"),
      /older than 0\.3\.1: only new versions .* never a backfill/,
    );
    assert.match(
      publishProblem("opentide.opentide", "0.2.9", "x/opentide-marketplace-0.2.9.vsix"),
      /older than 0\.3\.1/,
    );
    assert.match(publishProblem("opentidehq.opentide", "0.3.1", file), /not the Marketplace's id/);
    assert.match(
      publishProblem("opentide.opentide", "0.3.1", "release/opentide-openvsx-0.3.1.vsix"),
      /is not opentide-marketplace-0\.3\.1\.vsix/,
    );
    assert.match(
      publishProblem("opentide.opentide", "0.3.2", file),
      /is not opentide-marketplace-0\.3\.2\.vsix/,
    );
    assert.match(publishProblem("opentide.opentide", "v0.3.1", file), /not a release version/);
  });

  it("publish.yml checks the package's version and name before vsce publish", () => {
    const text = readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8");
    const job = text.slice(text.indexOf("  publish-marketplace:"), text.indexOf("  publish-openvsx:"));
    const check = job.search(
      /node tools\/publish\/marketplace\.mjs --check opentide\.opentide "\$\{VERSION\}" "\$\{VSIX\}"/,
    );
    assert.ok(check > 0 && check < job.indexOf("vsce publish"), "the check runs before vsce publish");
  });

  it("publish.yml checks the listing of opentide.opentide after vsce publish, in the Marketplace job", () => {
    const text = readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8");
    const job = text.slice(text.indexOf("  publish-marketplace:"), text.indexOf("  publish-openvsx:"));
    const publish = job.indexOf("vsce publish");
    const check = job.search(
      /node tools\/publish\/marketplace\.mjs opentide\.opentide "\$\{VERSION\}" "\$\{VSIX\}"/,
    );
    assert.ok(publish > 0 && check > publish, "the listing check runs after vsce publish");
  });
});
