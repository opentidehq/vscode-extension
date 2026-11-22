import * as assert from "node:assert/strict";
import { hasOpentideContent, OPENTIDE_LANGUAGES } from "../../src/core/dormant";

describe("a window with no opentide content", () => {
  it("is dormant with no opentide folder and no opentide file open", () => {
    assert.equal(hasOpentideContent(0, []), false);
    assert.equal(hasOpentideContent(0, ["typescript", "markdown", "kql", "yaml", "plaintext"]), false);
  });
  it("has content with an opentide folder, or an opentide file open anywhere", () => {
    assert.equal(hasOpentideContent(1, []), true);
    assert.equal(hasOpentideContent(0, ["markdown", "opentide-yaml"]), true);
    assert.equal(hasOpentideContent(0, ["opentide-config"]), true);
    assert.deepEqual([...OPENTIDE_LANGUAGES].sort(), ["opentide-config", "opentide-yaml"]);
  });
});
