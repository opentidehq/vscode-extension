// Find Detection (#21) in VS Code. Needs a VS Code download (CI).
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated } from "./helpers";

describe("search (#21)", () => {
  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  });

  it("registers Find Detection", async () => {
    await activated();
    assert.ok((await vscode.commands.getCommands(true)).includes("opentide.search.open"));
  });

  it("opens Find Detection with a query from the matrix", async () => {
    await activated();
    await vscode.commands.executeCommand("opentide.search.open", { query: "t:T1003" });
  });
});
