// The graph panel (#19) in VS Code. Needs a VS Code download (CI).
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { GraphPanelStatus } from "../../src/features/graph/state";
import { activated, fixture, waitFor } from "./helpers";

/** Every graph panel's tab, in every editor group. */
function graphTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith("opentide.graph"),
    );
}

function graphTab(): vscode.Tab | undefined {
  return graphTabs()[0];
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
    // A second panel would open asynchronously: give it the time to show up before counting.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(graphTabs().length, 1, "Show in Graph reused the panel instead of opening another");
  });

  it("opens Show in Graph beside the editor, leaves the focus there, and follows the active editor", async () => {
    await activated();
    // A catalogued rule: the fixture's rule folder is detections/rules/ (paths.toml), and with `info
    // catalog` Show in Graph on a file outside the catalogue has no object to show.
    const rule = fixture("detections", "rules", "custom-folder-rule.yaml");
    const objective = fixture("objects", "objectives", "detect-lsass-access.yaml");
    // The graph is on an object: its UUID once the catalogue has loaded, its file before (or without).
    const on = async (target: string | undefined, uri: vscode.Uri): Promise<boolean> => {
      const uuid = /uuid:\s*(\S+)/.exec((await vscode.workspace.openTextDocument(uri)).getText())?.[1];
      return target === uri.fsPath || (uuid !== undefined && target === uuid);
    };
    const editor = await vscode.window.showTextDocument(rule, { viewColumn: vscode.ViewColumn.One });
    const shown = await vscode.commands.executeCommand<GraphPanelStatus>("opentide.graph.showInGraph", rule);
    const tab = await waitFor(() => graphTab());
    assert.notEqual(tab.group.viewColumn, editor.viewColumn, "the graph opened beside the editor");
    assert.equal(
      vscode.window.activeTextEditor?.document.uri.toString(),
      rule.toString(),
      "the editor kept the focus",
    );
    assert.ok(shown?.following, "it follows the editor by default");
    assert.ok(await on(shown?.target, rule), `on the rule, not ${shown?.target}`);

    await vscode.window.showTextDocument(objective, { viewColumn: vscode.ViewColumn.One });
    const followed = await waitFor(async () => {
      const status = await vscode.commands.executeCommand<GraphPanelStatus>("opentide.graph.reveal");
      return status && (await on(status.target, objective)) ? status : undefined;
    });
    assert.equal(followed.viewColumn, tab.group.viewColumn, "it stayed in its group");
    assert.equal(graphTabs().length, 1, "and retargeted the same panel");

    // Asked again from the objective's editor: still beside, never over the YAML.
    await vscode.commands.executeCommand("opentide.graph.showInGraph");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(graphTabs().length, 1);
    assert.notEqual(graphTab()?.group.viewColumn, vscode.window.activeTextEditor?.viewColumn);
  });

  it("reveals a UUID from another view without failing when it is unknown", async () => {
    await activated();
    await vscode.commands.executeCommand("opentide.graph.reveal", {
      uuid: "00000000-0000-4000-8000-000000000000",
    });
  });
});
