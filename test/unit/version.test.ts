import * as assert from "node:assert/strict";
import {
  atLeast,
  compareVersions,
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

  it("reads `opentide --version` and `opentide-lsp --version --json`", () => {
    assert.equal(parseOpentideVersionOutput("opentide 0.20.1\n"), "0.20.1");
    assert.equal(parseOpentideVersionOutput("opentide 0.21.0rc1"), "0.21.0rc1");
    assert.equal(parseOpentideVersionOutput("something else"), undefined);
    assert.equal(parseEngineVersionOutput('{"host":null,"engine":"0.9.0","catalog":"bundled"}'), "0.9.0");
    assert.equal(parseEngineVersionOutput('{"engine":{"version":"0.9.1"}}'), "0.9.1");
    assert.equal(parseEngineVersionOutput("opentide-lsp 0.8.0"), "0.8.0");
  });
});
