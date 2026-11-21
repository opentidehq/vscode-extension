import * as assert from "node:assert/strict";
import { traceLogLevel } from "../../src/core/services/traceLevel";

// The channel itself needs VS Code; its level rule (traceLevel.ts) does not.
describe("the language server trace channel's level follows opentide.trace.server", () => {
  it("is Trace for messages and verbose, and Info for off or unset", () => {
    assert.equal(traceLogLevel("verbose"), "trace");
    assert.equal(traceLogLevel("messages"), "trace");
    assert.equal(traceLogLevel("off"), "info");
    assert.equal(traceLogLevel(undefined), "info");
    assert.equal(traceLogLevel(3), "info");
  });
});
