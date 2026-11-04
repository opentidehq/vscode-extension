import * as assert from "node:assert/strict";
import {
  ageInDays,
  isEmptyQuery,
  parseDate,
  parseQuery,
  tokenize,
  unreviewedWindow,
} from "../../../src/features/search/query";

describe("search query", () => {
  it("splits on spaces and keeps quoted values together", () => {
    assert.deepEqual(tokenize(`lsass author:"Jane Doe"  t:T1003 'two words'`), [
      "lsass",
      "author:Jane Doe",
      "t:T1003",
      "two words",
    ]);
    assert.deepEqual(tokenize(`author:"unterminated`), ["author:unterminated"]);
  });

  it("reads free text and filters, with short aliases", () => {
    const query = parseQuery(
      "LSASS dump t:T1003 p:Sentinel s:production type:rule tactic:TA0006 a:G0016 tlp:amber",
    );
    assert.deepEqual(query.words, ["lsass", "dump"]);
    assert.deepEqual(
      query.filters.map((f) => [f.key, f.value]),
      [
        ["technique", "t1003"],
        ["platform", "sentinel"],
        ["status", "production"],
        ["type", "rule"],
        ["tactic", "ta0006"],
        ["actor", "g0016"],
        ["tlp", "amber"],
      ],
    );
    assert.deepEqual(query.problems, []);
  });

  it("excludes with a leading dash", () => {
    const query = parseQuery("-p:splunk -test lsass");
    assert.deepEqual(
      query.filters.map((f) => [f.key, f.value, f.negated]),
      [["platform", "splunk", true]],
    );
    assert.deepEqual(query.excluded, ["test"]);
    assert.deepEqual(query.words, ["lsass"]);
    assert.deepEqual(parseQuery("-").words, ["-"]);
  });

  it("keeps technique ids, UUIDs and paths as text", () => {
    assert.deepEqual(parseQuery("T1003.001 4444-aaaa objects/rules/x.yaml").words, [
      "t1003.001",
      "4444-aaaa",
      "objects/rules/x.yaml",
    ]);
  });

  it("flags unknown keys and bad values, and ignores a key still being typed", () => {
    const query = parseQuery("colour:red modified:soon t: s:");
    assert.deepEqual(query.problems, ["colour:red", "modified:soon"]);
    assert.deepEqual(query.filters, []);
    assert.ok(isEmptyQuery(query));
    assert.ok(!isEmptyQuery(parseQuery("x")));
  });

  it("parses dates and ages", () => {
    assert.deepEqual(parseDate(">2026-01-01"), { kind: "date", op: ">", date: "2026-01-01" });
    assert.deepEqual(parseDate("<=30d"), { kind: "age", op: "<=", days: 30 });
    assert.deepEqual(parseDate("2026-10"), { kind: "date", op: "=", date: "2026-10" });
    assert.deepEqual(parseDate("none"), { kind: "none" });
    assert.equal(parseDate("yesterday"), undefined);
    assert.equal(ageInDays("2w"), 14);
    assert.equal(ageInDays("6m"), 180);
    assert.equal(ageInDays("1y"), 365);
    assert.equal(ageInDays("3 days"), 3);
    assert.equal(ageInDays("x"), undefined);
    const modified = parseQuery("modified:<30d").filters[0];
    assert.deepEqual(modified?.date, { kind: "age", op: "<", days: 30 });
  });

  it("turns unreviewed: into the window rules unreviewed takes", () => {
    assert.equal(parseQuery("unreviewed:>90d").unreviewed, "90d");
    assert.equal(unreviewedWindow("true"), "90d");
    assert.equal(unreviewedWindow("30"), "30d");
    assert.equal(unreviewedWindow("12h"), "12h");
    assert.equal(unreviewedWindow("2w"), "14d");
    assert.equal(unreviewedWindow("soon"), undefined);
    assert.deepEqual(parseQuery("unreviewed:soon").problems, ["unreviewed:soon"]);
  });
});
