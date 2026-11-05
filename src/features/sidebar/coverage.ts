// The Coverage view (SPEC §9): the ATT&CK techniques the objects name, by tactic, with rule counts,
// gaps first and sub-techniques under their parent (a parent counts its sub-techniques' rules, as
// `info coverage` does). vscode-free.

import { objectIcon } from "../../core/catalog/objectIcons";
import { type RelationIndex, relationIndexOf } from "../../core/catalog/relations";
import { type LoadedObject, loadedObjects } from "../../core/catalog/rows";
import type { CatalogState } from "../../core/catalog/store";
import type { CatalogDocument } from "../../core/catalog/types";
import { branch, filterNodes, messageNode, type TreeNode, type ViewModel } from "./node";
import { objectTooltip } from "./relationsModel";

export interface TechniqueCount {
  readonly id: string;
  readonly name: string;
  /** Rules naming it or inheriting it (a parent: or one of its sub-techniques). */
  readonly rules: readonly LoadedObject[];
  readonly subtechniques: readonly TechniqueCount[];
}

export interface CoverageSummary {
  /** Distinct techniques named by any object (parents added for named sub-techniques). */
  readonly techniques: number;
  /** Of those, the ones at least one rule covers. */
  readonly covered: number;
}

export interface Coverage {
  readonly tactics: readonly {
    readonly id: string;
    readonly name: string;
    readonly techniques: readonly TechniqueCount[];
  }[];
  readonly summary: CoverageSummary;
}

const ruleTechniques = (rule: LoadedObject): Set<string> =>
  new Set([...rule.techniques.own, ...rule.techniques.inherited]);

const parentOf = (doc: CatalogDocument, id: string): string | null =>
  doc.attack.techniques[id]?.parent ?? (id.includes(".") ? (id.split(".")[0] ?? null) : null);

/** Gaps first, then by id. */
const order = (a: TechniqueCount, b: TechniqueCount): number =>
  (a.rules.length === 0 ? 0 : 1) - (b.rules.length === 0 ? 0 : 1) || a.id.localeCompare(b.id);

export function computeCoverage(doc: CatalogDocument): Coverage {
  const loaded = loadedObjects(doc.objects);
  const rules = loaded.filter((o) => o.type === "rule");
  const named = new Set<string>();
  for (const object of loaded) for (const id of object.techniques.own) named.add(id);
  for (const rule of rules) for (const id of rule.techniques.inherited) named.add(id);
  // Parents of named sub-techniques are shown too, so sub-techniques sit under them.
  const parents = new Map<string, Set<string>>();
  for (const id of [...named]) {
    const parent = parentOf(doc, id);
    if (parent) {
      named.add(parent);
      parents.set(parent, (parents.get(parent) ?? new Set()).add(id));
    }
  }
  const sets = new Map(rules.map((rule) => [rule.uuid, ruleTechniques(rule)]));
  const rulesFor = (ids: readonly string[]) =>
    rules
      .filter((rule) => ids.some((id) => sets.get(rule.uuid)?.has(id)))
      .sort((a, b) => a.name.localeCompare(b.name));
  const count = (id: string): TechniqueCount => {
    const subs = [...(parents.get(id) ?? [])].map(count).sort(order);
    return {
      id,
      name: doc.attack.techniques[id]?.name ?? "",
      rules: rulesFor([id, ...subs.map((s) => s.id)]),
      subtechniques: subs,
    };
  };
  const roots = [...named].filter((id) => !parentOf(doc, id) || !named.has(parentOf(doc, id) ?? ""));
  const placed = new Set<string>();
  const tactics: { id: string; name: string; techniques: TechniqueCount[] }[] = [];
  for (const tactic of doc.attack.tactics) {
    const techniques = roots
      .filter((id) => tactic.techniques.includes(id))
      .map((id) => {
        placed.add(id);
        return count(id);
      })
      .sort(order);
    if (techniques.length) tactics.push({ id: tactic.id ?? tactic.shortname, name: tactic.name, techniques });
  }
  const other = roots
    .filter((id) => !placed.has(id))
    .map(count)
    .sort(order);
  if (other.length) tactics.push({ id: "", name: "Other techniques", techniques: other });
  const all = [...named];
  const covered = all.filter((id) => rulesFor([id, ...(parents.get(id) ?? [])]).length > 0).length;
  return { tactics, summary: { techniques: all.length, covered } };
}

export function summaryText(summary: CoverageSummary): string {
  return `${summary.techniques} technique${summary.techniques === 1 ? "" : "s"} · ${summary.covered} covered`;
}

/** Tree nodes for one folder's coverage. */
export function coverageNodes(
  coverage: Coverage,
  folder: string,
  prefix = "",
  index?: RelationIndex,
): TreeNode[] {
  const techniqueNode = (t: TechniqueCount, parentId: string): TreeNode => {
    const id = `${parentId}/${t.id}`;
    const gap = t.rules.length === 0;
    const children: TreeNode[] = [
      ...t.subtechniques.map((sub) => techniqueNode(sub, id)),
      ...t.rules.map(
        (rule): TreeNode => ({
          id: `${id}/rule:${rule.uuid}`,
          label: rule.name,
          description: rule.path,
          tooltipMarkdown: objectTooltip(rule, index),
          icon: objectIcon("rule").codicon,
          iconColor: objectIcon("rule").themeColor,
          contextValue: "object.rule",
          open: { path: rule.file_path, line: Math.max(0, rule.line - 1) },
          decorate: false,
          ref: {
            kind: "object",
            folder,
            uuid: rule.uuid,
            type: "rule",
            name: rule.name,
            file: rule.file_path,
          },
          search: `${rule.name}\n${rule.uuid}`.toLowerCase(),
        }),
      ),
    ];
    return branch(
      {
        id,
        label: t.name ? `${t.id} ${t.name}` : t.id,
        description: gap ? "0 rules · gap" : `${t.rules.length} rule${t.rules.length === 1 ? "" : "s"}`,
        tooltip: gap
          ? `${t.id}: named by an object, but no rule covers it`
          : `${t.id}: ${t.rules.length} rule${t.rules.length === 1 ? "" : "s"}`,
        icon: gap ? "circle-large-outline" : "pass",
        iconColor: gap ? "problemsWarningIcon.foreground" : "testing.iconPassed",
        contextValue: gap ? "technique.gap" : "technique",
        ref: { kind: "technique", folder, id: t.id },
        search: `${t.id}\n${t.name}`.toLowerCase(),
      },
      children,
    );
  };
  return coverage.tactics.map((tactic) => {
    const id = `${prefix}tactic:${tactic.id || "other"}`;
    const covered = tactic.techniques.filter((t) => t.rules.length > 0).length;
    return branch(
      {
        id,
        label: tactic.name,
        description: `${covered} of ${tactic.techniques.length} covered`,
        tooltip: tactic.id ? `${tactic.id} ${tactic.name}` : tactic.name,
        icon: "layers",
        contextValue: "tactic",
        search: `${tactic.id}\n${tactic.name}`.toLowerCase(),
      },
      tactic.techniques.map((t) => techniqueNode(t, id)),
    );
  });
}

export interface CoverageFolder {
  readonly path: string;
  readonly name: string;
  readonly state: CatalogState;
}

/** The Coverage view: one folder's tactics, or a node per folder in a multi-root window. */
export function buildCoverageView(
  folders: readonly CoverageFolder[],
  filter?: string,
): ViewModel & { readonly empty: boolean; readonly needsCatalog: boolean } {
  const multi = folders.length > 1;
  const nodes: TreeNode[] = [];
  let techniques = 0;
  let covered = 0;
  let ready = 0;
  let needsCatalog = false;
  for (const folder of folders) {
    const state = folder.state;
    const prefix = multi ? `${folder.path}|` : "";
    let inner: TreeNode[];
    // A catalogue from the language server's index has no techniques: coverage needs opentide.
    if (state.catalog && state.source !== "server") {
      ready++;
      const coverage = computeCoverage(state.catalog);
      techniques += coverage.summary.techniques;
      covered += coverage.summary.covered;
      inner = coverageNodes(coverage, folder.path, prefix, relationIndexOf(state.catalog));
    } else if (state.status === "empty" || state.status === "loading") {
      inner = [messageNode(`${prefix}coverage:loading`, "Loading coverage…", "loading~spin")];
    } else if (state.status === "error") {
      inner = [
        messageNode(`${prefix}coverage:error`, "Coverage did not load. Retry", "error", {
          description: state.error,
          tooltip: state.error,
          command: { command: "opentide.sidebar.refresh", title: "Retry", args: ["coverage"] },
        }),
      ];
    } else {
      if (state.unavailable?.reason === "needs-command") needsCatalog = true;
      inner =
        multi && state.unavailable
          ? [messageNode(`${prefix}coverage:unavailable`, state.unavailable.message, "info")]
          : [];
    }
    if (multi)
      nodes.push(
        branch({ id: `folder:${folder.path}`, label: folder.name, icon: "root-folder" }, inner, "expanded"),
      );
    else nodes.push(...inner);
  }
  const empty = ready > 0 && techniques === 0;
  return {
    nodes: empty && !multi ? [] : filterNodes(nodes, filter),
    ...(ready > 0 ? { description: summaryText({ techniques, covered }) } : {}),
    ...(techniques - covered > 0
      ? {
          badge: {
            value: techniques - covered,
            tooltip: `${techniques - covered} technique${techniques - covered === 1 ? "" : "s"} without a rule`,
          },
        }
      : {}),
    empty,
    needsCatalog,
  };
}
