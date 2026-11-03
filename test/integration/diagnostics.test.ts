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
    const uri = fixture("objects", "rules", "suspicious-lsass-access.yaml");
    await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand("opentide.diagnostics.validateWorkspace");
    const all = await waitFor(() => {
      const diagnostics = vscode.languages.getDiagnostics(uri);
      return diagnostics.some((d) => d.source === "opentide") ? diagnostics : undefined;
    });
    const server = new Set(
      all.filter((d) => d.source === "opentide").map((d) => `${codeOf(d)}:${d.range.start.line}`),
    );
    for (const d of all.filter((x) => x.source === "opentide validate"))
      assert.ok(!server.has(`${codeOf(d)}:${d.range.start.line}`), `${codeOf(d)} shows twice`);
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
