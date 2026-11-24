import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { activated } from "./helpers";

describe("activation (#2)", () => {
  it("activates on workspaceContains:.opentide/** and registers the core commands", async () => {
    const api = await activated();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "opentide.restartServer",
      "opentide.showOutput",
      "opentide.switchRuntime",
      "opentide.showReferences",
    ]) {
      assert.ok(commands.includes(command), command);
    }
    assert.equal(api.ctx.folders.all.length, 1);
    assert.equal(api.ctx.trust.isTrusted, true);
  });

  // SPEC §14: activation until the commands and views are registered, with no process start on the critical path.
  it("activates in under 300 ms", async () => {
    const api = await activated();
    assert.ok(typeof api.activationMs === "number", "the test API reports how long activate took");
    assert.ok(api.activationMs < 300, `activate took ${api.activationMs} ms`);
  });

  it("restarts the language server and the backend on opentide: Restart Server", async () => {
    const api = await activated();
    await vscode.commands.executeCommand("opentide.restartServer");
    if (api.ctx.runtime.current) assert.ok(await api.ctx.client.ready());
  });
});
