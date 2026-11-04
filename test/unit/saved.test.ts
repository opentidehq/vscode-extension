import * as assert from "node:assert/strict";
import { ensureSaved, type SavableDocument } from "../../src/core/util/saved";

function document(isDirty: boolean, saves = true): SavableDocument & { saved: number } {
  return {
    isDirty,
    saved: 0,
    save() {
      this.saved++;
      return Promise.resolve(saves);
    },
  };
}

describe("unsaved rules before a command that reads them from disk", () => {
  const validate = { verb: "validates", action: "Validate" };

  it("asks only when a rule has unsaved edits", async () => {
    const asked: string[][] = [];
    const ask = (message: string, ...items: string[]) => {
      asked.push([message, ...items]);
      return Promise.resolve(undefined);
    };
    assert.equal(await ensureSaved([document(false)], validate, ask), true);
    assert.deepEqual(asked, []);
    assert.equal(await ensureSaved([document(true)], validate, ask), false, "Escape stops the command");
    assert.deepEqual(asked, [
      ["opentide validates the saved rule. Save it first?", "Save and Validate", "Validate Saved Version"],
    ]);
  });

  it("saves every dirty rule, or goes on with the saved versions", async () => {
    const a = document(true);
    const b = document(true);
    const clean = document(false);
    const preview = { verb: "previews", action: "Preview" };
    assert.equal(await ensureSaved([a, clean, b], preview, async () => "Save and Preview"), true);
    assert.deepEqual([a.saved, b.saved, clean.saved], [1, 1, 0]);
    const c = document(true);
    assert.equal(await ensureSaved([c, document(true)], preview, async () => "Preview Saved Versions"), true);
    assert.equal(c.saved, 0);
    assert.equal(await ensureSaved([document(true, false)], preview, async () => "Save and Preview"), false);
  });
});
