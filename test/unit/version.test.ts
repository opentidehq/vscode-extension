import * as assert from "node:assert/strict";
import {
  atLeast,
  checkMinimum,
  compareVersions,
  isUntaggedDevBuild,
  MIN_OPENTIDE_VERSION,
  parseEngineVersionOutput,
  parseOpentideVersionOutput,
} from "../../src/core/runtime/version";

describe("version", () => {
  it("orders releases, pre-releases and dev builds as PEP 440 does", () => {
    const ordered = [
      "0.20.0",
      "0.20.1.dev1",
      "0.20.1a1",
      "0.20.1b2",
      "0.20.1rc1",
      "0.20.1",
      "0.20.1.post1",
      "0.21.0",
    ];
    for (let i = 0; i + 1 < ordered.length; i++) {
      assert.equal(
        compareVersions(ordered[i] as string, ordered[i + 1] as string),
        -1,
        `${ordered[i]} < ${ordered[i + 1]}`,
      );
    }
    assert.equal(compareVersions("0.20", "0.20.0"), 0);
    assert.equal(compareVersions("v0.9.0", "0.9.0"), 0);
  });

  it("keeps the minimum in one constant", () => {
    assert.equal(MIN_OPENTIDE_VERSION, "0.20.1");
    assert.ok(atLeast("0.20.1", MIN_OPENTIDE_VERSION));
    assert.ok(!atLeast("0.20.0", MIN_OPENTIDE_VERSION));
    assert.ok(!atLeast("not a version", MIN_OPENTIDE_VERSION));
  });

  it("lets an untagged dev build past the minimum, and nothing else older", () => {
    // hatch-vcs / setuptools-scm with no release tag in the history.
    for (const version of ["0.1.dev216+g0a65c49", "0.1.dev1", "0.1.0.dev3+g1.d20261103", "0.0.dev0"]) {
      assert.ok(isUntaggedDevBuild(version), version);
      assert.equal(checkMinimum(version, MIN_OPENTIDE_VERSION), "untagged", version);
    }
    // Real releases and dev builds from a tagged history order normally.
    for (const version of ["0.1.0", "0.19.2", "0.20.0", "0.20.1.dev4+gabc", "0.2.dev1", "not a version"]) {
      assert.ok(!isUntaggedDevBuild(version), version);
      assert.equal(checkMinimum(version, MIN_OPENTIDE_VERSION), "too-old", version);
    }
    assert.equal(checkMinimum("0.21.1.dev3+g1234567", MIN_OPENTIDE_VERSION), "ok");
    assert.equal(parseOpentideVersionOutput("opentide 0.1.dev216+g0a65c49\n"), "0.1.dev216+g0a65c49");
  });

  it("reads `opentide --version` and `opentide-lsp --version --json`", () => {
    assert.equal(parseOpentideVersionOutput("opentide 0.20.1\n"), "0.20.1");
    assert.equal(parseOpentideVersionOutput("opentide 0.21.0rc1"), "0.21.0rc1");
    assert.equal(parseOpentideVersionOutput("something else"), undefined);
    assert.equal(parseEngineVersionOutput('{"host":null,"engine":"0.9.0","catalog":"bundled"}'), "0.9.0");
    assert.equal(parseEngineVersionOutput('{"engine":{"version":"0.9.1"}}'), "0.9.1");
    assert.equal(parseEngineVersionOutput("opentide-lsp 0.8.0"), "0.8.0");
  });
});
