// The details pane of the graph (SPEC §10.1): the selected node, then what it points to (Outgoing) and
// what points to it (Incoming), grouped by relation kind with the words, arrows and counts every surface
// uses, each related node a link. Built from the catalogue's RelationIndex over the graph's edges, plus
// the edges only the graph draws. "View as list" lists the same groups. vscode-free and DOM-free.

import { type Direction, type Relation, RelationIndex } from "../../core/catalog/relations";
import type { CatalogEdge, CatalogSignal } from "../../core/catalog/types";
import {
  type GraphEdge,
  type GraphModel,
  type GraphNode,
  KIND_LABELS,
  type NodeKind,
  shortId,
} from "./model";
import { GRAPH_RELATION_ORDER, graphRelationLabel, NODE_ICONS, wordsOf } from "./words";

export interface DetailItem {
  /** The graph node id at the other end. */
  readonly id: string;
  readonly label: string;
  readonly kind: NodeKind;
  /** A dangling reference: no object has this UUID. */
  readonly missing: boolean;
  /** A chaining edge's relation (`preceeds`). */
  readonly note?: string;
}

export interface DetailGroup {
  readonly kind: string;
  readonly direction: Direction;
  /** `relationLabel(kind, direction, count)`: "Implements 1 →", "← Implemented by 3". */
  readonly header: string;
  /** The relation's codicon. */
  readonly icon: string;
  readonly items: readonly DetailItem[];
}

export interface NodeDetails {
  readonly node: GraphNode;
  readonly kindLabel: string;
  /** The node kind's codicon and theme colour id. */
  readonly icon: string;
  readonly themeColor: string;
  readonly outgoing: readonly DetailGroup[];
  readonly incoming: readonly DetailGroup[];
}

/** Kinds the catalogue's RelationIndex lists both ways; the rest the graph indexes itself. */
const INDEXED_BOTH_WAYS = new Set(["implements", "covers", "signal", "parent", "chains"]);

interface Link {
  readonly kind: string;
  readonly other: string;
  readonly relation: string | null;
}

/** The details of every node of one model, answered in O(degree) per node. */
export class DetailsIndex {
  private readonly nodes: ReadonlyMap<string, GraphNode>;
  private readonly relations: RelationIndex;
  private readonly extraOut = new Map<string, Link[]>();
  private readonly extraIn = new Map<string, Link[]>();

  constructor(model: GraphModel) {
    this.nodes = new Map(model.nodes.map((node) => [node.id, node]));
    const edges: CatalogEdge[] = [];
    const signals: CatalogSignal[] = [];
    for (const edge of model.edges) {
      if (edge.kind === "signal") {
        signals.push({ uuid: edge.target, name: "", objective: edge.source, parent: null });
        continue;
      }
      if (INDEXED_BOTH_WAYS.has(edge.kind)) {
        // `missing` comes from the far node's kind instead, so a missing node still lists who names it.
        edges.push({
          from: edge.source,
          to: edge.target,
          kind: edge.kind,
          field_path: edge.fieldPath,
          relation: edge.relation,
          missing: false,
        });
        continue;
      }
      // Techniques and log sources (listed by the RelationIndex from the object's side only), actors
      // and platforms: indexed here, both ways.
      this.link(edge);
    }
    this.relations = new RelationIndex({ edges, signals });
  }

  private link(edge: GraphEdge): void {
    const add = (map: Map<string, Link[]>, id: string, link: Link): void => {
      const list = map.get(id);
      if (list) list.push(link);
      else map.set(id, [link]);
    };
    add(this.extraOut, edge.source, { kind: edge.kind, other: edge.target, relation: edge.relation });
    add(this.extraIn, edge.target, { kind: edge.kind, other: edge.source, relation: edge.relation });
  }

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** The details of the node `id`, or undefined when the model has no such node. */
  details(id: string): NodeDetails | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    const relations = this.relations.of(id);
    const icon = NODE_ICONS[node.kind];
    return {
      node,
      kindLabel: KIND_LABELS[node.kind],
      icon: icon.codicon,
      themeColor: icon.themeColor,
      outgoing: this.groups("out", relations.outgoing, this.extraOut.get(id) ?? []),
      incoming: this.groups("in", relations.incoming, this.extraIn.get(id) ?? []),
    };
  }

  /** How many related nodes the node `id` has, both ways (its degree in the model). */
  degree(id: string): number {
    const relations = this.relations.of(id);
    return (
      relations.outgoing.length +
      relations.incoming.length +
      (this.extraOut.get(id)?.length ?? 0) +
      (this.extraIn.get(id)?.length ?? 0)
    );
  }

  private groups(direction: Direction, indexed: readonly Relation[], extra: readonly Link[]): DetailGroup[] {
    const byKind = new Map<string, DetailItem[]>();
    const add = (kind: string, other: string, relation: string | null): void => {
      const target = this.nodes.get(other);
      const item: DetailItem = {
        id: other,
        label: target?.label ?? other,
        kind: target?.kind ?? "missing",
        missing: !target || target.kind === "missing",
        ...(kind === "chains" && relation ? { note: shortId(relation) } : {}),
      };
      const list = byKind.get(kind);
      if (list) list.push(item);
      else byKind.set(kind, [item]);
    };
    for (const relation of indexed) add(relation.kind, relation.other, relation.relation);
    for (const link of extra) add(link.kind, link.other, link.relation);
    const kinds = [
      ...GRAPH_RELATION_ORDER.filter((kind) => byKind.has(kind)),
      ...[...byKind.keys()]
        .filter((kind) => !(GRAPH_RELATION_ORDER as readonly string[]).includes(kind))
        .sort(),
    ];
    return kinds.map((kind) => {
      const items = [...(byKind.get(kind) ?? [])].sort(
        (a, b) =>
          Number(a.missing) - Number(b.missing) || a.label.localeCompare(b.label) || (a.id < b.id ? -1 : 1),
      );
      return {
        kind,
        direction,
        header: graphRelationLabel(kind, direction, items.length),
        icon: wordsOf(kind).icon,
        items,
      };
    });
  }
}

/** Every node id a node's details link to, in the order the pane lists them. */
export function detailTargets(details: NodeDetails): string[] {
  return [...details.outgoing, ...details.incoming].flatMap((group) => group.items.map((item) => item.id));
}
