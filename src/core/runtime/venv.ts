// Creating the workspace's .venv with the pinned opentide: `uv venv .venv`, then `uv pip install`. Run as
// processes, with no shell, so the same steps work under cmd, PowerShell 5.1 (no `&&`) and POSIX shells,
// and a path with spaces needs no quoting. vscode-free.
import { execFile } from "node:child_process";

export interface Step {
  readonly command: string;
  readonly args: readonly string[];
}

export function venvSteps(uv: string, version: string): Step[] {
  return [
    { command: uv, args: ["venv", ".venv"] },
    { command: uv, args: ["pip", "install", "--python", ".venv", `opentide==${version}`] },
  ];
}

export type StepRunner = (
  step: Step,
  cwd: string,
) => Promise<{ readonly code: number; readonly output: string }>;

/** A step through child_process.execFile; a missing command is code -1. */
export const execStep: StepRunner = (step, cwd) =>
  new Promise((resolve) => {
    execFile(
      step.command,
      [...step.args],
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        if (!error) return resolve({ code: 0, output });
        const code = typeof error.code === "number" ? error.code : -1;
        resolve({ code, output: output || error.message });
      },
    );
  });

/** Run the steps in order, stopping at the first that fails. */
export async function runSteps(
  steps: readonly Step[],
  cwd: string,
  run: StepRunner = execStep,
  onOutput: (step: Step, output: string) => void = () => undefined,
): Promise<{ ok: true } | { ok: false; step: Step; code: number }> {
  for (const step of steps) {
    const { code, output } = await run(step, cwd);
    onOutput(step, output);
    if (code !== 0) return { ok: false, step, code };
  }
  return { ok: true };
}
