import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const steps = pkg.contributes.walkthroughs.flatMap((w) => w.steps);
const media = (step) => (step.media?.markdown ? readFileSync(join(root, step.media.markdown), "utf8") : "");

describe("walkthrough copy", () => {
  it("never says Tab moves between placeholders (Tab indents; SPEC §7)", () => {
    for (const step of steps) {
      for (const text of [step.description, media(step)]) {
        assert.doesNotMatch(text, /placeholders? with Tab|`Tab` moves|Tab (moves|jumps)/i, step.id);
      }
    }
    const keys = pkg.contributes.keybindings.filter((k) => k.command === "opentide.placeholder.next");
    assert.ok(keys.length > 0 && keys.every((k) => k.key !== "tab"));
    const create = steps.find((s) => s.id === "create");
    assert.match(create.description, /Next Placeholder \(Ctrl\+Alt\+\./);
  });
});
