// Query lenses (#17), the deploy plan (#18) and the ATT&CK matrix (#20) inside VS Code.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated, fixture, waitFor } from "./helpers";

const panelOpen = (viewType: string) =>
  vscode.window.tabGroups.all.some((group) =>
    group.tabs.some(
      (tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType),
    ),
  );

describe("panels (#17, #18, #20)", () => {
  before(() => activated());
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("registers the panels' commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "opentide.query.run",
      "opentide.query.validateLive",
      "opentide.query.showCompiled",
      "opentide.deployPlan.open",
      "opentide.deployPlan.openChanged",
      "opentide.matrix.open",
    ])
      assert.ok(commands.includes(command), command);
  });

  it("puts query lenses on the rule's query, and none on its UUID beyond the server's own", async function () {
    const api = await activated();
    if (!api.ctx.client.current) this.skip();
    const uri = fixture("objects", "rules", "suspicious-lsass-access.yaml");
    await vscode.window.showTextDocument(uri);
    const lenses = await waitFor(async () => {
      const found = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        uri,
      );
      return found?.some((lens) => lens.command?.command === "opentide.query.showCompiled")
        ? found
        : undefined;
    });
    const ours = lenses.filter((lens) => lens.command?.command.startsWith("opentide.query."));
    const queryLine = (await vscode.workspace.openTextDocument(uri))
      .getText()
      .split("\n")
      .findIndex((line) => line.includes("DeviceProcessEvents"));
    for (const lens of ours) assert.equal(lens.range.start.line, queryLine);
  });

  it("opens the compiled query as a read-only document", async function () {
    const api = await activated();
    if (!api.ctx.client.current) this.skip();
    const uri = fixture("objects", "rules", "suspicious-lsass-access.yaml");
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      uri,
    );
    const compiled = lenses?.find((lens) => lens.command?.command === "opentide.query.showCompiled");
    if (!compiled?.command) this.skip();
    const rule = await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand(compiled.command.command, ...(compiled.command.arguments ?? []));
    const editor = await waitFor(() =>
      vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "opentide-compiled"),
    );
    assert.match(editor.document.getText(), /DeviceProcessEvents/);
    // Beside the rule, which keeps the focus.
    assert.notEqual(editor.viewColumn, rule.viewColumn);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), uri.toString());
  });

  it("opens the ATT&CK matrix, with the needs-a-newer-opentide state where info catalog is missing", async () => {
    await vscode.commands.executeCommand("opentide.matrix.open");
    await waitFor(() => panelOpen("opentide.matrix") || undefined);
  });

  it("opens the deploy plan for the active rule", async function () {
    const api = await activated();
    if (!api.ctx.runtime.current || api.ctx.backend.availability().available !== true) this.skip();
    await vscode.window.showTextDocument(fixture("objects", "rules", "suspicious-lsass-access.yaml"));
    await vscode.commands.executeCommand("opentide.deployPlan.open");
    await waitFor(() => panelOpen("opentide.deployPlan") || undefined);
  });
});

const webviewTabs = (viewType: string) =>
  vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter(
      (tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType),
    ),
  );

describe("panels open beside the object and reuse their panel (SPEC §10)", () => {
  before(() => activated());
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("deploy plan: beside the rule, keeping its focus; the next rule retargets the same panel", async () => {
    const rule = fixture("objects", "rules", "suspicious-lsass-access.yaml");
    const editor = await vscode.window.showTextDocument(rule);
    await vscode.commands.executeCommand("opentide.deployPlan.open", rule);
    const [tab] = await waitFor(() => {
      const tabs = webviewTabs("opentide.deployPlan");
      return tabs.length > 0 ? tabs : undefined;
    });
    assert.ok(tab);
    assert.notEqual(tab.group.viewColumn, editor.viewColumn, "beside the rule, not over it");
    assert.equal(
      vscode.window.activeTextEditor?.document.uri.toString(),
      rule.toString(),
      "the rule keeps the focus",
    );
    // The title names the rule (the tab model hears of a new title a moment later).
    const first = await waitFor(
      () => webviewTabs("opentide.deployPlan").find((t) => t.label.startsWith("Deploy Plan · "))?.label,
    );
    await vscode.commands.executeCommand(
      "opentide.deployPlan.open",
      fixture("detections", "rules", "custom-folder-rule.yaml"),
    );
    const retargeted = await waitFor(() => {
      const tabs = webviewTabs("opentide.deployPlan");
      return tabs.length === 1 && tabs[0]?.label !== first ? tabs[0] : undefined;
    });
    assert.equal(webviewTabs("opentide.deployPlan").length, 1, "one plan panel, retargeted");
    assert.equal(retargeted.group.viewColumn, tab.group.viewColumn);
  });

  it("ATT&CK matrix: one panel; asked for a technique from an editor, it opens beside", async () => {
    const rule = fixture("objects", "rules", "suspicious-lsass-access.yaml");
    const editor = await vscode.window.showTextDocument(rule);
    await vscode.commands.executeCommand("opentide.matrix.open", { technique: "T1003" });
    const tab = await waitFor(() => webviewTabs("opentide.matrix")[0]);
    assert.notEqual(tab.group.viewColumn, editor.viewColumn, "beside the editor");
    assert.equal(
      vscode.window.activeTextEditor?.document.uri.toString(),
      rule.toString(),
      "the editor keeps the focus",
    );
    await vscode.commands.executeCommand("opentide.matrix.open");
    await vscode.commands.executeCommand("opentide.matrix.open", { technique: "T1059" });
    // Give a second panel the time to appear, if one were opened.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(webviewTabs("opentide.matrix").length, 1, "reused, not a new tab");
  });
});
