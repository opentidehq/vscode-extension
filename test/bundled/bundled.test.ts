// The bundled runtime in VS Code (`npx vscode-test --label bundled`). It needs a checkout whose runtime/
// holds a build (`npm run runtime:build -- --target <t>`), as CI's Windows package jobs have, and fails
// without one. On Windows 11 on Arm, VS Code (arm64) runs the package's win32-x64 runtime under emulation.
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { bundledLayout } from "../../src/core/runtime/resolve";
import { activated, EXTENSION_ID } from "../integration/helpers";

interface BuildInfo {
  readonly target: string;
  readonly runtime?: string;
  readonly opentide: string;
}

describe("the bundled runtime in VS Code", () => {
  let extensionPath = "";
  let info: BuildInfo | undefined;

  before(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is installed`);
    extensionPath = extension.extensionPath;
    const file = path.join(extensionPath, "runtime", "BUILD-INFO.json");
    assert.ok(fs.existsSync(file), `${file}: run npm run runtime:build -- --target <t> first`);
    info = JSON.parse(fs.readFileSync(file, "utf8")) as BuildInfo;
    console.log(
      `bundled: VS Code ${vscode.version} on ${process.platform}-${process.arch}, ` +
        `the ${info.target} package's ${info.runtime ?? info.target} runtime (opentide ${info.opentide})`,
    );
    await vscode.workspace
      .getConfiguration("opentide")
      .update("runtime", "bundled", vscode.ConfigurationTarget.Workspace);
    const api = await activated();
    await api.ctx.runtime.restart("test");
  });

  after(async () => {
    await vscode.workspace
      .getConfiguration("opentide")
      .update("runtime", undefined, vscode.ConfigurationTarget.Workspace);
  });

  it("resolves as tier 4, the package's own interpreter, at the version it was built with", async () => {
    const api = await activated();
    const runtime = api.ctx.runtime.current;
    assert.ok(runtime, JSON.stringify(api.ctx.runtime.attempts));
    assert.equal(runtime.tier, 4);
    assert.equal(runtime.source, "bundled");
    // The same file: VS Code may give the extension's path with another drive-letter case (d:\ and D:\),
    // which path.relative ignores on Windows.
    const python = bundledLayout(extensionPath, process.platform).python;
    assert.equal(path.relative(python, runtime.command), "", `${runtime.command} is ${python}`);
    assert.equal(runtime.version, info?.opentide);
  });

  it("starts the language server from it", async () => {
    const api = await activated();
    assert.ok(await api.ctx.client.ready());
  });

  it("reads the fixture's catalogue with info catalog", async () => {
    const api = await activated();
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    const state = await api.ctx.catalog.refresh(folder.path, { immediate: true });
    assert.equal(state.status, "ready", state.error ?? JSON.stringify(state.unavailable));
    const uuids = new Set(state.catalog?.objects.map((object) => object.uuid));
    for (const uuid of ["04149254-2a5b-4c1e-9f0e-3c1d2b5a6e7f", "ff8bf67e-64dc-460d-b5df-48db643f3560"])
      assert.ok(uuids.has(uuid), `the catalogue has ${uuid}`);
  });

  it("runs a command through the backend", async () => {
    const api = await activated();
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    const result = await api.ctx.backend.run(folder.path, ["explain", "vocab_unknown"]);
    assert.equal(result.exitCode, 0);
  });
});
