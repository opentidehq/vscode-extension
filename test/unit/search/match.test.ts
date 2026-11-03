import * as assert from "node:assert/strict";
import { facets, type MatchContext, matchDate, search } from "../../../src/features/search/match";
import { parseQuery } from "../../../src/features/search/query";
import { buildIndex, type SearchItem } from "../../../src/features/search/searchIndex";
import { ROOT, sampleCatalog, syntheticCatalog, UUID } from "../catalogFixture";

const NOW = Date.UTC(2026, 10, 3, 12);
const index = buildIndex([{ folder: ROOT, status: "ready", catalog: sampleCatalog(), refreshing: false }]);
const find = (text: string, context: Partial<MatchContext> = {}) =>
  search(index, parseQuery(text), { now: NOW, ...context }).results.map((r) => r.item.id);

describe("search matching", () => {
  it("matches every word of free text against names, UUIDs and paths", () => {
    assert.deepEqual(find("lsass suspicious"), [UUID.rule]);
    assert.deepEqual(find("44444444-0000-4000-8000-000000000002"), [UUID.comsvcs]);
    assert.deepEqual(find("bad.yaml"), ["file:objects/rules/bad.yaml"]);
    assert.deepEqual(find("lsass -comsvcs type:rule"), [UUID.rule]);
  });

  it("ranks names that start with the text first, rules before other types", () => {
    const ids = find("lsass");
    assert.equal(ids[0], UUID.comsvcs, "“LSASS dump…” starts with it");
    assert.ok(ids.indexOf(UUID.rule) < ids.indexOf(UUID.objective), "a rule before an objective");
  });

  it("matches a technique's sub-techniques, as coverage counts them (issue #21)", () => {
    const ids = find("t:T1003 type:rule");
    assert.deepEqual(ids.sort(), [UUID.comsvcs, UUID.rule].sort());
    assert.deepEqual(find("t:T1003.001 type:objective"), [UUID.objective]);
    assert.deepEqual(find("t:T1003.002"), []);
  });

  it("holds platform and status on the same block", () => {
    assert.deepEqual(find("p:sentinel s:production"), [UUID.broken]);
    assert.deepEqual(find("p:defender s:production"), [UUID.rule]);
    assert.deepEqual(find("s:design").sort(), [UUID.rule]);
    assert.deepEqual(
      find("p:sentinel p:splunk").sort(),
      [UUID.broken, UUID.comsvcs, UUID.rule].sort(),
      "same key: or",
    );
    assert.deepEqual(
      find("type:rule -p:sentinel").sort(),
      [UUID.comsvcs, "file:objects/rules/bad.yaml"].sort(),
    );
  });

  it("filters by tactic (shortname, id or part), actor, author, TLP, UUID and path", () => {
    assert.deepEqual(find("tactic:TA0008"), [UUID.lateral]);
    assert.deepEqual(find("tactic:lateral"), [UUID.lateral]);
    assert.ok(find("tactic:credential-access").includes(UUID.signal), "signals take their objective's");
    assert.deepEqual(find("actor:G0016 type:threat"), [UUID.threat]);
    assert.deepEqual(find('author:"jane doe"'), [UUID.rule]);
    assert.deepEqual(find("tlp:green"), [UUID.comsvcs]);
    assert.deepEqual(find("tlp:tlp:green"), [UUID.comsvcs]);
    assert.deepEqual(
      find("uuid:44444444-0000-4000-8000-00000000000").sort(),
      [UUID.rule, UUID.comsvcs, UUID.broken].sort(),
    );
    assert.deepEqual(find("path:threats/lateral").sort(), [UUID.lateral]);
    assert.deepEqual(find("type:signals").length, 2, "plurals work");
  });

  it("finds problems as the Problems panel has them, and files that did not load", () => {
    const problems = (item: SearchItem) =>
      item.id === UUID.comsvcs ? { errors: 1, warnings: 0, placeholders: 2 } : undefined;
    assert.deepEqual(
      find("has:errors", { problems }).sort(),
      [UUID.comsvcs, "file:objects/rules/bad.yaml"].sort(),
    );
    assert.deepEqual(find("has:placeholders", { problems }), [UUID.comsvcs]);
    assert.deepEqual(find("has:warnings", { problems }), []);
    assert.deepEqual(find("has:deployment"), [UUID.rule]);
    assert.deepEqual(find("-has:errors type:rule", { problems }).sort(), [UUID.broken, UUID.rule].sort());
    assert.deepEqual(find("has:nonsense"), []);
  });

  it("compares dates and ages", () => {
    assert.deepEqual(find("created:<2026-01-01"), [UUID.comsvcs]);
    assert.deepEqual(find("modified:>200d type:rule"), [UUID.comsvcs]);
    assert.ok(find("modified:<60d type:rule").includes(UUID.rule));
    assert.deepEqual(find("reviewed:2025-06"), [UUID.comsvcs]);
    assert.ok(find("reviewed:none type:rule").includes(UUID.rule));
    assert.ok(matchDate("2026-11-03T10:00:00Z", { kind: "age", op: "=", days: 0 }, NOW));
    assert.ok(!matchDate(undefined, { kind: "date", op: ">", date: "2020-01-01" }, NOW));
    assert.ok(matchDate("2026-01-01", { kind: "date", op: ">=", date: "2026-01-01" }, NOW));
  });

  it("waits for rules unreviewed, then lists the rules it named", () => {
    const pending = search(index, parseQuery("unreviewed:>90d"), { now: NOW });
    assert.equal(pending.pending, true);
    assert.deepEqual(pending.results, []);
    const unreviewed = new Map([[ROOT, new Set(["objects/rules/lsass-dump-via-comsvcs.yaml"])]]);
    assert.deepEqual(find("unreviewed:>90d", { unreviewed }), [UUID.comsvcs]);
  });

  it("answers names, types and paths from workspace symbols, and says what else needs info catalog", () => {
    const symbols = buildIndex([
      {
        folder: ROOT,
        status: "unavailable",
        refreshing: false,
        unavailable: { reason: "needs-command", command: "info catalog", message: "needs" },
        symbols: [
          {
            name: "Suspicious LSASS Access",
            family: "rule",
            uri: "file:///ws/objects/rules/a.yaml",
            line: 0,
            character: 6,
          },
          {
            name: "Detect LSASS access",
            family: "objective",
            uri: "file:///ws/objects/objectives/b.yaml",
            line: 2,
            character: 6,
          },
        ],
      },
    ]);
    assert.ok(symbols.symbolsOnly);
    const byName = search(symbols, parseQuery("lsass type:rule"), { now: NOW });
    assert.deepEqual(
      byName.results.map((r) => r.item.name),
      ["Suspicious LSASS Access"],
    );
    assert.deepEqual(byName.unsupported, []);
    const byTechnique = search(symbols, parseQuery("lsass t:T1003 p:sentinel"), { now: NOW });
    assert.deepEqual(byTechnique.results, []);
    assert.deepEqual(
      byTechnique.unsupported.map((f) => f.raw),
      ["t:T1003", "p:sentinel"],
    );
    assert.deepEqual(search(symbols, parseQuery("path:objectives"), { now: NOW }).results.length, 1);
  });

  it("counts facets once per item", () => {
    const counts = facets(search(index, parseQuery("type:rule"), { now: NOW }).results);
    assert.equal(counts.type.get("rule"), 4);
    assert.equal(counts.platform.get("sentinel"), 2);
    assert.equal(counts.status.get("PRODUCTION"), 3);
    assert.equal(counts.tlp.get("amber"), 3);
  });

  it("answers a keystroke within 50 ms at 5,000 objects (issue #21)", () => {
    const big = buildIndex([
      { folder: ROOT, status: "ready", catalog: syntheticCatalog(5000), refreshing: false },
    ]);
    const queries = [
      "l",
      "ls",
      "lsa",
      "lsass",
      "lsass t:T1003",
      "lsass t:T1003 p:sentinel s:production",
      "author:jane -tlp:green",
    ];
    search(big, parseQuery("warm up"), { now: NOW });
    const timings = queries.map((text) => {
      const started = performance.now();
      search(big, parseQuery(text), { now: NOW });
      return performance.now() - started;
    });
    const worst = Math.max(...timings);
    assert.ok(worst < 50, `slowest keystroke took ${worst.toFixed(1)} ms`);
    assert.ok(search(big, parseQuery("lsass t:T1003"), { now: NOW }).results.length > 0);
  });
});
