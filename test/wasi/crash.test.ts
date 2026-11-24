// The bundled opentide's language server (WASI) keeps crashing: the client restarts it after a growing wait, and
// at the fifth crash in three minutes the engine (WASM) serves the editor features instead (restartPolicy.ts).
// The server is ended the way a crash ends it for the client: its `exit` notification stops the process with no
// `shutdown` first, so the connection closes under a running client.
import * as assert from "node:assert/strict";
import * as path from "node:path";

import * as vscode from "vscode";

import { BACKOFF_MS, CRASH_CEILING } from "../../src/core/lsp/restartPolicy";
import type { LanguageClientManager } from "../../src/core/services/languageClient";
import { activated, fixture, waitFor } from "../integration/helpers";

const ROOT = path.join(__dirname, "..", "..", "..");

describe("a language server that keeps crashing", function () {
  this.timeout(3 * 60_000);
  before(() =>
    vscode.workspace
      .getConfiguration("opentide")
      .update("path", path.join(ROOT, "no-such-dir", "opentide"), vscode.ConfigurationTarget.Global),
  );
  after(async () => {
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", undefined, vscode.ConfigurationTarget.Global);
    const api = await activated();
    await api.ctx.runtime.restart("crash test: done");
  });

  it("restarts it with a growing wait, then the engine (WASM) takes over at the fifth crash", async () => {
    const api = await activated();
    await api.ctx.runtime.restart("crash test");
    const manager = api.ctx.client as LanguageClientManager;
    assert.equal(api.ctx.runtime.current?.source, "wasi", JSON.stringify(api.ctx.runtime.attempts));
    // The bundled module runs the language server, not the engine: a runtime of kind `opentide` with `wasi` set.
    assert.equal(manager.serverRuntime?.kind, "opentide", JSON.stringify(manager.serverRuntime));
    assert.ok(manager.serverRuntime?.wasi, "the WASI module's language server runs");
    const events: { at: number; up: boolean }[] = [];
    const watch = api.ctx.client.onDidChange((client) =>
      events.push({ at: Date.now(), up: client !== undefined }),
    );
    try {
      for (let crash = 1; crash <= CRASH_CEILING; crash += 1) {
        const running = await waitFor(() => api.ctx.client.current, 45_000);
        await running.sendNotification("exit").catch(() => undefined);
        // The client has noticed: nothing answers until the restart (or the engine) does.
        await waitFor(() => (api.ctx.client.current === undefined ? true : undefined), 15_000);
        if (crash < CRASH_CEILING) await waitFor(() => api.ctx.client.current, 45_000);
      }
      // After the ceiling the engine runs, and says why it does.
      const engine = await waitFor(
        () =>
          manager.serverRuntime?.kind === "engine" && api.ctx.client.current
            ? manager.serverRuntime
            : undefined,
        60_000,
      );
      assert.equal(engine.kind, "engine");
      assert.equal(
        manager.fallback?.crashed,
        true,
        "the fallback is recorded as crashes, not as a start that failed",
      );
      assert.match(manager.fallback?.reason ?? "", /crashed 5 times in 3 minutes/);
      const attempts = api.ctx.runtime.attempts;
      assert.ok(
        attempts.some((a) => a.outcome === "failed" && /stopped repeatedly/.test(a.detail)),
        JSON.stringify(attempts),
      );
      assert.ok(
        attempts.some((a) => a.tier === 5 && a.outcome === "ok"),
        JSON.stringify(attempts),
      );
      // The commands still run on the bundled opentide: only the editor features moved to the engine.
      assert.equal(api.ctx.runtime.current?.source, "wasi");
      // Looking for a user's own opentide again (a new .venv, or the window getting the focus back) resolves the
      // runtime again, without a restart: the engine still serves, and the attempts still say why.
      const before = api.ctx.runtime.attempts;
      const venv = fixture(".venv", "recheck-marker");
      await vscode.workspace.fs.writeFile(venv, new Uint8Array());
      try {
        await waitFor(() => (api.ctx.runtime.attempts !== before ? true : undefined), 30_000);
        const again = api.ctx.runtime.attempts;
        assert.ok(
          again.some((a) => a.outcome === "failed" && /stopped repeatedly/.test(a.detail)),
          JSON.stringify(again),
        );
        assert.ok(
          again.some((a) => a.tier === 5 && a.outcome === "ok"),
          JSON.stringify(again),
        );
        assert.equal(manager.serverRuntime?.kind, "engine", "the engine still serves");
      } finally {
        await vscode.workspace.fs.delete(fixture(".venv"), { recursive: true });
      }
    } finally {
      watch.dispose();
    }
    // Each restart waited at least its backoff: a down event, then the next up.
    const gaps: number[] = [];
    for (let i = 0; i < events.length; i += 1) {
      const down = events[i];
      if (!down || down.up || events[i - 1]?.up === false) continue;
      const up = events.slice(i + 1).find((event) => event.up);
      if (up) gaps.push(up.at - down.at);
    }
    for (const [n, wait] of BACKOFF_MS.entries()) {
      const gap = gaps[n];
      assert.ok(
        gap !== undefined && gap >= wait - 100,
        `restart ${n + 1} came after ${gap} ms, wanted ${wait}: ${gaps}`,
      );
    }
    // The editor features work on the engine.
    const uri = fixture("detections", "rules", "misspelled-tlp.yaml");
    await vscode.window.showTextDocument(uri);
    await waitFor(() => (vscode.languages.getDiagnostics(uri).length > 0 ? true : undefined), 45_000);
  });
});
