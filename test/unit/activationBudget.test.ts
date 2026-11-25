// The activation test's verdict (test/integration/activationBudget.ts): CPU time against the budget, wall time against
// a loose ceiling, and wall time against the budget where there is no CPU clock.
import * as assert from "node:assert/strict";

import { activationVerdict } from "../integration/activationBudget";

const budget = { budgetMs: 300, wallCeilingMs: 2000 };

describe("activationVerdict", () => {
  it("passes a runner that descheduled the host: wall over the budget, CPU under it", () => {
    // macOS stable on CI: 554 ms wall, 37 ms CPU (runner 454 ms, 2 ms CPU).
    const verdict = activationVerdict({ wallMs: 554, cpuMs: 37 }, budget);
    assert.equal(verdict.ok, true, verdict.reason);
  });

  it("fails our own code: CPU over the budget", () => {
    const verdict = activationVerdict({ wallMs: 420, cpuMs: 340 }, budget);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /used 340 ms of CPU \(420 ms wall\), the budget is 300 ms/);
  });

  it("fails a blocking call even though it is off the CPU: wall over the ceiling", () => {
    // A process start or a synchronous read of the workspace: seconds of wall time, little CPU.
    const verdict = activationVerdict({ wallMs: 2600, cpuMs: 40 }, budget);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /2600 ms wall \(40 ms CPU\), over the 2000 ms ceiling/);
  });

  it("judges wall time against the budget where there is no CPU clock (VS Code 1.91)", () => {
    assert.equal(activationVerdict({ wallMs: 82 }, budget).ok, true);
    const verdict = activationVerdict({ wallMs: 310 }, budget);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /310 ms \(no CPU clock .*\), the budget is 300 ms/);
  });

  it("treats the budget and the ceiling as exclusive bounds", () => {
    assert.equal(activationVerdict({ wallMs: 1999, cpuMs: 299 }, budget).ok, true);
    assert.equal(activationVerdict({ wallMs: 1999, cpuMs: 300 }, budget).ok, false);
    assert.equal(activationVerdict({ wallMs: 2000, cpuMs: 10 }, budget).ok, false);
  });
});
