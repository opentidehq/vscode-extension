// The Relations view and Show Relations in VS Code. Needs a VS Code download (CI).
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated, fixture, waitFor } from "./helpers";

interface RelationsTestState {
  readonly target?: { readonly folder: string; readonly file?: string; readonly uuid?: string };
  readonly pinned: boolean;
  readonly visible: boolean;
  readonly labels: readonly string[];
}

const state = () => vscode.commands.executeCommand<RelationsTestState>("opentide.relations.testState");

/** Wait until the view's target is `file` (the view follows the editor after a short debounce). */
async function targets(file: vscode.Uri): Promise<RelationsTestState> {
  return waitFor(async () => {
    const current = await state();
    return current.target?.file === file.fsPath ? current : undefined;
  });
}

describe("relations", () => {
  const rule = () => fixture("objects", "rules", "suspicious-lsass-access.yaml");
  const objective = () => fixture("objects", "objectives", "detect-lsass-access.yaml");

  afterEach(async () => {
    await vscode.commands.executeCommand("opentide.relations.unpin");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("registers Show Relations and the view's commands", async () => {
    await activated();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "opentide.relations.show",
      "opentide.relations.open",
      "opentide.relations.openToSide",
      "opentide.relations.pin",
      "opentide.relations.unpin",
      "opentide.relations.back",
      "opentide.relations.forward",
    ])
      assert.ok(commands.includes(command), command);
  });

  it("Show Relations opens the view on the active object", async () => {
    await activated();
    await vscode.window.showTextDocument(rule());
    await vscode.commands.executeCommand("opentide.relations.show");
    // The view renders after the command returns when it was hidden: wait for all three.
    await waitFor(async () => {
      const current = await state();
      return current.target?.file === rule().fsPath && current.visible && current.labels.length > 0
        ? current
        : undefined;
    });
  });

  it("retargets when the editor changes, and a pin keeps it on its object", async () => {
    await activated();
    await vscode.window.showTextDocument(rule());
    await vscode.commands.executeCommand("opentide.relations.show");
    await targets(rule());

    await vscode.window.showTextDocument(objective());
    await targets(objective());

    await vscode.commands.executeCommand("opentide.relations.pin");
    await vscode.window.showTextDocument(rule());
    // Longer than the follow debounce: a view that followed would have moved by now.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const pinned = await state();
    assert.equal(pinned.pinned, true);
    assert.equal(pinned.target?.file, objective().fsPath);

    await vscode.commands.executeCommand("opentide.relations.unpin");
    const following = await targets(rule());
    assert.equal(following.pinned, false);
  });

  it("does not leave its object for an editor that holds none", async () => {
    await activated();
    await vscode.window.showTextDocument(rule());
    await vscode.commands.executeCommand("opentide.relations.show");
    await targets(rule());
    const other = await vscode.workspace.openTextDocument({ content: "plain text", language: "plaintext" });
    await vscode.window.showTextDocument(other);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await state()).target?.file, rule().fsPath);
  });

  it("Show Relations on a file that holds no object keeps the view on its object", async () => {
    await activated();
    await vscode.window.showTextDocument(rule());
    await vscode.commands.executeCommand("opentide.relations.show");
    await targets(rule());
    await vscode.window.showTextDocument(fixture("Cargo.toml"));
    await vscode.commands.executeCommand("opentide.relations.show");
    assert.equal((await state()).target?.file, rule().fsPath);
  });

  it("puts the relations lens on the name: line when the catalogue has the object", async () => {
    // The fixture's rule folder is detections/rules/ (paths.toml): objects/rules/ holds no catalogued rule.
    const catalogued = fixture("detections", "rules", "custom-folder-rule.yaml");
    const api = await activated();
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    const catalog = await waitFor(() => {
      const current = api.ctx.catalog.get(folder.path);
      return current.status === "loading" || current.status === "empty" ? undefined : current;
    });
    const document = await vscode.workspace.openTextDocument(catalogued);
    await vscode.window.showTextDocument(document);
    const lenses =
      (await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        catalogued,
      )) ?? [];
    const relations = lenses.filter((lens) => lens.command?.command === "opentide.relations.show");
    if (!catalog.catalog) {
      // Without `info catalog` the language server's lens is the only one.
      assert.equal(relations.length, 0);
      return;
    }
    assert.equal(relations.length, 1);
    const line = relations[0]?.range.start.line ?? -1;
    assert.match(document.lineAt(line).text, /^name\s*:/);
    assert.match(relations[0]?.command?.title ?? "", /→|←|No relations/);
  });
});
