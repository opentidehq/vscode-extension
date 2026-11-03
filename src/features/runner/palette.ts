// The palette commands SPEC §11 gives a home of their own, for verbs without a panel: Generate…, Open
// Generated Docs, Show Vocabulary…, Show Unreviewed Rules, share preview/status/targets, Explain a Code…,
// Open the TUI in a terminal. Each runs a real opentide command (P3) and says what it ran.
import * as path from "node:path";
import * as vscode from "vscode";
import type { FeatureContext } from "../../core/context";
import { cliCommand, hasCli } from "../../core/runtime/types";
import {
  docsFolders,
  docsIndex,
  explainEntries,
  explainMarkdown,
  type GenerateChoice,
  generateChoices,
  generateRuns,
  unreviewedRules,
  vocabularies,
  vocabularyMarkdown,
} from "./bespoke";
import { summarize } from "./result";
import type { Runner } from "./run";

export class Palette {
  private lastDocs: unknown;

  constructor(
    private readonly ctx: FeatureContext,
    private readonly runner: Runner,
  ) {}

  /** Ready to run `command` in a folder: available, the command exists, a folder picked. */
  private async prepare(
    command: string,
    placeHolder?: string,
    about?: vscode.Uri,
  ): Promise<string | undefined> {
    if (!(await this.runner.ensureAvailable())) return undefined;
    await this.ctx.capabilities.ready();
    if (!this.ctx.capabilities.hasCommand(command)) {
      this.runner.needs(command);
      return undefined;
    }
    // A command about a file runs in that file's folder.
    const owner = about ? this.ctx.folders.folderOf(about) : undefined;
    return owner?.path ?? this.runner.folder(placeHolder);
  }

  async generate(): Promise<void> {
    const folder = await this.prepare("generate", "Generate in which folder?");
    const tree = this.ctx.capabilities.current;
    if (!folder || !tree) return;
    const all = {
      label: "$(run-all) Everything",
      description: "opentide generate: the full pipeline (no extract)",
      choice: undefined as GenerateChoice | undefined,
    };
    const items = [
      all,
      ...generateChoices(tree).map((choice) => ({
        label: `${choice.contactsTenant ? "$(globe) " : ""}${choice.label}`,
        description: choice.description,
        detail: choice.contactsTenant ? "contacts the platform's tenants" : undefined,
        choice,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "opentide: Generate",
      placeHolder: "Pick phases; each subcommand runs on its own, phases together",
      canPickMany: true,
    });
    if (!picked || picked.length === 0) return;
    const chosen = picked.map((item) => item.choice).filter((c): c is GenerateChoice => c !== undefined);
    const runs = picked.includes(all)
      ? [["generate"], ...generateRuns(chosen.filter((c) => c.contactsTenant))]
      : generateRuns(chosen);
    const names: string[] = [];
    for (const argv of runs) {
      const confirmed = await this.runner.confirm(folder, argv);
      if (!confirmed) return;
      const ran = await this.runner.background(folder, confirmed, { quietSuccess: true });
      if (ran?.result.exitCode !== 0) return;
      if (argv[1] === "docs" || argv.length === 1) this.lastDocs = ran.result.document;
      names.push(argv.slice(1).join(" ") || "everything");
    }
    const actions = this.lastDocs !== undefined ? ["Open Generated Docs"] : [];
    const choice = await vscode.window.showInformationMessage(
      `opentide generate: ${names.join(", ")} done`,
      ...actions,
    );
    if (choice) await this.openDocs(folder);
  }

  async openDocs(given?: string): Promise<void> {
    const folder = given ?? (await this.runner.folder("Open the docs of which folder?"));
    if (!folder) return;
    for (const dir of docsFolders(this.lastDocs)) {
      const base = path.isAbsolute(dir) ? dir : path.join(folder, dir);
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(vscode.Uri.file(base), "**/*.md"),
        undefined,
        2000,
      );
      const relative = files.map((uri) => path.relative(base, uri.fsPath).split(path.sep).join("/"));
      const index = docsIndex(relative);
      if (index) {
        await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(path.join(base, index)));
        return;
      }
    }
    const picked = await vscode.window.showInformationMessage(
      "No generated docs yet in this folder.",
      "Generate Docs",
    );
    if (!picked || !(await this.runner.ensureAvailable())) return;
    if (!this.ctx.capabilities.hasCommand("generate docs")) return this.runner.needs("generate docs");
    const ran = await this.runner.background(folder, ["generate", "docs"], { quietSuccess: true });
    if (ran?.result.exitCode === 0) {
      this.lastDocs = ran.result.document;
      await this.openDocs(folder);
    }
  }

  async showVocabulary(name?: string): Promise<void> {
    const folder = await this.prepare("info vocab", "Read vocabularies of which folder?");
    if (!folder) return;
    let vocabulary = typeof name === "string" ? name : undefined;
    if (!vocabulary) {
      const list = await this.runner.background(folder, ["info", "vocab"], { quietSuccess: true });
      if (list?.result.exitCode !== 0) return;
      const items = vocabularies(list.result.document).map((v) => ({
        label: v.name,
        description: v.title,
        detail: v.entries !== undefined ? `${v.entries} entries` : undefined,
      }));
      if (items.length === 0) {
        void vscode.window.showInformationMessage("opentide lists no vocabularies.");
        return;
      }
      vocabulary = (
        await vscode.window.showQuickPick(items, { title: "Show vocabulary", matchOnDescription: true })
      )?.label;
    }
    if (!vocabulary) return;
    const ran = await this.runner.background(folder, ["info", "vocab", vocabulary], { quietSuccess: true });
    if (ran?.result.exitCode !== 0) return;
    const markdown = vocabularyMarkdown(ran.result.document, ran.result.argvDisplay);
    if (!markdown) return this.runner.open(ran.uri);
    await this.runner.openMarkdown(`vocabulary-${vocabulary.replace(/[^A-Za-z0-9._-]/g, "_")}`, markdown);
  }

  async unreviewed(): Promise<void> {
    const folder = await this.prepare("rules unreviewed", "Which folder's rules?");
    if (!folder) return;
    const ran = await this.runner.background(folder, ["rules", "unreviewed"], { quietSuccess: true });
    if (ran?.result.exitCode !== 0) return;
    const rules = unreviewedRules(ran.result.document);
    if (rules.length === 0) {
      void vscode.window.showInformationMessage(summarize(ran.result).text);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      rules.map((rule) => ({
        label: path.posix.basename(rule.path),
        description: rule.path,
        detail: rule.reviewed
          ? `last reviewed ${rule.reviewed}`
          : `not reviewed (${rule.reason || "no date"})`,
        rule,
      })),
      { title: summarize(ran.result).text, placeHolder: "Open a rule", matchOnDescription: true },
    );
    if (picked) await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, picked.rule.path)));
  }

  /** `share preview` or `share status`, for one object (from a menu or the active editor) or all. */
  async share(sub: "preview" | "status", target?: unknown): Promise<void> {
    const folder = await this.prepare(
      `share ${sub}`,
      `share ${sub} in which folder?`,
      target instanceof vscode.Uri ? target : undefined,
    );
    if (!folder) return;
    const argv = ["share", sub];
    const uri = target instanceof vscode.Uri ? target : vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === "file" && this.ctx.folders.isObjectFile(uri)) {
      const relative = path.relative(folder, uri.fsPath).split(path.sep).join("/");
      const scope =
        target instanceof vscode.Uri
          ? "one"
          : (
              await vscode.window.showQuickPick(
                [
                  { label: `$(file) ${path.basename(uri.fsPath)}`, description: "this object", scope: "one" },
                  { label: "$(files) Every object", description: "the configured scope", scope: "all" },
                ],
                { title: `opentide share ${sub}` },
              )
            )?.scope;
      if (!scope) return;
      if (scope === "one" && !relative.startsWith("..")) argv.push("--file", relative);
    }
    await this.runner.background(folder, argv, { open: true });
  }

  async shareTargets(): Promise<void> {
    const folder = await this.prepare("share targets", "Which folder's sharing targets?");
    if (folder) await this.runner.background(folder, ["share", "targets"], { open: true });
  }

  async explain(code?: unknown): Promise<void> {
    const folder = await this.prepare("explain", "Explain with which folder's opentide?");
    if (!folder) return;
    let picked = typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code) ? code : undefined;
    if (!picked) {
      const list = await this.runner.background(folder, ["explain"], { quietSuccess: true });
      if (list?.result.exitCode !== 0) return;
      picked = (
        await vscode.window.showQuickPick(
          explainEntries(list.result.document).map((entry) => ({ label: entry.code, detail: entry.meaning })),
          { title: "Explain a code", placeHolder: "Pick a diagnostic code", matchOnDetail: true },
        )
      )?.label;
    }
    if (!picked) return;
    const ran = await this.runner.background(folder, ["explain", picked], { quietSuccess: true });
    if (ran?.result.exitCode !== 0) return;
    await this.runner.openMarkdown(`explain-${picked}`, explainMarkdown(ran.result.document));
  }

  async openTui(): Promise<void> {
    const folder = await this.prepare("tui", "Open the TUI for which folder?");
    const runtime = this.ctx.runtime.current;
    if (!folder || !hasCli(runtime)) return;
    const { command, args } = cliCommand(runtime, ["tui"]);
    const terminal = vscode.window.createTerminal({
      name: "opentide tui",
      shellPath: command,
      shellArgs: args,
      cwd: folder,
      env: { ...runtime.env, OPENTIDE_REPO_ROOT: folder },
      iconPath: new vscode.ThemeIcon("table"),
      isTransient: true,
    });
    terminal.show();
    this.ctx.log.info(`▶ opentide tui  (terminal, in ${folder})`);
  }
}
