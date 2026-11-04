// The workspace's `tide-*` snippets in `opentide-yaml` files, while opentide writes them for `yaml` only
// (SPEC §7, opentide#752), and "Add <platform> block…" on a rule's `configurations:`. Reads
// `.vscode/*.code-snippets`; writes nothing (the user applies the insertion).
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { FeatureContext } from "../../core/context";
import { platformLabel } from "./flow";
import { configurationsLine, indentBlock, type TideSnippet, tideSnippets } from "./snippets";

interface Cached {
  readonly mtimeMs: number;
  readonly all: TideSnippet[];
  readonly missing: TideSnippet[];
}

export class Snippets implements vscode.Disposable, vscode.CompletionItemProvider, vscode.CodeActionProvider {
  private readonly cache = new Map<string, Cached>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: FeatureContext,
    private readonly enabledPlatforms: (folder: string) => ReadonlySet<string> | undefined,
  ) {
    this.disposables.push(
      vscode.languages.registerCompletionItemProvider({ language: "opentide-yaml" }, this),
      vscode.languages.registerCodeActionsProvider({ language: "opentide-yaml" }, this, {
        providedCodeActionKinds: [vscode.CodeActionKind.Refactor],
      }),
      vscode.commands.registerCommand(
        "opentide.newObject.addPlatformBlock",
        (uri?: unknown, platform?: unknown) => this.addBlock(uri, platform),
      ),
    );
  }

  /** Every `tide-*` snippet of the folder's `.vscode/*.code-snippets`, re-read when a file changes. */
  async snippets(folder: string): Promise<{ all: TideSnippet[]; missing: TideSnippet[] }> {
    const dir = path.join(folder, ".vscode");
    let names: string[];
    try {
      names = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".code-snippets")).sort();
    } catch {
      return { all: [], missing: [] };
    }
    const all: TideSnippet[] = [];
    const missing: TideSnippet[] = [];
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const stat = await fs.promises.stat(file);
        let cached = this.cache.get(file);
        if (!cached || cached.mtimeMs !== stat.mtimeMs) {
          const text = await fs.promises.readFile(file, "utf8");
          cached = { mtimeMs: stat.mtimeMs, all: tideSnippets(text, true), missing: tideSnippets(text) };
          this.cache.set(file, cached);
        }
        all.push(...cached.all);
        missing.push(...cached.missing);
      } catch {
        // unreadable: skip it
      }
    }
    return { all, missing };
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const folder = this.ctx.folders.folderOf(document.uri);
    if (!folder) return [];
    const { missing } = await this.snippets(folder.path);
    if (missing.length === 0) return [];
    const before = document.lineAt(position.line).text.slice(0, position.character);
    const word = /[\w-]*$/.exec(before)?.[0] ?? "";
    const range = new vscode.Range(
      position.line,
      position.character - word.length,
      position.line,
      position.character,
    );
    return missing.map((snippet) => {
      const item = new vscode.CompletionItem(
        { label: snippet.prefix, description: snippet.name },
        vscode.CompletionItemKind.Snippet,
      );
      item.insertText = new vscode.SnippetString(snippet.body);
      item.range = range;
      item.detail = snippet.description;
      item.documentation = new vscode.MarkdownString().appendCodeblock(snippet.body, "yaml");
      return item;
    });
  }

  async provideCodeActions(document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[]> {
    const folder = this.ctx.folders.folderOf(document.uri);
    if (!folder) return [];
    const lines: string[] = [];
    for (let line = 0; line < document.lineCount; line++) lines.push(document.lineAt(line).text);
    const at = configurationsLine(lines);
    if (at === undefined || range.start.line !== at) return [];
    const { all } = await this.snippets(folder.path);
    const present = new Set(
      lines
        .slice(at + 1)
        .map((line) => /^ {2}([A-Za-z_]\w*):/.exec(line)?.[1])
        .filter((key): key is string => !!key),
    );
    const enabled = this.enabledPlatforms(folder.path);
    return all
      .filter((snippet) => snippet.platform && !present.has(snippet.platform))
      .map((snippet) => {
        const platform = snippet.platform ?? "";
        const off = enabled && !enabled.has(platform) ? " (not enabled here)" : "";
        const action = new vscode.CodeAction(
          `Add ${platformLabel(platform)} block${off}`,
          vscode.CodeActionKind.Refactor.append("opentide"),
        );
        action.command = {
          title: action.title,
          command: "opentide.newObject.addPlatformBlock",
          arguments: [document.uri, platform],
        };
        return action;
      });
  }

  private async addBlock(uri: unknown, platform: unknown): Promise<void> {
    if (!(uri instanceof vscode.Uri) || typeof platform !== "string") return;
    const folder = this.ctx.folders.folderOf(uri);
    if (!folder) return;
    const snippet = (await this.snippets(folder.path)).all.find((s) => s.platform === platform);
    if (!snippet) {
      void vscode.window.showInformationMessage(
        `No tide-${platform} snippet in .vscode/: run opentide: Regenerate Templates, Schemas and Snippets.`,
      );
      return;
    }
    const editor = await vscode.window.showTextDocument(uri);
    const lines: string[] = [];
    for (let line = 0; line < editor.document.lineCount; line++)
      lines.push(editor.document.lineAt(line).text);
    const at = configurationsLine(lines);
    if (at === undefined) return;
    const end = editor.document.lineAt(at).range.end;
    // The platform block's body is the block's content; it goes under `  <platform>:`. The
    // `configurations:` line is not indented, so VS Code's indentation adjustment keeps it as is.
    const body = snippet.body.startsWith("\n") ? snippet.body : `\n${snippet.body}`;
    await editor.insertSnippet(new vscode.SnippetString(`\n  ${platform}:${indentBlock(body, "  ")}`), end, {
      undoStopBefore: true,
      undoStopAfter: true,
    });
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}
