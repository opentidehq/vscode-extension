// Diagnostics (SPEC §6, #13): the `opentide validate` and `opentide lint` collections next to the
// language server's own `opentide` collection, one squiggle per finding, quick fixes from each
// finding's `fix`, "Explain <code>" on every opentide diagnostic, and the problem counts.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { RunResult } from "../../core/backend/backend";
import { BackendError } from "../../core/backend/types";
import type { FeatureContext, OpentideFolder } from "../../core/context";
import { defineFeature } from "../../core/feature";
import { isFamilyFile } from "../../core/folders";
import { DOCUMENT_SELECTOR } from "../../core/lsp";
import { cliRange, type LineSource, linesOf } from "../../core/positions";
import { dryRunFixes, explainCodes, explainMarkdown, isCode } from "./explain";
import {
  diagnosticMessage,
  docsUrl,
  type Finding,
  type FindingSource,
  fixTitle,
  isDeprecationCode,
  lintFindings,
  type ParsedFindings,
  type Severity,
  validateFindings,
} from "./findings";
import { FindingsModel, fileKey, type RunScope } from "./model";
import {
  type Counts,
  codeText,
  countSeverities,
  dedupeKey,
  droppedFixFor,
  itemSignature,
  lintArgv,
  nonOverlapping,
  type OnSave,
  planSaveBatch,
  serverKeys,
  summaryText,
  validateArgv,
  withoutDuplicates,
} from "./plan";
import { Runs, runKey } from "./runs";
import { type SaveBatch, SaveBatcher } from "./saves";

export const SERVER_SOURCE = "opentide";
export const COLLECTION: Record<FindingSource, string> = {
  validate: "opentide validate",
  lint: "opentide lint",
};
const SOURCES: readonly FindingSource[] = ["validate", "lint"];
const EXPLAIN_SCHEME = "opentide-explain";
const FIXES_SCHEME = "opentide-fixes";

const SEVERITY: Record<Severity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

const SEVERITY_NAME = new Map<vscode.DiagnosticSeverity, Severity>([
  [vscode.DiagnosticSeverity.Error, "error"],
  [vscode.DiagnosticSeverity.Warning, "warning"],
  [vscode.DiagnosticSeverity.Information, "info"],
  [vscode.DiagnosticSeverity.Hint, "hint"],
]);

interface Rendered {
  readonly diagnostic: vscode.Diagnostic;
  readonly finding: Finding;
  readonly key: string;
  /** The server diagnostics that would report it (`serverKeys`). */
  readonly alternatives: string[][];
}

interface Outcome {
  readonly result: RunResult;
  readonly parsed: ParsedFindings;
}

function documentLines(document: vscode.TextDocument): LineSource {
  return { lineCount: document.lineCount, lineText: (line) => document.lineAt(line).text };
}

function setting<T>(key: string, scope: vscode.Uri | undefined, fallback: T): T {
  return vscode.workspace.getConfiguration("opentide", scope).get<T>(key) ?? fallback;
}

function sameRange(a: vscode.Range, b: vscode.Range): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

function failureText(result: RunResult): string {
  const failure = result.document.failure;
  return failure ? `${failure.code}: ${failure.message}` : result.document.message;
}

class Diagnostics implements vscode.Disposable {
  private readonly model = new FindingsModel();
  private readonly runs = new Runs();
  private readonly collections: Record<FindingSource, vscode.DiagnosticCollection> = {
    validate: vscode.languages.createDiagnosticCollection(COLLECTION.validate),
    lint: vscode.languages.createDiagnosticCollection(COLLECTION.lint),
  };
  /** Every finding as a diagnostic, before the dedupe, by URI. */
  private readonly rendered = new Map<string, Record<FindingSource, Rendered[]>>();
  /** What each collection shows, by URI (after the dedupe), with a signature to skip no-op updates. */
  private readonly shown = new Map<string, Record<FindingSource, { items: Rendered[]; signature: string }>>();
  private readonly explainPages = new Map<string, string>();
  private readonly explainChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly fixDiffs = new Map<string, string>();
  private readonly saves = new SaveBatcher<OpentideFolder>({
    invalidate: (paths) => this.ctx.backend.invalidate(paths),
    flush: (batches) => this.flushSaves(batches),
  });
  private countTimer: NodeJS.Timeout | undefined;
  private startupFor: unknown;
  private knownFolders: readonly string[];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: FeatureContext) {
    this.knownFolders = ctx.folders.all.map((folder) => folder.path);
    const provider: vscode.TextDocumentContentProvider = {
      onDidChange: this.explainChanged.event,
      provideTextDocumentContent: (uri) =>
        uri.scheme === EXPLAIN_SCHEME
          ? (this.explainPages.get(path.posix.basename(uri.path, ".md")) ?? "")
          : (this.fixDiffs.get(uri.toString()) ?? ""),
    };
    this.disposables.push(
      this.collections.validate,
      this.collections.lint,
      this.explainChanged,
      vscode.workspace.registerTextDocumentContentProvider(EXPLAIN_SCHEME, provider),
      vscode.workspace.registerTextDocumentContentProvider(FIXES_SCHEME, provider),
      vscode.languages.registerCodeActionsProvider(DOCUMENT_SELECTOR, this, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
      vscode.languages.onDidChangeDiagnostics((event) => this.onDiagnostics(event)),
      vscode.workspace.onDidSaveTextDocument((document) => this.onSave(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.onEdit(event)),
      vscode.workspace.onDidDeleteFiles((event) => this.forget(event.files)),
      vscode.workspace.onDidRenameFiles((event) => this.forget(event.files.map((file) => file.oldUri))),
      ctx.onDidChangeFiles(({ uris }) => this.forget(uris.filter((uri) => !fs.existsSync(uri.fsPath)))),
      ctx.folders.onDidChange((all) => this.onFolders(all)),
      ctx.runtime.onDidChange(() => void this.startup()),
      ctx.trust.onDidGrant(() => void this.startup()),
      ctx.status.addMenuItem({
        label: "$(check-all) Validate workspace",
        command: "opentide.diagnostics.validateWorkspace",
        order: 10,
      }),
      ctx.status.addMenuItem({
        label: "$(checklist) Lint workspace",
        command: "opentide.diagnostics.lintWorkspace",
        order: 11,
      }),
      vscode.commands.registerCommand("opentide.diagnostics.validateWorkspace", () =>
        this.workspaceCommand("validate"),
      ),
      vscode.commands.registerCommand("opentide.diagnostics.lintWorkspace", () =>
        this.workspaceCommand("lint"),
      ),
      vscode.commands.registerCommand("opentide.diagnostics.validateFile", (uri?: unknown) =>
        this.validateFileCommand(uri instanceof vscode.Uri ? uri : undefined),
      ),
      vscode.commands.registerCommand("opentide.diagnostics.explain", (code?: unknown) => this.explain(code)),
      vscode.commands.registerCommand("opentide.diagnostics.fixAllSafe", () => this.fixAllSafe()),
      vscode.commands.registerCommand("opentide.diagnostics.clear", () => this.clearAll()),
    );
  }

  // ---- runs ----

  private available(): boolean {
    return this.ctx.trust.isTrusted && this.ctx.backend.availability().available;
  }

  /** Run validate or lint on a folder (or some of its files) and show what it found. */
  private async run(
    source: FindingSource,
    folder: OpentideFolder,
    files: readonly string[] | undefined,
    cancellation?: vscode.CancellationToken,
  ): Promise<Outcome | undefined> {
    const key = runKey(source, folder.path, files ? [...files].sort().join("|") : undefined);
    const { token, finish } = this.runs.start(key, cancellation);
    const seq = this.model.begin();
    const argv = source === "validate" ? validateArgv(files) : lintArgv(files);
    try {
      const result = await this.ctx.backend.run(folder.path, argv, { cancellation: token });
      if (result.cancelled || token.isCancellationRequested) return undefined;
      const parsed =
        source === "validate"
          ? validateFindings(result.document, folder.path)
          : lintFindings(result.document, folder.path);
      if (!parsed.complete) {
        this.ctx.log.warn(`${result.argvDisplay}: no findings in the result (${failureText(result)})`);
        return { result, parsed };
      }
      if (parsed.unlocated > 0)
        this.ctx.log.info(`${result.argvDisplay}: ${parsed.unlocated} findings name no file`);
      const scope: RunScope = files
        ? { kind: "files", folder: folder.path, files }
        : { kind: "workspace", folder: folder.path };
      const changed = this.model.apply(source, seq, scope, parsed.findings, (file) => this.isDirty(file));
      await this.render(changed);
      return { result, parsed };
    } catch (error) {
      if (error instanceof BackendError) this.ctx.log.warn(`opentide ${argv.join(" ")}: ${error.message}`);
      else this.ctx.log.error(error instanceof Error ? error : String(error));
      return undefined;
    } finally {
      finish();
    }
  }

  /** A run nobody waits for: progress in the status bar only. */
  private background(source: FindingSource, folder: OpentideFolder, files?: readonly string[]): void {
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `opentide ${source}` },
      () => this.run(source, folder, files),
    );
  }

  private isDirty(file: string): boolean {
    const uri = vscode.Uri.file(file).toString();
    return vscode.workspace.textDocuments.some(
      (document) => document.uri.toString() === uri && document.isDirty,
    );
  }

  private onSave(document: vscode.TextDocument): void {
    if (document.uri.scheme !== "file" || !this.available()) return;
    const folder = this.ctx.folders.folderOf(document.uri);
    if (!folder) return;
    const relative = path.relative(folder.path, document.uri.fsPath).split(path.sep).join("/");
    const isConfiguration = relative.startsWith(".opentide/configurations/");
    // Only a file directly in a family folder: `validate --file` and `lint --file` accept no other, and
    // a failed lint of one file in a batch would otherwise clear the others' problems.
    const isObject = isFamilyFile(folder.path, document.uri.fsPath, folder.objectFolders);
    if (!isObject && !isConfiguration) return;
    // Saving several files at once (Save All) gives one run per folder; serve forgets the saved file first.
    this.saves.add(folder.path, folder, document.uri.fsPath, isObject ? "object" : "configuration");
  }

  private async flushSaves(batches: readonly SaveBatch<OpentideFolder>[]): Promise<void> {
    const capabilities = await this.ctx.capabilities.ready();
    const features = {
      validateFile: capabilities?.hasOption("validate", "--file") ?? false,
      lintFile: capabilities?.hasOption("lint", "--file") ?? false,
    };
    for (const { folder, files, configuration } of batches) {
      const scope = folder.folder.uri;
      const settings = {
        validateOnSave: setting<OnSave>("validate.onSave", scope, "file"),
        lintOnSave: setting<"file" | "off">("lint.onSave", scope, "file"),
        lintWithValidate: setting<boolean>("lint.withValidate", scope, false),
      };
      const targets = [...files];
      const plan = planSaveBatch({ objects: targets.length, configuration }, settings, features);
      if (plan.validate) this.background("validate", folder, plan.validate === "file" ? targets : undefined);
      if (plan.lint) this.background("lint", folder, plan.lint === "file" ? targets : undefined);
    }
  }

  /** On activation (`opentide.validate.onStartup`), once per runtime. */
  async startup(): Promise<void> {
    const runtime = this.ctx.runtime.current;
    if (!runtime || runtime === this.startupFor || !this.available()) return;
    this.startupFor = runtime;
    // Let the language server start first: it answers the open files.
    await this.clientStarted();
    for (const folder of this.ctx.folders.all) this.validateFolderInBackground(folder);
  }

  /** The language client's next start (or now, when it runs), or 10 s, whichever comes first. */
  private clientStarted(): Promise<void> {
    if (this.ctx.client.current) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, 10_000);
      const subscription = this.ctx.client.onDidChange((client) => {
        if (client) done();
      });
      function done(): void {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      }
    });
  }

  private validateFolderInBackground(folder: OpentideFolder): void {
    const scope = folder.folder.uri;
    if (!setting<boolean>("validate.onStartup", scope, true)) return;
    this.background("validate", folder);
    if (setting<boolean>("lint.withValidate", scope, false)) this.background("lint", folder);
  }

  private onFolders(all: readonly { path: string }[]): void {
    const now = all.map((folder) => folder.path);
    for (const gone of this.knownFolders.filter((folder) => !now.includes(folder))) {
      for (const source of SOURCES) this.runs.cancel(runKey(source, gone));
      void this.render(this.model.removeFolder(gone));
    }
    const added = this.ctx.folders.all.filter((folder) => !this.knownFolders.includes(folder.path));
    this.knownFolders = now;
    if (this.available() && this.startupFor)
      for (const folder of added) this.validateFolderInBackground(folder);
  }

  // ---- commands ----

  private async workspaceCommand(source: FindingSource): Promise<void> {
    if (!this.canRun()) return;
    const folders = this.ctx.folders.all;
    if (folders.length === 0) {
      void vscode.window.showInformationMessage("No opentide folder in this workspace.");
      return;
    }
    const withLint =
      source === "validate" && folders.some((f) => setting("lint.withValidate", f.folder.uri, false));
    const outcomes = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: source === "validate" ? "Validating the workspace" : "Linting the workspace",
        cancellable: true,
      },
      (_progress, token) =>
        Promise.all(
          folders.flatMap((folder) => [
            this.run(source, folder, undefined, token),
            ...(withLint && setting("lint.withValidate", folder.folder.uri, false)
              ? [this.run("lint", folder, undefined, token)]
              : []),
          ]),
        ),
    );
    const done = outcomes.filter((outcome): outcome is Outcome => outcome !== undefined);
    if (done.length === 0) return;
    // The run is done: the command resolves now, not when the notification closes (a caller awaiting it,
    // a keybinding or another command, would otherwise wait on the user).
    const failed = done.find((outcome) => !outcome.parsed.complete);
    if (failed) {
      void vscode.window
        .showErrorMessage(
          `${failed.result.argvDisplay} failed: ${failed.result.document.failure?.message ?? failed.result.document.message}`,
          "Show output",
        )
        .then((choice) => {
          if (choice) this.ctx.log.show();
        });
      return;
    }
    const findings = done.flatMap((outcome) => outcome.parsed.findings);
    const counts = countSeverities(findings.map((finding) => finding.severity));
    const files = new Set(findings.map((finding) => finding.file)).size;
    if (counts.errors === 0 && counts.warnings === 0) {
      vscode.window.setStatusBarMessage(`$(check) opentide ${source}: no problems`, 5000);
      return;
    }
    void vscode.window
      .showInformationMessage(`opentide ${source}: ${summaryText(counts, files)}.`, "Show Problems")
      .then((choice) => {
        if (choice) void vscode.commands.executeCommand("workbench.actions.view.problems");
      });
  }

  private async validateFileCommand(uri: vscode.Uri | undefined): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || !this.canRun()) return;
    const folder = this.ctx.folders.folderOf(target);
    if (!folder) {
      void vscode.window.showInformationMessage("This file is not in an opentide folder.");
      return;
    }
    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
    if (document?.isDirty) {
      await document.save();
      // Saving validates it, unless validate on save is off.
      if (setting<OnSave>("validate.onSave", folder.folder.uri, "file") !== "off") return;
    }
    const capabilities = await this.ctx.capabilities.ready();
    const files = capabilities?.hasOption("validate", "--file") ? [target.fsPath] : undefined;
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "opentide validate" },
      () => this.run("validate", folder, files),
    );
    if (!outcome) return;
    const mine = outcome.parsed.findings.filter(
      (finding) => fileKey(finding.file) === fileKey(target.fsPath),
    );
    const counts = countSeverities(mine.map((finding) => finding.severity));
    vscode.window.setStatusBarMessage(
      counts.errors + counts.warnings === 0
        ? "$(check) opentide validate: no problems in this file"
        : `$(warning) opentide validate: ${summaryText(counts, 1)}`,
      5000,
    );
  }

  /** True when commands can run; otherwise says why (Restricted Mode, no runtime). */
  private canRun(): boolean {
    const availability = this.ctx.backend.availability();
    if (availability.available) return true;
    const messages = {
      untrusted: "Trust this folder to run opentide.",
      "no-runtime": "No opentide runtime: install opentide in the workspace or set opentide.path.",
      "editor-only": "opentide.path names opentide-lsp, which has no commands. Point it at opentide.",
    };
    void vscode.window.showInformationMessage(messages[availability.code]);
    return false;
  }

  private async explain(requested: unknown): Promise<void> {
    let picked = isCode(requested) ? requested : undefined;
    const availability = this.ctx.backend.availability();
    if (!availability.available) {
      const target = picked;
      const choice = await vscode.window.showInformationMessage(
        availability.code === "untrusted"
          ? "Trust this folder to explain codes offline."
          : "Explaining a code needs an opentide runtime.",
        ...(target ? ["Open the online page"] : []),
      );
      if (choice && target) await vscode.env.openExternal(vscode.Uri.parse(docsUrl(target)));
      return;
    }
    const cwd = await this.commandFolder();
    if (!picked) {
      const list = await this.ctx.backend.run(cwd, ["explain"]).catch(() => undefined);
      const codes = explainCodes(list?.document);
      if (codes.length === 0) return;
      const choice = await vscode.window.showQuickPick(
        codes.map((entry) => ({ label: entry.code, detail: entry.meaning })),
        { placeHolder: "Explain a diagnostic code", matchOnDetail: true },
      );
      picked = choice?.label;
    }
    if (!picked) return;
    const code = picked;
    let markdown = this.explainPages.get(code);
    if (!markdown) {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `opentide explain ${code}` },
        () => this.ctx.backend.run(cwd, ["explain", code]),
      );
      markdown = explainMarkdown(code, result.document);
      if (!markdown) {
        void vscode.window.showWarningMessage(
          `opentide explain ${code}: ${result.document.failure?.message ?? result.document.message}`,
        );
        return;
      }
      this.explainPages.set(code, markdown);
    }
    const uri = vscode.Uri.from({ scheme: EXPLAIN_SCHEME, path: `/${code}.md` });
    this.explainChanged.fire(uri);
    try {
      await vscode.commands.executeCommand("markdown.showPreviewToSide", uri);
    } catch {
      // The built-in Markdown extension is disabled: show the source instead.
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    }
  }

  /** A folder to run folder-independent commands (explain) in. */
  private async commandFolder(): Promise<string> {
    const folder = this.ctx.folders.all[0]?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) return folder;
    const storage = this.ctx.extension.globalStorageUri.fsPath;
    await fs.promises.mkdir(storage, { recursive: true }).catch(() => undefined);
    return storage;
  }

  /** "Fix all safe opentide problems in the workspace": the dry-run diff first, then `validate --fix`. */
  private async fixAllSafe(): Promise<void> {
    if (!this.canRun()) return;
    const folder = await this.ctx.folders.pick("Fix safe problems in which folder?");
    if (!folder) return;
    const capabilities = await this.ctx.capabilities.ready();
    if (!capabilities?.hasOption("validate", "--fix") || !capabilities.hasOption("validate", "--dry-run")) {
      void vscode.window.showInformationMessage("This needs an opentide with `validate --fix --dry-run`.");
      return;
    }
    const preview = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Looking for safe fixes", cancellable: true },
      (_progress, token) =>
        this.ctx.backend.run(folder.path, ["validate", "--fix", "--dry-run"], { cancellation: token }),
    );
    if (preview.cancelled) return;
    const { diff, fixes } = dryRunFixes(preview.document);
    if (fixes.length === 0) {
      void vscode.window.showInformationMessage(`No safe fixes in ${folder.folder.name}.`);
      return;
    }
    const uri = vscode.Uri.from({ scheme: FIXES_SCHEME, path: `/${folder.folder.name}/safe-fixes.diff` });
    this.fixDiffs.set(uri.toString(), diff);
    this.explainChanged.fire(uri);
    const document = await vscode.languages.setTextDocumentLanguage(
      await vscode.workspace.openTextDocument(uri),
      "diff",
    );
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    const files = [...new Set(fixes.map((fix) => path.resolve(folder.path, fix.path)))];
    const dirty = files.filter((file) => this.isDirty(file));
    if (dirty.length > 0) {
      void vscode.window.showWarningMessage(
        `Save ${dirty.map((file) => path.basename(file)).join(", ")} first: opentide fixes the files on disk.`,
      );
      return;
    }
    const apply = `Apply ${fixes.length === 1 ? "the fix" : `${fixes.length} fixes`}`;
    const choice = await vscode.window.showInformationMessage(
      `${fixes.length} safe ${fixes.length === 1 ? "fix" : "fixes"} in ${files.length} ${files.length === 1 ? "file" : "files"}: ${preview.argvDisplay.replace(" --dry-run", "")}`,
      apply,
    );
    if (choice !== apply) return;
    const seq = this.model.begin();
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Applying safe fixes" },
      () => this.ctx.backend.run(folder.path, ["validate", "--fix"]),
    );
    const parsed = validateFindings(result.document, folder.path);
    if (parsed.complete) {
      const changed = this.model.apply(
        "validate",
        seq,
        { kind: "workspace", folder: folder.path },
        parsed.findings,
      );
      await this.render(changed);
    }
    vscode.window.setStatusBarMessage(
      `$(check) opentide: applied ${fixes.length} safe ${fixes.length === 1 ? "fix" : "fixes"}`,
      5000,
    );
  }

  private clearAll(): void {
    this.runs.cancel();
    void this.render(this.model.clear());
  }

  // ---- rendering ----

  private async lines(file: string): Promise<LineSource> {
    const uri = vscode.Uri.file(file).toString();
    const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri);
    if (open) return documentLines(open);
    try {
      return linesOf(await fs.promises.readFile(file, "utf8"));
    } catch {
      return linesOf("");
    }
  }

  private async relatedInformation(finding: Finding): Promise<vscode.DiagnosticRelatedInformation[]> {
    const out: vscode.DiagnosticRelatedInformation[] = [];
    for (const related of finding.related) {
      const lines = await this.lines(related.file);
      let range = new vscode.Range(0, 0, 0, 0);
      if (related.value) {
        for (let line = 0; line < lines.lineCount; line++) {
          const character = lines.lineText(line).indexOf(related.value);
          if (character >= 0) {
            range = new vscode.Range(line, character, line, character + related.value.length);
            break;
          }
        }
      }
      out.push(
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(vscode.Uri.file(related.file), range),
          related.message,
        ),
      );
    }
    return out;
  }

  private async toDiagnostic(finding: Finding, lines: LineSource): Promise<Rendered> {
    const range = cliRange(lines, finding.span);
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character),
      diagnosticMessage(finding),
      SEVERITY[finding.severity],
    );
    diagnostic.source = COLLECTION[finding.source];
    diagnostic.code = { value: finding.code, target: vscode.Uri.parse(docsUrl(finding.code)) };
    if (isDeprecationCode(finding.code)) diagnostic.tags = [vscode.DiagnosticTag.Deprecated];
    if (finding.related.length > 0) diagnostic.relatedInformation = await this.relatedInformation(finding);
    return {
      diagnostic,
      finding,
      key: dedupeKey(finding.code, range.start.line),
      alternatives: serverKeys(finding.code, range.start.line, finding.message),
    };
  }

  /** Rebuild the diagnostics of these files from the model, then show them. */
  private async render(files: readonly string[]): Promise<void> {
    for (const file of files) {
      const uri = vscode.Uri.file(file);
      const lines = await this.lines(file);
      const entry: Record<FindingSource, Rendered[]> = { validate: [], lint: [] };
      for (const source of SOURCES) {
        for (const finding of this.model.get(source, file))
          entry[source].push(await this.toDiagnostic(finding, lines));
      }
      if (entry.validate.length + entry.lint.length === 0) this.rendered.delete(uri.toString());
      else this.rendered.set(uri.toString(), entry);
      this.show(uri);
    }
  }

  /** Set the collections for `uri`: every rendered finding the language server does not already report. */
  private show(uri: vscode.Uri): void {
    const key = uri.toString();
    const entry = this.rendered.get(key) ?? { validate: [], lint: [] };
    const server = new Set<string>();
    for (const diagnostic of vscode.languages.getDiagnostics(uri)) {
      const code = codeText(diagnostic.code);
      if (diagnostic.source === SERVER_SOURCE && code)
        server.add(dedupeKey(code, diagnostic.range.start.line));
    }
    const previous = this.shown.get(key);
    const next = {
      ...(previous ?? { validate: { items: [], signature: "" }, lint: { items: [], signature: "" } }),
    };
    let changed = false;
    for (const source of SOURCES) {
      const items = withoutDuplicates(entry[source], (item) => item.alternatives, server);
      const signature = items.map(itemSignature).join("\u0002");
      if (previous?.[source].signature === signature && previous[source].items.length === items.length)
        continue;
      this.collections[source].set(
        uri,
        items.map((item) => item.diagnostic),
      );
      next[source] = { items, signature };
      changed = true;
    }
    if (!changed) return;
    if (next.validate.items.length + next.lint.items.length === 0) this.shown.delete(key);
    else this.shown.set(key, next);
    this.scheduleCounts();
  }

  private onDiagnostics(event: vscode.DiagnosticChangeEvent): void {
    for (const uri of event.uris)
      if (this.rendered.has(uri.toString()) || this.shown.has(uri.toString())) this.show(uri);
    this.scheduleCounts();
  }

  private onEdit(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0 || event.document.uri.scheme !== "file") return;
    if (!this.ctx.folders.folderOf(event.document.uri)) return;
    // Stale is worse than missing: the language server covers the file until the next run.
    if (this.model.edited(event.document.uri.fsPath)) void this.render([event.document.uri.fsPath]);
  }

  private forget(uris: readonly vscode.Uri[]): void {
    const files = uris
      .filter((uri) => uri.scheme === "file" && this.model.removed(uri.fsPath))
      .map((uri) => uri.fsPath);
    if (files.length > 0) void this.render(files);
  }

  private scheduleCounts(): void {
    if (this.countTimer) return;
    this.countTimer = setTimeout(() => {
      this.countTimer = undefined;
      this.updateCounts();
    }, 200);
  }

  /** The union of the three collections in the status bar (SPEC §6 rule 8). */
  private updateCounts(): void {
    const severities = (diagnostics: readonly vscode.Diagnostic[]): Severity[] =>
      diagnostics.flatMap((diagnostic) => {
        const severity = SEVERITY_NAME.get(diagnostic.severity);
        return severity ? [severity] : [];
      });
    const server: Severity[] = [];
    for (const [, diagnostics] of vscode.languages.getDiagnostics())
      server.push(...severities(diagnostics.filter((diagnostic) => diagnostic.source === SERVER_SOURCE)));
    const counts: Record<string, Counts> = {
      [SERVER_SOURCE]: countSeverities(server),
      [COLLECTION.validate]: { errors: 0, warnings: 0 },
      [COLLECTION.lint]: { errors: 0, warnings: 0 },
    };
    for (const entry of this.shown.values()) {
      for (const source of SOURCES) {
        const c = countSeverities(entry[source].items.map((item) => item.finding.severity));
        const total = counts[COLLECTION[source]];
        if (total) {
          total.errors += c.errors;
          total.warnings += c.warnings;
        }
      }
    }
    for (const [source, value] of Object.entries(counts)) this.ctx.status.setCounts(source, value);
  }

  // ---- code actions ----

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    // Fix-all stays the server's (`source.fixAll.opentide`, explicit only); this provider offers quick fixes.
    if (context.only && !context.only.intersects(vscode.CodeActionKind.QuickFix)) return [];
    const actions: vscode.CodeAction[] = [];
    const explained = new Set<string>();
    const entry = this.shown.get(document.uri.toString());
    let safeHere = false;
    for (const diagnostic of context.diagnostics) {
      const source = diagnostic.source;
      const code = codeText(diagnostic.code);
      const ours = SOURCES.find((s) => COLLECTION[s] === source);
      if (ours && entry && code) {
        const match = entry[ours].items.find(
          (item) =>
            item.finding.code === code &&
            sameRange(item.diagnostic.range, diagnostic.range) &&
            item.diagnostic.message === diagnostic.message,
        );
        const fix = match?.finding.fix;
        if (match && fix) {
          const action = new vscode.CodeAction(fixTitle(match.finding), vscode.CodeActionKind.QuickFix);
          action.edit = this.editFor(document, [match.finding]);
          action.diagnostics = [diagnostic];
          action.isPreferred = fix.safe;
          actions.push(action);
          if (fix.safe) safeHere = true;
        }
      }
      if (source === SERVER_SOURCE && code) {
        // A validate or lint finding the dedupe dropped in favour of this one still offers its fix here.
        const rendered = this.rendered.get(document.uri.toString());
        const key = dedupeKey(code, diagnostic.range.start.line);
        for (const ourSource of SOURCES) {
          const dropped = rendered
            ? droppedFixFor(rendered[ourSource], entry?.[ourSource].items ?? [], key)
            : undefined;
          if (!dropped?.finding.fix) continue;
          const action = new vscode.CodeAction(fixTitle(dropped.finding), vscode.CodeActionKind.QuickFix);
          action.edit = this.editFor(document, [dropped.finding]);
          action.diagnostics = [diagnostic];
          action.isPreferred = dropped.finding.fix.safe;
          actions.push(action);
          break;
        }
      }
      if ((ours || source === SERVER_SOURCE) && isCode(code) && !explained.has(code)) {
        explained.add(code);
        const action = new vscode.CodeAction(
          `Explain ${code}`,
          vscode.CodeActionKind.QuickFix.append("opentide").append("explain"),
        );
        action.command = {
          title: `Explain ${code}`,
          command: "opentide.diagnostics.explain",
          arguments: [code],
        };
        action.diagnostics = [diagnostic];
        actions.push(action);
      }
    }
    if (safeHere && entry) {
      const safe = entry.validate.items.filter((item) => item.finding.fix?.safe).map((item) => item.finding);
      if (safe.length > 1) {
        const action = new vscode.CodeAction(
          `Fix all ${safe.length} safe opentide problems in this file`,
          vscode.CodeActionKind.QuickFix,
        );
        action.edit = this.editFor(document, safe);
        action.diagnostics = entry.validate.items
          .filter((item) => item.finding.fix?.safe)
          .map((item) => item.diagnostic);
        actions.push(action);
      }
      const workspace = new vscode.CodeAction(
        "Fix all safe opentide problems in the workspace…",
        vscode.CodeActionKind.QuickFix,
      );
      workspace.command = { title: workspace.title, command: "opentide.diagnostics.fixAllSafe" };
      actions.push(workspace);
    }
    return actions;
  }

  /** One workspace edit with every edit of these findings' fixes, overlapping edits left out. */
  private editFor(document: vscode.TextDocument, findings: readonly Finding[]): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();
    const changes = findings.flatMap((finding) =>
      (finding.fix?.edits ?? []).map((change) => ({
        range: this.ctx.positions.toRange(document, change),
        replacement: change.replacement,
      })),
    );
    for (const change of nonOverlapping(changes))
      edit.replace(document.uri, change.range, change.replacement);
    return edit;
  }

  dispose(): void {
    this.saves.dispose();
    if (this.countTimer) clearTimeout(this.countTimer);
    this.runs.cancel();
    for (const source of [SERVER_SOURCE, COLLECTION.validate, COLLECTION.lint])
      this.ctx.status.setCounts(source, undefined);
    for (const disposable of this.disposables) disposable.dispose();
  }
}

export default defineFeature({
  id: "diagnostics",
  activate(ctx) {
    const diagnostics = new Diagnostics(ctx);
    ctx.subscriptions.push(diagnostics);
    // The first resolution may already have happened before this feature subscribed.
    void ctx.runtime.ready().then(() => diagnostics.startup());
  },
});
