// The language server's `opentide/catalog` index (language-server docs/EDITORS.md, CONTRACTS.md), and
// what it says about relations: each object's reference fields become the catalogue's edges. Incoming
// references are the outgoing ones of every other object of the root, inverted. vscode-free and free of
// Node built-ins: the desktop core (src/core/catalog/serverCatalog.ts) and the web extension share it.
import type { CatalogEdge, CatalogSignal } from "../core/catalog/types";

/** The request and its notification. */
export const SERVER_CATALOG = "opentide/catalog";
export const SERVER_CATALOG_CHANGED = "opentide/catalogChanged";

export interface ServerRange {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}

export interface ServerRef {
  readonly uuid: string;
  /** Keys and list indexes joined with `.`: `detection_model`, `objective.threats.0`. */
  readonly field_path: string;
  readonly range: ServerRange;
}

export interface ServerObject {
  readonly uuid: string;
  /** The schema family: `rule`, `objective`, `threat`. */
  readonly object_type: string;
  readonly schema: string;
  readonly name: string;
  readonly uri: string;
  /** The `name` value's range (UTF-16, 0-based). */
  readonly range: ServerRange;
  readonly refs: readonly ServerRef[];
}

export interface ServerRoot {
  /** The root's URI; null for the documents outside every root. */
  readonly root: string | null;
  readonly objects: readonly ServerObject[];
}

export interface ServerCatalog {
  readonly roots: readonly ServerRoot[];
}

/** A signal as the index knows it: its UUID's line in its objective's file, no name. */
export interface ServerSignal extends CatalogSignal {
  /** 0-based line of the signal's `uuid:` in its objective. */
  readonly line: number;
}

/** The edges and signals of one root, in the catalogue's shape. */
export interface ServerRelations {
  readonly edges: CatalogEdge[];
  readonly signals: ServerSignal[];
}

function isRange(value: unknown): value is ServerRange {
  const range = value as ServerRange | null;
  return (
    typeof range === "object" &&
    range !== null &&
    typeof range.start?.line === "number" &&
    typeof range.end?.line === "number"
  );
}

function isObject(value: unknown): value is ServerObject {
  const object = value as ServerObject | null;
  return (
    typeof object === "object" &&
    object !== null &&
    typeof object.uuid === "string" &&
    typeof object.object_type === "string" &&
    typeof object.name === "string" &&
    typeof object.uri === "string" &&
    isRange(object.range) &&
    Array.isArray(object.refs)
  );
}

/** The response, keeping only what has the documented shape; undefined when it is not a catalog. */
export function parseServerCatalog(value: unknown): ServerCatalog | undefined {
  const roots = (value as { roots?: unknown } | null)?.roots;
  if (!Array.isArray(roots)) return undefined;
  return {
    roots: roots
      .filter((root): root is ServerRoot => typeof root === "object" && root !== null)
      .map((root) => ({
        root: typeof root.root === "string" ? root.root : null,
        objects: (Array.isArray(root.objects) ? root.objects : []).filter(isObject).map((object) => ({
          ...object,
          refs: object.refs.filter(
            (ref): ref is ServerRef =>
              typeof ref?.uuid === "string" && typeof ref.field_path === "string" && isRange(ref.range),
          ),
        })),
      })),
  };
}

const SIGNAL_UUID = /^objective\.signals\.(\d+)\.uuid$/;
const SIGNAL_PARENT = /^objective\.signals\.(\d+)\.parent$/;
const THREAT = /^objective\.threats\.\d+$/;
const CHAINING = /^threat\.chaining\.\d+\.vector$/;

/**
 * The edges and signals of `objects` (one root). A ref names an edge by its field: `detection_model`
 * implements, `objective.threats.<i>` covers, `threat.chaining.<i>.vector` chains (the relation is not
 * in the index), a signal's `parent` is its parent; `objective.signals.<i>.uuid` is the objective's own
 * signal. A ref no object or signal of the root carries is missing.
 */
export function serverRelations(objects: readonly ServerObject[]): ServerRelations {
  const signals: ServerSignal[] = [];
  const signalAt = new Map<string, string>();
  for (const object of objects) {
    for (const ref of object.refs) {
      const match = SIGNAL_UUID.exec(ref.field_path);
      if (!match) continue;
      signalAt.set(`${object.uuid}|${match[1]}`, ref.uuid);
      signals.push({
        uuid: ref.uuid,
        name: `Signal ${Number(match[1]) + 1}`,
        objective: object.uuid,
        parent: null,
        line: ref.range.start.line,
      });
    }
  }
  const known = new Set([...objects.map((o) => o.uuid), ...signals.map((s) => s.uuid)].map(lower));
  const parents = new Map<string, string>();
  const edges: CatalogEdge[] = [];
  const push = (from: string, ref: ServerRef, kind: string) =>
    edges.push({
      from,
      to: ref.uuid,
      kind,
      field_path: fieldOf(ref.field_path),
      relation: null,
      missing: !known.has(lower(ref.uuid)),
    });
  for (const object of objects) {
    for (const ref of object.refs) {
      if (ref.field_path === "detection_model") push(object.uuid, ref, "implements");
      else if (THREAT.test(ref.field_path)) push(object.uuid, ref, "covers");
      else if (CHAINING.test(ref.field_path)) push(object.uuid, ref, "chains");
      else {
        const parent = SIGNAL_PARENT.exec(ref.field_path);
        const child = parent ? signalAt.get(`${object.uuid}|${parent[1]}`) : undefined;
        if (!child) continue;
        push(child, ref, "parent");
        parents.set(child, ref.uuid);
      }
    }
  }
  return {
    edges,
    signals: signals.map((signal) => ({ ...signal, parent: parents.get(signal.uuid) ?? null })),
  };
}

/**
 * The field a list entry's ref is in, as `info catalog` names it: `objective.threats.1` and
 * `threat.chaining.0.vector` are `objective.threats` and `threat.chaining`, so the same reference listed
 * twice is one relation (RelationIndex keys on the field).
 */
export function fieldOf(fieldPath: string): string {
  if (CHAINING.test(fieldPath)) return "threat.chaining";
  return fieldPath.replace(/\.\d+$/, "");
}

function lower(value: string): string {
  return value.toLowerCase();
}

/** Whether an error is JSON-RPC's MethodNotFound (-32601): a server without the request. */
export function isMethodNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === -32601;
}
