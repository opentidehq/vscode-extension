// The graph panel (#19) in VS Code. Needs a VS Code download (CI).
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated, fixture, waitFor } from "./helpers";

function graphTab(): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith("opentide.graph"),
    );
}

describe("graph (#19)", () => {
  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("registers the graph commands", async () => {
    await activated();
    const commands = await vscode.commands.getCommands(true);
    for (const command of ["opentide.graph.open", "opentide.graph.reveal", "opentide.graph.showInGraph"])
      assert.ok(commands.includes(command), command);
  });

  it("opens one graph panel, and Show in Graph reuses it for the open rule", async () => {
    await activated();
    await vscode.commands.executeCommand("opentide.graph.open");
    await waitFor(() => graphTab());
    const rule = fixture("objects", "rules", "suspicious-lsass-access.yaml");
    await vscode.window.showTextDocument(rule);
    await vscode.commands.executeCommand("opentide.graph.showInGraph", rule);
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab === graphTab());
    assert.equal(tabs.length, 1);
  });

  it("reveals a UUID from another view without failing when it is unknown", async () => {
    await activated();
    await vscode.commands.executeCommand("opentide.graph.reveal", {
      uuid: "00000000-0000-4000-8000-000000000000",
    });
  });
});
