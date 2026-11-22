// How long the first document opened after a language server start waits for its diagnostics, in a real VS Code, under
// whichever WASI host the label has (`wasm-wasi-core` for `wasi`, the launcher for `wasi-launcher`). It prints one
// `WASI-PERF` line per round and fails only when more than a quarter of the rounds get no diagnostics at all. Runs only with
// OPENTIDE_PERF=1 (the Test VSIX workflow sets it). docs/PACKAGING.md, "Cold start of the language server", has the numbers.
import * as assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import * as vscode from "vscode";
import { activated, fixture } from "../integration/helpers";

const ROUNDS = 8;
const IDLE_MS = 1500;
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/** A rule the server has never seen, with a misspelled TLP so it has a diagnostic of its own. */
const rule = (n: number): string => `name: Perf ${n}
metadata:
  uuid: 6d1c3a52-8f0e-4b7a-9c21-5e4f3a2b${String(n).padStart(4, "0")}
  schema: rule::1.1
  tlp: ambr
detection_model: 04149254-2a5b-4c1e-9f0e-3c1d2b5a6e7f
configurations:
  sentinel:
    query: |
      DeviceProcessEvents
      | where FileName =~ "perf-${n}.exe"
`;

/** Until the document has a diagnostic (an event, so the resolution is not a poll interval's). */
function firstDiagnostics(uri: vscode.Uri): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listener.dispose();
      reject(new Error(`no diagnostics for ${uri.fsPath} in 30 s`));
    }, 30_000);
    const listener = vscode.languages.onDidChangeDiagnostics((event) => {
      if (!event.uris.some((u) => u.toString() === uri.toString())) return;
      if (vscode.languages.getDiagnostics(uri).length === 0) return;
      clearTimeout(timer);
      listener.dispose();
      resolve();
    });
  });
}

describe("language server cold start: the first document after a start", function () {
  before(function () {
    if (process.env.OPENTIDE_PERF !== "1") this.skip();
  });
  this.timeout(10 * 60_000);

  it("gets its diagnostics, and how soon is printed", async () => {
    const api = await activated();
    const host = vscode.extensions.getExtension("ms-vscode.wasm-wasi-core") ? "wasm-wasi-core" : "launcher";
    const ready: number[] = [];
    const first: number[] = [];
    let timeouts = 0;
    for (let n = 1; n <= ROUNDS; n += 1) {
      const t0 = Date.now();
      await api.ctx.runtime.restart("perf");
      await api.ctx.client.ready();
      const started = Date.now() - t0;
      // The first document is opened a little after the server started, as when a person opens a rule.
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
      // The fixture's paths.toml puts rules in detections/rules/, where the server analyses them as rules.
      const uri = fixture("detections", "rules", `perf-${n}.yaml`);
      writeFileSync(uri.fsPath, rule(n));
      try {
        const diagnostics = firstDiagnostics(uri);
        const t1 = Date.now();
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        try {
          await diagnostics;
          const waited = Date.now() - t1;
          ready.push(started);
          first.push(waited);
          say(`WASI-PERF host=${host} round=${n} restart->ready=${started}ms open->diagnostics=${waited}ms`);
        } catch (error) {
          timeouts += 1;
          say(`WASI-PERF host=${host} round=${n} restart->ready=${started}ms TIMEOUT ${String(error)}`);
        }
      } finally {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        rmSync(uri.fsPath, { force: true });
      }
    }
    say(
      `WASI-PERF host=${host} median open->diagnostics ${median(first)}ms, restart->ready ${median(ready)}ms, ` +
        `${timeouts} of ${ROUNDS} rounds with no diagnostics in 30 s`,
    );
    assert.ok(timeouts <= ROUNDS / 4, `${timeouts} of ${ROUNDS} rounds got no diagnostics`);
  });
});
