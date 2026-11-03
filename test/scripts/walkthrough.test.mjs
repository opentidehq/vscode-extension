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

describe("welcome views in virtual and web workspaces", () => {
  const welcomes = pkg.contributes.viewsWelcome;
  it("never call a repository there 'not an opentide repository yet'", () => {
    for (const welcome of welcomes.filter((w) => /!opentide\.hasWorkspace/.test(w.when ?? ""))) {
      if (/workspaceFolderCount == 0/.test(welcome.when)) continue;
      assert.match(welcome.when, /!virtualWorkspace/, `${welcome.view}: ${welcome.when}`);
    }
  });

  it("say instead that the views need a local folder in VS Code Desktop", () => {
    for (const view of ["catalogue", "coverage", "platforms", "health"]) {
      const welcome = welcomes.find(
        (w) => w.view === `opentide.sidebar.${view}` && w.when === "virtualWorkspace",
      );
      assert.ok(welcome, view);
      assert.match(welcome.contents, /local folder in VS Code Desktop/);
    }
  });
});
