import * as assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { usePinnedVersion } from "../../src/core/runtime/pinned";
import type { ResolveAttempt, Runtime } from "../../src/core/runtime/types";
import { execStep, runSteps, type Step, venvSteps } from "../../src/core/runtime/venv";
import { fakeRuntime } from "./helpers";

describe("runtime: creating the pinned .venv", () => {
  it("is two processes with no shell, so a quoted path or PowerShell 5.1 does not matter", () => {
    assert.deepEqual(venvSteps("C:\\Program Files\\uv\\uv.exe", "0.21.0"), [
      { command: "C:\\Program Files\\uv\\uv.exe", args: ["venv", ".venv"] },
      {
        command: "C:\\Program Files\\uv\\uv.exe",
        args: ["pip", "install", "--python", ".venv", "opentide==0.21.0"],
      },
    ]);
  });

  it("stops at the first step that fails and says which", async () => {
    const ran: Step[] = [];
    const result = await runSteps(venvSteps("uv", "0.21.0"), "/ws", async (step) => {
      ran.push(step);
      return { code: step.args[0] === "venv" ? 2 : 0, output: "" };
    });
    assert.equal(ran.length, 1);
    assert.deepEqual(result, { ok: false, step: ran[0], code: 2 });
    assert.deepEqual(
      await runSteps(venvSteps("uv", "0.21.0"), "/ws", async () => ({ code: 0, output: "" })),
      { ok: true },
    );
  });

  it("runs a real process, and reports one that cannot start", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "otide-venv-"));
    const ok = await execStep({ command: process.execPath, args: ["-e", "process.stdout.write('hi')"] }, cwd);
    assert.deepEqual(ok, { code: 0, output: "hi" });
    const missing = await execStep({ command: path.join(cwd, "no-such-uv"), args: [] }, cwd);
    assert.notEqual(missing.code, 0);
  });
});

describe("runtime: Use the pinned version", () => {
  const off: ResolveAttempt = {
    tier: 3,
    source: "uv",
    outcome: "skipped",
    detail: "opentide.uv.usePin is off",
  };

  /** A runtime whose resolution reads the setting, as the real one does. */
  function runtimeWith(afterEnable: { current: Runtime; attempts: ResolveAttempt[] }) {
    let enabled = false;
    const order: string[] = [];
    const runtime = {
      current: fakeRuntime({ source: "bundled", tier: 4 }) as Runtime | undefined,
      attempts: [off] as readonly ResolveAttempt[],
      async restart() {
        order.push(enabled ? "restart with usePin" : "restart without usePin");
        if (enabled) {
          runtime.current = afterEnable.current;
          runtime.attempts = afterEnable.attempts;
        }
      },
    };
    const enable = async () => {
      order.push("enable");
      enabled = true;
    };
    return { runtime, enable, order };
  }

  it("resolves again with the setting on, and says nothing once uv runs", async () => {
    const uv = fakeRuntime({ source: "uv", tier: 3, version: "0.20.1" });
    const { runtime, enable, order } = runtimeWith({
      current: uv,
      attempts: [{ tier: 3, source: "uv", outcome: "ok", detail: "uv 0.20.1" }],
    });
    assert.equal(await usePinnedVersion(runtime, enable), undefined);
    assert.deepEqual(order, ["enable", "restart with usePin"]);
  });

  it("warns with the new resolution's reason, never the stale 'usePin is off'", async () => {
    const { runtime, enable } = runtimeWith({
      current: fakeRuntime({ source: "bundled", tier: 4 }),
      attempts: [{ tier: 3, source: "uv", outcome: "missing", detail: "uv is not on PATH" }],
    });
    assert.equal(
      await usePinnedVersion(runtime, enable),
      "Could not use the pinned version with uv: uv is not on PATH",
    );
  });
});
