import * as assert from "node:assert/strict";
import {
  compiledMethod,
  elasticLanguage,
  type LspDocumentSymbol,
  queryText,
  ruleQueryTargets,
  writesPreviewAlerts,
} from "../../../src/features/query/targets";

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

// What the language server 0.9.1 sends for a rule with a Splunk and a Sentinel block (captured).
const OUTLINE: LspDocumentSymbol[] = [
  {
    name: "Suspicious LSASS Access 0",
    detail: "ff8bf67e-64dc-460d-b5df-48db643f3560",
    kind: 5,
    range: range(0, 0, 112, 22),
    children: [
      { name: "name", kind: 3, range: range(0, 0, 0, 31), children: [] },
      { name: "metadata", kind: 3, range: range(2, 0, 9, 16), children: [] },
      {
        name: "response",
        kind: 3,
        range: range(31, 0, 40, 0),
        children: [
          { name: "procedure.searches.0.query", detail: "kql", kind: 15, range: range(35, 8, 37, 0) },
        ],
      },
      {
        name: "configurations",
        kind: 3,
        range: range(44, 0, 112, 22),
        children: [
          {
            name: "splunk",
            kind: 19,
            range: range(45, 0, 57, 21),
            children: [{ name: "query", detail: "spl", kind: 15, range: range(49, 6, 51, 0), children: [] }],
          },
          {
            name: "sentinel",
            kind: 19,
            range: range(59, 0, 112, 22),
            children: [{ name: "query", detail: "kql", kind: 15, range: range(72, 6, 75, 0), children: [] }],
          },
        ],
      },
    ],
  },
];

describe("query targets (#17)", () => {
  it("finds each platform block's query in the server outline, with the rule's UUID", () => {
    const targets = ruleQueryTargets(OUTLINE);
    assert.deepEqual(
      targets.map((t) => [t.platform, t.field, t.language, t.range.start.line, t.uuid]),
      [
        ["splunk", "query", "spl", 49, "ff8bf67e-64dc-460d-b5df-48db643f3560"],
        ["sentinel", "query", "kql", 72, "ff8bf67e-64dc-460d-b5df-48db643f3560"],
      ],
    );
    assert.equal(targets[0]?.ruleName, "Suspicious LSASS Access 0");
  });

  it("ignores response hunts (no platform block) and documents with no outline", () => {
    assert.ok(ruleQueryTargets(OUTLINE).every((t) => t.field === "query"));
    assert.deepEqual(ruleQueryTargets(null), []);
    assert.deepEqual(ruleQueryTargets([{ name: "x", kind: 5, range: range(0, 0, 0, 1) }]), []);
  });

  it("reads a block scalar's text under its range, without the YAML indentation", () => {
    const lines = [
      "    query: |",
      "      DeviceProcessEvents",
      '      | where FileName =~ "rundll32.exe"',
      "        | take 10",
      "    scheduling:",
    ];
    assert.equal(
      queryText(lines, range(1, 6, 4, 0)),
      'DeviceProcessEvents\n| where FileName =~ "rundll32.exe"\n  | take 10',
    );
  });

  it("reads quoted and plain scalars", () => {
    assert.equal(queryText(['    query: "a | b \\"c\\""'], range(0, 11, 0, 25)), 'a | b "c"');
    assert.equal(queryText(["    query: 'it''s'"], range(0, 11, 0, 18)), "it's");
    assert.equal(queryText(["    query: index=main"], range(0, 11, 0, 21)), "index=main");
  });

  it("knows which languages compile, Elastic's --language and the Kuery write", () => {
    assert.equal(compiledMethod("kql"), "opentide/compiledKql");
    assert.equal(compiledMethod("spl"), "opentide/compiledSpl");
    assert.equal(compiledMethod("esql"), undefined);
    assert.equal(elasticLanguage("elastic", "eql"), "eql");
    assert.equal(elasticLanguage("carbon_black_cloud", "lucene"), undefined);
    assert.equal(writesPreviewAlerts("elastic", "kuery"), true);
    assert.equal(writesPreviewAlerts("elastic", "esql"), false);
  });
});
