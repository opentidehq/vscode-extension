// The integrated terminal (SPEC §11): the launcher in globalStorage, `PATH` for new terminals
// (environmentVariableCollection, `opentide.terminal.addToPath`), the "opentide" terminal profile, and
// links for object UUIDs and diagnostic codes. Glue over launcher.ts and links.ts.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FeatureContext } from "../../core/context";
import { which } from "../../core/runtime/process";
import { hasCli, type Runtime } from "../../core/runtime/types";
import { readRestricted } from "../../core/services/settings";
import { launcherDir, launcherFiles, prependPath, runsAsModule, shouldAddToPath } from "./launcher";
import { linkedObject, type TerminalMatch, terminalMatches } from "./links";

export const PROFILE_ID = "opentide.terminal";

export class TerminalIntegration implements vscode.Disposable {
  /** The launcher folder of the active runtime, once written. */
  private dir: { runtime: Runtime; dir: string } | undefined;
  private writing: Promise<string | undefined> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: FeatureContext) {
    const collection = ctx.extension.environmentVariableCollection;
    collection.persistent = false;
    this.disposables.push(
      ctx.runtime.onDidChange(() => void this.update()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("opentide.terminal.addToPath")) void this.update();
      }),
      vscode.window.registerTerminalProfileProvider(PROFILE_ID, {
        provideTerminalProfile: () => this.profile(),
      }),
      vscode.window.registerTerminalLinkProvider({
        provideTerminalLinks: (context) => this.links(context.line),
        handleTerminalLink: (link: OpentideLink) => this.openLink(link),
      }),
    );
  }

  /** Write the launcher for the active runtime (once per runtime) and return its folder. */
  launcher(): Promise<string | undefined> {
    const runtime = this.ctx.runtime.current;
    if (!hasCli(runtime)) return Promise.resolve(undefined);
    if (this.dir?.runtime === runtime) return Promise.resolve(this.dir.dir);
    this.writing ??= this.write(runtime).finally(() => {
      this.writing = undefined;
    });
    return this.writing;
  }

  private async write(runtime: Runtime): Promise<string | undefined> {
    const dir = launcherDir(this.ctx.extension.globalStorageUri.fsPath, runtime);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      for (const file of launcherFiles(runtime, process.platform)) {
        const target = path.join(dir, file.name);
        const current = await fs.promises.readFile(target, "utf8").catch(() => undefined);
        if (current !== file.content) await fs.promises.writeFile(target, file.content, { mode: file.mode });
        if (process.platform !== "win32") await fs.promises.chmod(target, file.mode);
      }
    } catch (error) {
      this.ctx.log.warn(`could not write the opentide launcher in ${dir}: ${String(error)}`);
      return undefined;
    }
    this.dir = { runtime, dir };
    return dir;
  }

  /** Re-evaluate the terminal PATH after a runtime or setting change. */
  async update(): Promise<void> {
    const collection = this.ctx.extension.environmentVariableCollection;
    const runtime = this.ctx.runtime.current;
    const add = shouldAddToPath({
      module: runsAsModule(runtime?.args),
      restricted: !this.ctx.trust.isTrusted || runtime?.restricted === true,
      setting: readRestricted<boolean>("opentide.terminal.addToPath"),
      opentideOnPath: which("opentide", process.env.PATH, process.platform) !== undefined,
    });
    if (!add) {
      collection.clear();
      return;
    }
    const dir = await this.launcher();
    if (!dir || this.ctx.runtime.current !== runtime) return;
    collection.clear();
    collection.description = `Adds opentide ${runtime?.version ?? ""} (python -m opentide) to PATH`;
    collection.prepend("PATH", `${dir}${path.delimiter}`);
  }

  private async profile(): Promise<vscode.TerminalProfile> {
    if (!this.ctx.trust.isTrusted)
      throw new Error("Restricted Mode: trust this folder to open an opentide terminal.");
    await this.ctx.runtime.ready();
    const runtime = this.ctx.runtime.current;
    if (!hasCli(runtime))
      throw new Error("No opentide runtime: install opentide in the workspace or set opentide.path.");
    const dir = await this.launcher();
    if (!dir) throw new Error("Could not write the opentide launcher; see the opentide output.");
    const { key, value } = prependPath(process.env, dir, process.platform);
    const folder = this.ctx.folders.all[0];
    return new vscode.TerminalProfile({
      name: `opentide ${runtime.version}`,
      iconPath: new vscode.ThemeIcon("terminal"),
      env: { [key]: value, ...(folder ? { OPENTIDE_REPO_ROOT: folder.path } : {}) },
      ...(folder ? { cwd: folder.folder.uri } : {}),
    });
  }

  private links(line: string): OpentideLink[] {
    if (!this.ctx.trust.isTrusted) return [];
    const out: OpentideLink[] = [];
    for (const match of terminalMatches(line)) {
      if (match.kind === "code") {
        out.push({ startIndex: match.start, length: match.length, tooltip: `Explain ${match.value}`, match });
        continue;
      }
      const object = this.findObject(match.value);
      if (object)
        out.push({
          startIndex: match.start,
          length: match.length,
          tooltip: `Open ${object.name}`,
          match,
          file: object.file_path,
          line: object.line,
        });
    }
    return out;
  }

  private findObject(uuid: string): { name: string; file_path: string; line: number } | undefined {
    return linkedObject(
      this.ctx.folders.all.map((folder) => this.ctx.catalog.get(folder.path).catalog?.objects),
      uuid,
    );
  }

  private async openLink(link: OpentideLink): Promise<void> {
    if (link.match.kind === "code") {
      await vscode.commands.executeCommand("opentide.runner.explain", link.match.value);
      return;
    }
    if (!link.file) return;
    const line = Math.max(0, (link.line ?? 1) - 1);
    await vscode.window.showTextDocument(vscode.Uri.file(link.file), {
      selection: new vscode.Range(line, 0, line, 0),
    });
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.ctx.extension.environmentVariableCollection.clear();
  }
}

interface OpentideLink extends vscode.TerminalLink {
  readonly match: TerminalMatch;
  readonly file?: string;
  readonly line?: number;
}
