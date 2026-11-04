// The generic runner's form: a command's arguments and options as fields, and the argv they make. vscode-free.
import type { CommandArgument, CommandInfo, CommandOption } from "../../core/capabilities/tree";

export type FieldKind = "flag" | "toggle" | "choice" | "text" | "integer" | "number" | "path";

/** Where a value comes from besides typing it. */
export type Picker = "file" | "folder" | "uuid";

export interface Field {
  /** `arg:<name>` or `opt:<primary flag>`. */
  readonly id: string;
  readonly positional: boolean;
  /** The primary flag (`--file`); undefined for a positional argument. */
  readonly flag?: string;
  /** The flag that turns a toggle off (`--no-staging`). */
  readonly negative?: string;
  readonly name: string;
  /** What the UI shows: `--file` or `<code>`. */
  readonly label: string;
  readonly help: string;
  readonly kind: FieldKind;
  readonly choices: readonly string[];
  readonly required: boolean;
  readonly multiple: boolean;
  readonly picker?: Picker;
  /** For a UUID picker: the object type the option names (`objective`), or undefined for any. */
  readonly objectType?: string;
}

/** A field's value: the strings it passes, or a toggle's on/off. */
export type FieldValue = readonly string[] | boolean;

export type FormValues = ReadonlyMap<string, FieldValue>;

/** Options the runner never offers: the backend adds `--json`, and `--repo` is the folder the user picked. */
const HIDDEN_FLAGS = new Set(["--json", "--repo", "--help", "--version", "-V"]);

const FILE_FLAGS = new Set(["--file", "--query-file"]);
const FOLDER_FLAGS = new Set(["--path", "-C", "--output"]);
const UUID_FLAGS: Readonly<Record<string, string | undefined>> = {
  "--uuid": undefined,
  "--objective": "objective",
  "--threat": "threat",
  "--rule": "rule",
};

function kindOf(type: string, choices: readonly string[] | null | undefined, isFlag: boolean): FieldKind {
  if (isFlag) return "flag";
  if (choices && choices.length > 0) return "choice";
  if (type === "integer") return "integer";
  if (type === "number" || type === "float") return "number";
  if (type === "path") return "path";
  return "text";
}

function argumentField(argument: CommandArgument): Field {
  return {
    id: `arg:${argument.name}`,
    positional: true,
    name: argument.name,
    label: `<${argument.name}>`,
    help: argument.help ?? "",
    kind: kindOf(argument.type, argument.choices, false),
    choices: argument.choices ?? [],
    required: argument.required === true,
    multiple: argument.multiple === true,
  };
}

function optionField(option: CommandOption): Field | undefined {
  const flag = option.flags.find((f) => f.startsWith("--")) ?? option.flags[0];
  if (!flag || option.flags.some((f) => HIDDEN_FLAGS.has(f))) return undefined;
  const negative = option.is_flag ? option.secondary_flags?.[0] : undefined;
  let kind = kindOf(option.type, option.choices, option.is_flag === true);
  if (kind === "flag" && negative) kind = "toggle";
  let picker: Picker | undefined;
  let objectType: string | undefined;
  if (kind === "text" || kind === "path") {
    const flags = option.flags;
    // A `path`-typed option is a file (`validate --output report.sarif`); a string `--output` a folder.
    if (kind === "path" || flags.some((f) => FILE_FLAGS.has(f))) picker = "file";
    else if (flags.some((f) => FOLDER_FLAGS.has(f))) picker = "folder";
    else if (flags.some((f) => Object.hasOwn(UUID_FLAGS, f))) {
      picker = "uuid";
      objectType = flags.map((f) => UUID_FLAGS[f]).find((t) => t !== undefined);
    }
  }
  return {
    id: `opt:${flag}`,
    positional: false,
    flag,
    ...(negative ? { negative } : {}),
    name: option.name,
    label: negative ? `${flag} / ${negative}` : flag,
    help: option.help ?? "",
    kind,
    choices: option.choices ?? [],
    required: option.required === true,
    multiple: option.multiple === true,
    ...(picker ? { picker } : {}),
    ...(objectType ? { objectType } : {}),
  };
}

/** Every field of a command: positional arguments first, in order, then its options. */
export function fieldsOf(command: CommandInfo): Field[] {
  const fields: Field[] = command.arguments.map(argumentField);
  for (const option of command.options) {
    const field = optionField(option);
    if (field) fields.push(field);
  }
  return fields;
}

/** The fields a run cannot do without. */
export function requiredFields(fields: readonly Field[]): Field[] {
  return fields.filter((field) => field.required);
}

/** The fields "Add options…" offers. */
export function optionalFields(fields: readonly Field[]): Field[] {
  return fields.filter((field) => !field.required);
}

/** Why `text` is not a valid value for `field`, or undefined when it is. */
export function validateValue(field: Field, text: string): string | undefined {
  const value = text.trim();
  if (value === "") return field.required ? `${field.label} is required` : undefined;
  if (field.kind === "integer" && !/^-?\d+$/.test(value)) return `${field.label} takes a whole number`;
  if (field.kind === "number" && !/^-?(\d+\.?\d*|\.\d+)$/.test(value)) return `${field.label} takes a number`;
  if (field.kind === "choice" && !field.choices.includes(value))
    return `${field.label} takes one of: ${field.choices.join(", ")}`;
  return undefined;
}

/** Values typed into one box: comma-separated for a field that takes several. */
export function splitValues(field: Field, text: string): string[] {
  const parts = field.multiple ? text.split(",") : [text];
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** `opentide <argv>` for a command and its form values (no `--json`: the backend adds it). */
export function buildArgv(command: CommandInfo, fields: readonly Field[], values: FormValues): string[] {
  const argv = command.path.split(" ");
  for (const field of fields.filter((f) => f.positional)) {
    const value = values.get(field.id);
    if (Array.isArray(value)) argv.push(...value);
  }
  for (const field of fields.filter((f) => !f.positional)) {
    const value = values.get(field.id);
    if (value === undefined || !field.flag) continue;
    if (typeof value === "boolean") {
      if (value) argv.push(field.flag);
      else if (field.negative) argv.push(field.negative);
      continue;
    }
    for (const item of value as readonly string[]) argv.push(field.flag, item);
  }
  return argv;
}

/** A required field without a value, if any. */
export function missingRequired(fields: readonly Field[], values: FormValues): Field | undefined {
  return fields.find((field) => {
    if (!field.required) return false;
    const value = values.get(field.id);
    return value === undefined || (Array.isArray(value) && value.length === 0);
  });
}

/** A short description of a field's current value, for the "Add options…" list. */
export function describeValue(value: FieldValue | undefined, field: Field): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value ? (field.flag ?? "on") : (field.negative ?? "off");
  return value.join(", ");
}
