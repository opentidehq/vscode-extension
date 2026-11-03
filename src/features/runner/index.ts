// Every CLI command has a home (SPEC §11, #7): the generic runner, the palette commands for verbs without a
// panel, the `opentide` task type with `$opentide`, and the terminal (launcher on PATH, profile, links).
import * as vscode from "vscode";
import { defineFeature } from "../../core/feature";
import { Palette } from "./palette";
import { RESULT_SCHEME, ResultStore } from "./resultStore";
import { Runner } from "./run";
import { OpentideTaskProvider } from "./taskProvider";
import { TASK_TYPE } from "./tasks";
import { TerminalIntegration } from "./terminal";
import { runCommand } from "./wizard";

/** The diagnostics feature's Explain, which takes the code. */
const EXPLAIN_COMMAND = "opentide.diagnostics.explain";

export default defineFeature({
  id: "runner",
  activate(ctx) {
    const results = new ResultStore();
    const runner = new Runner(ctx, results);
    const palette = new Palette(ctx, runner);
    const changed = new vscode.EventEmitter<vscode.Uri>();
    const command = (id: string, run: (...args: unknown[]) => unknown) =>
      vscode.commands.registerCommand(id, run);

    ctx.subscriptions.push(
      results,
      runner,
      changed,
      results.onDidChange((path) => changed.fire(vscode.Uri.from({ scheme: RESULT_SCHEME, path }))),
      vscode.workspace.registerTextDocumentContentProvider(RESULT_SCHEME, {
        onDidChange: changed.event,
        provideTextDocumentContent: (uri) =>
          results.get(uri.path) ?? "This result is no longer kept. Run the command again.\n",
      }),
      command("opentide.runner.run", (args) => runCommand(ctx, runner, args)),
      command("opentide.runner.showLastResult", async () => {
        const last = results.lastResult;
        if (last) await runner.open(vscode.Uri.from({ scheme: RESULT_SCHEME, path: last }));
        else void vscode.window.showInformationMessage("No command has run in this window yet.");
      }),
      command("opentide.runner.generate", () => palette.generate()),
      command("opentide.runner.openDocs", () => palette.openDocs()),
      command("opentide.runner.showVocabulary", (name) =>
        palette.showVocabulary(typeof name === "string" ? name : undefined),
      ),
      command("opentide.runner.showUnreviewed", () => palette.unreviewed()),
      command("opentide.runner.sharePreview", (uri) => palette.share("preview", uri)),
      command("opentide.runner.shareStatus", (uri) => palette.share("status", uri)),
      command("opentide.runner.shareTargets", () => palette.shareTargets()),
      // One Explain: the diagnostics feature's (cached Markdown preview, online fallback) when it runs;
      // the palette entry is its. This id stays for the runner's failure messages and terminal links.
      command("opentide.runner.explain", async (code) =>
        (await vscode.commands.getCommands(true)).includes(EXPLAIN_COMMAND)
          ? vscode.commands.executeCommand(EXPLAIN_COMMAND, code)
          : palette.explain(code),
      ),
      command("opentide.runner.openTui", () => palette.openTui()),
      vscode.tasks.registerTaskProvider(TASK_TYPE, new OpentideTaskProvider(ctx)),
      new TerminalIntegration(ctx),
      ctx.status.addMenuItem({ label: "$(play) Run command…", command: "opentide.runner.run", order: 90 }),
    );
  },
});
