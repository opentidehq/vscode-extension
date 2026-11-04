// The Relations view (SPEC §9): one object, what it points to (→) and what points to it (←), from the
// catalogue's RelationIndex or, without `info catalog`, from the language server's index. Also the
// tooltips and the CodeLens text every sidebar surface shares. vscode-free.
import * as path from "node:path";
import { countOf, kindName, objectIcon } from "../../core/catalog/objectIcons";
import {
  type Direction,
  groupByKind,
  MISSING_ICON,
  RELATION_WORDS,
  type Relation,
  RelationIndex,
  type RelationKind,
  relationIndexOf,
  relationLabel,
  relationWords,
} from "../../core/catalog/relations";
import { isLoaded } from "../../core/catalog/rows";
import { type ServerObject, serverRelations } from "../../core/catalog/serverCatalog";
import { fileUriPath } from "../../core/catalog/symbols";
import type { CatalogDocument, CatalogPlatform } from "../../core/catalog/types";
import { messageNode, type TreeNode, type ViewModel } from "./node";
import { platformName } from "./platformNames";

/** An object as the Relations view shows it, from either source. */
export interface RelObject {
  readonly uuid: string;
  readonly type: string;
  readonly name: string;
  /** Workspace-relative, forward slashes. */
  readonly path: string;
  /** Absolute. */
  readonly file: string;
  /** 0-based line of its `name:`. */
  readonly line: number;
  readonly platforms: readonly CatalogPlatform[];
}

export interface RelSignal {
  readonly uuid: string;
  readonly name: string;
  readonly objective: string | null;
  /** 0-based line of its `uuid:` in the objective's file, when the source knows it. */
  readonly line?: number;
}

/** Where the relations come from: `info catalog`, or the language server's `opentide/catalog`. */
export type RelationSource = "catalog" | "server";

const fold = (platform: NodeJS.Platform) => {
  const lib = platform === "win32" ? path.win32 : path.posix;
  return (file: string): string => {
    const resolved = lib.resolve(file);
    return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
  };
};

/** One folder's objects, signals and relations, built once per catalogue version. */
export class RelationGraph {
  private readonly objects = new Map<string, RelObject>();
  private readonly signals = new Map<string, RelSignal>();
  private readonly files = new Map<string, RelObject>();
  private readonly key: (file: string) => string;

  constructor(
    readonly source: RelationSource,
    readonly folder: string,
    readonly index: RelationIndex,
    objects: readonly RelObject[],
    signals: readonly RelSignal[],
    private readonly techniques: Readonly<Record<string, { readonly name: string }>> = {},
    platform: NodeJS.Platform = process.platform,
  ) {
    this.key = fold(platform);
    for (const object of objects) {
      this.objects.set(object.uuid.toLowerCase(), object);
      this.files.set(this.key(object.file), object);
    }
    for (const signal of signals) this.signals.set(signal.uuid.toLowerCase(), signal);
  }

  object(uuid: string): RelObject | undefined {
    return this.objects.get(uuid.toLowerCase());
  }

  signal(uuid: string): RelSignal | undefined {
    return this.signals.get(uuid.toLowerCase());
  }

  /** The object whose file is `file` (absolute): what the active editor shows. */
  objectAt(file: string): RelObject | undefined {
    return this.files.get(this.key(file));
  }

  techniqueName(id: string): string | undefined {
    return this.techniques[id]?.name;
  }

  /** The name of an object or signal, for a label; undefined when neither is known. */
  nameOf(uuid: string): string | undefined {
    return this.object(uuid)?.name ?? this.signal(uuid)?.name;
  }
}

const fromCatalog = new WeakMap<CatalogDocument, RelationGraph>();
const fromServer = new WeakMap<readonly ServerObject[], RelationGraph>();

/** The graph of a folder's `info catalog` document (memoised on the document). */
export function graphFromCatalog(
  doc: CatalogDocument,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): RelationGraph {
  const known = fromCatalog.get(doc);
  if (known && known.folder === folder) return known;
  const objects = doc.objects.filter(isLoaded).map(
    (o): RelObject => ({
      uuid: o.uuid,
      type: o.type,
      name: o.name,
      path: o.path,
      file: o.file_path,
      line: Math.max(0, o.line - 1),
      platforms: o.platforms,
    }),
  );
  const graph = new RelationGraph(
    "catalog",
    folder,
    relationIndexOf(doc),
    objects,
    doc.signals,
    doc.attack?.techniques ?? {},
    platform,
  );
  fromCatalog.set(doc, graph);
  return graph;
}

/**
 * The graph of one root of the language server's index (memoised on its object list). Incoming
 * references come from inverting every object's refs, which RelationIndex does.
 */
export function graphFromServer(
  objects: readonly ServerObject[],
  folder: string,
  platform: NodeJS.Platform = process.platform,
): RelationGraph {
  const known = fromServer.get(objects);
  if (known && known.folder === folder) return known;
  const lib = platform === "win32" ? path.win32 : path.posix;
  const relations = serverRelations(objects);
  const rows: RelObject[] = [];
  for (const object of objects) {
    const file = fileUriPath(object.uri, platform);
    if (!file) continue;
    rows.push({
      uuid: object.uuid,
      type: object.object_type,
      name: object.name,
      path: lib.relative(folder, file).replaceAll("\\", "/"),
      file,
      line: object.range.start.line,
      platforms: [],
    });
  }
  const graph = new RelationGraph(
    "server",
    folder,
    new RelationIndex(relations),
    rows,
    relations.signals,
    {},
    platform,
  );
  fromServer.set(objects, graph);
  return graph;
}

// ── tooltips and lens text ───────────────────────────────────────────────────────────────────────────

/** Markdown with every character that could start markup escaped, `$(` included (theme icons are on). */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~$&]/g, (c) => `\\${c}`);
}

export interface RelationGroup {
  readonly kind: RelationKind;
  /** A chain's relation (`sequence::preceeds`): chains are grouped by it, each with its own words. */
  readonly relation: string | null;
  readonly relations: Relation[];
}

/** `relations` by kind in RELATION_ORDER, and chains by their relation, so each group has one label. */
export function relationGroups(relations: readonly Relation[]): RelationGroup[] {
  return groupByKind(relations).flatMap(({ kind, relations: list }): RelationGroup[] => {
    if (kind !== "chains") return [{ kind, relation: null, relations: list }];
    const byRelation = new Map<string, Relation[]>();
    for (const r of list) {
      const words = relationWords("chains", "out", r.relation);
      byRelation.set(words, [...(byRelation.get(words) ?? []), r]);
    }
    return [...byRelation.values()].map((group) => ({
      kind,
      relation: group[0]?.relation ?? null,
      relations: group,
    }));
  });
}

/** `Implements 1 → · Technique 2 →`, or "" when there is none that way. */
export function countsLine(index: RelationIndex, uuid: string, direction: Direction): string {
  const { outgoing, incoming } = index.of(uuid);
  return relationGroups(direction === "out" ? outgoing : incoming)
    .map((g) => relationLabel(g.kind, direction, g.relations.length, g.relation))
    .join(" · ");
}

function isInert(p: CatalogPlatform): boolean {
  return p.strategy?.toUpperCase() === "INERT" || p.status?.toUpperCase() === "INERT";
}

export interface TooltipSubject {
  readonly uuid: string;
  readonly type: string;
  readonly name: string;
  readonly path: string;
  readonly platforms: readonly CatalogPlatform[];
}

/**
 * An object's tooltip, as Markdown with theme icons: name, type and path, its platforms with their
 * status, and its relation counts both ways. `extra` lines (techniques, problems) go before the counts.
 */
export function objectTooltip(
  subject: TooltipSubject,
  index: RelationIndex | undefined,
  extra: readonly string[] = [],
): string {
  const icon = objectIcon(subject.type).codicon;
  const lines = [
    `$(${icon}) **${escapeMarkdown(subject.name || subject.path)}**`,
    `${kindName(subject.type)} · \`${subject.path.replaceAll("`", "'")}\``,
  ];
  if (subject.platforms.length)
    lines.push(
      subject.platforms
        .map((p) => {
          const status = p.status ? ` ${escapeMarkdown(p.status)}` : "";
          return `\`${platformName(p.id).short}\`${status}${isInert(p) ? " (inert)" : ""}`;
        })
        .join(" · "),
    );
  lines.push(...extra.filter(Boolean).map(escapeMarkdown));
  if (index) {
    const out = countsLine(index, subject.uuid, "out");
    const inbound = countsLine(index, subject.uuid, "in");
    lines.push(out || inbound ? [out, inbound].filter(Boolean).join("  \n") : "No relations");
  }
  return lines.join("\n\n");
}

/** Object kinds the lens summarises; techniques and log sources show in the YAML already. */
const LENS_KINDS: readonly RelationKind[] = ["implements", "covers", "signal", "parent", "chains"];

const short = (text: string, max = 40): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The family of the far ends of `relations`, when they share one. */
function familyOf(graph: RelationGraph, relations: readonly Relation[]): string | undefined {
  const families = new Set(
    relations.map((r) => (r.otherKind === "signal" ? "signal" : (graph.object(r.other)?.type ?? "?"))),
  );
  if (families.size !== 1) return undefined;
  const [family] = families;
  return family === "?" ? undefined : family;
}

/**
 * The CodeLens on an object's `name:` line: `Implements → Detect LSASS memory access · ← Implemented
 * by 3 rules`. Outgoing first, then incoming, in RELATION_ORDER, the words of RELATION_WORDS.
 */
export function lensText(graph: RelationGraph, uuid: string): string {
  const { outgoing, incoming } = graph.index.of(uuid);
  const parts: string[] = [];
  for (const group of relationGroups(outgoing.filter((r) => LENS_KINDS.includes(r.kind)))) {
    const head = relationLabel(group.kind, "out", undefined, group.relation);
    const [only] = group.relations;
    if (group.relations.length === 1 && only) {
      const name = only.missing ? undefined : graph.nameOf(only.other);
      parts.push(`${head} ${name ? short(name) : `$(${MISSING_ICON}) missing`}`);
    } else {
      const missing = group.relations.filter((r) => r.missing).length;
      const found = group.relations.filter((r) => !r.missing);
      parts.push(
        `${head} ${countOf(found.length, familyOf(graph, found))}${missing ? `, $(${MISSING_ICON}) ${missing} missing` : ""}`,
      );
    }
  }
  for (const group of relationGroups(incoming.filter((r) => LENS_KINDS.includes(r.kind)))) {
    const n = group.relations.length;
    const noun = countOf(n, familyOf(graph, group.relations)).replace(/^\d+ /, "");
    parts.push(`${relationLabel(group.kind, "in", n, group.relation)} ${noun}`);
  }
  return parts.length ? parts.join(" · ") : "No relations";
}

/** The 0-based line of the top-level `name:` key among `count` lines (`at(i)` reads one), if any. */
export function nameLine(count: number, at: (line: number) => string): number | undefined {
  for (let line = 0; line < count; line += 1) if (/^name\s*:/.test(at(line))) return line;
  return undefined;
}

// ── the view ─────────────────────────────────────────────────────────────────────────────────────────

/** What the Relations view is about: an object or a signal of a folder. */
export interface RelationsTarget {
  readonly folder: string;
  readonly uuid: string;
}

/** What a row's click opens: a file at a line, beside the editor the view follows (or in place). */
export interface RelationsOpen {
  readonly file: string;
  readonly line: number;
  /** A signal: open its objective at the signal's `uuid:` (found in the text when no line is known). */
  readonly signal?: string;
  /** Open where the object already shows rather than beside (the header row). */
  readonly inPlace?: boolean;
}

export const OPEN_COMMAND = "opentide.relations.open";
export const MATRIX_COMMAND = "opentide.sidebar.openMatrix";

export type RelationsState =
  /** No opentide object yet: the welcome view explains. */
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly graph: RelationGraph;
      readonly uuid: string;
      readonly folderName?: string;
    }
  /** An object file the index does not have (new, or it did not load). */
  | { readonly kind: "not-indexed"; readonly name: string; readonly file: string; readonly folder: string }
  | {
      readonly kind: "unavailable";
      /** `needs-newer`: neither `info catalog` nor `opentide/catalog`. */
      readonly reason: "needs-newer" | "no-server" | "untrusted" | "failed";
      readonly detail?: string;
      /** The object, by name, from workspace symbols, so the view says which one it is about. */
      readonly name?: string;
      readonly family?: string;
      readonly file?: string;
    };

const SERVER_MESSAGE =
  "From the language server's index: references between objects. Techniques and log sources need an opentide with `info catalog`.";

function header(graph: RelationGraph, uuid: string, folderName: string | undefined): TreeNode {
  const object = graph.object(uuid);
  const signal = object ? undefined : graph.signal(uuid);
  const owner = signal?.objective ? graph.object(signal.objective) : undefined;
  const type = object?.type ?? "signal";
  const name = object?.name ?? signal?.name ?? uuid;
  const icon = objectIcon(type);
  const where = object?.path ?? (owner ? `in ${owner.name}` : "");
  const description = folderName ? [folderName, where].filter(Boolean).join(" · ") : where;
  const base = {
    id: `rel:${uuid}`,
    label: `${kindName(type)} · ${name}`,
    description,
    icon: icon.codicon,
    iconColor: icon.themeColor,
  };
  if (object)
    return {
      ...base,
      tooltipMarkdown: objectTooltip(object, graph.index),
      contextValue: `object.${object.type}`,
      open: { path: object.file, line: object.line },
      decorate: false,
      command: openCommand({ file: object.file, line: object.line, inPlace: true }),
      ref: objectRef(graph.folder, object),
    };
  return {
    ...base,
    tooltipMarkdown: signalTooltip(graph, signal, uuid),
    contextValue: "signal",
    ref: { kind: "signal", folder: graph.folder, uuid, name, objective: signal?.objective ?? null },
    ...(owner
      ? {
          command: openCommand({
            file: owner.file,
            line: signal?.line ?? owner.line,
            signal: uuid,
            inPlace: true,
          }),
        }
      : {}),
  };
}

function openCommand(open: RelationsOpen): NonNullable<TreeNode["command"]> {
  return { command: OPEN_COMMAND, title: "Open", args: [open] };
}

function objectRef(folder: string, object: RelObject): NonNullable<TreeNode["ref"]> {
  return {
    kind: "object",
    folder,
    uuid: object.uuid,
    type: object.type,
    name: object.name,
    file: object.file,
  };
}

function signalTooltip(graph: RelationGraph, signal: RelSignal | undefined, uuid: string): string {
  const owner = signal?.objective ? graph.object(signal.objective) : undefined;
  const lines = [
    `$(${objectIcon("signal").codicon}) **${escapeMarkdown(signal?.name ?? uuid)}**`,
    `Signal${owner ? ` of ${escapeMarkdown(owner.name)}` : ""} · \`${uuid}\``,
  ];
  const out = countsLine(graph.index, uuid, "out");
  const inbound = countsLine(graph.index, uuid, "in");
  lines.push(out || inbound ? [out, inbound].filter(Boolean).join("  \n") : "No relations");
  return lines.join("\n\n");
}

function relationRow(graph: RelationGraph, relation: Relation, parentId: string): TreeNode {
  const id = `${parentId}/${relation.other}`;
  const folder = graph.folder;
  if (relation.missing) {
    return {
      id,
      label: relation.other,
      description: "missing",
      tooltip: `No object carries ${relation.other} (${relation.fieldPath}).`,
      icon: MISSING_ICON,
      iconColor: "problemsWarningIcon.foreground",
      contextValue: "relation.missing",
      sortKey: `~${relation.other}`,
    };
  }
  if (relation.otherKind === "technique") {
    const icon = objectIcon("technique");
    const name = graph.techniqueName(relation.other);
    return {
      id,
      label: relation.other,
      ...(name ? { description: name } : {}),
      tooltip: name ? `${relation.other} ${name}` : relation.other,
      icon: icon.codicon,
      iconColor: icon.themeColor,
      contextValue: "technique",
      ref: { kind: "technique", folder, id: relation.other },
      command: {
        command: MATRIX_COMMAND,
        title: "Open ATT&CK Matrix",
        args: [{ kind: "technique", folder, id: relation.other }],
      },
      sortKey: relation.other,
    };
  }
  if (relation.otherKind === "logsource") {
    const icon = objectIcon("logsource");
    return {
      id,
      label: relation.other,
      tooltip: `Log source ${relation.other} (visibility.toml)`,
      icon: icon.codicon,
      iconColor: icon.themeColor,
      contextValue: "logsource",
      sortKey: relation.other,
    };
  }
  const object = graph.object(relation.other);
  if (object) {
    const icon = objectIcon(object.type);
    return {
      id,
      label: object.name || object.path,
      description: object.path,
      tooltipMarkdown: objectTooltip(object, graph.index),
      icon: icon.codicon,
      iconColor: icon.themeColor,
      contextValue: `object.${object.type}`,
      open: { path: object.file, line: object.line },
      decorate: false,
      command: openCommand({ file: object.file, line: object.line }),
      ref: objectRef(folder, object),
      sortKey: object.name.toLowerCase(),
    };
  }
  const signal = graph.signal(relation.other);
  if (signal) {
    const icon = objectIcon("signal");
    const owner = signal.objective ? graph.object(signal.objective) : undefined;
    const implemented = graph.index.of(signal.uuid).incoming.filter((r) => r.kind === "implements").length;
    return {
      id,
      label: signal.name,
      description:
        relation.kind === "signal"
          ? relationLabel("implements", "in", implemented)
          : owner
            ? `signal of ${owner.name}`
            : "signal",
      tooltipMarkdown: signalTooltip(graph, signal, signal.uuid),
      icon: icon.codicon,
      iconColor: icon.themeColor,
      contextValue: "signal",
      ref: { kind: "signal", folder, uuid: signal.uuid, name: signal.name, objective: signal.objective },
      ...(owner
        ? { command: openCommand({ file: owner.file, line: signal.line ?? owner.line, signal: signal.uuid }) }
        : {}),
      sortKey: signal.name.toLowerCase(),
    };
  }
  // Named, not missing, yet not a loaded object: a file that did not load carries it.
  return {
    id,
    label: relation.other,
    description: "did not load",
    tooltip: `${relation.other}: its file did not load. See the Catalogue's "Files that failed to load".`,
    icon: "error",
    iconColor: "problemsErrorIcon.foreground",
    contextValue: "relation.unloaded",
    sortKey: `~${relation.other}`,
  };
}

function groups(graph: RelationGraph, uuid: string, name: string): TreeNode[] {
  const { outgoing, incoming } = graph.index.of(uuid);
  const build = (direction: Direction, list: readonly Relation[]): TreeNode[] =>
    relationGroups(list).map(({ kind, relation, relations }) => {
      const id = `rel:${uuid}:${direction}:${kind}${relation ? `:${relation}` : ""}`;
      const icon = RELATION_WORDS[kind].icon;
      const words = { out: relationWords(kind, "out", relation), in: relationWords(kind, "in", relation) };
      const fields = [...new Set(relations.map((r) => r.fieldPath).filter(Boolean))];
      const rows = relations
        .map((r) => relationRow(graph, r, id))
        .sort((a, b) => (a.sortKey ?? a.label).localeCompare(b.sortKey ?? b.label));
      return {
        id,
        label: relationLabel(kind, direction, relations.length, relation),
        icon,
        contextValue: "relation.group",
        tooltip:
          direction === "out"
            ? `${words.out}: what ${name} points to${fields.length ? ` (${fields.join(", ")})` : ""}`
            : `${words.in}: what points to ${name}${fields.length ? ` (${fields.join(", ")})` : ""}`,
        collapsed: "expanded",
        children: rows,
      };
    });
  return [...build("out", outgoing), ...build("in", incoming)];
}

/** The Relations view's model. `pinned` only changes the view's description. */
export function relationsViewModel(state: RelationsState, pinned: boolean): ViewModel {
  if (state.kind === "none") return { nodes: [] };
  if (state.kind === "loading")
    return { nodes: [messageNode("relations:loading", "Loading the catalogue…", "loading~spin")] };
  if (state.kind === "not-indexed")
    return {
      nodes: [
        messageNode("relations:not-indexed", state.name, "file", {
          description: "not in the catalogue yet",
          tooltip: `${state.file}: save it (or fix what keeps it from loading) to see its relations.`,
          open: { path: state.file, line: 0 },
        }),
      ],
      description: `${pinned ? "Pinned" : "Following"}: ${state.name}`,
    };
  if (state.kind === "unavailable") {
    const nodes: TreeNode[] = [];
    if (state.name) {
      const icon = objectIcon(state.family);
      nodes.push({
        id: "relations:symbol",
        label: `${kindName(state.family)} · ${state.name}`,
        icon: icon.codicon,
        iconColor: icon.themeColor,
        ...(state.file ? { open: { path: state.file, line: 0 }, decorate: false } : {}),
      });
    }
    nodes.push(unavailableNode(state.reason, state.detail));
    return {
      nodes,
      ...(state.name ? { description: `${pinned ? "Pinned" : "Following"}: ${state.name}` } : {}),
    };
  }
  const { graph, uuid } = state;
  const head = header(graph, uuid, state.folderName);
  const name = graph.nameOf(uuid) ?? uuid;
  const children = groups(graph, uuid, name);
  const nodes = [
    head,
    ...(children.length
      ? children
      : [
          messageNode(`rel:${uuid}:none`, "No relations", "info", {
            description: "it points to nothing, and nothing points to it",
          }),
        ]),
  ];
  return {
    nodes,
    description: `${pinned ? "Pinned" : "Following"}: ${name}`,
    ...(graph.source === "server" ? { message: SERVER_MESSAGE } : {}),
  };
}

function unavailableNode(
  reason: "needs-newer" | "no-server" | "untrusted" | "failed",
  detail?: string,
): TreeNode {
  switch (reason) {
    case "untrusted":
      return messageNode("relations:untrusted", "Trust this folder to see relations", "shield", {
        description: "Manage Workspace Trust…",
        tooltip: "In Restricted Mode the language server runs without an index of relations.",
        command: { command: "workbench.trust.manage", title: "Manage Workspace Trust" },
      });
    case "failed":
      return messageNode("relations:failed", "The relations did not load", "error", {
        ...(detail ? { description: detail, tooltip: detail } : {}),
        command: { command: "opentide.sidebar.refreshCatalogue", title: "Retry" },
      });
    case "no-server":
      return messageNode("relations:no-server", "Relations need opentide or its language server", "info", {
        description: "Switch Runtime…",
        tooltip: detail ?? "Neither `info catalog` nor the language server's index is available.",
        command: { command: "opentide.switchRuntime", title: "Switch Runtime…" },
      });
    default:
      return messageNode("relations:needs-newer", "Relations need a newer opentide", "info", {
        description: "Switch Runtime…",
        tooltip:
          detail ?? "This opentide has neither `info catalog` nor a language server with `opentide/catalog`.",
        command: { command: "opentide.switchRuntime", title: "Switch Runtime…" },
      });
  }
}

// ── history ──────────────────────────────────────────────────────────────────────────────────────────

/** Back and forward through the objects the view showed, as a browser does. */
export class History<T> {
  private readonly items: T[] = [];
  private at = -1;

  constructor(
    private readonly same: (a: T, b: T) => boolean,
    private readonly limit = 50,
  ) {}

  get current(): T | undefined {
    return this.items[this.at];
  }

  get canBack(): boolean {
    return this.at > 0;
  }

  get canForward(): boolean {
    return this.at < this.items.length - 1;
  }

  /** Show `item`: drops what was forward of the current one, unless `item` is the current one. */
  push(item: T): void {
    const current = this.current;
    if (current !== undefined && this.same(current, item)) {
      this.items[this.at] = item;
      return;
    }
    this.items.splice(this.at + 1);
    this.items.push(item);
    if (this.items.length > this.limit) this.items.shift();
    this.at = this.items.length - 1;
  }

  back(): T | undefined {
    if (this.canBack) this.at -= 1;
    return this.current;
  }

  forward(): T | undefined {
    if (this.canForward) this.at += 1;
    return this.current;
  }
}
