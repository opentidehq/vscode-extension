// The @opentide/opentide a platform VSIX carries, in VS Code: the extension host's own executable
// (Electron, as Node.js) runs dist/opentide/cli.js, with no Python and no opentide.path. Runs when the
// build staged dist/opentide (OPENTIDE_NPM=<dir> npm run build); skipped otherwise.
import * as assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { activated } from "./helpers";

const ROOT = path.join(__dirname, "..", "..", "..");
const MANIFEST = path.join(ROOT, "dist", "opentide", "opentide.json");

describe("the bundled @opentide/opentide (tier 2, no Python)", () => {
  before(async function () {
    if (!existsSync(MANIFEST)) this.skip();
    const config = vscode.workspace.getConfiguration("opentide");
    await config.update("path", undefined, vscode.ConfigurationTarget.Workspace);
    await config.update("interpreter", undefined, vscode.ConfigurationTarget.Workspace);
    const api = await activated();
    await api.ctx.runtime.restart("bundled package test");
  });

  it("resolves the package, run by the extension host's executable", async () => {
    const api = await activated();
    const runtime = api.ctx.runtime.current;
    const version = (JSON.parse(readFileSync(MANIFEST, "utf8")) as { version: string }).version;
    assert.equal(runtime?.source, "package", JSON.stringify(api.ctx.runtime.attempts));
    assert.equal(runtime?.version, version);
    assert.equal(runtime?.command, process.execPath);
    assert.equal(runtime?.interpreter, undefined);
  });

  it("starts the language server and runs commands through the backend", async () => {
    const api = await activated();
    assert.ok(await api.ctx.client.ready());
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    const result = await api.ctx.backend.run(folder.path, ["explain", "vocab_unknown"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.document.ok, true);
  });
});
