// The ATT&CK matrix (SPEC §10.2) from `info catalog`: the `attack` skeleton's tactics and techniques,
// and which objects name each technique. vscode-free.
import { type LoadedObject, loadedObjects } from "../../core/catalog/rows";
import type { CatalogDocument, CatalogObject } from "../../core/catalog/types";

export type Layer = "rules" | "planned" | "unaddressed";

export interface MatrixFilters {
  /** rules only; plus objectives without rules ("planned"); plus threats without objectives ("unaddressed"). */
  readonly layer: Layer;
  /** Only rules with a block for this platform. */
  readonly platform?: string;
  /** Leave out rules whose (filtered) blocks are all `INERT`. */
  readonly excludeInert: boolean;
  /** Only rules deployed to this tenant. */
  readonly tenant?: string;
  /** Count techniques an object inherits from its objective or threat, not only its own. */
  readonly inherited: boolean;
}

export const DEFAULT_FILTERS: MatrixFilters = { layer: "rules", excludeInert: false, inherited: true };

export interface ObjectRef {
  readonly uuid: string;
  readonly name: string;
  readonly type: string;
  readonly path: string;
  /** How it names the technique (or one of its sub-techniques): its own field, or inherited. */
  readonly via: "own" | "inherited";
  /** `platform: STATUS` of each block, for rules. */
  readonly statuses: readonly string[];
}

export interface Cell {
  readonly id: string;
  readonly name: string;
  /** Rules naming the technique, or a sub-technique of it (as `info coverage --technique` counts). */
  readonly rules: number;
  /** Objectives naming it that no rule implements (layer `planned` and up). */
  readonly planned: number;
  /** Threats naming it that no objective covers (layer `unaddressed`). */
  readonly unaddressed: number;
  /** 0 = gap; 1 = one rule; 2 = 2–3; 3 = 4–9; 4 = 10 or more. */
  readonly level: 0 | 1 | 2 | 3 | 4;
  /** The first rules by name (up to TOP_RULES), for the cell's hover card. */
  readonly top: readonly string[];
  readonly subtechniques: readonly Cell[];
}

export interface Column {
  readonly id: string;
  readonly shortname: string;
  readonly name: string;
  readonly cells: readonly Cell[];
  /** Techniques in the column with at least one rule. */
  readonly covered: number;
}

export interface MatrixView {
  readonly columns: readonly Column[];
  /** Distinct techniques (parents) in the matrix, and how many have a rule. */
  readonly techniques: number;
  readonly covered: number;
  /** Techniques objects name that the Enterprise matrix does not have. */
  readonly unknown: readonly string[];
  readonly platforms: readonly string[];
  readonly tenants: readonly string[];
  readonly rules: number;
}

const norm = (id: string) => id.trim().toUpperCase();

/** `info coverage`'s rule: a technique covers itself and its sub-techniques (`T1059` ⊇ `T1059.001`). */
export function covers(requested: string, candidate: string): boolean {
  const needle = norm(requested);
  const value = norm(candidate);
  return needle !== "" && (value === needle || value.startsWith(`${needle}.`));
}

function techniquesOf(object: CatalogObject, inherited: boolean): { id: string; via: "own" | "inherited" }[] {
  const own = object.techniques.own.map((id) => ({ id: norm(id), via: "own" as const }));
  if (!inherited) return own;
  const seen = new Set(own.map((t) => t.id));
  return [
    ...own,
    ...object.techniques.inherited
      .filter((id) => !seen.has(norm(id)))
      .map((id) => ({ id: norm(id), via: "inherited" as const })),
  ];
}

/** Whether a rule passes the platform, status and tenant filters. */
export function ruleMatches(rule: CatalogObject, filters: MatrixFilters): boolean {
  const blocks = filters.platform ? rule.platforms.filter((p) => p.id === filters.platform) : rule.platforms;
  if (filters.platform && blocks.length === 0) return false;
  if (filters.excludeInert && !blocks.some((p) => p.strategy !== "INERT")) return false;
  if (filters.tenant) {
    const deployed = rule.deployment.some(
      (d) =>
        d.deployed && d.tenant === filters.tenant && (!filters.platform || d.platform === filters.platform),
    );
    if (!deployed) return false;
  }
  return true;
}

/** Per technique id (upper case), the objects naming it exactly, by kind. */
interface Index {
  readonly rules: Map<string, Map<string, "own" | "inherited">>;
  readonly planned: Map<string, Map<string, "own" | "inherited">>;
  readonly unaddressed: Map<string, Map<string, "own" | "inherited">>;
}

function add(
  map: Map<string, Map<string, "own" | "inherited">>,
  technique: string,
  uuid: string,
  via: "own" | "inherited",
) {
  let entry = map.get(technique);
  if (!entry) {
    entry = new Map();
    map.set(technique, entry);
  }
  if (!entry.has(uuid) || via === "own") entry.set(uuid, via);
}

function index(catalog: CatalogDocument, filters: MatrixFilters): Index {
  const out: Index = { rules: new Map(), planned: new Map(), unaddressed: new Map() };
  const signalObjective = new Map(catalog.signals.map((s) => [s.uuid, s.objective]));
  const implemented = new Set<string>();
  const covered = new Set<string>();
  const byUuid = new Map<string, LoadedObject>(loadedObjects(catalog.objects).map((o) => [o.uuid, o]));
  for (const edge of catalog.edges) {
    if (edge.missing) continue;
    if (edge.kind === "implements" && byUuid.get(edge.from)?.type === "rule") {
      implemented.add(edge.to);
      const objective = signalObjective.get(edge.to);
      if (objective) implemented.add(objective);
    }
    if (edge.kind === "covers") covered.add(edge.to);
  }
  for (const object of loadedObjects(catalog.objects)) {
    const techniques = techniquesOf(object, filters.inherited);
    if (object.type === "rule") {
      if (!ruleMatches(object, filters)) continue;
      for (const t of techniques) add(out.rules, t.id, object.uuid, t.via);
    } else if (object.type === "objective" && filters.layer !== "rules" && !implemented.has(object.uuid)) {
      for (const t of techniques) add(out.planned, t.id, object.uuid, t.via);
    } else if (object.type === "threat" && filters.layer === "unaddressed" && !covered.has(object.uuid)) {
      for (const t of techniques) add(out.unaddressed, t.id, object.uuid, t.via);
    }
  }
  return out;
}

/** The objects naming `technique` or one of its sub-techniques, with how each names it. */
function matching(
  map: Map<string, Map<string, "own" | "inherited">>,
  technique: string,
): Map<string, "own" | "inherited"> {
  const out = new Map<string, "own" | "inherited">();
  for (const [id, objects] of map) {
    if (!covers(technique, id)) continue;
    for (const [uuid, via] of objects) if (!out.has(uuid) || via === "own") out.set(uuid, via);
  }
  return out;
}

export function level(count: number): Cell["level"] {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 9) return 3;
  return 4;
}

/** How many rule names a cell carries for its hover card. */
export const TOP_RULES = 3;

export function buildMatrix(catalog: CatalogDocument, filters: MatrixFilters = DEFAULT_FILTERS): MatrixView {
  const idx = index(catalog, filters);
  const { tactics, techniques } = catalog.attack;
  const names = new Map(loadedObjects(catalog.objects).map((o) => [o.uuid, o.name]));
  const cell = (id: string): Cell => {
    const technique = techniques[id];
    const matched = matching(idx.rules, id);
    const rules = matched.size;
    const top = [...matched.keys()]
      .map((uuid) => names.get(uuid) ?? uuid)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, TOP_RULES);
    return {
      id,
      name: technique?.name ?? id,
      rules,
      top,
      planned: matching(idx.planned, id).size,
      unaddressed: matching(idx.unaddressed, id).size,
      level: level(rules),
      subtechniques: (technique?.subtechniques ?? []).map(cell),
    };
  };
  const parents = new Set<string>();
  const coveredParents = new Set<string>();
  const columns = tactics.map((tactic): Column => {
    const cells = tactic.techniques.filter((id) => !techniques[id]?.parent).map(cell);
    for (const c of cells) {
      parents.add(c.id);
      if (c.rules > 0) coveredParents.add(c.id);
    }
    return {
      id: tactic.id ?? "",
      shortname: tactic.shortname,
      name: tactic.name,
      cells,
      covered: cells.filter((c) => c.rules > 0).length,
    };
  });
  const known = new Set(Object.keys(techniques).map(norm));
  const named = new Set<string>();
  for (const map of [idx.rules, idx.planned, idx.unaddressed]) for (const id of map.keys()) named.add(id);
  const platforms = new Set<string>();
  const tenants = new Set<string>();
  let rules = 0;
  for (const object of loadedObjects(catalog.objects)) {
    if (object.type !== "rule") continue;
    rules++;
    for (const p of object.platforms) platforms.add(p.id);
    for (const d of object.deployment) if (d.tenant) tenants.add(d.tenant);
  }
  return {
    columns,
    techniques: parents.size,
    covered: coveredParents.size,
    unknown: [...named].filter((id) => !known.has(id)).sort(),
    platforms: [...platforms].sort(),
    tenants: [...tenants].sort(),
    rules,
  };
}

export interface CellDetail {
  readonly id: string;
  readonly name: string;
  readonly rules: readonly ObjectRef[];
  readonly planned: readonly ObjectRef[];
  readonly unaddressed: readonly ObjectRef[];
}

/** What a cell lists: its rules, and on the wider layers its planned objectives and unaddressed threats. */
export function cellDetail(
  catalog: CatalogDocument,
  technique: string,
  filters: MatrixFilters = DEFAULT_FILTERS,
): CellDetail {
  const idx = index(catalog, filters);
  const byUuid = new Map<string, LoadedObject>(loadedObjects(catalog.objects).map((o) => [o.uuid, o]));
  const refs = (map: Map<string, Map<string, "own" | "inherited">>): ObjectRef[] =>
    [...matching(map, technique)]
      .flatMap(([uuid, via]) => {
        const object = byUuid.get(uuid);
        return object
          ? [
              {
                uuid,
                name: object.name,
                type: object.type,
                path: object.path,
                via,
                statuses: object.platforms.map((p) => (p.status ? `${p.id}: ${p.status}` : p.id)),
              },
            ]
          : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: norm(technique),
    name: catalog.attack.techniques[norm(technique)]?.name ?? technique,
    rules: refs(idx.rules),
    planned: refs(idx.planned),
    unaddressed: refs(idx.unaddressed),
  };
}

/**
 * The filters without a platform or tenant this folder's data lacks. Filters are saved once for every
 * folder: a tenant saved in a folder with deployment records filtered every rule out of a folder
 * without any, behind a disabled Tenant select, and a platform the rules lack showed as "All" while
 * still filtering.
 */
export function cleanFilters(
  filters: MatrixFilters,
  view: Pick<MatrixView, "platforms" | "tenants">,
): MatrixFilters {
  const { platform, tenant, ...rest } = filters;
  return {
    ...rest,
    ...(platform && view.platforms.includes(platform) ? { platform } : {}),
    ...(tenant && view.tenants.includes(tenant) ? { tenant } : {}),
  };
}

/** The platforms and tenants the folder's rules have: what the Platform and Tenant filters offer. */
export function filterChoices(catalog: CatalogDocument): Pick<MatrixView, "platforms" | "tenants"> {
  const platforms = new Set<string>();
  const tenants = new Set<string>();
  for (const object of catalog.objects) {
    if (object.type !== "rule") continue;
    for (const p of object.platforms) platforms.add(p.id);
    for (const d of object.deployment) if (d.tenant) tenants.add(d.tenant);
  }
  return { platforms: [...platforms].sort(), tenants: [...tenants].sort() };
}
