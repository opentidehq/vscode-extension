// New objects (SPEC §7, #14): "New object…" runs `opentide new` (the only thing that creates an object,
// D3) from a multi-step quick input, opens the file on its first placeholder, and handles each failure
// by its code. Also placeholder navigation and the workspace's `tide-*` snippets in `opentide-yaml`.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { BackendError } from "../../core/backend/types";
import type { FeatureContext, OpentideFolder } from "../../core/context";
import { defineFeature } from "../../core/feature";
import {
  type ChoiceItem,
  choiceItem,
  choicesFromCatalog,
  createdOf,
  failureAction,
  isKind,
  KIND_DETAIL,
  KIND_LABEL,
  KINDS,
  kindOfFolder,
  type NewInput,
  newArgv,
  type ObjectChoice,
  type ObjectKind,
  objectFolderPaths,
  objectHeader,
  type PlatformInfo,
  placeholdersText,
  platformItems,
  platformsOf,
  slugOf,
  validateName,
} from "./flow";
import { askText, BACK, isButton, pickMany, pickOne } from "./input";
import { Placeholders } from "./placeholderUi";
import { Snippets } from "./snippetUi";

/** What the commands accept: a folder from the Explorer, or prefilled fields from another view. */
export interface NewObjectArgs {
  readonly kind?: ObjectKind;
  /** A workspace folder's path (else the active editor's, else ask). */
  readonly folder?: string;
  /** Where to write (`--path`): a folder or a file. */
  readonly path?: string;
  readonly name?: string;
  readonly objective?: string;
  readonly threats?: readonly string[];
}

/** Commands that may open the setup wizard, in order of preference (another feature owns it). */
const SETUP_COMMANDS = ["opentide.setup.open", "opentide.setup.wizard", "opentide.setup"];

const NEW_THREAT_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("add"),
  tooltip: "Create a new threat…",
};

type PlatformPick = vscode.QuickPickItem & { readonly id: string };
type ObjectPick = vscode.QuickPickItem & { readonly uuid?: string; readonly action?: "create" | "none" };
type FolderPick = vscode.QuickPickItem & { readonly choose?: true };

/** Read `uuid` from a catalogue node or an argument, whatever shape another view passes. */
function uuidOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const candidate =
      (value as { uuid?: unknown; object?: { uuid?: unknown } }).uuid ??
      (value as { object?: { uuid?: unknown } }).object?.uuid;
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function argsOf(value: unknown, kind?: ObjectKind): NewObjectArgs {
  if (value instanceof vscode.Uri) return { ...(kind ? { kind } : {}), path: value.fsPath };
  const args: NewObjectArgs = value && typeof value === "object" ? (value as NewObjectArgs) : {};
  const own = isKind(args.kind) ? args.kind : undefined;
  return { ...args, ...((kind ?? own) ? { kind: kind ?? own } : {}) };
}

class NewObject implements vscode.Disposable, vscode.CodeActionProvider {
  private readonly placeholders: Placeholders;
  private readonly snippets: Snippets;
  /** `info`'s platforms per folder, read once per flow and kept for the code actions. */
  private readonly platformInfo = new Map<string, readonly PlatformInfo[]>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ctx: FeatureContext) {
    this.placeholders = new Placeholders(ctx);
    this.snippets = new Snippets(ctx, (folder) => {
      const info = this.platformInfo.get(folder);
      return info ? new Set(info.filter((p) => p.enabled).map((p) => p.name)) : undefined;
    });
    const command = (id: string, run: (arg: unknown) => unknown) =>
      vscode.commands.registerCommand(id, (arg?: unknown) => run(arg));
    this.disposables.push(
      this.placeholders,
      this.snippets,
      command("opentide.newObject", (arg) => this.start(argsOf(arg))),
      ...KINDS.flatMap((kind) => [
        command(`opentide.newObject.${kind}`, (arg) => this.start(argsOf(arg, kind))),
        command(`opentide.newObject.newFile.${kind}`, () => this.start({ kind })),
      ]),
      command("opentide.newObject.ruleForObjective", (arg) => {
        const objective = uuidOf(arg);
        return this.start({ kind: "rule", ...(objective ? { objective } : {}) });
      }),
      command("opentide.newObject.objectiveForThreat", (arg) => {
        const threat = uuidOf(arg);
        return this.start({ kind: "objective", ...(threat ? { threats: [threat] } : {}) });
      }),
      command("opentide.newObject.regenerateTemplates", () => this.regenerate()),
      vscode.languages.registerCodeActionsProvider({ language: "opentide-yaml" }, this, {
        providedCodeActionKinds: [vscode.CodeActionKind.Refactor],
      }),
      ctx.folders.onDidChange(() => this.updateFolderContext()),
    );
    this.updateFolderContext();
  }

  /** The Explorer menu shows "New object…" on these folders (`resourcePath in opentide.objectFolders`). */
  private updateFolderContext(): void {
    const folders = this.ctx.folders.all.flatMap((f) => objectFolderPaths(f.path, f.objectFolders));
    void vscode.commands.executeCommand("setContext", "opentide.objectFolders", folders);
  }

  private canRun(): boolean {
    const availability = this.ctx.backend.availability();
    if (availability.available) return true;
    const messages = {
      untrusted: "Trust this folder to create objects: opentide new writes the file.",
      "no-runtime": "No opentide runtime: install opentide in the workspace or set opentide.path.",
      "editor-only": "opentide.path names opentide-lsp, which has no commands. Point it at opentide.",
    };
    void vscode.window.showInformationMessage(messages[availability.code]);
    return false;
  }

  private async folderFor(args: NewObjectArgs): Promise<OpentideFolder | undefined> {
    const target = args.path ?? args.folder;
    if (target) {
      const folder = this.ctx.folders.folderOf(vscode.Uri.file(target));
      if (folder) return folder;
    }
    const folder = await this.ctx.folders.pick("Create the object in which folder?");
    if (!folder && this.ctx.folders.all.length === 0) {
      const choice = await vscode.window.showInformationMessage(
        "No opentide workspace is open here.",
        "Set up this folder",
      );
      if (choice) await this.openSetup();
    }
    return folder;
  }

  /** Entry point of every command: collect the fields, run `opentide new`, open the result. */
  async start(requested: NewObjectArgs): Promise<void> {
    let args = requested;
    if (!this.canRun()) return;
    const folder = await this.folderFor(args);
    if (!folder) return;
    const tree = await this.ctx.capabilities.ready();
    const folderKind = args.path ? kindOfFolder(folder.path, args.path, folder.objectFolders) : undefined;
    // `objects/` itself is no kind's folder: each kind then goes to its own default folder.
    if (args.path && !folderKind && !args.kind) args = { ...args, path: undefined };
    let kind = args.kind ?? folderKind;
    if (!kind) {
      const picked = await pickOne<vscode.QuickPickItem & { objectKind: ObjectKind }>({
        title: "New detection object",
        step: 1,
        totalSteps: 1,
        placeholder: "What kind of object?",
        items: KINDS.filter((k) => tree?.hasCommand(`new ${k}`) ?? true).map((k) => ({
          label: KIND_LABEL[k],
          detail: KIND_DETAIL[k],
          objectKind: k,
        })),
      });
      if (!picked || picked === BACK || isButton(picked)) return;
      kind = picked.objectKind;
    }
    if (tree && !tree.hasCommand(`new ${kind}`)) {
      void vscode.window.showInformationMessage(`The active opentide has no \`new ${kind}\` command.`);
      return;
    }
    const input = await this.collect(folder, kind, args);
    if (!input) return;
    await this.create(folder, input, args);
  }

  /** The multi-step input for one kind. Undefined when the user dismissed it. */
  private async collect(
    folder: OpentideFolder,
    kind: ObjectKind,
    args: NewObjectArgs,
  ): Promise<NewInput | undefined> {
    const tree = this.ctx.capabilities.current;
    const has = (flag: string) => tree?.hasOption(`new ${kind}`, flag) ?? true;
    const platformChoices =
      kind === "rule"
        ? ([...(this.ctx.capabilities.commands().find((c) => c.path === "new rule")?.options ?? [])].find(
            (o) => o.flags.includes("--platform"),
          )?.choices ?? [])
        : [];
    const info = kind === "rule" && platformChoices.length > 0 ? this.loadPlatforms(folder) : undefined;
    const steps: ("name" | "platforms" | "objective" | "threats" | "folder")[] = ["name"];
    if (kind === "rule" && has("--platform") && platformChoices.length > 0) steps.push("platforms");
    if (kind === "rule" && has("--objective") && !args.objective) steps.push("objective");
    if (kind === "objective" && has("--threat") && !args.threats) steps.push("threats");
    if (has("--path") && !args.path) steps.push("folder");

    const title = `New ${kind}`;
    const defaultDir = folder.objectFolders[kind] ?? `objects/${kind}s/`;
    let name = args.name ?? "";
    let platforms: string[] | undefined;
    let objective = args.objective;
    let threats = args.threats ? [...args.threats] : undefined;
    let target = args.path;
    let index = 0;
    while (index < steps.length) {
      const header = { title, step: index + 1, totalSteps: steps.length };
      const step = steps[index];
      let result: unknown;
      switch (step) {
        case "name":
          result = await askText({
            ...header,
            value: name,
            placeholder:
              kind === "rule"
                ? "Suspicious LSASS Access"
                : kind === "objective"
                  ? "Detect LSASS access"
                  : "Credential Dumping",
            prompt: (value) =>
              value.trim()
                ? `Name · → ${target ? `${path.relative(folder.path, target).split(path.sep).join("/")}/` : defaultDir}${slugOf(value)}.yaml`
                : "Name · the file name is made from it",
            validate: validateName,
          });
          if (typeof result === "string") name = result;
          break;
        case "platforms": {
          const chosen = platforms;
          result = await pickMany<PlatformPick>({
            ...header,
            placeholder: "Platforms: a configuration block for each",
            items: (info ?? Promise.resolve([])).then((available) =>
              platformItems(platformChoices, available).map((item) => ({
                ...item,
                picked: chosen ? chosen.includes(item.id) : item.picked,
              })),
            ),
            matchOnDescription: true,
          });
          if (Array.isArray(result)) platforms = result.map((item: PlatformPick) => item.id);
          break;
        }
        case "objective": {
          const picked = await pickOne<ObjectPick>({
            ...header,
            placeholder: "Objective (fills detection_model): search by name, UUID or technique",
            items: this.objectItems(folder, "objective").then((items) => [
              ...items,
              { label: "", kind: vscode.QuickPickItemKind.Separator },
              { label: "$(add) Create a new objective…", action: "create" as const },
              { label: "$(circle-slash) None for now", action: "none" as const },
            ]),
            matchOnDescription: true,
            matchOnDetail: true,
          });
          result = picked;
          if (picked && picked !== BACK && !isButton(picked)) {
            if (picked.action === "create") {
              const created = await this.createInline(folder, "objective");
              if (!created) continue;
              objective = created;
            } else objective = picked.action === "none" ? undefined : picked.uuid;
          }
          break;
        }
        case "threats": {
          const picked = await pickMany<ObjectPick>({
            ...header,
            placeholder: "Threats this objective addresses (none is fine for now)",
            items: this.objectItems(folder, "threat").then((items) =>
              items.map((item) => ({ ...item, picked: threats?.includes(item.uuid ?? "") ?? false })),
            ),
            matchOnDescription: true,
            matchOnDetail: true,
            buttons: [NEW_THREAT_BUTTON],
          });
          result = picked;
          if (isButton(picked)) {
            const created = await this.createInline(folder, "threat");
            if (created) threats = [...(threats ?? []), created];
            continue;
          }
          if (Array.isArray(picked))
            threats = picked.flatMap((item: ObjectPick) => (item.uuid ? [item.uuid] : []));
          break;
        }
        case "folder": {
          const picked = await pickOne<FolderPick>({
            ...header,
            placeholder: "Folder",
            items: [
              { label: `$(folder) ${defaultDir}`, description: "default from paths.toml" },
              { label: "$(folder-opened) Choose…", choose: true },
            ],
          });
          result = picked;
          if (picked && picked !== BACK && !isButton(picked)) {
            if (picked.choose) {
              const chosen = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                defaultUri: vscode.Uri.file(path.join(folder.path, defaultDir)),
                openLabel: `Create the ${kind} here`,
              });
              if (!chosen?.[0]) continue;
              target = chosen[0].fsPath;
            } else target = undefined;
          }
          break;
        }
      }
      if (result === undefined) return undefined;
      if (result === BACK) index = Math.max(0, index - 1);
      else index++;
    }
    return {
      kind,
      name,
      ...(platforms ? { platforms } : {}),
      ...(objective ? { objective } : {}),
      ...(threats ? { threats } : {}),
      ...(target ? { path: target } : {}),
    };
  }

  private loadPlatforms(folder: OpentideFolder): Promise<readonly PlatformInfo[]> {
    const known = this.platformInfo.get(folder.path);
    const fresh = this.ctx.backend
      .run(folder.path, ["info"])
      .then((result) => {
        const platforms = platformsOf(result.document);
        if (platforms.length > 0) this.platformInfo.set(folder.path, platforms);
        return platforms;
      })
      .catch(() => known ?? []);
    return known ? Promise.resolve(known) : fresh;
  }

  /** Objectives or threats to pick from: the catalogue when it is loaded, else the object files' headers. */
  private async objectItems(folder: OpentideFolder, kind: ObjectKind): Promise<ObjectPick[]> {
    const state = this.ctx.catalog.get(folder.path);
    let choices: ObjectChoice[];
    if (state.catalog) choices = choicesFromCatalog(state.catalog.objects, kind);
    else choices = await this.choicesFromFiles(folder, kind);
    return choices.map((choice): ObjectPick => {
      const item: ChoiceItem = choiceItem(choice);
      return {
        label: item.label,
        description: item.description,
        ...(item.detail ? { detail: item.detail } : {}),
        uuid: item.uuid,
      };
    });
  }

  private async choicesFromFiles(folder: OpentideFolder, kind: ObjectKind): Promise<ObjectChoice[]> {
    const dir = path.join(folder.path, folder.objectFolders[kind] ?? `objects/${kind}s/`);
    const files: string[] = [];
    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 4 || files.length > 5000) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (/\.ya?ml$/i.test(entry.name)) files.push(full);
      }
    };
    await walk(dir, 0);
    const choices: ObjectChoice[] = [];
    for (const file of files) {
      try {
        const header = objectHeader(await fs.promises.readFile(file, "utf8"));
        if (header) choices.push({ ...header, techniques: [], file });
      } catch {
        // unreadable: leave it out
      }
    }
    return choices.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** "Create a new objective/threat…" from inside another flow: returns the new object's UUID. */
  private async createInline(folder: OpentideFolder, kind: ObjectKind): Promise<string | undefined> {
    const input = await this.collect(folder, kind, {});
    if (!input) return undefined;
    const created = await this.create(folder, input, {}, false);
    return created;
  }

  /** Run `opentide new`; open the file (unless inline) on its first placeholder. Returns the UUID. */
  private async create(
    folder: OpentideFolder,
    input: NewInput,
    args: NewObjectArgs,
    open = true,
  ): Promise<string | undefined> {
    const tree = this.ctx.capabilities.current;
    const argv = newArgv(input, (flag) => tree?.hasOption(`new ${input.kind}`, flag) ?? true);
    let result: Awaited<ReturnType<FeatureContext["backend"]["run"]>>;
    try {
      result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Creating ${input.kind} “${input.name}”`,
          cancellable: true,
        },
        (_progress, token) => this.ctx.backend.run(folder.path, argv, { cancellation: token }),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof BackendError ? error.message : String(error));
      return undefined;
    }
    if (result.cancelled) return undefined;
    const created = createdOf(result.document, folder.path);
    if (created) {
      if (open) await this.open(created.file, created.placeholders);
      else vscode.window.setStatusBarMessage(`$(check) ${created.message || `Created ${input.kind}`}`, 5000);
      return created.uuid;
    }
    await this.failed(folder, input, args, result);
    return undefined;
  }

  private async open(file: string, placeholders: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    this.placeholders.remember(document);
    const selected = this.placeholders.selectFirst(editor);
    if (!selected || placeholders === 0) {
      vscode.window.setStatusBarMessage(`$(check) Created ${path.basename(file)}`, 5000);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `${path.basename(file)}: ${placeholdersText(placeholders)}.`,
      "Next placeholder",
    );
    if (choice) await vscode.commands.executeCommand("opentide.placeholder.next");
  }

  private async failed(
    folder: OpentideFolder,
    input: NewInput,
    args: NewObjectArgs,
    result: Awaited<ReturnType<FeatureContext["backend"]["run"]>>,
  ): Promise<void> {
    const failure = result.document.failure;
    const message = failure?.message ?? result.document.message;
    const action = failureAction(failure?.code, message, folder.path);
    const retry = () => this.start({ ...args, kind: input.kind, name: input.name, folder: folder.path });
    switch (action.kind) {
      case "setup": {
        const choice = await vscode.window.showWarningMessage(message, "Set up this folder");
        if (choice) await this.openSetup();
        return;
      }
      case "pick-again": {
        void this.ctx.catalog.refresh(folder.path, { immediate: true });
        const choice = await vscode.window.showWarningMessage(
          `${message}. It may have been deleted or renamed.`,
          "Pick again",
        );
        if (choice) await retry();
        return;
      }
      case "exists": {
        const options = [
          ...(action.file && fs.existsSync(action.file) ? ["Open existing"] : []),
          "Pick another name",
        ];
        const choice = await vscode.window.showWarningMessage(message, ...options);
        if (choice === "Open existing" && action.file)
          await vscode.window.showTextDocument(vscode.Uri.file(action.file));
        else if (choice === "Pick another name") await retry();
        return;
      }
      case "regenerate": {
        const choice = await vscode.window.showErrorMessage(message, "Regenerate templates");
        if (choice) await this.regenerate();
        return;
      }
      default: {
        const choice = await vscode.window.showErrorMessage(
          `opentide new ${input.kind} failed: ${message}`,
          "Copy command",
          "Show output",
        );
        if (choice === "Copy command") await vscode.env.clipboard.writeText(result.argvDisplay);
        else if (choice === "Show output") this.ctx.log.show();
      }
    }
  }

  private async openSetup(): Promise<void> {
    const commands = await vscode.commands.getCommands(true);
    const setup = SETUP_COMMANDS.find((id) => commands.includes(id));
    if (setup) await vscode.commands.executeCommand(setup);
    else
      void vscode.window.showInformationMessage("Run `opentide setup` in a terminal to set up this folder.");
  }

  /** "Regenerate templates, schemas and snippets": `opentide generate templates schemas snippets`. */
  private async regenerate(): Promise<void> {
    if (!this.canRun()) return;
    const folder = await this.ctx.folders.pick("Regenerate templates in which folder?");
    if (!folder) return;
    const argv = ["generate", "templates", "schemas", "snippets"];
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Regenerating templates, schemas and snippets",
          cancellable: true,
        },
        (_progress, token) => this.ctx.backend.run(folder.path, argv, { cancellation: token }),
      );
      if (result.cancelled) return;
      if (result.exitCode === 0)
        vscode.window.setStatusBarMessage(`$(check) ${result.document.message}`, 5000);
      else
        void vscode.window.showErrorMessage(
          `${result.argvDisplay}: ${result.document.failure?.message ?? result.document.message}`,
        );
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof BackendError ? error.message : String(error));
    }
  }

  /** "Create a rule for this objective" in an objective file, on its name or UUID line. */
  provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const folder = this.ctx.folders.folderOf(document.uri);
    if (!folder || !this.ctx.trust.isTrusted) return [];
    if (kindOfFolder(folder.path, path.dirname(document.uri.fsPath), folder.objectFolders) !== "objective")
      return [];
    const head = document.getText(new vscode.Range(0, 0, Math.min(document.lineCount, 40), 0));
    const header = objectHeader(head);
    if (!header) return [];
    const headerEnd = head.split(/\r?\n/).findIndex((line) => /^\s+uuid:/.test(line));
    if (range.start.line > Math.max(headerEnd, 0)) return [];
    const action = new vscode.CodeAction(
      "Create a rule for this objective…",
      vscode.CodeActionKind.Refactor.append("opentide"),
    );
    action.command = {
      title: action.title,
      command: "opentide.newObject.rule",
      arguments: [{ kind: "rule", objective: header.uuid, folder: folder.path } satisfies NewObjectArgs],
    };
    return [action];
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}

export default defineFeature({
  id: "new-object",
  activate(ctx) {
    ctx.subscriptions.push(new NewObject(ctx));
  },
});
