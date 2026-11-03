import * as assert from "node:assert/strict";
import {
  configurationsLine,
  indentBlock,
  parseJsonc,
  servedNatively,
  tideSnippets,
} from "../../../src/features/new-object/snippets";

// As `opentide generate snippets` 0.21.0 writes `.vscode/model-templates.code-snippets` (bodies trimmed).
const FILE = `{
  // generated
  "Detection Rules Template": {
    "prefix": "tide-rule",
    "scope": "yaml",
    "description": "Detection Rules: a new object from the generated template.",
    "body": ["name: \${1:name}", "", "metadata:"],
  },
  "Platform configuration : Microsoft Sentinel Template": {
    "prefix": "tide-sentinel",
    "scope": "yaml",
    "description": "Microsoft Sentinel: the platform block.",
    "body": ["", "  #enabled: false", "  schema: platform::sentinel::1.0", "  status: \${1:status}"]
  },
  "Fixed upstream": { "prefix": "tide-splunk", "scope": "yaml,opentide-yaml", "body": ["", "  status: x"] },
  "Unscoped": { "prefix": "tide-threat", "body": "name: x" },
  "Other": { "prefix": "mine", "scope": "yaml", "body": "x" }
}`;

describe("new-object: snippets", () => {
  it("parses JSON with comments and trailing commas, keeping // inside strings", () => {
    assert.deepEqual(parseJsonc('{ "a": "http://x", /* c */ "b": [1,], }'), { a: "http://x", b: [1] });
  });

  it("offers only the tide-* snippets VS Code does not serve in opentide-yaml", () => {
    const missing = tideSnippets(FILE);
    assert.deepEqual(
      missing.map((s) => s.prefix),
      ["tide-rule", "tide-sentinel"],
    );
    assert.equal(missing[0]?.body, ["name: $", "{1:name}\n\nmetadata:"].join(""));
    assert.equal(missing[0]?.platform, undefined);
    assert.equal(missing[1]?.platform, "sentinel");
  });

  it("knows every tide snippet for Add <platform> block, and which scopes VS Code serves", () => {
    assert.deepEqual(
      tideSnippets(FILE, true).map((s) => s.prefix),
      ["tide-rule", "tide-sentinel", "tide-splunk", "tide-threat"],
    );
    assert.ok(servedNatively("yaml,opentide-yaml"));
    assert.ok(servedNatively(undefined));
    assert.ok(!servedNatively("yaml"));
    assert.deepEqual(tideSnippets("not json"), []);
  });

  it("indents a platform block under configurations:", () => {
    assert.equal(
      indentBlock("\n  #enabled: false\n  status: x", "  "),
      "\n    #enabled: false\n    status: x",
    );
    assert.equal(configurationsLine(["name: x", "configurations:", "  sentinel:"]), 1);
    assert.equal(configurationsLine(["  configurations:"]), undefined);
  });
});
