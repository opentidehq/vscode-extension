// The gate a restart holds closed until it knows the runtime it lands on (src/core/util/gate.ts).
import * as assert from "node:assert/strict";

import { SettleGate } from "../../src/core/util/gate";

const state = async (promise: Promise<void>): Promise<"open" | "closed"> =>
  Promise.race([
    promise.then(() => "open" as const),
    new Promise<"closed">((r) => setImmediate(() => r("closed"))),
  ]);

describe("settle gate", () => {
  it("is open until a restart closes it, and opens again once", async () => {
    const gate = new SettleGate();
    assert.equal(await state(gate.settled()), "open", "no restart: nothing waits");
    gate.close();
    const waiting = gate.settled();
    assert.equal(await state(waiting), "closed");
    gate.open();
    assert.equal(await state(waiting), "open");
    assert.equal(await state(gate.settled()), "open");
    gate.open();
    assert.equal(await state(gate.settled()), "open", "opening an open gate does nothing");
  });

  it("keeps a waiter waiting when it is closed twice, until it opens", async () => {
    const gate = new SettleGate();
    gate.close();
    const first = gate.settled();
    gate.close();
    assert.equal(await state(first), "closed");
    gate.open();
    assert.equal(await state(first), "open");
  });
});
