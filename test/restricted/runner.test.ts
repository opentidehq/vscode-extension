// Restricted Mode (#6, #7): no opentide task, and the runner's commands run nothing.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { OpentideTaskProvider } from "../../src/features/runner/taskProvider";
import { activated } from "../integration/helpers";

describe("Restricted Mode: runner and agents", () => {
  it("provides no opentide task and records no run", async () => {
    const api = await activated();
    assert.equal(vscode.workspace.isTrusted, false);
    // vscode.tasks.fetchTasks asks for workspace trust in a modal first, which nobody answers here: ask
    // the provider the extension registers.
    assert.deepEqual(await new OpentideTaskProvider(api.ctx).provideTasks(), []);
    const before = api.ctx.activity.list().length;
    // Says why in a notification, and runs nothing.
    await vscode.commands.executeCommand("opentide.runner.run", { argv: ["validate"] });
    assert.equal(api.ctx.activity.list().length, before);
  });
});
