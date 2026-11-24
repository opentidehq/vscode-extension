import * as assert from "node:assert/strict";

import {
  FIXED_WORKSPACE_PULL_VERSION,
  skipWorkspacePull,
  workspacePullIsSlow,
  workspacePullSetting,
} from "../../src/core/runtime/diagnostics";

describe("workspace/diagnostic pulls (E1)", () => {
  it("an opentide older than 1.0.0rc3 is slow; rc3 and later, and an untagged dev build, are not", () => {
    assert.equal(FIXED_WORKSPACE_PULL_VERSION, "1.0.0rc3");
    for (const old of ["0.28.1", "1.0.0rc2", "1.0.0-rc.2", "1.0.0rc1", "0.45.0"])
      assert.equal(workspacePullIsSlow(old), true, old);
    for (const fine of [
      "1.0.0rc3",
      "1.0.0-rc.3",
      "1.0.0-rc.3-dev+9cd8da7",
      "1.0.0",
      "1.2.0",
      "0.1.dev3+g8b55d0c",
    ])
      assert.equal(workspacePullIsSlow(fine), false, fine);
  });

  it("auto skips the pull for an old server only, never for an unknown version", () => {
    assert.equal(skipWorkspacePull("auto", "0.28.1"), true);
    assert.equal(skipWorkspacePull("auto", "1.0.0rc2"), true);
    assert.equal(skipWorkspacePull("auto", "1.0.0rc3"), false);
    assert.equal(skipWorkspacePull("auto", "1.1.0"), false);
    assert.equal(skipWorkspacePull("auto", undefined), false);
  });

  it("always pulls and never does not, whatever the version", () => {
    for (const version of ["0.28.1", "1.0.0rc3", undefined]) {
      assert.equal(skipWorkspacePull("always", version), false);
      assert.equal(skipWorkspacePull("never", version), true);
    }
  });

  it("reads the setting, with auto for anything else", () => {
    assert.equal(workspacePullSetting("always"), "always");
    assert.equal(workspacePullSetting("never"), "never");
    for (const other of ["auto", undefined, 3, "yes"]) assert.equal(workspacePullSetting(other), "auto");
  });
});
