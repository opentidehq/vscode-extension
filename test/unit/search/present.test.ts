import * as assert from "node:assert/strict";
import { search } from "../../../src/features/search/match";
import {
  catalogueFilterOf,
  countProblems,
  describeItem,
  graphSelection,
  HINTS,
  insertHint,
  parseSearchArgs,
  present,
  type Row,
  unreviewedPaths,
} from "../../../src/features/search/present";
import { parseQuery } from "../../../src/features/search/query";
import { buildIndex } from "../../../src/features/search/searchIndex";
import { ROOT, sampleCatalog, UUID } from "../catalogFixture";

const NOW = Date.UTC(2026, 10, 3);
const index = buildIndex([{ folder: ROOT, status: "ready", catalog: sampleCatalog(), refreshing: false }]);
const rows = (text: string, limit?: number): Row[] => {
  const query = parseQuery(text);
  return present(query, index, search(index, query, { now: NOW }), limit ? { limit } : {});
};
const labels = (list: Row[]) =>
  list.map((row) =>
    row.kind === "result" ? `· ${row.label}` : row.kind === "hint" ? `? ${row.hint.token}` : row.label,
  );

describe("search rows", () => {
  it("groups results by type with counts, rules first", () => {
    assert.deepEqual(labels(rows("lsass")), [
      "Rules (2)",
      "· LSASS dump via comsvcs",
      "· Suspicious LSASS Access",
      "Objectives (1)",
      "· Detect LSASS access",
      "Signals (2)",
      "· LSASS handle opened",
      "· LSASS handle with VM_READ",
    ]);
  });

  it("describes each result with its techniques, platforms and statuses, and where it is", () => {
    const rule = rows("suspicious").find((row) => row.kind === "result");
    assert.ok(rule?.kind === "result");
    assert.equal(rule.icon, "shield");
    assert.equal(rule.description, "T1003.001, T1003 · sentinel DESIGN, defender PRODUCTION");
    assert.equal(rule.detail, "objects/rules/suspicious-lsass-access.yaml");
    const bad = rows("bad.yaml").find((row) => row.kind === "result");
    assert.ok(bad?.kind === "result");
    assert.equal(bad.icon, "error");
    assert.match(bad.detail, /failed to load: mapping values/);
  });

  it("shows the filters when the query is empty", () => {
    const list = rows("");
    assert.equal(list.filter((row) => row.kind === "hint").length, HINTS.length);
    assert.equal(list[0]?.kind === "separator" && list[0].label, "Filters");
  });

  it("says what is wrong, what is pending, and when nothing matches", () => {
    assert.match(labels(rows("colour:red"))[0] ?? "", /Not a filter: colour:red/);
    assert.match(labels(rows("unreviewed:>90d"))[0] ?? "", /rules unreviewed/);
    assert.match(labels(rows("zzz")).join("\n"), /No detection matches/);
  });

  it("caps the list and says how many there are", () => {
    const list = rows("type:rule", 2);
    assert.equal(list.filter((row) => row.kind === "result").length, 2);
    assert.match(labels(list).at(-1) ?? "", /Showing 2 results of 4/);
  });

  it("explains the symbol fallback and an empty workspace", () => {
    const symbols = buildIndex([
      {
        folder: ROOT,
        status: "unavailable",
        refreshing: false,
        unavailable: { reason: "needs-command", command: "info catalog", message: "needs" },
        symbols: [
          { name: "R", family: "rule", uri: "file:///ws/objects/rules/r.yaml", line: 0, character: 0 },
        ],
      },
    ]);
    const query = parseQuery("t:T1003");
    const list = present(query, symbols, search(symbols, query, { now: NOW }));
    assert.match(labels(list)[0] ?? "", /t:T1003 needs a newer opentide/);
    const empty = buildIndex([
      {
        folder: ROOT,
        status: "unavailable",
        refreshing: false,
        unavailable: { reason: "untrusted", message: "Trust this folder to load the catalogue." },
      },
    ]);
    const nothing = present(parseQuery(""), empty, undefined);
    assert.equal(
      nothing[0]?.kind === "notice" && nothing[0].detail,
      "Trust this folder to load the catalogue.",
    );
    const loading = buildIndex([{ folder: ROOT, status: "loading", refreshing: true }]);
    assert.match(labels(present(parseQuery(""), loading, undefined))[0] ?? "", /Loading the catalogue/);
  });

  it("names the folder of each result in a multi-root window", () => {
    const query = parseQuery("suspicious");
    const list = present(query, index, search(index, query, { now: NOW }), {
      folderNames: new Map([[ROOT, "detections"]]),
    });
    const rule = list.find((row) => row.kind === "result");
    assert.ok(rule?.kind === "result" && rule.detail.startsWith("detections: objects/rules/"));
  });

  it("inserts a hint into the query", () => {
    assert.equal(insertHint("lsass", { token: "t:", description: "" }), "lsass t:");
    assert.equal(insertHint("", { token: "has:errors", description: "" }), "has:errors ");
    assert.equal(insertHint("a ", { token: "-", description: "" }), "a -");
  });

  it("picks the folder with most catalogue results for the graph", () => {
    const results = search(index, parseQuery("lsass"), { now: NOW }).results;
    const selection = graphSelection(results);
    assert.equal(selection?.folder, ROOT);
    assert.ok(selection?.uuids.includes(UUID.rule));
    assert.equal(graphSelection([]), undefined);
  });

  it("reads the paths rules unreviewed lists", () => {
    assert.deepEqual(
      [
        ...(unreviewedPaths({
          rules: [{ path: "objects/rules/a.yaml" }, { path: "objects\\rules\\b.yaml" }, {}],
        }) ?? []),
      ],
      ["objects/rules/a.yaml", "objects/rules/b.yaml"],
    );
    assert.equal(unreviewedPaths({ failure: {} }), undefined);
    assert.equal(unreviewedPaths(null), undefined);
  });

  it("shortens a long technique list", () => {
    const item = index.items.find((i) => i.id === UUID.rule);
    assert.ok(item);
    assert.equal(
      describeItem({ ...item, techniques: ["T1", "T2", "T3", "T4"], platforms: [] }),
      "T1, T2, T3, …",
    );
  });
});

describe("search glue helpers", () => {
  it("reads opentide.search.open arguments", () => {
    assert.deepEqual(parseSearchArgs({ query: "t:T1003" }), { query: "t:T1003" });
    assert.deepEqual(parseSearchArgs("lsass"), { query: "lsass" });
    assert.deepEqual(parseSearchArgs({ query: 3 }), {});
    assert.deepEqual(parseSearchArgs(undefined), {});
    // The matrix passes its folder: search only that folder.
    assert.deepEqual(parseSearchArgs({ query: "t:T1003", folder: "/ws/a" }), {
      query: "t:T1003",
      folder: "/ws/a",
    });
    assert.deepEqual(parseSearchArgs({ folder: "" }), {});
  });

  it("hands the Catalogue view only a query its substring filter can express", () => {
    assert.equal(catalogueFilterOf(parseQuery("lsass")), "lsass");
    // Search matches each word in any order; the Catalogue one substring: not the same question.
    assert.equal(catalogueFilterOf(parseQuery("lsass access")), undefined);
    assert.equal(catalogueFilterOf(parseQuery("t:T1003")), "t1003");
    assert.equal(catalogueFilterOf(parseQuery("technique:T1003.001")), "t1003.001");
    assert.equal(catalogueFilterOf(parseQuery("path:rules/")), "rules/");
    assert.equal(catalogueFilterOf(parseQuery("lsass t:T1003")), undefined);
    assert.equal(catalogueFilterOf(parseQuery("p:sentinel")), undefined);
    assert.equal(catalogueFilterOf(parseQuery("-t:T1003")), undefined);
    assert.equal(catalogueFilterOf(parseQuery("lsass -mimikatz")), undefined);
    assert.equal(catalogueFilterOf(parseQuery("")), undefined);
  });

  it("reads technique: and t: as the same filter", () => {
    for (const text of ["t:T1003", "technique:T1003"]) {
      const [filter] = parseQuery(text).filters;
      assert.equal(filter?.key, "technique", text);
      assert.equal(filter?.value, "t1003", text);
    }
  });

  it("counts errors, warnings and placeholders as the Problems panel shows them", () => {
    assert.deepEqual(
      countProblems([
        { severity: 0, code: "invalid_ref" },
        { severity: 1, code: { value: "placeholder" } },
        { severity: 1, code: "placeholder" },
        { severity: 3 },
      ]),
      { errors: 1, warnings: 2, placeholders: 2 },
    );
  });
});
