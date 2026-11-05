import * as assert from "node:assert/strict";
import { RECHECK_INTERVAL_MS, shouldRecheck, VENV_GLOB } from "../../src/core/runtime/recheck";
import { fakeRuntime } from "./helpers";

describe("looking again for an opentide on the engine tier", () => {
  const engine = fakeRuntime({ tier: 5, source: "engine", kind: "engine" });

  it("looks only on the engine tier", () => {
    assert.equal(shouldRecheck(engine, undefined, 0), true);
    assert.equal(shouldRecheck(fakeRuntime(), undefined, 0), false);
    assert.equal(shouldRecheck(undefined, undefined, 0), false);
  });

  it("looks at most once per interval on focus", () => {
    assert.equal(shouldRecheck(engine, 1000, 1000 + RECHECK_INTERVAL_MS - 1), false);
    assert.equal(shouldRecheck(engine, 1000, 1000 + RECHECK_INTERVAL_MS), true);
  });

  it("watches everything a .venv gets, bin/ and Scripts/ alike", () => {
    assert.equal(VENV_GLOB, ".venv/**");
  });
});
