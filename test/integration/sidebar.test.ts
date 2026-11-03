import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated, waitFor } from "./helpers";

describe("sidebar (#15)", () => {
  it("registers the views' commands", async () => {
    await activated();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "opentide.sidebar.refreshCatalogue",
      "opentide.sidebar.groupBy",
      "opentide.sidebar.filter",
      "opentide.sidebar.validate",
      "opentide.sidebar.setCredential",
      "opentide.sidebar.checkCredentials",
      "opentide.sidebar.runFix",
      "opentide.sidebar.copyReport",
      "opentide.sidebar.rerun",
    ]) {
      assert.ok(commands.includes(command), command);
    }
  });

  it("opens the Catalogue and loads the fixture folder's catalogue (or its symbols)", async () => {
    const api = await activated();
    await vscode.commands.executeCommand("opentide.sidebar.catalogue.focus");
    const folder = api.ctx.folders.all[0];
    assert.ok(folder);
    const state = await waitFor(() => {
      const current = api.ctx.catalog.get(folder.path);
      return current.status === "loading" || current.status === "empty" ? undefined : current;
    });
    assert.ok(["ready", "unavailable", "error"].includes(state.status));
  });

  it("lists the run in Activity after a refresh", async () => {
    const api = await activated();
    if (!api.ctx.runtime.current) return;
    await vscode.commands.executeCommand("opentide.sidebar.refreshPlatforms");
    await waitFor(() => api.ctx.activity.list().find((entry) => entry.argv[0] === "info"));
  });
});
