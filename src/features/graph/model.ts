// The graph's nodes and edges, built from one `info catalog` document (CONTRACTS.md). No YAML is read
// here: every edge is one opentide reported, plus three it implies (objective → its signals, threat →
// its actors, rule → its platforms). vscode-free and DOM-free: the webview imports it too.
import { isLoaded, type LoadedObject, rowKey } from "../../core/catalog/rows";
import type { CatalogDocument, CatalogObject } from "../../core/catalog/types";
import { graphRelationWords } from "./words";

export type NodeKind =
  | "threat"
  | "objective"
  | "signal"
  | "rule"
  | "technique"
  | "actor"
  | "logsource"
  | "platform"
  | "missing";

/** Always drawn unless filtered out. */
export const OBJECT_KINDS: readonly NodeKind[] = ["threat", "objective", "signal", "rule"];
/** Drawn when switched on. */
export const OPTIONAL_KINDS: readonly NodeKind[] = ["technique", "actor", "logsource", "platform"];
export const ALL_KINDS: readonly NodeKind[] = [...OBJECT_KINDS, ...OPTIONAL_KINDS, "missing"];

export const KIND_LABELS: Readonly<Record<NodeKind, string>> = {
  threat: "Threat",
  objective: "Objective",
  signal: "Signal",
  rule: "Rule",
  technique: "ATT&CK technique",
  actor: "Actor",
  logsource: "Log source",
  platform: "Platform",
  missing: "Missing reference",
};

export type GraphEdgeKind =
  | "covers"
  | "implements"
  | "parent"
  | "chains"
  | "technique"
  | "logsource"
  /** objective → one of its signals (signals[].objective). */
  | "signal"
  /** threat → an actor it names. */
  | "actor"
  /** rule → a platform it has a block for. */
  | "platform"
  | (string & {});

export interface GraphPlatform {
  readonly id: string;
  readonly status: string;
  readonly enabled: boolean;
}

export interface GraphNode {
  /** A UUID for objects and signals; `<kind>:<name>` for the rest. */
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly uuid?: string;
  /** Workspace-relative path of the file that defines it (a signal's objective). */
  readonly path?: string;
  readonly filePath?: string;
  /** 1-based line of the `name:` key. */
  readonly line?: number;
  readonly platforms: readonly GraphPlatform[];
  /** Own and inherited ATT&CK ids. */
  readonly techniques: readonly string[];
  /** The file did not load (`load_error.message`). */
  readonly loadError?: string;
  /** A signal's objective. */
  readonly objective?: string;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: GraphEdgeKind;
  /** A chaining relation as written (`sequence::preceeds`). */
  readonly relation: string | null;
  readonly fieldPath: string;
  /** A dangling reference: the target is a `missing` node. */
  readonly missing: boolean;
}

export interface GraphModel {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** Problem counts of one node (from load errors and the Problems panel). */
export interface NodeProblems {
  readonly errors: number;
  readonly warnings: number;
}

export type ProblemMap = Readonly<Record<string, NodeProblems>>;

const KIND_PREFIX = {
  technique: "technique:",
  actor: "actor:",
  logsource: "logsource:",
  platform: "platform:",
};

export const techniqueId = (id: string): string => `${KIND_PREFIX.technique}${id}`;
export const missingId = (id: string): string => `missing:${id}`;

function objectKind(object: CatalogObject): NodeKind {
  if (object.type === "threat") return "threat";
  return object.type === "objective" ? "objective" : "rule";
}

/**
 * The id of an object row: a loaded object's UUID, or `file:<path>` for a file that did not load, even
 * one that carries a UUID (which may be a loaded object's).
 */
export function objectNodeId(object: CatalogObject): string {
  return rowKey(object);
}

/** Strip a vocabulary prefix for display: `att&ck::G0016` → `G0016`. */
export function shortId(value: string): string {
  const at = value.lastIndexOf("::");
  return at >= 0 ? value.slice(at + 2) : value;
}

export function buildModel(catalog: CatalogDocument): GraphModel {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();
  const techniques = catalog.attack?.techniques ?? {};

  const addEdge = (edge: Omit<GraphEdge, "id">): void => {
    const base = `${edge.kind}|${edge.source}|${edge.target}`;
    let id = base;
    for (let n = 2; edgeIds.has(id); n += 1) id = `${base}|${n}`;
    edgeIds.add(id);
    edges.push({ ...edge, id });
  };

  const objectsByUuid = new Map<string, LoadedObject>();
  for (const object of catalog.objects) {
    const id = objectNodeId(object);
    if (isLoaded(object)) objectsByUuid.set(object.uuid, object);
    nodes.set(id, {
      id,
      kind: objectKind(object),
      label: object.name || object.path || object.file_path || id,
      ...(object.uuid ? { uuid: object.uuid } : {}),
      ...(object.path ? { path: object.path } : {}),
      ...(object.file_path ? { filePath: object.file_path } : {}),
      line: object.line || 1,
      platforms: (object.platforms ?? []).map((p) => ({
        id: p.id,
        status: p.status ?? "",
        enabled: p.enabled,
      })),
      techniques: [...new Set([...(object.techniques?.own ?? []), ...(object.techniques?.inherited ?? [])])],
      ...(object.load_error ? { loadError: object.load_error.message } : {}),
    });
  }

  for (const signal of catalog.signals ?? []) {
    const objective = signal.objective ? objectsByUuid.get(signal.objective) : undefined;
    nodes.set(signal.uuid, {
      id: signal.uuid,
      kind: "signal",
      label: signal.name,
      uuid: signal.uuid,
      ...(objective
        ? { path: objective.path, filePath: objective.file_path, line: objective.line || 1 }
        : {}),
      platforms: [],
      techniques: objective ? (nodes.get(objective.uuid)?.techniques ?? []) : [],
      ...(signal.objective ? { objective: signal.objective } : {}),
    });
    if (signal.objective && objective) {
      addEdge({
        source: signal.objective,
        target: signal.uuid,
        kind: "signal",
        relation: null,
        fieldPath: "objective.signals",
        missing: false,
      });
    }
  }

  const ensure = (id: string, node: () => GraphNode): string => {
    if (!nodes.has(id)) nodes.set(id, node());
    return id;
  };

  for (const edge of catalog.edges) {
    if (!edge.from || !edge.to) continue;
    let target: string;
    if (edge.missing) {
      target = ensure(missingId(edge.to), () => ({
        id: missingId(edge.to),
        kind: "missing",
        label: edge.to,
        platforms: [],
        techniques: [],
      }));
    } else if (edge.kind === "technique") {
      target = ensure(techniqueId(edge.to), () => {
        const name = techniques[edge.to]?.name;
        return {
          id: techniqueId(edge.to),
          kind: "technique",
          label: name ? `${edge.to} ${name}` : edge.to,
          platforms: [],
          techniques: [edge.to],
        };
      });
    } else if (edge.kind === "logsource") {
      target = ensure(`${KIND_PREFIX.logsource}${edge.to}`, () => ({
        id: `${KIND_PREFIX.logsource}${edge.to}`,
        kind: "logsource",
        label: edge.to,
        platforms: [],
        techniques: [],
      }));
    } else if (nodes.has(edge.to)) {
      target = edge.to;
    } else {
      // A reference opentide did not flag as missing but that names nothing we know: draw it as missing.
      target = ensure(missingId(edge.to), () => ({
        id: missingId(edge.to),
        kind: "missing",
        label: edge.to,
        platforms: [],
        techniques: [],
      }));
    }
    if (!nodes.has(edge.from)) continue;
    addEdge({
      source: edge.from,
      target,
      kind: edge.kind,
      relation: edge.relation ?? null,
      fieldPath: edge.field_path ?? "",
      missing: edge.missing || target.startsWith("missing:"),
    });
  }

  for (const object of catalog.objects) {
    const id = objectNodeId(object);
    if (object.type === "threat") {
      for (const actor of object.actors ?? []) {
        const actorNode = ensure(`${KIND_PREFIX.actor}${actor}`, () => ({
          id: `${KIND_PREFIX.actor}${actor}`,
          kind: "actor",
          label: shortId(actor),
          platforms: [],
          techniques: [],
        }));
        addEdge({
          source: id,
          target: actorNode,
          kind: "actor",
          relation: null,
          fieldPath: "threat.actors",
          missing: false,
        });
      }
    }
    if (object.type === "rule") {
      for (const platform of object.platforms ?? []) {
        const platformNode = ensure(`${KIND_PREFIX.platform}${platform.id}`, () => ({
          id: `${KIND_PREFIX.platform}${platform.id}`,
          kind: "platform",
          label: platform.id,
          platforms: [],
          techniques: [],
        }));
        addEdge({
          source: id,
          target: platformNode,
          kind: "platform",
          relation: null,
          fieldPath: `configurations.${platform.id}`,
          missing: false,
        });
      }
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/**
 * What an edge says, read from its source, in the words every surface uses (relations.ts): "Implements",
 * "Covers", "Has signal"; a chaining edge by its relation ("Precedes"), else "Chains to".
 */
export function edgeLabel(edge: Pick<GraphEdge, "kind" | "relation">): string {
  return graphRelationWords(edge.kind, "out", edge.relation);
}

/** The platforms and statuses that occur in the model (for the filter menus), sorted. */
export function facets(model: GraphModel): { platforms: string[]; statuses: string[] } {
  const platforms = new Set<string>();
  const statuses = new Set<string>();
  for (const node of model.nodes) {
    for (const platform of node.platforms) {
      platforms.add(platform.id);
      if (platform.status) statuses.add(platform.status);
    }
  }
  return { platforms: [...platforms].sort(), statuses: [...statuses].sort() };
}
