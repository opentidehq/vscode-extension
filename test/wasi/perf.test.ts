// Cold start of the language server in a real VS Code, with and without the warm-up (src/core/lsp/warmup.ts): how long
// the first document opened a little after a server start waits for its diagnostics. It prints one `WASI-PERF` line per
// round and asserts only that the warm-up does not make it slower. Runs only with OPENTIDE_PERF=1 (the Test VSIX workflow
// sets it); the hosts it reports are the two the `wasi` and `wasi-launcher` labels use.
import * as assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import * as vscode from "vscode";
import { activated, fixture } from "../integration/helpers";

const ROUNDS = 4;
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

/** From `opened` until the document has a diagnostic (an event, so the resolution is not a poll interval's). */
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

describe("language server cold start, with and without the warm-up", function () {
  before(function () {
    if (process.env.OPENTIDE_PERF !== "1") this.skip();
  });
  this.timeout(10 * 60_000);

  it("the first document after a server start gets its diagnostics sooner with the warm-up", async () => {
    const api = await activated();
    const host = vscode.extensions.getExtension("ms-vscode.wasm-wasi-core") ? "wasm-wasi-core" : "launcher";
    const config = vscode.workspace.getConfiguration("opentide.languageServer");
    const result: Record<string, { ready: number[]; first: number[] }> = {};
    let n = 0;
    try {
      for (const warmUp of [false, true, false, true]) {
        const key = String(warmUp);
        result[key] ??= { ready: [], first: [] };
        await config.update("warmUp", warmUp, vscode.ConfigurationTarget.Global);
        for (let round = 1; round <= ROUNDS; round += 1) {
          const t0 = Date.now();
          await api.ctx.runtime.restart("perf");
          await api.ctx.client.ready();
          const ready = Date.now() - t0;
          // The first document is opened a little after the server started, as when a person opens a rule.
          await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
          n += 1;
          // The fixture's paths.toml puts rules in detections/rules/, which is where the server analyses them as rules.
          const uri = fixture("detections", "rules", `perf-${n}.yaml`);
          writeFileSync(uri.fsPath, rule(n));
          try {
            const diagnostics = firstDiagnostics(uri);
            const t1 = Date.now();
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
            await diagnostics;
            const first = Date.now() - t1;
            result[key]?.ready.push(ready);
            result[key]?.first.push(first);
            say(
              `WASI-PERF host=${host} warmUp=${warmUp} round=${round} restart->ready=${ready}ms open->diagnostics=${first}ms`,
            );
          } finally {
            await vscode.commands.executeCommand("workbench.action.closeAllEditors");
            rmSync(uri.fsPath, { force: true });
          }
        }
      }
    } finally {
      await config.update("warmUp", undefined, vscode.ConfigurationTarget.Global);
    }
    const off = median(result.false?.first ?? []);
    const on = median(result.true?.first ?? []);
    say(
      `WASI-PERF host=${host} median open->diagnostics: warmUp=false ${off}ms, warmUp=true ${on}ms; ` +
        `median restart->ready: false ${median(result.false?.ready ?? [])}ms, true ${median(result.true?.ready ?? [])}ms`,
    );
    // Not a benchmark gate: the warm-up must not make the first document slower.
    assert.ok(on <= off + 100, `warm-up first document ${on} ms, without ${off} ms`);
  });
});
