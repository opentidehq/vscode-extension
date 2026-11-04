// The host side of the graph, without vscode: what the webview is told for a catalogue state, which
// object a file holds, and problem counts per node. Unit-tested in plain node.
import type { CatalogState } from "../../core/catalog/store";
import type { CatalogDocument } from "../../core/catalog/types";
import { buildModel, type GraphModel, type NodeProblems, objectNodeId } from "./model";
import type { ExportFormat, GraphData } from "./protocol";
import type { GraphMode } from "./view";

/** Builds a model once per catalogue document. */
export class ModelCache {
  private document: CatalogDocument | undefined;
  private model: GraphModel | undefined;

  get(document: CatalogDocument): GraphModel {
    if (this.document !== document || !this.model) {
      this.document = document;
      this.model = buildModel(document);
    }
    return this.model;
  }
}

export function graphData(state: CatalogState, folder: string, cache: ModelCache): GraphData {
  const refreshing = state.refreshing;
  if (state.catalog) {
    return {
      status: "ready",
      folder,
      model: cache.get(state.catalog),
      refreshing,
      // A failed refresh keeps the last good catalogue; say so.
      ...(state.status === "error" && state.error
        ? { message: `Showing the last catalogue: ${state.error}` }
        : {}),
    };
  }
  switch (state.status) {
    case "empty":
    case "loading":
      return { status: "loading", folder, refreshing: true };
    case "unavailable": {
      const reason = state.unavailable?.reason;
      const needsCommand = reason === "needs-command";
      return {
        status: "unavailable",
        folder,
        refreshing,
        ...(reason ? { reason } : {}),
        ...(needsCommand ? { needs: state.unavailable?.command ?? "info catalog" } : {}),
        message: needsCommand
          ? `The graph needs a newer opentide: one with \`${state.unavailable?.command ?? "info catalog"}\`. Names alone (workspace symbols) have no links to draw.`
          : (state.unavailable?.message ?? "The catalogue is unavailable."),
      };
    }
    case "error":
      return {
        status: "error",
        folder,
        refreshing,
        message: `The catalogue failed to load: ${state.error ?? "unknown error"}`,
      };
    default:
      return { status: "loading", folder, refreshing };
  }
}

/** Compare file paths as the platform does (case-insensitive on Windows and macOS defaults aside). */
export function pathKey(file: string, platform: NodeJS.Platform): string {
  const normal = file.replaceAll("\\", "/");
  return platform === "win32" ? normal.toLowerCase() : normal;
}

/** Node id of the object a file defines, if the catalogue has it. */
export function objectAtPath(
  catalog: CatalogDocument,
  file: string,
  platform: NodeJS.Platform,
): string | undefined {
  const key = pathKey(file, platform);
  const object = catalog.objects.find((o) => pathKey(o.file_path, platform) === key);
  return object ? objectNodeId(object) : undefined;
}

/** Whether `file` is in the folder `root` (not merely a path that starts with it, like `/repo-2`). */
export function inFolder(root: string, file: string, platform: NodeJS.Platform): boolean {
  const base = pathKey(root, platform).replace(/\/+$/, "");
  return pathKey(file, platform).startsWith(`${base}/`);
}

/**
 * What the graph's problem map is for the folder shown: its map, or an empty one while its catalogue
 * loads, so a switched-to folder never shows the previous folder's problems.
 */
export function problemsFor(
  catalog: CatalogDocument | undefined,
  files: readonly FileProblems[],
  platform: NodeJS.Platform,
): Record<string, NodeProblems> {
  return catalog ? problemMap(catalog, files, platform) : {};
}

export interface FileProblems {
  readonly file: string;
  readonly errors: number;
  readonly warnings: number;
}

/** Problem counts per node id, from the Problems panel's counts per file. */
export function problemMap(
  catalog: CatalogDocument,
  files: readonly FileProblems[],
  platform: NodeJS.Platform,
): Record<string, NodeProblems> {
  const byPath = new Map<string, string>();
  for (const object of catalog.objects) byPath.set(pathKey(object.file_path, platform), objectNodeId(object));
  const map: Record<string, NodeProblems> = {};
  for (const file of files) {
    const id = byPath.get(pathKey(file.file, platform));
    if (!id || file.errors + file.warnings === 0) continue;
    const known = map[id];
    map[id] = {
      errors: (known?.errors ?? 0) + file.errors,
      warnings: (known?.warnings ?? 0) + file.warnings,
    };
  }
  return map;
}

/** The folder of the catalogue that has this UUID (a reveal from another view). */
export function folderWithNode(states: readonly CatalogState[], id: string): string | undefined {
  return states.find(
    (state) =>
      state.catalog?.objects.some((o) => objectNodeId(o) === id) ||
      state.catalog?.signals?.some((s) => s.uuid === id),
  )?.folder;
}

export const EXPORT_FILTERS: Readonly<Record<ExportFormat, { name: string; extension: string }>> = {
  svg: { name: "SVG image", extension: "svg" },
  png: { name: "PNG image", extension: "png" },
  mermaid: { name: "Mermaid diagram", extension: "mmd" },
};

/** The bytes a webview export becomes on disk. */
export function exportBytes(format: ExportFormat, data: string): Uint8Array {
  if (format === "png") {
    const base64 = data.replace(/^data:image\/png;base64,/, "");
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  return new TextEncoder().encode(data);
}

// Command arguments, as other views pass them.

export interface GraphOpenArgs {
  /** Node ids (UUIDs) to focus on. */
  readonly uuids?: readonly string[];
  /** The workspace folder path; default: the active editor's, else ask. */
  readonly folder?: string;
  readonly mode?: GraphMode;
}

const MODES: readonly string[] = ["focus", "catalogue", "chains"];

/** `opentide.graph.open` arguments: `{uuids?, folder?, mode?}`; anything else is ignored. */
export function parseOpenArgs(value: unknown): GraphOpenArgs {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as { uuids?: unknown; folder?: unknown; mode?: unknown };
  return {
    ...(Array.isArray(raw.uuids)
      ? { uuids: raw.uuids.filter((id): id is string => typeof id === "string") }
      : {}),
    ...(typeof raw.folder === "string" ? { folder: raw.folder } : {}),
    ...(typeof raw.mode === "string" && MODES.includes(raw.mode) ? { mode: raw.mode as GraphMode } : {}),
  };
}

/** `opentide.graph.reveal` takes `{uuid}` (the sidebar) or a bare UUID string. */
export function parseRevealArgs(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const uuid = (value as { uuid?: unknown }).uuid;
  return typeof uuid === "string" && uuid ? uuid : undefined;
}

/** Sends a value only when it differs from the last one sent (the graph's problem map, per webview). */
export class ChangedOnly {
  private last: string | undefined;

  /** Whether `value` differs from the last value seen; remembers it. */
  changed(value: unknown): boolean {
    const next = JSON.stringify(value);
    if (next === this.last) return false;
    this.last = next;
    return true;
  }

  /** Forget the last value: a new webview or folder needs the next one whatever it is. */
  reset(): void {
    this.last = undefined;
  }
}
