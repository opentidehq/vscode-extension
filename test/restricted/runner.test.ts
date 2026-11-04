// Restricted Mode (#6, #7): no opentide task, and the runner's commands run nothing.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated } from "../integration/helpers";

describe("Restricted Mode: runner and agents", () => {
  it("provides no opentide task and records no run", async () => {
    const api = await activated();
    assert.equal(vscode.workspace.isTrusted, false);
    assert.deepEqual(await vscode.tasks.fetchTasks({ type: "opentide" }), []);
    const before = api.ctx.activity.list().length;
    // Says why in a notification, and runs nothing.
    await vscode.commands.executeCommand("opentide.runner.run", { argv: ["validate"] });
    assert.equal(api.ctx.activity.list().length, before);
  });
});
