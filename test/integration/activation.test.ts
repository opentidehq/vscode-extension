import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { overlapMs } from "../../src/core/activationClock";
import { activated } from "./helpers";

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * SPEC §14's budget for `activate`: 300 ms, a real VS Code on a developer machine with the shipped (minified) bundle.
 * CI runs the unminified bundle, which V8 compiles lazily on each first call, on shared VMs. Observed there (the
 * ACTIVATION lines of 26 CI runs, 2026-11-24): ubuntu stable median 26 ms, max 48; macOS stable median 76, max 136;
 * Windows stable median 122, p90 358, max 820; Windows floor (1.91) median 50, max 82. On Windows nearly all the
 * spread is in the features' synchronous time, landing on whichever feature runs (sidebar 442 in one run, new-object
 * 104 in another) while the same feature takes 7-20 ms most runs, and while 1.91 on the same runners never passes
 * 82 ms; activate's synchronous part does nine small file reads in all. So Linux and macOS keep the 300 ms, and
 * Windows is allowed 750 ms (about its p96): a regression of the kind this test exists for (a process start, a
 * synchronous read of the workspace) is seconds, not hundreds of milliseconds. The CPU and GC figures printed with
 * the times tell such a spike (wall time well above CPU, or GC) from our own code (CPU less GC).
 */
const BUDGET_MS = process.platform === "win32" ? 750 : 300;

/**
 * VS Code Insiders is measured too, but it runs its own pre-release work in the same window while we activate (the
 * logs show its agent host and chat model selection), so its numbers say little about ours: the same commit measured
 * 849 ms on macOS (diagnostics 398 ms) and 1429 ms on Windows (sidebar 734 ms) on Insiders, and 270 ms and under the
 * Windows budget on stable. Insiders gets 2 s: still well under the seconds a process start or a synchronous
 * workspace read would cost, which is the regression this test is for. Stable and the floor keep the budgets above.
 */
const INSIDERS_BUDGET_MS = 2000;
const budgetMs = (): number => (vscode.version.includes("insider") ? INSIDERS_BUDGET_MS : BUDGET_MS);

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
    // Besides wall time: this thread's CPU (where Node has a per-thread clock), and the GC pauses that fell inside.
    // Wall well above CPU is time the thread did not run: blocking I/O, or the runner running something else. GC is
    // the collector's work for every extension in the host. Only CPU less GC is our own code.
    const pauses = times.gcPauses?.() ?? [];
    const parts = (span: { at: number; ms: number }, cpuMs: number | undefined): string => {
      const gcMs = overlapMs(span, pauses);
      return [
        ...(cpuMs !== undefined ? [`cpu ${Math.round(cpuMs)}`] : []),
        ...(times.gcPauses ? [`gc ${Math.round(gcMs)}`] : []),
      ].join(", ");
    };
    const summary = parts(times.span, times.cpuMs);
    say(
      `ACTIVATION platform=${process.platform} total=${ms(times.totalMs)} core=${ms(times.coreMs)} ` +
        `features=${ms(times.featuresMs)} start=${ms(times.startMs)} settle=${ms(times.settleMs)}` +
        (summary
          ? ` (${summary}; ${pauses.filter((p) => overlapMs(times.span, [p]) > 0).length} GC pauses)`
          : ""),
    );
    // Where `core` went: `createCore`'s steps (the folder scan reads the workspace synchronously).
    say(`ACTIVATION core ${times.coreSteps.map((step) => `${step.name} ${ms(step.ms)}`).join(", ")}`);
    // Each feature's own synchronous time, in the order they activate.
    say(
      `ACTIVATION features ${times.features
        .map((feature) => {
          const detail = parts(feature, feature.cpuMs);
          return `${feature.id} ${ms(feature.ms)}${detail ? ` (${detail})` : ""}`;
        })
        .join(", ")}`,
    );
    const budget = budgetMs();
    say(`ACTIVATION vscode=${vscode.version} budget=${budget} ms`);
    assert.ok(times.totalMs < budget, `activate took ${ms(times.totalMs)}, the budget is ${budget} ms`);
  });

  it("restarts the language server and the backend on opentide: Restart Server", async () => {
    const api = await activated();
    await vscode.commands.executeCommand("opentide.restartServer");
    if (api.ctx.runtime.current) assert.ok(await api.ctx.client.ready());
  });
});
