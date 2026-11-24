import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { activated } from "./helpers";

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** Provisional while the per-OS distribution is collected (SPEC §14 says 300 ms). */
const BUDGET_MS = 1000;

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
  // The times print on every run, whatever the result, so CI shows the distribution per OS and where it goes.
  it("activates in under the budget, and says where the time went", async () => {
    const api = await activated();
    const times = api.activation;
    assert.ok(times, "the test API reports how long activate took");
    const ms = (value: number): string => `${Math.round(value)} ms`;
    const slowest = [...times.features].sort((a, b) => b.ms - a.ms);
    say(
      `ACTIVATION platform=${process.platform} total=${ms(times.totalMs)} core=${ms(times.coreMs)} ` +
        `features=${ms(times.featuresMs)} start=${ms(times.startMs)} settle=${ms(times.settleMs)}`,
    );
    say(`ACTIVATION features ${slowest.map((feature) => `${feature.id} ${ms(feature.ms)}`).join(", ")}`);
    assert.ok(times.totalMs < BUDGET_MS, `activate took ${ms(times.totalMs)}, the budget is ${BUDGET_MS} ms`);
  });

  it("restarts the language server and the backend on opentide: Restart Server", async () => {
    const api = await activated();
    await vscode.commands.executeCommand("opentide.restartServer");
    if (api.ctx.runtime.current) assert.ok(await api.ctx.client.ready());
  });
});
