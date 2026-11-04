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
    const shown = await vscode.commands.executeCommand<{ title: string; value: string } | undefined>(
      "opentide.search.open",
      { query: "t:T1003" },
    );
    assert.deepEqual(
      shown,
      { title: "Find Detection", value: "t:T1003" },
      "the matrix's query is in the box",
    );
    const typed = await vscode.commands.executeCommand<{ value: string } | undefined>(
      "opentide.search.open",
      "lsass",
    );
    assert.equal(typed?.value, "lsass", "a keybinding's string argument is the query too");
  });
});
