// New objects and placeholders (#14) in VS Code. Needs a VS Code download (CI).
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated } from "./helpers";

describe("new objects and placeholders (#14)", () => {
  it("registers opentide.newObject and the placeholder commands", async () => {
    await activated();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "opentide.newObject",
      "opentide.newObject.rule",
      "opentide.newObject.ruleForObjective",
      "opentide.placeholder.next",
      "opentide.placeholder.previous",
    ])
      assert.ok(commands.includes(id), id);
  });

  it("Next placeholder visits every marked line and selects its value", async () => {
    await activated();
    const document = await vscode.workspace.openTextDocument({
      language: "opentide-yaml",
      content: [
        "name: x",
        "description: |  # opentide:placeholder",
        "  ...",
        "scheduling:",
        "  frequency: 1h  # opentide:placeholder",
        "",
      ].join("\n"),
    });
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand("opentide.placeholder.next");
    assert.equal(document.getText(editor.selection), "...");
    await vscode.commands.executeCommand("opentide.placeholder.next");
    assert.equal(document.getText(editor.selection), "1h");
    await vscode.commands.executeCommand("opentide.placeholder.next");
    assert.equal(document.getText(editor.selection), "...", "wraps to the first");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });
});
