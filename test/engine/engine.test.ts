// Desktop VS Code with no opentide anywhere: opentide.path names nothing, the extension carries no bundled
// runtime (a development checkout, like the universal package), and .vscode-test.mjs's `engine` label
// takes every folder holding an opentide executable off PATH. The engine (WASM) is the runtime.
import * as assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { activated, fixture, waitFor } from "../integration/helpers";

const ROOT = path.join(__dirname, "..", "..", "..");
const pins = JSON.parse(readFileSync(path.join(ROOT, "pins.json"), "utf8")) as {
  engine: { version: string };
};

describe("the engine (WASM) tier, with no opentide anywhere", () => {
  before(async () => {
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", path.join(ROOT, "no-such-dir", "opentide"), vscode.ConfigurationTarget.Global);
    const api = await activated();
    await api.ctx.runtime.restart("engine test");
  });
  after(async () => {
    await vscode.workspace
      .getConfiguration("opentide")
      .update("path", undefined, vscode.ConfigurationTarget.Global);
  });

  it("resolves tier 5 once opentide.path, the environment and the bundled runtime fail", async () => {
    const api = await activated();
    const runtime = api.ctx.runtime.current;
    assert.equal(runtime?.kind, "engine", JSON.stringify(api.ctx.runtime.attempts));
    assert.equal(runtime?.tier, 5);
    assert.equal(runtime?.version, pins.engine.version);
    const outcome = (tier: number) =>
      api.ctx.runtime.attempts.filter((a) => a.tier === tier).map((a) => a.outcome);
    assert.deepEqual(outcome(1), ["failed"]);
    assert.ok(
      outcome(2).every((o) => o === "missing"),
      JSON.stringify(api.ctx.runtime.attempts),
    );
    assert.deepEqual(outcome(4), ["missing"]);
    const client = await api.ctx.client.ready();
    assert.ok(client, "the engine's language client runs");
    assert.equal(api.ctx.client.serverInfo?.host, null);
    assert.equal(api.ctx.client.serverInfo?.engine, pins.engine.version);
  });

  it("reports diagnostics on a broken object, with references resolved from the fed workspace", async () => {
    const uri = fixture("detections", "rules", "misspelled-tlp.yaml");
    await vscode.window.showTextDocument(uri);
    const diagnostics = await waitFor(() => {
      const found = vscode.languages.getDiagnostics(uri);
      return found.some(
        (d) => d.code === "vocab_unknown" || (d.code as { value?: unknown })?.value === "vocab_unknown",
      )
        ? found
        : undefined;
    }, 30_000);
    const tlp = diagnostics.find((d) => /ambr/.test(d.message));
    assert.ok(tlp, diagnostics.map((d) => d.message).join("; "));
    assert.equal(tlp.source, "opentide");
    assert.equal(tlp.range.start.line, 4);
    // The objective is in objects/, read through VS Code: detection_model resolves.
    assert.equal(
      diagnostics.some((d) => /invalid_ref/.test(JSON.stringify(d.code))),
      false,
      diagnostics.map((d) => JSON.stringify(d.code)).join(", "),
    );
  });

  it("hovers the objective a rule implements", async () => {
    const uri = fixture("detections", "rules", "misspelled-tlp.yaml");
    const hovers = await waitFor(async () => {
      const found = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        new vscode.Position(5, 25),
      );
      return found && found.length > 0 ? found : undefined;
    });
    const text = hovers
      .flatMap((hover) => hover.contents)
      .map((content) => (typeof content === "string" ? content : content.value))
      .join("\n");
    assert.match(text, /Detect LSASS access/);
  });

  it("completes Tide keys", async () => {
    const uri = fixture("detections", "rules", "misspelled-tlp.yaml");
    const list = await waitFor(async () => {
      const found = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        uri,
        // Inside `configurations:`: the platforms a rule may have a block for.
        new vscode.Position(7, 2),
      );
      return found && found.items.length > 0 ? found : undefined;
    });
    const labels = list.items.map((item) => (typeof item.label === "string" ? item.label : item.label.label));
    assert.ok(labels.includes("splunk"), labels.join(", "));
  });

  it("lists the Catalogue from opentide/catalog, paths.toml object folders included", async () => {
    const api = await activated();
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    await vscode.commands.executeCommand("opentide.sidebar.catalogue.focus");
    const state = await waitFor(() => {
      const current = api.ctx.catalog.get(folder.path);
      return current.status === "ready" ? current : undefined;
    }, 30_000);
    assert.equal(state.source, "server");
    assert.equal(state.unavailable?.reason, "editor-only");
    assert.deepEqual(state.catalog?.objects.map((o) => o.path).sort(), [
      "detections/rules/custom-folder-rule.yaml",
      "detections/rules/misspelled-tlp.yaml",
      "objects/objectives/detect-lsass-access.yaml",
      "objects/rules/suspicious-lsass-access.yaml",
    ]);
    assert.ok(state.catalog?.edges.some((e) => e.kind === "implements" && !e.missing));
  });

  it("follows an object file created and deleted on disk", async () => {
    const api = await activated();
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    const file = path.join(folder.path, "objects", "objectives", "engine-test-objective.yaml");
    const names = () => api.ctx.catalog.get(folder.path).catalog?.objects.map((o) => o.name) ?? [];
    try {
      await fs.writeFile(
        file,
        "name: Engine test objective\nmetadata:\n  uuid: 5b1f0c3e-2d4a-4e8b-9c7d-1a2b3c4d5e6f\n  schema: objective::1.0\n",
      );
      await waitFor(() => names().includes("Engine test objective"), 30_000);
    } finally {
      await fs.rm(file, { force: true });
    }
    await waitFor(() => !names().includes("Engine test objective"), 30_000);
  });

  it("reads a folder that paths.toml names after a paths.toml edit", async () => {
    const api = await activated();
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    const toml = path.join(folder.path, ".opentide", "configurations", "paths.toml");
    const before = await fs.readFile(toml, "utf8");
    const extra = path.join(folder.path, "extra-rules");
    const names = () => api.ctx.catalog.get(folder.path).catalog?.objects.map((o) => o.name) ?? [];
    try {
      // A rule outside every object folder: no file event of the engine's folders reports it.
      await fs.mkdir(extra, { recursive: true });
      await fs.writeFile(
        path.join(extra, "extra-rule.yaml"),
        "name: Extra folder rule\nmetadata:\n  uuid: 7c2e1d4f-3a5b-4c6d-8e9f-0a1b2c3d4e5f\n  schema: rule::1.1\n",
      );
      await waitFor(() => names().length > 0, 30_000);
      assert.equal(names().includes("Extra folder rule"), false);
      await fs.writeFile(toml, before.replace('rule = "detections/rules/"', 'rule = "extra-rules/"'));
      await waitFor(() => names().includes("Extra folder rule"), 30_000);
    } finally {
      await fs.writeFile(toml, before);
      await fs.rm(extra, { recursive: true, force: true });
    }
    await waitFor(() => !names().includes("Extra folder rule") && names().includes("Misspelled TLP"), 30_000);
  });

  it("says commands need opentide, offering to install it", async () => {
    const api = await activated();
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    assert.deepEqual(api.ctx.backend.availability(), { available: false, code: "editor-only" });
    await assert.rejects(
      api.ctx.backend.run(folder.path, ["validate"]),
      // Not `instanceof`: the extension's BackendError is the bundle's class, not this file's.
      (error: { code?: unknown; message?: unknown }) =>
        error.code === "editor-only" && /engine \(WASM\).*needs opentide/.test(String(error.message)),
    );
  });
});
