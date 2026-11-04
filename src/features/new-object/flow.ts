// The "New object" flow's logic (SPEC §7): what it asks, the `opentide new` argv it builds, the picker
// items it shows and what each failure offers. vscode-free.
import * as path from "node:path";
import type { CatalogObject } from "../../core/catalog/types";
import { folderSpelling } from "../../core/util/paths";

export type ObjectKind = "threat" | "objective" | "rule";

export const KINDS: readonly ObjectKind[] = ["threat", "objective", "rule"];

export const KIND_LABEL: Record<ObjectKind, string> = {
  threat: "Threat",
  objective: "Objective",
  rule: "Rule",
};

export const KIND_DETAIL: Record<ObjectKind, string> = {
  threat: "A threat vector: what an attacker does",
  objective: "A detection objective: what to detect, and with which signals",
  rule: "A detection rule: a query per platform, implementing an objective",
};

export function isKind(value: unknown): value is ObjectKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** What `opentide new <kind>` gets. */
export interface NewInput {
  readonly kind: ObjectKind;
  readonly name: string;
  readonly platforms?: readonly string[];
  readonly objective?: string;
  readonly threats?: readonly string[];
  /** A folder (or file) to write in; omitted for the kind's default folder. */
  readonly path?: string;
}

/** `["new", "rule", "--name", …]`: the options the active opentide has, nothing else. */
export function newArgv(input: NewInput, hasOption: (flag: string) => boolean = () => true): string[] {
  const argv = ["new", input.kind, "--name", input.name];
  if (input.kind === "rule" && hasOption("--platform"))
    for (const platform of input.platforms ?? []) argv.push("--platform", platform);
  if (input.kind === "rule" && input.objective && hasOption("--objective"))
    argv.push("--objective", input.objective);
  if (input.kind === "objective" && hasOption("--threat"))
    for (const threat of input.threats ?? []) argv.push("--threat", threat);
  if (input.path && hasOption("--path")) argv.push("--path", input.path);
  return argv;
}

/** About the file name `opentide new` gives (its slug); the CLI has the last word. */
export function slugOf(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "object"
  );
}

export function validateName(name: string): string | undefined {
  if (!name.trim()) return "Give it a name: the file name is made from it.";
  if (name.length > 200) return "Keep the name under 200 characters.";
  return undefined;
}

/** The kind whose object folder `folder` (absolute) is, from paths.toml's object folders. */
export function kindOfFolder(
  root: string,
  folder: string,
  objectFolders: Readonly<Record<string, string>>,
): ObjectKind | undefined {
  const relative = `${path.relative(root, folder).split(path.sep).join("/")}/`;
  for (const kind of KINDS) {
    const dir = objectFolders[kind];
    if (dir && (relative === dir || relative.startsWith(dir))) return kind;
  }
  return undefined;
}

/** The absolute object folders of a workspace folder (for the Explorer menu's `when` clause). */
export function objectFolderPaths(root: string, objectFolders: Readonly<Record<string, string>>): string[] {
  const dirs = new Set(["objects/", ...Object.values(objectFolders)]);
  return [...dirs].map((dir) => path.join(root, dir.replace(/\/$/, "")));
}

// ---- platforms ----

export interface PlatformInfo {
  readonly name: string;
  readonly enabled: boolean;
  readonly can_deploy?: boolean;
  readonly can_validate?: boolean;
  readonly can_query?: boolean;
}

/** `platforms[]` of `opentide --json info`. */
export function platformsOf(document: unknown): PlatformInfo[] {
  const platforms = (document as { platforms?: unknown } | undefined)?.platforms;
  if (!Array.isArray(platforms)) return [];
  return platforms.filter(
    (p): p is PlatformInfo =>
      !!p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string",
  );
}

export interface PlatformItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly picked: boolean;
}

const PLATFORM_NAMES: Record<string, string> = {
  sentinel: "Microsoft Sentinel",
  defender_for_endpoint: "Microsoft Defender for Endpoint",
  splunk: "Splunk",
  elastic: "Elastic",
  crowdstrike: "CrowdStrike",
  sentinel_one: "SentinelOne",
  carbon_black_cloud: "Carbon Black Cloud",
  harfanglab: "HarfangLab",
  sysdig: "Sysdig Secure",
};

export function platformLabel(id: string): string {
  return PLATFORM_NAMES[id] ?? id;
}

/**
 * The platform picker: the `--platform` choices, enabled ones first and picked, each with what
 * opentide can do there; the others say validate will warn (SPEC §7 "The flow", step 2).
 */
export function platformItems(choices: readonly string[], info: readonly PlatformInfo[]): PlatformItem[] {
  const byName = new Map(info.map((p) => [p.name, p]));
  const items = choices.map((id): PlatformItem & { order: number } => {
    const platform = byName.get(id);
    if (!platform) return { id, label: platformLabel(id), description: "", picked: false, order: 1 };
    if (!platform.enabled)
      return {
        id,
        label: platformLabel(id),
        description: "not enabled here: validate will warn",
        picked: false,
        order: 2,
      };
    const can = [
      platform.can_deploy ? "deploy" : "",
      platform.can_validate ? "validate" : "",
      platform.can_query ? "query" : "",
    ].filter(Boolean);
    return {
      id,
      label: platformLabel(id),
      description: ["enabled", ...can].join(" · "),
      picked: true,
      order: 0,
    };
  });
  return items.sort((a, b) => a.order - b.order).map(({ order: _order, ...item }) => item);
}

// ---- objectives and threats ----

export interface ObjectChoice {
  readonly uuid: string;
  readonly name: string;
  readonly techniques: readonly string[];
  readonly file?: string;
}

/** The objects of a kind from the catalogue, by name. */
export function choicesFromCatalog(objects: readonly CatalogObject[], kind: ObjectKind): ObjectChoice[] {
  return objects
    .filter((object) => object.type === kind && object.uuid && !object.load_error)
    .map((object) => ({
      uuid: object.uuid,
      name: object.name,
      techniques: [...object.techniques.own, ...object.techniques.inherited],
      file: object.file_path,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `name` and `metadata.uuid` from an object file's text, for the picker when the active opentide has no
 * `info catalog`. Top-level `name:` and the `uuid:` directly under `metadata:`; nothing else is read.
 */
export function objectHeader(text: string): { name: string; uuid: string } | undefined {
  let name: string | undefined;
  let uuid: string | undefined;
  let inMetadata = false;
  for (const line of text.split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*):\s*(.*?)\s*(#.*)?$/.exec(line);
    if (top) {
      inMetadata = top[1] === "metadata";
      if (top[1] === "name" && top[2]) name = unquote(top[2]);
      continue;
    }
    const child = /^\s+uuid:\s*([0-9A-Fa-f-]{8,})\s*(#.*)?$/.exec(line);
    if (inMetadata && child?.[1]) uuid = child[1];
    if (name && uuid) break;
  }
  return name && uuid ? { name, uuid } : undefined;
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(value);
  return quoted ? (quoted[1] ?? quoted[2] ?? "") : value;
}

export interface ChoiceItem {
  readonly label: string;
  readonly description: string;
  readonly detail?: string;
  readonly uuid: string;
}

/** A picker row: searchable by name (label), UUID prefix (description) and technique (detail). */
export function choiceItem(choice: ObjectChoice): ChoiceItem {
  return {
    label: choice.name,
    description: choice.uuid.slice(0, 8),
    ...(choice.techniques.length > 0 ? { detail: choice.techniques.join(" · ") } : {}),
    uuid: choice.uuid,
  };
}

// ---- results ----

export interface Created {
  readonly file: string;
  readonly placeholders: number;
  readonly uuid: string | undefined;
  readonly message: string;
}

/** What a successful `new` printed: the file it wrote (absolute) and its placeholders. */
export function createdOf(
  document: unknown,
  root: string,
  spell: (file: string) => string = folderSpelling(root),
): Created | undefined {
  const value = (document ?? {}) as {
    ok?: unknown;
    file_path?: unknown;
    path?: unknown;
    placeholders?: unknown;
    summary?: { placeholders?: unknown };
    uuid?: unknown;
    message?: unknown;
  };
  if (value.ok !== true) return undefined;
  // opentide reports the real path: open the file under the folder's own spelling of it.
  const file =
    typeof value.file_path === "string"
      ? spell(path.resolve(root, value.file_path))
      : typeof value.path === "string"
        ? spell(path.resolve(root, value.path))
        : undefined;
  if (!file) return undefined;
  const placeholders = Array.isArray(value.placeholders)
    ? value.placeholders.length
    : typeof value.summary?.placeholders === "number"
      ? value.summary.placeholders
      : 0;
  return {
    file,
    placeholders,
    uuid: typeof value.uuid === "string" ? value.uuid : undefined,
    message: typeof value.message === "string" ? value.message : "",
  };
}

export type FailureAction =
  | { readonly kind: "setup" }
  | { readonly kind: "pick-again" }
  | { readonly kind: "exists"; readonly file: string | undefined }
  | { readonly kind: "regenerate" }
  | { readonly kind: "message" };

/** What a failed `new` offers, by `failure.code` (SPEC §7 "The flow", step 4). */
export function failureAction(code: string | undefined, message: string, root: string): FailureAction {
  switch (code) {
    case "workspace_not_found":
      return { kind: "setup" };
    case "reference_not_found":
      return { kind: "pick-again" };
    case "path_exists": {
      // `objects/rules/x.yaml already exists; new never overwrites a file`
      const named = /^(.+?\.ya?ml) already exists/.exec(message)?.[1];
      return { kind: "exists", file: named ? path.resolve(root, named) : undefined };
    }
    case "path_not_writable":
    case "template_missing":
      return { kind: "regenerate" };
    default:
      return { kind: "message" };
  }
}

/** `1 placeholder to replace`, `4 placeholders to replace`. */
export function placeholdersText(count: number): string {
  return `${count} ${count === 1 ? "placeholder" : "placeholders"} to replace`;
}

/** `3 placeholders left`. */
export function placeholdersLeft(count: number): string {
  return `${count} ${count === 1 ? "placeholder" : "placeholders"} left`;
}

/**
 * What "New rule for this objective" and "New objective for this threat" are handed: the parent's UUID,
 * and the workspace folder it is in (`{uuid, folder}` from the graph and the sidebar; a bare UUID or
 * `{object: {uuid}}` still works). The folder keeps the new object next to its parent in a multi-root
 * window, where the active editor's folder may be another.
 */
export function parentOf(value: unknown): { readonly uuid?: string; readonly folder?: string } {
  if (typeof value === "string") return value ? { uuid: value } : {};
  if (!value || typeof value !== "object") return {};
  const { uuid, folder, object } = value as { uuid?: unknown; folder?: unknown; object?: { uuid?: unknown } };
  const id = typeof uuid === "string" ? uuid : typeof object?.uuid === "string" ? object.uuid : undefined;
  return {
    ...(id ? { uuid: id } : {}),
    ...(typeof folder === "string" && folder ? { folder } : {}),
  };
}
