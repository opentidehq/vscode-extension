import * as assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execStep, runSteps, type Step, venvSteps } from "../../src/core/runtime/venv";

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
