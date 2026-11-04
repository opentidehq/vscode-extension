// The language-model tools (SPEC §12), for live editor state only: a file's diagnostics, and the active
// object with its graph neighbourhood. Catalogue, validation and deployment stay on MCP. vscode-free.
import { isLoaded, loadedObjects } from "../../core/catalog/rows";
import type { CatalogDocument, CatalogObject } from "../../core/catalog/types";

export const DIAGNOSTICS_TOOL = "opentide_open_file_diagnostics";
export const ACTIVE_OBJECT_TOOL = "opentide_active_object";

/** What index.ts reads from a vscode.Diagnostic (0-based positions, VS Code's severity numbers). */
export interface PlainDiagnostic {
  readonly message: string;
  /** 0 error, 1 warning, 2 information, 3 hint. */
  readonly severity: number;
  readonly source?: string;
  readonly code?: string | number | { readonly value: string | number };
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

const SEVERITIES = ["error", "warning", "information", "hint"] as const;

export interface DiagnosticsPayload {
  readonly file: string;
  readonly counts: Readonly<Record<(typeof SEVERITIES)[number], number>>;
  readonly diagnostics: readonly {
    readonly severity: (typeof SEVERITIES)[number];
    readonly source: string | null;
    readonly code: string | null;
    readonly message: string;
    /** 1-based; columns count UTF-16 code units, as the editor does. */
    readonly line: number;
    readonly column: number;
    readonly end_line: number;
    readonly end_column: number;
  }[];
}

/** Every collection's diagnostics of a file, most severe first, then by position. */
export function diagnosticsPayload(
  file: string,
  diagnostics: readonly PlainDiagnostic[],
): DiagnosticsPayload {
  const counts = { error: 0, warning: 0, information: 0, hint: 0 };
  const rows = [...diagnostics]
    .sort(
      (a, b) =>
        a.severity - b.severity ||
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    )
    .map((d) => {
      const severity = SEVERITIES[d.severity] ?? "error";
      counts[severity]++;
      const code =
        d.code === undefined ? null : typeof d.code === "object" ? String(d.code.value) : String(d.code);
      return {
        severity,
        source: d.source ?? null,
        code,
        message: d.message,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        end_line: d.range.end.line + 1,
        end_column: d.range.end.character + 1,
      };
    });
  return { file, counts, diagnostics: rows };
}

export interface Neighbour {
  readonly direction: "out" | "in";
  readonly kind: string;
  readonly field_path: string;
  readonly relation: string | null;
  /** An object or signal UUID, an ATT&CK technique id, or a log source name. */
  readonly id: string;
  readonly name: string | null;
  readonly type: string | null;
  readonly missing: boolean;
}

export type ActiveObjectPayload =
  | {
      readonly file: string;
      readonly object: Pick<
        CatalogObject,
        | "uuid"
        | "type"
        | "schema"
        | "name"
        | "path"
        | "line"
        | "tlp"
        | "platforms"
        | "techniques"
        | "tactics"
        | "load_error"
      >;
      readonly neighbours: readonly Neighbour[];
    }
  | { readonly file: string | null; readonly object: null; readonly reason: string };

const samePath = (a: string, b: string, caseless: boolean): boolean => {
  const norm = (p: string) => (caseless ? p.replaceAll("\\", "/").toLowerCase() : p.replaceAll("\\", "/"));
  return norm(a) === norm(b);
};

/** The catalogue object at `file` and the edges that touch it, one hop. */
export function activeObjectPayload(
  file: string | undefined,
  catalog: CatalogDocument | undefined,
  unavailable: string | undefined,
  caseless = process.platform === "win32",
): ActiveObjectPayload {
  if (!file) return { file: null, object: null, reason: "No file is open in the editor." };
  if (!catalog) return { file, object: null, reason: unavailable ?? "The catalogue is not loaded yet." };
  const object = catalog.objects.find((o) => o.file_path !== null && samePath(o.file_path, file, caseless));
  if (!object) return { file, object: null, reason: "The active file is not an object in the catalogue." };
  // Only loaded objects name edge ends: a file that did not load has no edges, and the UUID it carries
  // may be a loaded object's (a copy that no longer parses), whose edges are not its own.
  const byUuid = new Map<string, { name: string; type: string }>();
  for (const o of loadedObjects(catalog.objects)) byUuid.set(o.uuid, { name: o.name, type: o.type });
  for (const s of catalog.signals ?? []) byUuid.set(s.uuid, { name: s.name, type: "signal" });
  const neighbours: Neighbour[] = [];
  for (const edge of isLoaded(object) ? catalog.edges : []) {
    const direction = edge.from === object.uuid ? "out" : edge.to === object.uuid ? "in" : undefined;
    if (!direction) continue;
    const id = direction === "out" ? edge.to : edge.from;
    const known = byUuid.get(id);
    neighbours.push({
      direction,
      kind: edge.kind,
      field_path: edge.field_path,
      relation: edge.relation ?? null,
      id,
      name:
        known?.name ?? (edge.kind === "technique" ? (catalog.attack?.techniques?.[id]?.name ?? null) : null),
      type:
        known?.type ??
        (edge.kind === "technique" ? "technique" : edge.kind === "logsource" ? "logsource" : null),
      missing: edge.missing === true,
    });
  }
  return {
    file,
    object: {
      uuid: object.uuid,
      type: object.type,
      schema: object.schema,
      name: object.name,
      path: object.path,
      line: object.line,
      tlp: object.tlp ?? null,
      platforms: object.platforms,
      techniques: object.techniques,
      tactics: object.tactics,
      load_error: object.load_error ?? null,
    },
    neighbours,
  };
}
