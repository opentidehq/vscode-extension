import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated, fixture, waitFor } from "./helpers";

describe("languages and file associations (#4)", () => {
  before(() => activated());

  it("opens objects/**/*.yaml as opentide-yaml", async () => {
    const document = await vscode.workspace.openTextDocument(
      fixture("objects", "rules", "suspicious-lsass-access.yaml"),
    );
    assert.equal(document.languageId, "opentide-yaml");
  });

  it("opens a rule in a paths.toml object folder as opentide-yaml", async () => {
    const document = await vscode.workspace.openTextDocument(
      fixture("detections", "rules", "custom-folder-rule.yaml"),
    );
    await waitFor(() => document.languageId === "opentide-yaml" || undefined, 5000);
  });

  it("opens .opentide/configurations/**/*.toml as opentide-config, and leaves Cargo.toml alone", async () => {
    const config = await vscode.workspace.openTextDocument(
      fixture(".opentide", "configurations", "paths.toml"),
    );
    assert.equal(config.languageId, "opentide-config");
    const cargo = await vscode.workspace.openTextDocument(fixture("Cargo.toml"));
    assert.notEqual(cargo.languageId, "opentide-config");
  });

  it("comments KQL inside configurations.sentinel.query with //", async () => {
    const document = await vscode.workspace.openTextDocument(
      fixture("objects", "rules", "suspicious-lsass-access.yaml"),
    );
    const editor = await vscode.window.showTextDocument(document);
    const line = document
      .getText()
      .split("\n")
      .findIndex((text) => text.includes("DeviceProcessEvents"));
    editor.selection = new vscode.Selection(line, 8, line, 8);
    await vscode.commands.executeCommand("editor.action.commentLine");
    assert.match(document.lineAt(line).text, /^\s*\/\/ ?DeviceProcessEvents/);
    await vscode.commands.executeCommand("undo");
  });
});
