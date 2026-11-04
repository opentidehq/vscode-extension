// The one vocabulary for relations between catalogue objects: which way they point, the words and the
// icon every surface (tree views, graph, hovers, tooltips, CodeLens) uses for them, and an index that
// answers "what does this object point to, and what points to it" in O(1) per object. vscode-free.
import type { CatalogDocument } from "./types";

/**
 * A relation kind. The catalogue's edge kinds, plus `signal` (an objective owns a signal: from
 * `signals[].objective`, not an edge).
 */
export type RelationKind =
  | "implements"
  | "covers"
  | "signal"
  | "parent"
  | "chains"
  | "technique"
  | "logsource";

/** `out`: from this object to another. `in`: from another object to this one. */
export type Direction = "out" | "in";

export interface RelationWords {
  /** Read from the source: "Implements". */
  readonly out: string;
  /** Read from the target: "Implemented by". */
  readonly in: string;
  /** A codicon id, without `$( )`. */
  readonly icon: string;
}

/** The words and icon of each kind, the same in every surface. */
export const RELATION_WORDS: Readonly<Record<RelationKind, RelationWords>> = {
  implements: { out: "Implements", in: "Implemented by", icon: "symbol-interface" },
  covers: { out: "Covers", in: "Covered by", icon: "shield" },
  signal: { out: "Has signal", in: "Signal of", icon: "pulse" },
  parent: { out: "Child of", in: "Parent of", icon: "type-hierarchy-sub" },
  chains: { out: "Chains to", in: "Chained from", icon: "arrow-swap" },
  // The index lists techniques and log sources from the object's side only, so their `in` words are
  // reserved for a surface that lists a technique's or log source's objects.
  technique: { out: "Technique", in: "Used by", icon: "target" },
  logsource: { out: "Uses log source", in: "Read by", icon: "database" },
};

/**
 * The words of each threat chaining relation (opentide's chaining_relations vocabulary, the name after
 * `stage::`), read from the threat that holds the reference (`out`) and from the threat it names (`in`).
 * "A preceeds B" means B happens after A: A "Precedes →" B, B "← Preceded by" A.
 */
export const CHAIN_WORDS: Readonly<Record<string, Pick<RelationWords, "out" | "in">>> = {
  preceeds: { out: "Precedes", in: "Preceded by" },
  succeeds: { out: "Succeeds", in: "Succeeded by" },
  implemented: { out: "Implemented by", in: "Implements" },
  implements: { out: "Implements", in: "Implemented by" },
  enabled: { out: "Enables", in: "Enabled by" },
  enabling: { out: "Enabled by", in: "Enables" },
  synergize: { out: "Synergizes with", in: "Synergizes with" },
};

/** The words of a relation in `direction`: a chain's own relation when it is known, else its kind's. */
export function relationWords(kind: RelationKind, direction: Direction, relation?: string | null): string {
  if (kind === "chains" && relation) {
    const name = relation.slice(relation.lastIndexOf(":") + 1).toLowerCase();
    const words = CHAIN_WORDS[name];
    if (words) return words[direction];
  }
  return RELATION_WORDS[kind][direction];
}

/** The order kinds are listed in, strongest link first. */
export const RELATION_ORDER: readonly RelationKind[] = [
  "implements",
  "covers",
  "signal",
  "parent",
  "chains",
  "technique",
  "logsource",
];

export const ARROW: Readonly<Record<Direction, string>> = { out: "→", in: "←" };

/** The icon of a missing (dangling) reference, in every surface. */
export const MISSING_ICON = "warning";

/**
 * The label of a relation group or row, with its arrow: "Implements →", "← Implemented by 3",
 * "Precedes →" for a chain whose `relation` is `sequence::preceeds`.
 * The arrow sits on the side the other object is read from, so a column of mixed labels stays scannable.
 */
export function relationLabel(
  kind: RelationKind,
  direction: Direction,
  count?: number,
  relation?: string | null,
): string {
  const words = relationWords(kind, direction, relation);
  const counted = count === undefined ? words : `${words} ${count}`;
  return direction === "out" ? `${counted} ${ARROW.out}` : `${ARROW.in} ${counted}`;
}

/** What the far end of a relation is. */
export type EndKind = "object" | "signal" | "technique" | "logsource";

export interface Relation {
  readonly kind: RelationKind;
  readonly direction: Direction;
  /** The other end: an object or signal UUID, an ATT&CK technique id, or a log source name. */
  readonly other: string;
  readonly otherKind: EndKind;
  /** The field that holds the reference, on the source object (`detection_model`, ...); "" for signals. */
  readonly fieldPath: string;
  /** `chains` only: the chaining relation (`sequence::preceeds`). */
  readonly relation: string | null;
  /** The reference names no object (`missing` on the edge). */
  readonly missing: boolean;
}

export interface Relations {
  readonly outgoing: readonly Relation[];
  readonly incoming: readonly Relation[];
}

const EMPTY: Relations = { outgoing: [], incoming: [] };

const KNOWN = new Set<string>(RELATION_ORDER);

function isKind(kind: string): kind is RelationKind {
  return KNOWN.has(kind);
}

const key = (id: string): string => id.toLowerCase();

/** What `id`, at the far end of an edge of `kind`, is. */
function endKind(kind: string, id: string, signals: ReadonlySet<string>): EndKind {
  if (kind === "technique") return "technique";
  if (kind === "logsource") return "logsource";
  return signals.has(key(id)) ? "signal" : "object";
}

const identity = (r: Relation): string =>
  `${r.kind}\u0000${key(r.other)}\u0000${r.fieldPath}\u0000${r.relation ?? ""}`;

function byKind(a: Relation, b: Relation): number {
  return (
    RELATION_ORDER.indexOf(a.kind) - RELATION_ORDER.indexOf(b.kind) ||
    Number(a.missing) - Number(b.missing) ||
    a.other.localeCompare(b.other)
  );
}

/** Every object's and signal's relations, both ways, built once per catalogue. */
export class RelationIndex {
  private readonly byId = new Map<string, { outgoing: Relation[]; incoming: Relation[] }>();

  constructor(catalog: Pick<CatalogDocument, "edges" | "signals">) {
    const signals = new Set(catalog.signals.map((signal) => key(signal.uuid)));
    const seen = new Set<string>();
    const add = (id: string, relation: Relation) => {
      const k = key(id);
      // The same reference twice (a field listing an id twice) is one relation.
      const unique = `${k}\u0000${relation.direction}\u0000${identity(relation)}`;
      if (seen.has(unique)) return;
      seen.add(unique);
      let entry = this.byId.get(k);
      if (!entry) {
        entry = { outgoing: [], incoming: [] };
        this.byId.set(k, entry);
      }
      (relation.direction === "out" ? entry.outgoing : entry.incoming).push(relation);
    };
    for (const edge of catalog.edges) {
      if (!isKind(edge.kind)) continue;
      const base = { kind: edge.kind, fieldPath: edge.field_path, relation: edge.relation ?? null };
      const target = endKind(edge.kind, edge.to, signals);
      add(edge.from, { ...base, direction: "out", other: edge.to, otherKind: target, missing: edge.missing });
      // Techniques and log sources are listed from the object's side only; a dangling target has no
      // object to list the reference on.
      if ((target === "object" || target === "signal") && !edge.missing) {
        add(edge.to, {
          ...base,
          direction: "in",
          other: edge.from,
          otherKind: endKind(edge.kind, edge.from, signals),
          missing: false,
        });
      }
    }
    for (const signal of catalog.signals) {
      if (!signal.objective) continue;
      const base = { kind: "signal" as const, fieldPath: "", relation: null, missing: false };
      add(signal.objective, { ...base, direction: "out", other: signal.uuid, otherKind: "signal" });
      add(signal.uuid, { ...base, direction: "in", other: signal.objective, otherKind: "object" });
    }
    for (const entry of this.byId.values()) {
      entry.outgoing.sort(byKind);
      entry.incoming.sort(byKind);
    }
  }

  /** The relations of the object or signal `id` (compared without case). */
  of(id: string): Relations {
    return this.byId.get(key(id)) ?? EMPTY;
  }

  /** How many relations of each kind `id` has in `direction`, in RELATION_ORDER. */
  counts(id: string, direction: Direction): { kind: RelationKind; count: number }[] {
    const list = direction === "out" ? this.of(id).outgoing : this.of(id).incoming;
    return RELATION_ORDER.map((kind) => ({
      kind,
      count: list.filter((r) => r.kind === kind).length,
    })).filter((c) => c.count > 0);
  }
}

/** `relations` grouped by kind, in RELATION_ORDER, empty groups left out. */
export function groupByKind(relations: readonly Relation[]): { kind: RelationKind; relations: Relation[] }[] {
  const groups = new Map<RelationKind, Relation[]>();
  for (const relation of relations) {
    const list = groups.get(relation.kind) ?? [];
    list.push(relation);
    groups.set(relation.kind, list);
  }
  return RELATION_ORDER.filter((kind) => groups.has(kind)).map((kind) => ({
    kind,
    relations: groups.get(kind) ?? [],
  }));
}
