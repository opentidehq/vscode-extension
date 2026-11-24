import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { activated } from "./helpers";

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * SPEC §14's budget for `activate`: 300 ms, a real VS Code on a developer machine with the shipped (minified) bundle.
 * CI runs the unminified bundle, which V8 compiles lazily on each first call, on shared VMs. Observed there (the
 * ACTIVATION lines of CI runs): linux 18-65 ms, macOS 35-126 ms, Windows 50-569 ms with the same code from run to run
 * (368, 522, 569, 409 and 82, 50). So Linux and macOS keep the 300 ms, and Windows, where a runner alone ranges
 * over an order of magnitude, is allowed 750 ms: a regression of the kind this test exists for (a process start, a
 * synchronous read of the workspace) is seconds, not hundreds of milliseconds.
 */
const BUDGET_MS = process.platform === "win32" ? 750 : 300;

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
    // Each feature's own synchronous time, in the order they activate.
    say(
      `ACTIVATION platform=${process.platform} total=${ms(times.totalMs)} core=${ms(times.coreMs)} ` +
        `features=${ms(times.featuresMs)} start=${ms(times.startMs)} settle=${ms(times.settleMs)}`,
    );
    say(
      `ACTIVATION features ${times.features.map((feature) => `${feature.id} ${ms(feature.ms)}`).join(", ")}`,
    );
    assert.ok(times.totalMs < BUDGET_MS, `activate took ${ms(times.totalMs)}, the budget is ${BUDGET_MS} ms`);
  });

  it("restarts the language server and the backend on opentide: Restart Server", async () => {
    const api = await activated();
    await vscode.commands.executeCommand("opentide.restartServer");
    if (api.ctx.runtime.current) assert.ok(await api.ctx.client.ready());
  });
});
