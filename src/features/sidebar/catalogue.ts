// The Catalogue view (SPEC §9): threats → objectives → signals → rules from `info catalog`, other
// groupings, and names from `workspace/symbol` until (or instead of) the catalogue. vscode-free.
import type { CatalogState } from "../../core/catalog/store";
import type { CatalogDocument, CatalogObject, CatalogSymbol } from "../../core/catalog/types";
import { branch, filterNodes, messageNode, type TreeNode, type ViewModel } from "./node";
import { platformName } from "./platformNames";

export type GroupBy = "chain" | "type" | "platform" | "status" | "technique";

export const GROUP_BY_LABELS: Readonly<Record<GroupBy, string>> = {
  chain: "Threat chain",
  type: "Type",
  platform: "Platform",
  status: "Status",
  technique: "Technique",
};

export interface ProblemCount {
  readonly errors: number;
  readonly warnings: number;
}

export interface CatalogueFolder {
  readonly path: string;
  readonly name: string;
  readonly state: CatalogState;
}

export interface CatalogueInput {
  readonly folders: readonly CatalogueFolder[];
  readonly groupBy: GroupBy;
  readonly filter?: string;
  /** Problems of an absolute file path (the Problems panel's counts). */
  readonly problems?: (file: string) => ProblemCount | undefined;
}

const ICONS: Readonly<Record<string, string>> = {
  threat: "flame",
  objective: "target",
  signal: "pulse",
  rule: "shield",
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `✗ 2 ! 1`: problem counts as text, so colour is never the only signal. */
export function problemBadge(count: ProblemCount | undefined): string {
  if (!count) return "";
  const parts: string[] = [];
  if (count.errors > 0) parts.push(`✗ ${count.errors}`);
  if (count.warnings > 0) parts.push(`! ${count.warnings}`);
  return parts.join(" ");
}

/** `Sentinel · Splunk (inert)`: a rule's platform blocks, inert ones marked. */
export function platformsText(object: CatalogObject): string {
  return object.platforms
    .map((p) => {
      const inert = p.strategy?.toUpperCase() === "INERT" || p.status?.toUpperCase() === "INERT";
      return `${platformName(p.id).short}${inert ? " (inert)" : ""}`;
    })
    .join(" · ");
}

function techniquesOf(object: CatalogObject): string[] {
  return [...new Set([...object.techniques.own, ...object.techniques.inherited])];
}

function searchText(object: CatalogObject): string {
  return [object.name, object.uuid ?? "", object.path, ...techniquesOf(object)].join("\n").toLowerCase();
}

/** The model of the Catalogue view. */
export function buildCatalogue(input: CatalogueInput): ViewModel {
  const multi = input.folders.length > 1;
  const nodes: TreeNode[] = [];
  const messages: string[] = [];
  let loadErrors = 0;
  for (const folder of input.folders) {
    const built = buildFolder(folder, input, multi);
    loadErrors += built.loadErrors;
    if (built.message) messages.push(multi ? `${folder.name}: ${built.message}` : built.message);
    if (multi) {
      nodes.push(
        branch(
          {
            id: `folder:${folder.path}`,
            label: folder.name,
            icon: "root-folder",
            tooltip: folder.path,
            search: folder.name.toLowerCase(),
          },
          built.nodes,
          "expanded",
        ),
      );
    } else nodes.push(...built.nodes);
  }
  const filtered = filterNodes(nodes, input.filter);
  const description = [
    input.groupBy === "chain" ? "" : `by ${GROUP_BY_LABELS[input.groupBy].toLowerCase()}`,
    input.filter?.trim() ? `filter: ${input.filter.trim()}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    nodes: filtered,
    ...(messages.length > 0 ? { message: messages.join(" ") } : {}),
    ...(description ? { description } : {}),
    ...(loadErrors > 0
      ? { badge: { value: loadErrors, tooltip: `${plural(loadErrors, "file")} failed to load` } }
      : {}),
  };
}

interface Built {
  nodes: TreeNode[];
  message?: string;
  loadErrors: number;
}

function buildFolder(folder: CatalogueFolder, input: CatalogueInput, multi: boolean): Built {
  const state = folder.state;
  const prefix = multi ? `${folder.path}|` : "";
  if (state.catalog) {
    const nodes = fromCatalog(state.catalog, folder.path, input, prefix);
    const loadErrors = state.catalog.objects.filter((o) => o.load_error).length;
    if (state.status === "error")
      return { nodes, loadErrors, message: `The last refresh failed (${state.error ?? "unknown error"}).` };
    return { nodes, loadErrors };
  }
  if (state.symbols && state.symbols.length > 0) {
    const reason =
      state.unavailable?.message ?? (state.error ? `The catalogue failed: ${state.error}` : undefined);
    return {
      nodes: fromSymbols(state.symbols, prefix),
      loadErrors: 0,
      message: `${reason ? `${reason} ` : ""}Showing names from the language server.`,
    };
  }
  if (state.status === "empty" || state.status === "loading")
    return {
      nodes: [messageNode(`${prefix}loading`, "Loading the catalogue…", "loading~spin")],
      loadErrors: 0,
    };
  if (state.status === "error")
    return {
      nodes: [
        messageNode(`${prefix}error`, "The catalogue did not load", "error", {
          description: state.error,
          tooltip: state.error,
          command: { command: "opentide.sidebar.refresh", title: "Retry" },
          ref: { kind: "retry", view: "catalogue" },
        }),
      ],
      loadErrors: 0,
    };
  if (state.unavailable?.reason === "needs-command")
    return {
      nodes: [
        messageNode(`${prefix}needs`, "Needs a newer opentide", "info", {
          description: `with \`${state.unavailable.command ?? "info catalog"}\``,
          tooltip: state.unavailable.message,
          command: { command: "opentide.switchRuntime", title: "Switch Runtime…" },
        }),
      ],
      loadErrors: 0,
    };
  // untrusted, no-runtime, editor-only, or an empty repository: the welcome view explains (multi-root:
  // a line per folder).
  if (multi && state.unavailable)
    return { nodes: [messageNode(`${prefix}unavailable`, state.unavailable.message, "info")], loadErrors: 0 };
  return { nodes: [], loadErrors: 0 };
}

function objectNode(
  object: CatalogObject,
  folder: string,
  input: CatalogueInput,
  id: string,
  extra: { description?: string; children?: TreeNode[] } = {},
): TreeNode {
  const problems = input.problems?.(object.file_path);
  const badge = problemBadge(problems);
  const own = object.techniques.own;
  const descriptionParts =
    object.type === "rule"
      ? [platformsText(object), badge]
      : [extra.description ?? "", own.slice(0, 2).join(" ") + (own.length > 2 ? " …" : ""), badge];
  const tooltip = [
    `${object.name} (${object.type})`,
    object.path,
    object.uuid ? `UUID ${object.uuid}` : "",
    techniquesOf(object).length ? `Techniques: ${techniquesOf(object).join(", ")}` : "",
    object.platforms.length
      ? `Platforms: ${object.platforms.map((p) => `${p.id} ${p.status}${p.strategy ? `/${p.strategy}` : ""}`).join(", ")}`
      : "",
    problems && (problems.errors || problems.warnings)
      ? `${plural(problems.errors, "error")}, ${plural(problems.warnings, "warning")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const node: Omit<TreeNode, "children" | "collapsed"> = {
    id,
    label: object.name || object.path,
    description: descriptionParts.filter(Boolean).join("  "),
    tooltip,
    icon: ICONS[object.type] ?? "file",
    ...(problems && problems.errors > 0 ? { iconColor: "problemsErrorIcon.foreground" } : {}),
    ...(problems && problems.errors === 0 && problems.warnings > 0
      ? { iconColor: "problemsWarningIcon.foreground" }
      : {}),
    contextValue: `object.${object.type}`,
    open: { path: object.file_path, line: Math.max(0, object.line - 1) },
    ref: {
      kind: "object",
      folder,
      uuid: object.uuid,
      type: object.type,
      name: object.name,
      file: object.file_path,
    },
    search: searchText(object),
  };
  return extra.children ? branch(node, extra.children) : node;
}

function group(id: string, label: string, icon: string, children: TreeNode[], tooltip?: string): TreeNode {
  return branch(
    {
      id,
      label,
      icon,
      group: true,
      description: String(children.length),
      ...(tooltip ? { tooltip } : {}),
      search: label.toLowerCase(),
    },
    children,
  );
}

function loadErrorNode(object: CatalogObject, prefix: string): TreeNode {
  const error = object.load_error;
  return {
    id: `${prefix}load:${object.path}`,
    label: object.path,
    description: error?.code,
    tooltip: `${error?.message ?? "Did not load"}${error?.line ? ` (line ${error.line})` : ""}`,
    icon: "error",
    iconColor: "problemsErrorIcon.foreground",
    contextValue: "loadError",
    open: { path: object.file_path, line: Math.max(0, (error?.line ?? 1) - 1) },
    search: `${object.path}\n${object.name ?? ""}`.toLowerCase(),
  };
}

function byName(a: CatalogObject, b: CatalogObject): number {
  return (a.name || a.path).localeCompare(b.name || b.path);
}

function fromCatalog(
  doc: CatalogDocument,
  folder: string,
  input: CatalogueInput,
  prefix: string,
): TreeNode[] {
  const loaded = doc.objects.filter((o) => !o.load_error && o.uuid);
  const failed = doc.objects.filter((o) => o.load_error);
  const failedGroup = failed.length
    ? [
        group(
          `${prefix}group:failed`,
          "Files that failed to load",
          "warning",
          failed.map((o) => loadErrorNode(o, prefix)),
        ),
      ]
    : [];
  const rules = loaded.filter((o) => o.type === "rule").sort(byName);
  const ruleNode = (rule: CatalogObject, parentId: string) =>
    objectNode(rule, folder, input, `${parentId}/${rule.uuid}`);
  if (input.groupBy === "chain") return [...chain(doc, loaded, folder, input, prefix), ...failedGroup];
  if (input.groupBy === "type") {
    const families: [string, string, string][] = [
      ["threat", "Threats", "flame"],
      ["objective", "Objectives", "target"],
      ["rule", "Rules", "shield"],
    ];
    return [
      ...families.map(([type, label, icon]) => {
        const id = `${prefix}type:${type}`;
        return group(
          id,
          label,
          icon,
          loaded
            .filter((o) => o.type === type)
            .sort(byName)
            .map((o) => objectNode(o, folder, input, `${id}/${o.uuid}`)),
        );
      }),
      ...failedGroup,
    ];
  }
  const buckets = new Map<string, CatalogObject[]>();
  const none: CatalogObject[] = [];
  for (const rule of rules) {
    const keys =
      input.groupBy === "platform"
        ? rule.platforms.map((p) => p.id)
        : input.groupBy === "status"
          ? rule.platforms.map((p) => p.status || "")
          : techniquesOf(rule);
    const distinct = [...new Set(keys.filter(Boolean))];
    if (distinct.length === 0) none.push(rule);
    for (const key of distinct) buckets.set(key, [...(buckets.get(key) ?? []), rule]);
  }
  const label = (key: string): string => {
    if (input.groupBy === "platform") return platformName(key).long;
    if (input.groupBy === "technique") {
      const name = doc.attack?.techniques?.[key]?.name;
      return name ? `${key} ${name}` : key;
    }
    return key;
  };
  const icon = input.groupBy === "platform" ? "server" : input.groupBy === "status" ? "tag" : "symbol-key";
  const noneLabel =
    input.groupBy === "platform" ? "No platform" : input.groupBy === "status" ? "No status" : "No technique";
  return [
    ...[...buckets.keys()].sort().map((key) => {
      const id = `${prefix}${input.groupBy}:${key}`;
      return group(
        id,
        label(key),
        icon,
        (buckets.get(key) ?? []).map((rule) => ruleNode(rule, id)),
      );
    }),
    ...(none.length
      ? [
          group(
            `${prefix}${input.groupBy}:none`,
            noneLabel,
            "circle-slash",
            none.map((r) => ruleNode(r, `${prefix}${input.groupBy}:none`)),
          ),
        ]
      : []),
    ...failedGroup,
  ];
}

function chain(
  doc: CatalogDocument,
  loaded: readonly CatalogObject[],
  folder: string,
  input: CatalogueInput,
  prefix: string,
): TreeNode[] {
  const byUuid = new Map(loaded.map((o) => [o.uuid, o]));
  const signals = new Map(doc.signals.map((s) => [s.uuid, s]));
  // rule → its objective (directly or through a signal); objective → signal → rules.
  const direct = new Map<string, CatalogObject[]>();
  const viaSignal = new Map<string, CatalogObject[]>();
  const placed = new Set<string>();
  const covers = new Map<string, string[]>();
  for (const edge of doc.edges) {
    if (edge.missing) continue;
    if (edge.kind === "implements") {
      const rule = byUuid.get(edge.from);
      if (rule?.type !== "rule") continue;
      const target = byUuid.get(edge.to);
      if (target?.type === "objective") {
        direct.set(target.uuid, [...(direct.get(target.uuid) ?? []), rule]);
        placed.add(rule.uuid);
      } else if (signals.has(edge.to)) {
        viaSignal.set(edge.to, [...(viaSignal.get(edge.to) ?? []), rule]);
        if (byUuid.get(signals.get(edge.to)?.objective ?? "")?.type === "objective") placed.add(rule.uuid);
      }
    } else if (edge.kind === "covers") {
      if (byUuid.get(edge.to)?.type === "threat")
        covers.set(edge.from, [...(covers.get(edge.from) ?? []), edge.to]);
    }
  }
  const signalsOf = (objective: string) => doc.signals.filter((s) => s.objective === objective);
  const rulesOf = (objective: string): number =>
    new Set([
      ...(direct.get(objective) ?? []).map((r) => r.uuid),
      ...signalsOf(objective).flatMap((s) => (viaSignal.get(s.uuid) ?? []).map((r) => r.uuid)),
    ]).size;
  const objectiveNode = (objective: CatalogObject, parentId: string): TreeNode => {
    const id = `${parentId}/${objective.uuid}`;
    const children: TreeNode[] = [
      ...signalsOf(objective.uuid).map((signal) => {
        const signalId = `${id}/${signal.uuid}`;
        const rules = [...(viaSignal.get(signal.uuid) ?? [])].sort(byName);
        return branch(
          {
            id: signalId,
            label: signal.name,
            description: plural(rules.length, "rule"),
            icon: "pulse",
            contextValue: "signal",
            tooltip: `Signal ${signal.uuid}`,
            search: `${signal.name}\n${signal.uuid}`.toLowerCase(),
          },
          rules.map((rule) => objectNode(rule, folder, input, `${signalId}/${rule.uuid}`)),
        );
      }),
      ...[...(direct.get(objective.uuid) ?? [])]
        .sort(byName)
        .map((rule) => objectNode(rule, folder, input, `${id}/${rule.uuid}`)),
    ];
    return objectNode(objective, folder, input, id, {
      description: plural(rulesOf(objective.uuid), "rule"),
      children,
    });
  };
  const objectives = loaded.filter((o) => o.type === "objective").sort(byName);
  const threats = loaded.filter((o) => o.type === "threat").sort(byName);
  const nodes: TreeNode[] = threats.map((threat) => {
    const id = `${prefix}chain:${threat.uuid}`;
    const mine = objectives.filter((o) => covers.get(o.uuid)?.includes(threat.uuid));
    const rules = mine.reduce((sum, o) => sum + rulesOf(o.uuid), 0);
    return objectNode(threat, folder, input, id, {
      description: `${mine.length} obj · ${plural(rules, "rule")}`,
      children: mine.map((o) => objectiveNode(o, id)),
    });
  });
  const orphanObjectives = objectives.filter((o) => !covers.get(o.uuid)?.length);
  if (orphanObjectives.length) {
    const id = `${prefix}group:no-threat`;
    nodes.push(
      group(
        id,
        "Objectives without a threat",
        "target",
        orphanObjectives.map((o) => objectiveNode(o, id)),
      ),
    );
  }
  const orphanRules = loaded.filter((o) => o.type === "rule" && !placed.has(o.uuid)).sort(byName);
  if (orphanRules.length) {
    const id = `${prefix}group:no-objective`;
    nodes.push(
      group(
        id,
        "Rules without an objective",
        "shield",
        orphanRules.map((r) => objectNode(r, folder, input, `${id}/${r.uuid}`)),
        "Rules whose detection_model names no objective or signal that exists",
      ),
    );
  }
  return nodes;
}

const FAMILIES: readonly [string, string, string][] = [
  ["threat", "Threats", "flame"],
  ["objective", "Objectives", "target"],
  ["rule", "Rules", "shield"],
];

/** Names and locations from `workspace/symbol`, by family. */
export function fromSymbols(symbols: readonly CatalogSymbol[], prefix = ""): TreeNode[] {
  const known = new Set(FAMILIES.map(([family]) => family));
  const families: [string, string, string][] = [...FAMILIES];
  if (symbols.some((s) => !known.has(s.family))) families.push(["", "Other", "symbol-misc"]);
  return families
    .map(([family, label, icon]) => {
      const id = `${prefix}symbols:${family}`;
      const items = symbols
        .filter((s) => (family ? s.family === family : !known.has(s.family)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (s): TreeNode => ({
            id: `${id}/${s.uri}#${s.line}`,
            label: s.name,
            icon: ICONS[s.family] ?? "symbol-misc",
            contextValue: `symbol.${s.family || "other"}`,
            open: { uri: s.uri, line: s.line, character: s.character },
            tooltip: decodeURIComponent(s.uri.replace(/^file:\/\//, "")),
            search: s.name.toLowerCase(),
          }),
        );
      return group(id, label, icon, items);
    })
    .filter((node) => (node.children?.length ?? 0) > 0);
}

/** Is a folder's catalogue loaded and empty (no object at all)? */
export function isEmptyRepository(state: CatalogState): boolean {
  return state.status === "ready" && (state.catalog?.objects.length ?? 0) === 0;
}
