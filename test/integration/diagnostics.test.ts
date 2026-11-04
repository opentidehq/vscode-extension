// Diagnostics (#13) in VS Code. Needs a VS Code download (CI); the runtime parts need OPENTIDE_TEST_BIN.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated, fixture, waitFor } from "./helpers";

const codeOf = (d: vscode.Diagnostic): string | undefined =>
  typeof d.code === "object" ? String(d.code.value) : d.code === undefined ? undefined : String(d.code);

describe("diagnostics (#13)", () => {
  it("registers its commands", async () => {
    await activated();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "opentide.diagnostics.validateWorkspace",
      "opentide.diagnostics.lintWorkspace",
      "opentide.diagnostics.validateFile",
      "opentide.diagnostics.explain",
      "opentide.diagnostics.fixAllSafe",
    ])
      assert.ok(commands.includes(id), id);
  });

  it("shows one squiggle per finding: validate drops what the server reports", async function () {
    const api = await activated();
    if (!api.ctx.runtime.current || !api.ctx.backend.availability().available) this.skip();
    // `tlp: ambr` in a paths.toml rule folder: validate and the language server both report vocab_unknown.
    const uri = fixture("detections", "rules", "misspelled-tlp.yaml");
    const line = 4;
    const at = (d: vscode.Diagnostic) => codeOf(d) === "vocab_unknown" && d.range.start.line === line;
    // Closed, only validate reports the file: its finding shows.
    await vscode.commands.executeCommand("opentide.diagnostics.validateWorkspace");
    await waitFor(
      () =>
        vscode.languages.getDiagnostics(uri).some((d) => d.source === "opentide validate" && at(d)) ||
        undefined,
    );
    // Open, the language server reports the same code on the same line: validate's goes, one squiggle stays.
    await vscode.window.showTextDocument(uri);
    const all = await waitFor(() => {
      const diagnostics = vscode.languages.getDiagnostics(uri).filter(at);
      return diagnostics.some((d) => d.source === "opentide") &&
        !diagnostics.some((d) => d.source === "opentide validate")
        ? diagnostics
        : undefined;
    });
    assert.equal(all.length, 1, all.map((d) => `${d.source} ${codeOf(d)}:${d.range.start.line}`).join(", "));
  });

  it("explains a code in a Markdown preview, offline", async function () {
    const api = await activated();
    if (!api.ctx.backend.availability().available) this.skip();
    await vscode.commands.executeCommand("opentide.diagnostics.explain", "vocab_unknown");
    await waitFor(() =>
      vscode.workspace.textDocuments.find(
        (d) => d.uri.scheme === "opentide-explain" && d.getText().includes("vocab_unknown"),
      ),
    );
  });
});
