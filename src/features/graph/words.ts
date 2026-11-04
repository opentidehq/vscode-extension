// The words, arrows and icons of the graph's edges and nodes: the catalogue's relations from
// src/core/catalog/relations.ts (the same in every surface), plus the two edges only the graph draws
// (threat → actor, rule → platform), and each node kind's codicon and theme colour, from
// src/core/catalog/objectIcons.ts. vscode-free and DOM-free: the webview imports it.
import { OBJECT_ICONS, type ObjectIcon } from "../../core/catalog/objectIcons";
import {
  ARROW,
  type Direction,
  MISSING_ICON,
  RELATION_ORDER,
  RELATION_WORDS,
  type RelationKind,
  type RelationWords,
  relationWords,
} from "../../core/catalog/relations";
import type { NodeKind } from "./model";

/** The graph's relation kinds: the catalogue's, and the two the graph adds. */
export type GraphRelationKind = RelationKind | "actor" | "platform";

/** Edges only the graph draws, read from their source (a threat, a rule) and from their target. */
export const GRAPH_ONLY_WORDS: Readonly<Record<"actor" | "platform", RelationWords>> = {
  actor: { out: "Attributed to", in: "Named by", icon: "person" },
  platform: { out: "On platform", in: "Platform of", icon: "server-environment" },
};

/** Every graph relation kind, strongest link first (the catalogue's order, then the graph's own). */
export const GRAPH_RELATION_ORDER: readonly GraphRelationKind[] = [...RELATION_ORDER, "actor", "platform"];

const KNOWN = new Set<string>(GRAPH_RELATION_ORDER);

export function isGraphRelationKind(kind: string): kind is GraphRelationKind {
  return KNOWN.has(kind);
}

/** The words of an edge kind; an unknown kind (a newer opentide's) reads as itself. */
export function wordsOf(kind: string): RelationWords {
  if (kind === "actor" || kind === "platform") return GRAPH_ONLY_WORDS[kind];
  if (isGraphRelationKind(kind)) return RELATION_WORDS[kind as RelationKind];
  return { out: kind, in: `${kind} (from)`, icon: "arrow-right" };
}

/**
 * `relationWords` for every graph relation kind: a chain's words come from its relation ("Precedes",
 * "← Preceded by"), the graph's own kinds from GRAPH_ONLY_WORDS.
 */
export function graphRelationWords(kind: string, direction: Direction, relation?: string | null): string {
  if (isGraphRelationKind(kind) && kind !== "actor" && kind !== "platform")
    return relationWords(kind, direction, relation);
  return wordsOf(kind)[direction];
}

/**
 * `relationLabel` for every graph relation kind: "Implements →", "← Implemented by 3", "Precedes 1 →".
 * The arrow sits on the side the other object is read from.
 */
export function graphRelationLabel(
  kind: string,
  direction: Direction,
  count?: number,
  relation?: string | null,
): string {
  const words = graphRelationWords(kind, direction, relation);
  const counted = count === undefined ? words : `${words} ${count}`;
  return direction === "out" ? `${counted} ${ARROW.out}` : `${ARROW.in} ${counted}`;
}

/** The icon and colour of a node kind: the sidebar's, for objects; the graph's own for the rest. */
export const NODE_ICONS: Readonly<Record<NodeKind, ObjectIcon>> = {
  ...OBJECT_ICONS,
  actor: { codicon: "person", themeColor: "charts.yellow" },
  platform: { codicon: "server-environment", themeColor: "descriptionForeground" },
  missing: { codicon: MISSING_ICON, themeColor: "errorForeground" },
};

/** The CSS variable of a theme colour id: `charts.red` → `--vscode-charts-red`. */
export function themeVar(themeColor: string): string {
  return `--vscode-${themeColor.replaceAll(".", "-")}`;
}
