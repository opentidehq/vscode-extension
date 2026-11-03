import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated } from "./helpers";

describe("setup (#16)", () => {
  it("registers the wizard, migrate and walkthrough commands", async () => {
    await activated();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "opentide.setup.open",
      "opentide.setup.migrate",
      "opentide.setup.agents",
      "opentide.setup.step",
    ]) {
      assert.ok(commands.includes(command), command);
    }
  });

  it("contributes the walkthrough with seven steps, each with a completion event", () => {
    const extension = vscode.extensions.getExtension("opentidehq.opentide");
    assert.ok(extension);
    const manifest = extension.packageJSON as {
      contributes?: { walkthroughs?: { id: string; steps: { completionEvents?: string[] }[] }[] };
    };
    const walkthroughs = manifest.contributes?.walkthroughs;
    const walkthrough = walkthroughs?.find((w) => w.id === "opentide.gettingStarted");
    assert.equal(walkthrough?.steps.length, 7);
    for (const step of walkthrough?.steps ?? []) assert.ok((step.completionEvents ?? []).length > 0);
  });

  it("opens the wizard on the fixture repository (an existing workspace)", async () => {
    const api = await activated();
    if (!api.ctx.runtime.current) return;
    await vscode.commands.executeCommand("opentide.setup.open", api.ctx.folders.all[0]?.path);
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.label === "Set Up opentide");
    assert.ok(tab, "the wizard panel is open");
  });
});
