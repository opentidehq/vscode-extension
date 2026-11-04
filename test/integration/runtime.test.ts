// Needs a real opentide: OPENTIDE_TEST_BIN. Skipped otherwise.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated, fixture, waitFor } from "./helpers";

const BIN = process.env.OPENTIDE_TEST_BIN;

describe("runtime, backend and language server (#3, #5, #12)", () => {
  before(async function () {
    if (!BIN) this.skip();
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", BIN, vscode.ConfigurationTarget.Workspace);
  });
  after(async () => {
    if (BIN)
      await vscode.workspace
        .getConfiguration("opentide")
        .update("path", undefined, vscode.ConfigurationTarget.Workspace);
  });

  it("resolves opentide.path as tier 1 and starts one language client", async () => {
    const api = await activated();
    await api.ctx.runtime.restart("test");
    assert.equal(api.ctx.runtime.current?.tier, 1);
    assert.ok(await api.ctx.client.ready());
  });

  it("runs a command through the backend and logs it in Activity", async () => {
    const api = await activated();
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    const result = await api.ctx.backend.run(folder.path, ["explain", "vocab_unknown"]);
    assert.equal(result.exitCode, 0);
    // Not necessarily the newest entry: with `info catalog` a catalogue refresh can start meanwhile.
    const entry = api.ctx.activity
      .list()
      .find((e) => e.argvDisplay === "opentide --json explain vocab_unknown");
    assert.equal(entry?.status, "ok");
  });

  it("shows each diagnostic of an open rule once (pulled diagnostics)", async () => {
    await activated();
    const uri = fixture("objects", "rules", "suspicious-lsass-access.yaml");
    await vscode.window.showTextDocument(uri);
    const diagnostics = await waitFor(() => {
      const found = vscode.languages.getDiagnostics(uri);
      return found.length > 0 ? found : undefined;
    }).catch(() => []);
    const keys = diagnostics.map((d) => `${d.range.start.line}:${String(d.code)}:${d.message}`);
    assert.equal(new Set(keys).size, keys.length);
  });
});
