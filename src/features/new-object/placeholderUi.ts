// Placeholder lines in the editor (SPEC §7 "Placeholders"): decorations (tint, gutter mark, overview
// ruler), Next / Previous placeholder, `N placeholders left`, the `opentide.hasPlaceholders` context
// key, and "Mark as done", a text edit the user applies (D3). Markers are never removed automatically.
import * as vscode from "vscode";
import type { FeatureContext } from "../../core/context";
import { placeholdersLeft } from "./flow";
import {
  isChanged,
  markerRange,
  nextPlaceholder,
  placeholderKey,
  placeholderLines,
  placeholderSelection,
  placeholderSnapshot,
} from "./placeholders";

function linesOf(document: vscode.TextDocument): string[] {
  const lines: string[] = [];
  for (let line = 0; line < document.lineCount; line++) lines.push(document.lineAt(line).text);
  return lines;
}

export class Placeholders implements vscode.Disposable, vscode.CodeActionProvider {
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly status = vscode.window.createStatusBarItem(
    "opentide.placeholders",
    vscode.StatusBarAlignment.Left,
    49,
  );
  /** The values each placeholder had when the extension first saw the document (or `new` wrote it). */
  private readonly snapshots = new Map<string, Map<string, string>>();
  private readonly cache = new Map<string, { version: number; lines: number[] }>();
  private timer: NodeJS.Timeout | undefined;
  private hasPlaceholders = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: FeatureContext) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("opentide.placeholderBackground"),
      overviewRulerColor: new vscode.ThemeColor("opentide.placeholderOverviewRuler"),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      gutterIconPath: vscode.Uri.joinPath(ctx.extension.extensionUri, "images", "placeholder.svg"),
      gutterIconSize: "70%",
    });
    this.status.name = "opentide placeholders";
    this.status.command = "opentide.placeholder.next";
    this.status.tooltip = "Go to the next placeholder";
    this.disposables.push(
      this.decoration,
      this.status,
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length > 0 && this.applies(event.document)) this.schedule();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.cache.delete(document.uri.toString());
        this.snapshots.delete(document.uri.toString());
      }),
      vscode.commands.registerCommand("opentide.placeholder.next", () => this.go(1)),
      vscode.commands.registerCommand("opentide.placeholder.previous", () => this.go(-1)),
      vscode.languages.registerCodeActionsProvider([{ language: "opentide-yaml" }], this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
    );
    this.refresh();
  }

  private applies(document: vscode.TextDocument): boolean {
    if (document.languageId === "opentide-yaml") return true;
    return document.languageId === "yaml" && this.ctx.folders.isObjectFile(document.uri);
  }

  /** The placeholder lines of a document, cached by version. */
  lines(document: vscode.TextDocument): number[] {
    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === document.version) return cached.lines;
    const text = linesOf(document);
    const lines = placeholderLines(text);
    this.cache.set(key, { version: document.version, lines });
    if (!this.snapshots.has(key)) this.snapshots.set(key, placeholderSnapshot(text));
    return lines;
  }

  /** Record the values `opentide new` wrote, so "Mark as done" knows when one changed. */
  remember(document: vscode.TextDocument): void {
    this.snapshots.set(document.uri.toString(), placeholderSnapshot(linesOf(document)));
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 100);
  }

  private refresh(): void {
    this.timer = undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      if (!this.applies(editor.document)) continue;
      const lines = this.lines(editor.document);
      editor.setDecorations(
        this.decoration,
        lines.map((line) => new vscode.Range(line, 0, line, 0)),
      );
    }
    const active = vscode.window.activeTextEditor;
    const count = active && this.applies(active.document) ? this.lines(active.document).length : 0;
    if (count > 0) {
      this.status.text = `$(edit) ${placeholdersLeft(count)}`;
      this.status.show();
    } else this.status.hide();
    if (count > 0 !== this.hasPlaceholders) {
      this.hasPlaceholders = count > 0;
      void vscode.commands.executeCommand("setContext", "opentide.hasPlaceholders", this.hasPlaceholders);
    }
  }

  /** Select the first placeholder of the editor (after `opentide new`). */
  selectFirst(editor: vscode.TextEditor): boolean {
    const first = this.lines(editor.document)[0];
    if (first === undefined) return false;
    this.select(editor, first);
    return true;
  }

  private select(editor: vscode.TextEditor, line: number): void {
    const span = placeholderSelection(linesOf(editor.document), line);
    const selection = new vscode.Selection(span.line, span.start, span.line, span.end);
    editor.selection = selection;
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private go(direction: 1 | -1): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const lines = this.lines(editor.document);
    const current = editor.selection.active.line;
    // A block scalar's selection sits on the line below its marker: count it as that placeholder.
    const from = lines.includes(current - 1) && !lines.includes(current) ? current - 1 : current;
    const target = nextPlaceholder(lines, from, direction);
    if (target === undefined) {
      vscode.window.setStatusBarMessage("$(check) No placeholders left in this file", 3000);
      return;
    }
    this.select(editor, target);
  }

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const lines = this.lines(document);
    if (lines.length === 0) return [];
    const text = linesOf(document);
    const snapshot = this.snapshots.get(document.uri.toString());
    const actions: vscode.CodeAction[] = [];
    for (let line = range.start.line; line <= range.end.line; line++) {
      // The marker's line, or the first line of its block scalar.
      const marker = lines.includes(line) ? line : lines.includes(line - 1) ? line - 1 : undefined;
      if (marker === undefined || !isChanged(text, marker, snapshot?.get(placeholderKey(text, marker))))
        continue;
      const span = markerRange(text, marker);
      if (!span) continue;
      const action = new vscode.CodeAction(
        "Mark as done (remove # opentide:placeholder)",
        vscode.CodeActionKind.QuickFix,
      );
      action.edit = new vscode.WorkspaceEdit();
      action.edit.delete(document.uri, new vscode.Range(span.line, span.start, span.line, span.end));
      action.isPreferred = true;
      actions.push(action);
      break;
    }
    return actions;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }
}
