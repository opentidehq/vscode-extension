// Restricted Mode (#8): only the engine (WASM), no restricted setting read, no commands.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated, waitFor } from "../integration/helpers";

describe("Restricted Mode", () => {
  it("runs untrusted, with only the engine (WASM) and no backend", async () => {
    assert.equal(vscode.workspace.isTrusted, false, "the fixture folder is untrusted");
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", "/nonexistent/opentide", vscode.ConfigurationTarget.Global);
    const api = await activated();
    const runtime = api.ctx.runtime.current;
    if (runtime) {
      // The engine (WASM), which spawns nothing.
      assert.equal(runtime.kind, "engine");
      assert.equal(runtime.restricted, true);
      // The settings change above restarts the server: wait for the new one.
      await waitFor(() => api.ctx.client.current);
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
