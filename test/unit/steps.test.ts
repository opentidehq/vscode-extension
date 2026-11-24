// createCore's step clock (src/core/util/steps.ts): what the activation test prints beside `core`.
import * as assert from "node:assert/strict";

import { Steps } from "../../src/core/util/steps";

describe("steps", () => {
  it("gives each mark the time since the one before, so the steps add up to the whole", () => {
    let now = 100;
    const steps = new Steps(() => now);
    now = 103;
    steps.mark("folders");
    now = 113;
    steps.mark("services");
    steps.mark("nothing");
    assert.deepEqual(steps.all, [
      { name: "folders", ms: 3 },
      { name: "services", ms: 10 },
      { name: "nothing", ms: 0 },
    ]);
  });
});
