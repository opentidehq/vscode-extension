// Restricted Mode (#8): only the bundled language server (or the engine, WASM), no restricted setting
// read, no commands.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated, waitFor } from "../integration/helpers";

describe("Restricted Mode", () => {
  it("runs untrusted, with only the bundled runtime and no backend", async () => {
    assert.equal(vscode.workspace.isTrusted, false, "the fixture folder is untrusted");
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", "/nonexistent/opentide", vscode.ConfigurationTarget.Global);
    const api = await activated();
    const runtime = api.ctx.runtime.current;
    if (runtime) {
      // The bundled runtime when the checkout has one built, else the engine (WASM), which spawns nothing.
      assert.ok(runtime.tier === 4 || runtime.tier === 5, `tier ${runtime.tier}`);
      assert.equal(runtime.restricted, true);
      // The settings change above restarts the server: wait for the new one.
      if (runtime.tier === 5) await waitFor(() => api.ctx.client.current);
    }
    assert.ok(
      !api.ctx.runtime.attempts.some(
        (attempt) => attempt.source === "setting" && attempt.outcome !== "skipped",
      ),
    );
    assert.deepEqual(api.ctx.backend.availability(), {
      available: false,
      code: runtime ? "untrusted" : "no-runtime",
    });
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    const state = await api.ctx.catalog.refresh(folder.path, { immediate: true });
    assert.equal(state.status, "unavailable");
  });
});
