// How long the first document opened after a language server start waits for its diagnostics, in a real VS Code, under
// whichever WASI host the label has (`wasm-wasi-core` for `wasi`, the launcher for `wasi-launcher`). It prints one
// `WASI-PERF` line per round and fails only when more than a quarter of the rounds get no diagnostics at all. Runs only with
// OPENTIDE_PERF=1 (the Test VSIX workflow sets it). docs/PACKAGING.md, "Cold start of the language server", has the numbers.
import * as assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../src/extension";
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

/** What a round that got nothing looks like from the client: the shape that tells a silent server from a silent client. */
async function probe(api: Required<ExtensionApi>, uri: vscode.Uri): Promise<string> {
  const client = api.ctx.client.current;
  const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  const parts = [
    `client=${client ? String(client.state) : "none"}`,
    `document=${document ? `open v${document.version} ${document.languageId}` : "not open"}`,
    `diagnostics=${vscode.languages.getDiagnostics(uri).length}`,
  ];
  if (client) {
    const started = Date.now();
    try {
      const reply = await Promise.race([
        client.sendRequest("textDocument/documentSymbol", { textDocument: { uri: uri.toString() } }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in 5 s")), 5000)),
      ]);
      parts.push(
        `documentSymbol=answered in ${Date.now() - started}ms (${Array.isArray(reply) ? reply.length : "?"} items)`,
      );
    } catch (error) {
      parts.push(`documentSymbol=${String(error)}`);
    }
  }
  return parts.join(" ");
}

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
    // The protocol trace (every message, both ways, timestamped) goes to the "opentide Language Server Trace" output, which
    // the workflow uploads with the OPENTIDE_LSP_TIMING stderr; the markers below say which round a message belongs to.
    const trace = vscode.workspace.getConfiguration("opentide");
    const traceBefore = trace.inspect<string>("trace.server")?.globalValue;
    await trace.update("trace.server", "verbose", vscode.ConfigurationTarget.Global);
    const host = vscode.extensions.getExtension("ms-vscode.wasm-wasi-core") ? "wasm-wasi-core" : "launcher";
    const ready: number[] = [];
    const first: number[] = [];
    let timeouts = 0;
    for (let n = 1; n <= ROUNDS; n += 1) {
      const t0 = Date.now();
      api.ctx.log.info(`PERF-ROUND host=${host} round=${n} restart ${new Date(t0).toISOString()}`);
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
        api.ctx.log.info(
          `PERF-ROUND host=${host} round=${n} open ${new Date(t1).toISOString()} ${uri.toString()}`,
        );
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        try {
          await diagnostics;
          const waited = Date.now() - t1;
          api.ctx.log.info(`PERF-ROUND host=${host} round=${n} diagnostics after ${waited}ms`);
          ready.push(started);
          first.push(waited);
          say(`WASI-PERF host=${host} round=${n} restart->ready=${started}ms open->diagnostics=${waited}ms`);
        } catch (error) {
          timeouts += 1;
          const shape = await probe(api, uri);
          api.ctx.log.warn(`PERF-ROUND host=${host} round=${n} TIMEOUT ${shape}`);
          say(
            `WASI-PERF host=${host} round=${n} restart->ready=${started}ms TIMEOUT ${String(error)}; ${shape}`,
          );
        }
      } finally {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        rmSync(uri.fsPath, { force: true });
      }
    }
    await trace.update("trace.server", traceBefore, vscode.ConfigurationTarget.Global);
    say(
      `WASI-PERF host=${host} median open->diagnostics ${median(first)}ms, restart->ready ${median(ready)}ms, ` +
        `${timeouts} of ${ROUNDS} rounds with no diagnostics in 30 s`,
    );
    assert.ok(timeouts <= ROUNDS / 4, `${timeouts} of ${ROUNDS} rounds got no diagnostics`);
  });
});
