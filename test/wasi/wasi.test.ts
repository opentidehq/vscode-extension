// Desktop VS Code with no opentide anywhere and the WASI module the extension carries as the runtime
// (tier 4): `serve` and the language server run through the launcher (VS Code's Node) by default, and under
// @vscode/wasm-wasi (the ms-vscode.wasm-wasi-core extension, which the `wasi` label installs) when asked, with the
// workspace mounted. .vscode-test.mjs's
// `wasi` label takes every folder holding an opentide executable off PATH, as the `engine` label does.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { activated, fixture, waitFor } from "../integration/helpers";

const ROOT = path.join(__dirname, "..", "..", "..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "dist", "wasi", "wasi.json"), "utf8")) as {
  version: string;
};

describe("the bundled opentide is the default runtime", () => {
  it("runs with nothing set: opentide.runtime and opentide.path at their defaults", async () => {
    const config = vscode.workspace.getConfiguration("opentide");
    await config.update("path", undefined, vscode.ConfigurationTarget.Global);
    await config.update("runtime", undefined, vscode.ConfigurationTarget.Global);
    const api = await activated();
    await api.ctx.runtime.restart("wasi default test");
    const runtime = api.ctx.runtime.current;
    assert.equal(runtime?.source, "wasi", JSON.stringify(api.ctx.runtime.attempts));
    const first = api.ctx.runtime.attempts.find((a) => a.tier === 1);
    assert.match(first?.detail ?? "", /opentide\.runtime is at its default, bundled/);
  });
});

// #100: first problems on 1,000 rules took 10.6 s under @vscode/wasm-wasi and 4.5 s through the launcher, so the launcher is
// the default wherever it runs. The `wasi` label installs ms-vscode.wasm-wasi-core, `wasi-launcher` does not.
describe("which host runs the bundled module (#100)", () => {
  const WASM_WASI_CORE = "ms-vscode.wasm-wasi-core";
  const installed = (): boolean => vscode.extensions.getExtension(WASM_WASI_CORE) !== undefined;
  const setHost = (value: string | undefined): Thenable<void> =>
    vscode.workspace
      .getConfiguration("opentide.wasi")
      .update("host", value, vscode.ConfigurationTarget.Global);
  const restart = async (reason: string) => {
    const api = await activated();
    await api.ctx.runtime.restart(reason);
    assert.ok(await api.ctx.client.ready(), "the language client runs");
    return api;
  };
  const noInstalledOpentide = (): Thenable<void> =>
    vscode.workspace
      .getConfiguration("opentide")
      .update("path", path.join(ROOT, "no-such-dir", "opentide"), vscode.ConfigurationTarget.Global);
  before(noInstalledOpentide);
  after(async () => {
    await setHost(undefined);
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", undefined, vscode.ConfigurationTarget.Global);
  });

  it("runs the launcher with opentide.wasi.host at its default, whether or not ms-vscode.wasm-wasi-core is installed", async () => {
    await setHost(undefined);
    const api = await restart("wasi host: default");
    assert.equal(api.wasiHost(), "launcher", `wasm-wasi-core installed: ${installed()}`);
  });

  it("runs the launcher when opentide.wasi.host says launcher", async () => {
    await setHost("launcher");
    const api = await restart("wasi host: launcher");
    assert.equal(api.wasiHost(), "launcher");
  });

  it("runs under @vscode/wasm-wasi when opentide.wasi.host asks for it and ms-vscode.wasm-wasi-core is installed", async function () {
    if (!installed()) this.skip();
    await setHost("wasm-wasi");
    const api = await restart("wasi host: wasm-wasi");
    assert.equal(api.wasiHost(), "wasm-wasi");
    const uri = fixture("detections", "rules", "misspelled-tlp.yaml");
    await vscode.window.showTextDocument(uri);
    await waitFor(() => (vscode.languages.getDiagnostics(uri).length > 0 ? true : undefined));
  });

  it("falls back to the launcher when opentide.wasi.host asks for wasm-wasi and the extension is not installed", async function () {
    if (installed()) this.skip();
    await setHost("wasm-wasi");
    const api = await restart("wasi host: wasm-wasi, not installed");
    assert.equal(api.wasiHost(), "launcher");
  });
});

// The `wasi` label has ms-vscode.wasm-wasi-core and this suite runs under it (opentide.wasi.host: wasm-wasi), where the
// default would be the launcher; the `wasi-launcher` label has no such extension and runs it through the launcher.
describe("the WASI module (tier 4), with no opentide anywhere", () => {
  const expectedHost = vscode.extensions.getExtension("ms-vscode.wasm-wasi-core") ? "wasm-wasi" : "launcher";
  before(async () => {
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", path.join(ROOT, "no-such-dir", "opentide"), vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration("opentide.wasi")
      .update("host", expectedHost, vscode.ConfigurationTarget.Global);
    const api = await activated();
    await api.ctx.runtime.restart("wasi test");
  });
  after(async () => {
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration("opentide.wasi")
      .update("host", undefined, vscode.ConfigurationTarget.Global);
  });

  it("is the runtime when opentide.path (which selects the installed opentide) names nothing", async () => {
    const api = await activated();
    const runtime = api.ctx.runtime.current;
    assert.equal(runtime?.source, "wasi", JSON.stringify(api.ctx.runtime.attempts));
    assert.equal(runtime?.tier, 4);
    assert.equal(runtime?.kind, "opentide");
    assert.equal(runtime?.version, manifest.version);
    assert.equal(runtime?.restricted, false);
  });

  it("runs the language server in the extension host: the module's own, with the workspace mounted", async () => {
    const api = await activated();
    const client = await api.ctx.client.ready();
    assert.ok(client, "the WASI language client runs");
    assert.equal(api.wasiHost(), expectedHost);
    assert.equal(api.ctx.client.serverInfo?.host?.name, "opentide");
    assert.equal(api.ctx.runtime.current?.source, "wasi");
    const uri = fixture("detections", "rules", "misspelled-tlp.yaml");
    await vscode.window.showTextDocument(uri);
    const diagnostics = await waitFor(() => {
      const found = vscode.languages.getDiagnostics(uri);
      return found.some(
        (d) =>
          String(d.code).includes("vocab_unknown") ||
          (d.code as { value?: unknown })?.value === "vocab_unknown",
      )
        ? found
        : undefined;
    });
    assert.ok(diagnostics.length > 0);
  });

  it("answers every command through the module's serve, with host paths in the documents", async () => {
    const api = await activated();
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    const result = await api.ctx.backend.run(folder.path, ["explain", "vocab_unknown"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.via, "serve");
    assert.equal(api.ctx.backend.serveRunning, true);
    // `info catalog` prints absolute paths: the module sees /workspace, the document says where the folder is.
    const catalog = await api.ctx.backend.run(folder.path, ["info", "catalog"]);
    assert.equal(catalog.exitCode, 0, JSON.stringify(catalog.document.failure));
    const objects =
      (catalog.document as { objects?: { file_path: string | null; path: string | null }[] }).objects ?? [];
    assert.ok(objects.length > 0);
    for (const object of objects) {
      if (object.file_path) assert.ok(object.file_path.startsWith(folder.path), object.file_path);
    }
    // Commands that would be a process of their own natively go through serve too, where tenant requests
    // are the extension host's (opentide/fetch).
    const doctor = await api.ctx.backend.run(folder.path, ["doctor", "--offline"]);
    assert.equal(doctor.via, "serve");
  });

  it("runs MCP and tasks through the launcher: VS Code's Node runs the same module", async () => {
    const api = await activated();
    const runtime = api.ctx.runtime.current;
    assert.ok(runtime?.wasi);
    assert.equal(runtime.env.ELECTRON_RUN_AS_NODE, "1");
    assert.deepEqual(runtime.args, [runtime.wasi.launcher, runtime.wasi.module]);
  });
});
