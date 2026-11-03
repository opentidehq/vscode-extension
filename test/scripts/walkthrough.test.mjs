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

describe("what the bundled opentide cannot do", () => {
  it("gates the graph's and the matrix's entry points on opentide.hasInfoCatalog, as the sidebar does", () => {
    const menus = pkg.contributes.menus;
    const entries = Object.values(menus).flat();
    for (const command of ["opentide.graph.open", "opentide.graph.showInGraph", "opentide.matrix.open"]) {
      const shown = entries.filter((m) => m.command === command && m.when !== "false");
      assert.ok(shown.length > 0, command);
      for (const entry of shown)
        assert.match(entry.when, /opentide\.hasInfoCatalog/, `${command}: ${entry.when}`);
    }
  });

  it("walks a user without info catalog to a newer opentide, not to panels that only refuse", () => {
    const fit = steps.find((s) => s.id === "fit");
    const needs = steps.find((s) => s.id === "fitNeedsCatalog");
    assert.equal(fit.when, "opentide.hasInfoCatalog");
    assert.equal(needs.when, "!opentide.hasInfoCatalog");
    assert.doesNotMatch(needs.description, /opentide\.(graph|matrix)\./);
    for (const step of steps)
      assert.doesNotMatch(`${step.description}\n${media(step)}`, /every feature works/i);
  });
});
