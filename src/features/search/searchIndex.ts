// The in-memory search index (SPEC §10.3): one item per object and signal of each folder's `info
// catalog`, or per workspace symbol when the active opentide has no catalogue. Built once per
// catalogue document, with every key lower-cased up front so a keystroke only compares. vscode-free.
import { isLoaded, rowKey } from "../../core/catalog/rows";
import type { CatalogState } from "../../core/catalog/store";
import type { CatalogDocument, CatalogSymbol } from "../../core/catalog/types";

export type ItemSource = "catalog" | "symbols";

export interface ItemPlatform {
  readonly id: string;
  readonly status: string;
  readonly enabled: boolean;
}

export interface SearchItem {
  /** The graph's node id: a loaded object's UUID, or `file:<path>` for a file that did not load. */
  readonly id: string;
  /** A loaded object's or a signal's UUID (a file that did not load has none here). */
  readonly uuid?: string;
  readonly type: string;
  readonly name: string;
  /** The workspace folder (absolute). */
  readonly folder: string;
  /** Workspace-relative path, forward slashes. */
  readonly path: string;
  /** A symbol's URI (catalogue items have `filePath`). */
  readonly uri?: string;
  /** An absolute path. */
  readonly filePath?: string;
  /** 1-based. */
  readonly line: number;
  /** 0-based UTF-16 column, from a symbol. */
  readonly character?: number;
  readonly platforms: readonly ItemPlatform[];
  readonly techniques: readonly string[];
  readonly tactics: readonly string[];
  readonly actors: readonly string[];
  readonly author?: string;
  readonly tlp?: string;
  readonly created?: string;
  readonly modified?: string;
  readonly reviewed?: string;
  readonly deployed: boolean;
  readonly loadError?: string;
  readonly source: ItemSource;
  /** Lower-cased keys for matching. */
  readonly keys: {
    readonly name: string;
    readonly uuid: string;
    readonly path: string;
    /** Each technique, and each sub-technique's parent (`t1003.001` also gives `t1003`). */
    readonly techniques: ReadonlySet<string>;
    /** Shortnames, ids (`ta0006`) and hyphenated names of the tactics. */
    readonly tactics: readonly string[];
    readonly actors: readonly string[];
    readonly author: string;
    readonly tlp: string;
  };
}

export interface SearchIndex {
  readonly items: readonly SearchItem[];
  /** Every item comes from workspace symbols: only names, types and paths can match. */
  readonly symbolsOnly: boolean;
  /** Folders whose catalogue is still loading. */
  readonly loading: readonly string[];
  /** Why some folders have no catalogue, by folder. */
  readonly unavailable: ReadonlyMap<string, string>;
}

const lower = (value: string | null | undefined): string => (value ?? "").toLowerCase();

function techniqueKeys(techniques: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const technique of techniques) {
    const key = technique.toLowerCase();
    keys.add(key);
    const dot = key.indexOf(".");
    if (dot > 0) keys.add(key.slice(0, dot));
  }
  return keys;
}

function tacticKeys(catalog: CatalogDocument, tactics: readonly string[]): string[] {
  const keys: string[] = [];
  for (const shortname of tactics) {
    keys.push(shortname.toLowerCase());
    const tactic = catalog.attack?.tactics?.find((t) => t.shortname === shortname);
    if (tactic) keys.push(lower(tactic.id), tactic.name.toLowerCase().replace(/\s+/g, "-"));
  }
  return keys;
}

function catalogItems(folder: string, catalog: CatalogDocument): SearchItem[] {
  const items: SearchItem[] = [];
  const byUuid = new Map<string, SearchItem>();
  for (const object of catalog.objects) {
    const techniques = [
      ...new Set([...(object.techniques?.own ?? []), ...(object.techniques?.inherited ?? [])]),
    ];
    const loaded = isLoaded(object);
    const id = rowKey(object);
    const item: SearchItem = {
      id,
      ...(loaded ? { uuid: object.uuid } : {}),
      type: object.type ?? "rule",
      name: object.name || object.path || object.file_path || id,
      folder,
      path: object.path ?? "",
      ...(object.file_path ? { filePath: object.file_path } : {}),
      line: object.line || 1,
      platforms: (object.platforms ?? []).map((p) => ({
        id: p.id,
        status: p.status ?? "",
        enabled: p.enabled,
      })),
      techniques,
      tactics: object.tactics ?? [],
      actors: object.actors ?? [],
      ...(object.author ? { author: object.author } : {}),
      ...(object.tlp ? { tlp: object.tlp } : {}),
      ...(object.created ? { created: object.created } : {}),
      ...(object.modified ? { modified: object.modified } : {}),
      ...(object.reviewed ? { reviewed: object.reviewed } : {}),
      deployed: (object.deployment ?? []).some((d) => d.deployed),
      ...(object.load_error ? { loadError: object.load_error.message } : {}),
      source: "catalog",
      keys: {
        name: lower(object.name),
        uuid: lower(object.uuid),
        path: lower(object.path),
        techniques: techniqueKeys(techniques),
        tactics: tacticKeys(catalog, object.tactics ?? []),
        actors: (object.actors ?? []).map((actor) => actor.toLowerCase()),
        author: lower(object.author),
        tlp: lower(object.tlp),
      },
    };
    items.push(item);
    if (loaded) byUuid.set(object.uuid, item);
  }
  for (const signal of catalog.signals ?? []) {
    const objective = signal.objective ? byUuid.get(signal.objective) : undefined;
    items.push({
      id: signal.uuid,
      uuid: signal.uuid,
      type: "signal",
      name: signal.name,
      folder,
      path: objective?.path ?? "",
      ...(objective?.filePath ? { filePath: objective.filePath } : {}),
      line: objective?.line ?? 1,
      platforms: [],
      techniques: objective?.techniques ?? [],
      tactics: objective?.tactics ?? [],
      actors: objective?.actors ?? [],
      ...(objective?.author ? { author: objective.author } : {}),
      ...(objective?.tlp ? { tlp: objective.tlp } : {}),
      deployed: false,
      source: "catalog",
      keys: {
        name: signal.name.toLowerCase(),
        uuid: signal.uuid.toLowerCase(),
        path: objective?.keys.path ?? "",
        techniques: objective?.keys.techniques ?? new Set(),
        tactics: objective?.keys.tactics ?? [],
        actors: objective?.keys.actors ?? [],
        author: objective?.keys.author ?? "",
        tlp: objective?.keys.tlp ?? "",
      },
    });
  }
  return items;
}

/** The workspace-relative path of a `file:` URI under a folder (POSIX paths; the glue passes VS Code's). */
export function relativePath(folder: string, uri: string): string {
  const root = `file://${encodeURI(folder.replaceAll("\\", "/"))}`.replace(/\/$/, "");
  if (!uri.startsWith(`${root}/`)) return uri;
  try {
    return decodeURIComponent(uri.slice(root.length + 1));
  } catch {
    return uri.slice(root.length + 1);
  }
}

export type Relative = (folder: string, uri: string) => string;

function symbolItems(folder: string, symbols: readonly CatalogSymbol[], relative: Relative): SearchItem[] {
  return symbols.map((symbol) => {
    const path = relative(folder, symbol.uri);
    const type = symbol.family.toLowerCase() || "object";
    return {
      id: `symbol:${symbol.uri}#${symbol.line}`,
      type,
      name: symbol.name,
      folder,
      path,
      uri: symbol.uri,
      line: symbol.line + 1,
      character: symbol.character,
      platforms: [],
      techniques: [],
      tactics: [],
      actors: [],
      deployed: false,
      source: "symbols" as const,
      keys: {
        name: symbol.name.toLowerCase(),
        uuid: "",
        path: path.toLowerCase(),
        techniques: new Set<string>(),
        tactics: [],
        actors: [],
        author: "",
        tlp: "",
      },
    };
  });
}

/** Builds each folder's items once per catalogue document (or symbol list). */
export class IndexCache {
  private readonly perFolder = new Map<string, { source: unknown; items: SearchItem[] }>();

  constructor(private readonly relative: Relative = relativePath) {}

  build(states: readonly CatalogState[]): SearchIndex {
    const items: SearchItem[] = [];
    const loading: string[] = [];
    const unavailable = new Map<string, string>();
    let catalogs = 0;
    for (const state of states) {
      const source = state.catalog ?? state.symbols;
      if (state.status === "loading" || (state.status === "empty" && !source)) loading.push(state.folder);
      if (state.status === "unavailable" && state.unavailable)
        unavailable.set(state.folder, state.unavailable.message);
      if (!source) continue;
      if (state.catalog) catalogs += 1;
      let entry = this.perFolder.get(state.folder);
      if (!entry || entry.source !== source) {
        entry = {
          source,
          items: state.catalog
            ? catalogItems(state.folder, state.catalog)
            : symbolItems(state.folder, state.symbols ?? [], this.relative),
        };
        this.perFolder.set(state.folder, entry);
      }
      items.push(...entry.items);
    }
    return { items, symbolsOnly: catalogs === 0 && items.length > 0, loading, unavailable };
  }
}

export function buildIndex(states: readonly CatalogState[]): SearchIndex {
  return new IndexCache().build(states);
}
