// "opentide: Run Command…" (SPEC §11): pick a command from the active opentide's tree, fill its form, review,
// and run it in the background or a terminal. Glue over form.ts, commands.ts and run.ts.
import * as path from "node:path";
import * as vscode from "vscode";
import { loadedObjects } from "../../core/catalog/rows";
import type { FeatureContext } from "../../core/context";
import { displayArgv } from "../../core/runtime/env";
import {
  type CommandEntry,
  classIcon,
  classLabel,
  modesOf,
  type RunMode,
  runnableCommands,
} from "./commands";
import {
  buildArgv,
  describeValue,
  type Field,
  type FieldValue,
  fieldsOf,
  optionalFields,
  requiredFields,
  splitValues,
  validateValue,
} from "./form";
import { commandLabel } from "./result";
import type { Runner } from "./run";
import { reachesTenants } from "./safety";
import { describeReach, type PlatformReach } from "./tenants";

/** `opentide.runner.run`'s argument, for keybindings: `{ "argv": ["validate", "--strict"], "mode": "terminal" }`. */
export interface RunArgs {
  readonly argv?: readonly string[];
  readonly folder?: string;
  readonly mode?: RunMode;
}

const isRunArgs = (value: unknown): value is RunArgs =>
  typeof value === "object" &&
  value !== null &&
  (!("argv" in value) ||
    (Array.isArray((value as RunArgs).argv) &&
      (value as { argv: unknown[] }).argv.every((a) => typeof a === "string")));

const BACK = Symbol("back");

export async function runCommand(ctx: FeatureContext, runner: Runner, rawArgs?: unknown): Promise<void> {
  const args = isRunArgs(rawArgs) ? rawArgs : {};
  if (!(await runner.ensureAvailable())) return;
  const tree = await ctx.capabilities.ready();
  if (!tree) {
    const picked = await vscode.window.showErrorMessage(
      "Could not read the active opentide's commands (`opentide --json commands`).",
      "Show Output",
    );
    if (picked) ctx.log.show();
    return;
  }
  const folder = args.folder ?? (await runner.folder("Run the command in which folder?"));
  if (!folder) return;

  if (args.argv && args.argv.length > 0) {
    const { path: commandPath } = tree.commandPathOf(args.argv);
    await execute(runner, folder, args.argv, args.mode ?? modesOf(commandPath, args.argv)[0] ?? "background");
    return;
  }

  const entry = await pickCommand(runnableCommands(tree, (argv) => ctx.capabilities.classify(argv)));
  if (!entry) return;
  const fields = fieldsOf(entry.command);
  const values = new Map<string, FieldValue>();
  for (const field of requiredFields(fields)) {
    const value = await promptField(ctx, folder, field, undefined);
    if (value === undefined || value === BACK) return;
    values.set(field.id, value);
  }
  await review(ctx, runner, folder, entry, fields, values);
}

async function pickCommand(entries: readonly CommandEntry[]): Promise<CommandEntry | undefined> {
  if (entries.length === 0) {
    void vscode.window.showWarningMessage("The active opentide lists no commands.");
    return undefined;
  }
  const items = entries.map((entry) => ({
    label: `${classIcon(entry.classification)} ${entry.command.path}`,
    description: entry.command.summary,
    detail: classLabel(entry),
    entry,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "opentide: Run Command",
    placeHolder: "Pick a command",
    matchOnDescription: true,
  });
  return picked?.entry;
}

type ReviewItem = vscode.QuickPickItem & { action?: () => Promise<"done" | "again"> };

async function review(
  ctx: FeatureContext,
  runner: Runner,
  folder: string,
  entry: CommandEntry,
  fields: readonly Field[],
  values: Map<string, FieldValue>,
): Promise<void> {
  const command = entry.command;
  const optional = optionalFields(fields);
  let reach: PlatformReach[] | undefined;
  for (;;) {
    const argv = buildArgv(command, fields, values);
    const modes = modesOf(command.path, argv);
    // From this argv, not the bare command: an option such as `--live` is what makes it reach tenants.
    const reaches = reachesTenants(ctx.capabilities.classify(argv));
    if (!reaches) reach = undefined;
    else if (reach === undefined) reach = await runner.reach(folder, argv);
    const missing = reach ? await runner.missingCredentials(folder, reach) : [];
    const items: ReviewItem[] = [];
    if (reach) {
      items.push({
        label: `Contacts ${describeReach(reach, undefined)}`,
        kind: vscode.QuickPickItemKind.Separator,
      });
    }
    if (modes.includes("background"))
      items.push({
        label: "$(play) Run",
        description: "in the background; the result opens as JSON",
        action: async () => {
          await execute(runner, folder, argv, "background");
          return "done";
        },
      });
    items.push({
      label: "$(terminal) Run in Terminal",
      description: "human output, colours and prompts",
      action: async () => {
        await execute(runner, folder, argv, "terminal");
        return "done";
      },
    });
    if (optional.length > 0)
      items.push({
        label: "$(add) Add Options…",
        description: `${optional.filter((f) => values.has(f.id)).length} of ${optional.length} set`,
        action: async () => {
          await addOptions(ctx, folder, optional, values);
          reach = undefined;
          return "again";
        },
      });
    for (const name of missing) {
      items.push({
        label: `$(key) Set ${name}…`,
        description: "a tenant needs it; nothing sets it",
        action: async () => {
          await runner.setCredential(folder, name);
          return "again";
        },
      });
    }
    items.push({
      label: "$(copy) Copy Command Line",
      action: async () => {
        await vscode.env.clipboard.writeText(commandLabel(displayArgv(argv)));
        void vscode.window.showInformationMessage("Copied the command line.");
        return "done";
      },
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: commandLabel(displayArgv(argv)),
      placeHolder: command.summary,
    });
    if (!picked?.action) return;
    if ((await picked.action()) === "done") return;
  }
}

/** Apply the D6 policy, then run. */
async function execute(
  runner: Runner,
  folder: string,
  argv: readonly string[],
  mode: RunMode,
): Promise<void> {
  const confirmed = await runner.confirm(folder, argv);
  if (!confirmed) return;
  if (mode === "terminal") await runner.terminal(folder, confirmed);
  else await runner.background(folder, confirmed, { open: true });
}

async function addOptions(
  ctx: FeatureContext,
  folder: string,
  optional: readonly Field[],
  values: Map<string, FieldValue>,
): Promise<void> {
  for (;;) {
    const items = [
      { label: "$(check) Done", field: undefined as Field | undefined },
      ...optional.map((field) => ({
        label: values.has(field.id) ? `$(pass-filled) ${field.label}` : field.label,
        description: describeValue(values.get(field.id), field) ?? field.kind,
        detail: field.help || undefined,
        field,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Add options",
      placeHolder: "Pick an option to set or change; a set flag clears when picked again",
      matchOnDetail: true,
    });
    if (!picked?.field) return;
    const field = picked.field;
    if (field.kind === "flag") {
      if (values.has(field.id)) values.delete(field.id);
      else values.set(field.id, true);
      continue;
    }
    const value = await promptField(ctx, folder, field, values.get(field.id));
    if (value === BACK || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) values.delete(field.id);
    else values.set(field.id, value);
  }
}

/** A field's value from the user; `undefined` when they cancelled. An empty list clears an optional field. */
async function promptField(
  ctx: FeatureContext,
  folder: string,
  field: Field,
  current: FieldValue | undefined,
): Promise<FieldValue | typeof BACK | undefined> {
  const title = `${field.label}${field.required ? "" : " (optional)"}`;
  if (field.kind === "toggle") {
    const picked = await vscode.window.showQuickPick(
      [
        { label: field.flag ?? "on", value: true as boolean | undefined },
        { label: field.negative ?? "off", value: false as boolean | undefined },
        { label: "Neither (the command's default)", value: undefined as boolean | undefined },
      ],
      { title, placeHolder: field.help || undefined },
    );
    if (!picked) return BACK;
    return picked.value ?? [];
  }
  if (field.kind === "flag") return true;
  if (field.kind === "choice") {
    const chosen = Array.isArray(current) ? (current as readonly string[]) : [];
    const items = field.choices.map((choice) => ({ label: choice, picked: chosen.includes(choice) }));
    if (field.multiple) {
      const picked = await vscode.window.showQuickPick(items, {
        title,
        placeHolder: field.help,
        canPickMany: true,
      });
      return picked ? picked.map((item) => item.label) : BACK;
    }
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder: field.help || undefined });
    return picked ? [picked.label] : BACK;
  }
  if (field.picker === "uuid") {
    const fromCatalog = await pickUuid(ctx, folder, field, title);
    if (fromCatalog !== "type") return fromCatalog;
  }
  return inputField(folder, field, current, title);
}

/** UUIDs from the catalogue; "type" when the user wants to type one, or there is no catalogue. */
async function pickUuid(
  ctx: FeatureContext,
  folder: string,
  field: Field,
  title: string,
): Promise<FieldValue | typeof BACK | "type"> {
  const catalog = ctx.catalog.get(folder).catalog;
  const objects = loadedObjects(catalog?.objects ?? []).filter(
    (o) => !field.objectType || o.type === field.objectType,
  );
  if (objects.length === 0) return "type";
  const typeOne = { label: "$(edit) Enter a value…", uuid: "" };
  const items = objects.map((o) => ({
    label: o.name,
    description: o.type,
    detail: `${o.uuid} · ${o.path}`,
    uuid: o.uuid,
  }));
  if (field.multiple) {
    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: "Pick objects (Enter with none picked to type values)",
      canPickMany: true,
      matchOnDetail: true,
    });
    if (!picked) return BACK;
    return picked.length > 0 ? picked.map((item) => item.uuid) : "type";
  }
  const picked = await vscode.window.showQuickPick([typeOne, ...items], {
    title,
    placeHolder: field.help || "Pick an object",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return BACK;
  return picked === typeOne ? "type" : [picked.uuid];
}

/** An input box, with a Browse… button for paths. */
function inputField(
  folder: string,
  field: Field,
  current: FieldValue | undefined,
  title: string,
): Promise<FieldValue | typeof BACK> {
  return new Promise((resolve) => {
    const box = vscode.window.createInputBox();
    box.title = title;
    box.prompt = [field.help, field.multiple ? "Separate several values with commas." : ""]
      .filter(Boolean)
      .join(" ");
    box.value = Array.isArray(current) ? (current as readonly string[]).join(", ") : "";
    box.ignoreFocusOut = true;
    const browse = { iconPath: new vscode.ThemeIcon("folder-opened"), tooltip: "Browse…" };
    if (field.picker === "file" || field.picker === "folder") box.buttons = [browse];
    let settled = false;
    let browsing = false;
    const finish = (value: FieldValue | typeof BACK) => {
      if (settled) return;
      settled = true;
      resolve(value);
      box.dispose();
    };
    box.onDidChangeValue((text) => {
      const problem = splitValues(field, text)
        .map((value) => validateValue(field, value))
        .find(Boolean);
      box.validationMessage =
        problem ?? (field.required && !text.trim() ? `${field.label} is required` : undefined);
    });
    box.onDidAccept(() => {
      const parts = splitValues(field, box.value);
      if (field.required && parts.length === 0) return;
      if (parts.some((value) => validateValue(field, value))) return;
      finish(parts);
    });
    box.onDidTriggerButton(async () => {
      browsing = true;
      const picked = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.file(folder),
        canSelectFiles: field.picker === "file",
        canSelectFolders: field.picker === "folder",
        canSelectMany: field.multiple,
        openLabel: `Use for ${field.label}`,
      });
      if (picked && picked.length > 0) {
        const shown = picked.map((uri) => relativeTo(folder, uri.fsPath));
        box.value =
          field.multiple && box.value.trim() ? `${box.value}, ${shown.join(", ")}` : shown.join(", ");
      }
      browsing = false;
      box.show();
    });
    // The open dialog can hide the box; it comes back after.
    box.onDidHide(() => {
      if (!browsing) finish(BACK);
    });
    box.show();
  });
}

/** Workspace-relative with forward slashes when inside the folder, else as given. */
function relativeTo(folder: string, file: string): string {
  const relative = path.relative(folder, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : file;
}
