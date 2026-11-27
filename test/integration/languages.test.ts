import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { activated, fixture, waitFor } from "./helpers";

describe("languages and file associations (#4)", () => {
  before(() => activated());

  it("contributes a language per object type, each with its own icon", async () => {
    const languages = await vscode.languages.getLanguages();
    for (const id of ["opentide-yaml", "opentide-threat", "opentide-objective", "opentide-rule"])
      assert.ok(languages.includes(id), id);
  });

  it("opens an objective in objects/objectives/ as opentide-objective", async () => {
    const document = await vscode.workspace.openTextDocument(
      fixture("objects", "objectives", "detect-lsass-access.yaml"),
    );
    assert.equal(document.languageId, "opentide-objective");
  });

  it("opens objects/**/*.yaml outside a type's folder as opentide-yaml", async () => {
    // This workspace's paths.toml puts rules in detections/rules/: objects/rules/ is no type's folder here.
    const document = await vscode.workspace.openTextDocument(
      fixture("objects", "rules", "suspicious-lsass-access.yaml"),
    );
    const language = await waitFor(() => {
      const current = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === document.uri.toString(),
      );
      return current?.languageId === "opentide-yaml" ? current.languageId : undefined;
    }, 5000);
    assert.equal(language, "opentide-yaml");
  });

  it("gives CoreTIDE's Objects/ YAML back to yaml: the objects/ glob matches without case", async () => {
    const coretide = vscode.Uri.joinPath(
      fixture(),
      "..",
      "coretide",
      "Objects",
      "Rules",
      "coretide-rule.yaml",
    );
    const document = await vscode.workspace.openTextDocument(coretide);
    const language = await waitFor(() => {
      const current = vscode.workspace.textDocuments.find((d) => d.uri.toString() === coretide.toString());
      return current?.languageId.startsWith("opentide-") ? undefined : current?.languageId;
    }, 5000);
    assert.equal(language, "yaml", `${document.uri.fsPath} stays out of the language server`);
  });

  it("opens a rule in the rule folder paths.toml names as opentide-rule", async () => {
    const uri = fixture("detections", "rules", "custom-folder-rule.yaml");
    await vscode.workspace.openTextDocument(uri);
    const language = await waitFor(() => {
      const current = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      return current?.languageId === "opentide-rule" ? current.languageId : undefined;
    }, 5000);
    assert.equal(language, "opentide-rule");
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
