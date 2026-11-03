import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { CatalogDocument, CatalogObject } from "../../../src/core/catalog/types";
import { parseOpenArgs } from "../../../src/features/matrix/index";
import {
  buildMatrix,
  type Cell,
  cellDetail,
  covers,
  DEFAULT_FILTERS,
  level,
} from "../../../src/features/matrix/model";
import { isFilters } from "../../../src/features/matrix/protocol";
import { ROOT } from "../helpers";

const object = (
  over: Partial<CatalogObject> & Pick<CatalogObject, "uuid" | "type" | "name">,
): CatalogObject => ({
  schema: `${over.type}::1.0`,
  path: `objects/${over.type}s/${over.uuid}.yaml`,
  file_path: `/w/objects/${over.type}s/${over.uuid}.yaml`,
  line: 1,
  platforms: [],
  deployment: [],
  techniques: { own: [], inherited: [] },
  tactics: [],
  actors: [],
  load_error: null,
  ...over,
});

/** Two tactics; T1003 has two sub-techniques. */
const CATALOG = {
  ok: true,
  objects: [
    object({
      uuid: "th-1",
      type: "threat",
      name: "Credential Dumping",
      techniques: { own: ["T1003"], inherited: [] },
    }),
    object({
      uuid: "th-2",
      type: "threat",
      name: "Unaddressed",
      techniques: { own: ["T1059"], inherited: [] },
    }),
    object({
      uuid: "ob-1",
      type: "objective",
      name: "Detect LSASS",
      techniques: { own: ["T1003.001"], inherited: ["T1003"] },
    }),
    object({
      uuid: "ob-2",
      type: "objective",
      name: "Planned",
      techniques: { own: ["T1003.002"], inherited: [] },
    }),
    object({
      uuid: "r-1",
      type: "rule",
      name: "LSASS access",
      techniques: { own: ["t1003.001"], inherited: ["T1003"] },
      platforms: [{ id: "sentinel", enabled: true, status: "PRODUCTION", strategy: "RELEASE" }],
      deployment: [{ platform: "sentinel", tenant: "prod", deployed: true, rule_id: "x" }],
    }),
    object({
      uuid: "r-2",
      type: "rule",
      name: "Design only",
      techniques: { own: [], inherited: ["T1003"] },
      platforms: [{ id: "splunk", enabled: true, status: "DESIGN", strategy: "INERT" }],
    }),
    object({
      uuid: "r-3",
      type: "rule",
      name: "Outside the matrix",
      techniques: { own: ["T9999"], inherited: [] },
    }),
    object({
      uuid: "bad",
      type: "rule",
      name: "broken",
      techniques: { own: ["T1059"], inherited: [] },
      load_error: { code: "yaml_parse", message: "x" },
    }),
  ],
  edges: [
    {
      from: "ob-1",
      to: "th-1",
      kind: "covers",
      field_path: "objective.threats",
      relation: null,
      missing: false,
    },
    {
      from: "ob-2",
      to: "th-1",
      kind: "covers",
      field_path: "objective.threats",
      relation: null,
      missing: false,
    },
    {
      from: "r-1",
      to: "sig-1",
      kind: "implements",
      field_path: "detection_model",
      relation: null,
      missing: false,
    },
    {
      from: "r-2",
      to: "ob-1",
      kind: "implements",
      field_path: "detection_model",
      relation: null,
      missing: false,
    },
  ],
  signals: [{ uuid: "sig-1", name: "s", objective: "ob-1", parent: null }],
  attack: {
    tactics: [
      {
        id: "TA0006",
        shortname: "credential-access",
        name: "Credential Access",
        techniques: ["T1003", "T1003.001", "T1003.002"],
      },
      { id: "TA0002", shortname: "execution", name: "Execution", techniques: ["T1059"] },
    ],
    techniques: {
      T1003: { name: "OS Credential Dumping", parent: null, subtechniques: ["T1003.001", "T1003.002"] },
      "T1003.001": { name: "LSASS Memory", parent: "T1003", subtechniques: [] },
      "T1003.002": { name: "Security Account Manager", parent: "T1003", subtechniques: [] },
      T1059: { name: "Command and Scripting Interpreter", parent: null, subtechniques: [] },
    },
  },
  summary: { objects: 8, threats: 2, objectives: 2, rules: 4, signals: 1, edges: 4, load_errors: 1 },
} as unknown as CatalogDocument;

const find = (cells: readonly Cell[], id: string): Cell | undefined => {
  for (const cell of cells) {
    if (cell.id === id) return cell;
    const sub = find(cell.subtechniques, id);
    if (sub) return sub;
  }
  return undefined;
};
const cellOf = (view: ReturnType<typeof buildMatrix>, id: string) =>
  find(
    view.columns.flatMap((c) => c.cells),
    id,
  );

describe("ATT&CK matrix (#20)", () => {
  it("lays out tactics as columns and parent techniques as cells, sub-techniques inside", () => {
    const view = buildMatrix(CATALOG);
    assert.deepEqual(
      view.columns.map((c) => [c.id, c.cells.map((cell) => cell.id)]),
      [
        ["TA0006", ["T1003"]],
        ["TA0002", ["T1059"]],
      ],
    );
    assert.deepEqual(
      cellOf(view, "T1003")?.subtechniques.map((s) => s.id),
      ["T1003.001", "T1003.002"],
    );
  });

  it("counts a parent's sub-technique rules, distinct rules once, case-insensitively", () => {
    const view = buildMatrix(CATALOG);
    assert.equal(cellOf(view, "T1003")?.rules, 2);
    assert.equal(cellOf(view, "T1003.001")?.rules, 1);
    assert.equal(cellOf(view, "T1003.002")?.rules, 0);
    assert.equal(cellOf(view, "T1059")?.rules, 0, "a rule that failed to load counts nothing");
    assert.equal(view.covered, 1);
    assert.equal(view.techniques, 2);
    assert.deepEqual(view.unknown, ["T9999"]);
  });

  it("counts only own techniques without inheritance, as info coverage --technique does", () => {
    const view = buildMatrix(CATALOG, { ...DEFAULT_FILTERS, inherited: false });
    assert.equal(cellOf(view, "T1003")?.rules, 1, "r-1 names T1003.001 itself; r-2 only inherits");
    assert.equal(cellOf(view, "T1003.001")?.rules, 1);
  });

  it("filters by platform, INERT status and tenant", () => {
    assert.equal(cellOf(buildMatrix(CATALOG, { ...DEFAULT_FILTERS, platform: "splunk" }), "T1003")?.rules, 1);
    assert.equal(cellOf(buildMatrix(CATALOG, { ...DEFAULT_FILTERS, excludeInert: true }), "T1003")?.rules, 1);
    assert.equal(
      cellOf(buildMatrix(CATALOG, { ...DEFAULT_FILTERS, platform: "splunk", excludeInert: true }), "T1003")
        ?.rules,
      0,
    );
    assert.equal(cellOf(buildMatrix(CATALOG, { ...DEFAULT_FILTERS, tenant: "prod" }), "T1003")?.rules, 1);
    assert.equal(cellOf(buildMatrix(CATALOG, { ...DEFAULT_FILTERS, tenant: "dev" }), "T1003")?.rules, 0);
    const view = buildMatrix(CATALOG);
    assert.deepEqual(view.platforms, ["sentinel", "splunk"]);
    assert.deepEqual(view.tenants, ["prod"]);
  });

  it("adds planned objectives (no rule implements them, directly or through a signal) and unaddressed threats", () => {
    const rules = buildMatrix(CATALOG);
    assert.equal(cellOf(rules, "T1003")?.planned, 0, "the rules layer shows no objectives");
    const planned = buildMatrix(CATALOG, { ...DEFAULT_FILTERS, layer: "planned" });
    assert.equal(
      cellOf(planned, "T1003")?.planned,
      1,
      "ob-1 is implemented (r-1 through its signal, r-2 directly)",
    );
    assert.equal(cellOf(planned, "T1003.002")?.planned, 1);
    assert.equal(cellOf(planned, "T1059")?.unaddressed, 0);
    const unaddressed = buildMatrix(CATALOG, { ...DEFAULT_FILTERS, layer: "unaddressed" });
    assert.equal(cellOf(unaddressed, "T1059")?.unaddressed, 1, "th-2 has no objective");
    assert.equal(cellOf(unaddressed, "T1003")?.unaddressed, 0, "th-1 is covered");
  });

  it("lists a cell's rules with how each names the technique", () => {
    const detail = cellDetail(CATALOG, "T1003");
    assert.deepEqual(
      detail.rules.map((r) => [r.uuid, r.via]),
      [
        ["r-2", "inherited"],
        ["r-1", "own"],
      ],
    );
    assert.equal(detail.name, "OS Credential Dumping");
    assert.deepEqual(detail.rules.find((r) => r.uuid === "r-1")?.statuses, ["sentinel: PRODUCTION"]);
    assert.deepEqual(
      cellDetail(CATALOG, "T1003.002", { ...DEFAULT_FILTERS, layer: "planned" }).planned.map((o) => o.uuid),
      ["ob-2"],
    );
  });

  it("shades by count, with 0 as the gap level", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 9, 10, 50].map(level), [0, 1, 2, 2, 3, 3, 4, 4]);
    assert.ok(covers("T1059", "t1059.001"));
    assert.ok(!covers("T1059.001", "T1059"));
    assert.ok(!covers("T105", "T1059"));
  });

  it("reads the real info catalog shape (opentide#749)", () => {
    const real = JSON.parse(
      readFileSync(path.join(ROOT, "test", "fixtures", "panels", "catalog.json"), "utf8"),
    ) as CatalogDocument;
    const view = buildMatrix(real);
    assert.equal(view.columns.length, real.attack.tactics.length);
    assert.equal(cellOf(view, "T1548")?.rules, 2, "both rules inherit T1548 from their threat");
    assert.equal(cellOf(buildMatrix(real, { ...DEFAULT_FILTERS, excludeInert: true }), "T1548")?.rules, 1);
    assert.equal(cellOf(buildMatrix(real, { ...DEFAULT_FILTERS, inherited: false }), "T1548")?.rules, 0);
    assert.ok(view.techniques > 150);
  });

  it("validates filters and parses the open command's arguments", () => {
    assert.ok(isFilters(DEFAULT_FILTERS));
    assert.ok(isFilters({ ...DEFAULT_FILTERS, platform: "splunk" }));
    assert.ok(!isFilters({ ...DEFAULT_FILTERS, layer: "all" }));
    assert.ok(!isFilters({ layer: "rules" }));
    assert.deepEqual(parseOpenArgs("t1003.001"), { technique: "T1003.001" });
    assert.deepEqual(parseOpenArgs("/w"), { folder: "/w" });
    assert.deepEqual(parseOpenArgs({ folder: "/w", technique: "T1003" }), {
      folder: "/w",
      technique: "T1003",
    });
    assert.deepEqual(parseOpenArgs(undefined), {});
  });
});
