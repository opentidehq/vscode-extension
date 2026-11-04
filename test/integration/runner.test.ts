// The runner (#7) and agents (#6) features in VS Code. The task and MCP cases need a real opentide
// (OPENTIDE_TEST_BIN); the rest run on any runtime.
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activated, waitFor } from "./helpers";

const BIN = process.env.OPENTIDE_TEST_BIN;

describe("runner and agents (#6, #7)", () => {
  it("registers the runner's and the agents' commands", async () => {
    await activated();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "opentide.runner.run",
      "opentide.runner.generate",
      "opentide.runner.openDocs",
      "opentide.runner.showVocabulary",
      "opentide.runner.showUnreviewed",
      "opentide.runner.sharePreview",
      "opentide.runner.shareStatus",
      "opentide.runner.shareTargets",
      "opentide.runner.explain",
      "opentide.runner.openTui",
      "opentide.runner.showLastResult",
      "opentide.agents.addToEditorMcp",
    ]) {
      assert.ok(commands.includes(command), command);
    }
  });

  describe("with a real opentide", () => {
    before(async function () {
      if (!BIN) this.skip();
      await vscode.workspace
        .getConfiguration("opentide")
        .update("path", BIN, vscode.ConfigurationTarget.Workspace);
      const api = await activated();
      await api.ctx.runtime.restart("test");
    });
    after(async () => {
      if (BIN)
        await vscode.workspace
          .getConfiguration("opentide")
          .update("path", undefined, vscode.ConfigurationTarget.Workspace);
    });

    it("provides opentide tasks, and a validate task fills Problems through $opentide", async () => {
      const tasks = await vscode.tasks.fetchTasks({ type: "opentide" });
      const validate = tasks.find((task) => task.name === "validate");
      assert.ok(validate, tasks.map((task) => task.name).join(", "));
      assert.ok(tasks.some((task) => task.name === "deploy --dry-run"));
      await vscode.tasks.executeTask(validate);
      await waitFor(
        () =>
          vscode.languages
            .getDiagnostics()
            .some(([, diagnostics]) => diagnostics.some((d) => d.source === "opentide")) || undefined,
        60_000,
      );
    });

    it("runs a command from keybinding arguments and records it in Activity", async () => {
      const api = await activated();
      const before = new Set(api.ctx.activity.list().map((entry) => entry.id));
      await vscode.commands.executeCommand("opentide.runner.run", { argv: ["explain", "vocab_unknown"] });
      // The extension's own runs (a restart's catalogue refresh, `info`) land in Activity too: find this one.
      const run = await waitFor(() =>
        api.ctx.activity
          .list()
          .find((entry) => !before.has(entry.id) && entry.argv.join(" ") === "explain vocab_unknown"),
      ).catch(() => undefined);
      assert.ok(
        run,
        `explain vocab_unknown in Activity: ${api.ctx.activity
          .list()
          .map((entry) => entry.argv.join(" "))
          .join(", ")}`,
      );
    });
  });
});
