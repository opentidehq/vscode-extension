// The handoff from the TextMate grammar to the language server's semantic tokens (docs/qa/highlighting-v0.3.0.md on
// test/wasi-e2e-2026-11-21): the YAML structure must have the colours before the server's tokens that it has after.
// The grammar (syntaxes/tide.tmLanguage.json, from scripts/tide-align.mjs) is run here with vscode-textmate, the
// tokenizer VS Code uses, and every token of representative rules is checked against the semantic token type the
// server gives the same text (taken from a run of the server on these rules).
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { alignTide } from "../../scripts/tide-align.mjs";

const require = createRequire(import.meta.url);
const vsctm = require("vscode-textmate");
const onig = require("vscode-oniguruma");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The types of the server's legend: opentide's `LSP_TOKEN_TYPES`, which `initialize` declares. */
const LEGEND = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
];

const SCOPE_BY_NAME = new Map(pkg.contributes.grammars.map((g) => [g.scopeName, g.path]));

async function makeRegistry() {
  const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
  await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  return new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new onig.OnigScanner(patterns),
      createOnigString: (text) => new onig.OnigString(text),
    }),
    loadGrammar: async (scope) => {
      const path = SCOPE_BY_NAME.get(scope);
      return path ? vsctm.parseRawGrammar(readFileSync(join(root, path), "utf8"), path) : null;
    },
  });
}

/** Tokenize a document: per line, the tokens with their text and their scopes (the grammar's own scope first). */
async function tokenize(text) {
  const grammar = await (await makeRegistry()).loadGrammar("source.opentide-yaml");
  let state = vsctm.INITIAL;
  return text.split("\n").map((line) => {
    const result = grammar.tokenizeLine(line, state);
    state = result.ruleStack;
    const tokens = result.tokens.map((token) => ({
      text: line.slice(token.startIndex, token.endIndex),
      start: token.startIndex,
      end: token.endIndex,
      scopes: token.scopes.slice(1),
    }));
    return Object.assign(tokens, { line });
  });
}

/**
 * The token of the first line that contains `row` which covers `text` (its first occurrence in that line, or the
 * `nth`): the scopes of what a reader sees at that text.
 */
function tokenAt(lines, row, text, nth = 0) {
  const tokens = lines.find((line) => line.line.includes(row));
  assert.ok(tokens, `no line contains ${JSON.stringify(row)}`);
  let offset = -1;
  for (let i = 0; i <= nth; i++) offset = tokens.line.indexOf(text, offset + 1);
  assert.ok(offset >= 0, `${JSON.stringify(row)} has no ${JSON.stringify(text)}`);
  const token = tokens.find((t) => t.start <= offset && offset < t.end);
  assert.ok(token, `no token at ${offset} of ${JSON.stringify(tokens.line)}`);
  return token;
}

const lastScope = (lines, row, text, nth) => tokenAt(lines, row, text, nth).scopes.at(-1);
const scopesOf = (lines, row, text, nth) => tokenAt(lines, row, text, nth).scopes;

const KQL_RULE = `name: HL KQL

metadata:
  uuid: 6bd65871-e768-4bb7-875b-570909c287a5
  schema: rule::1.0
  version: 1
  created: 2026-11-22
  tlp: amber
  author: qa
  contributors:
    - Acme
    - qa

description: Processes opening a handle to lsass.exe.

detection_model: 00000000-0000-4000-8006-000000000007

response:
  alert_severity: Informational

configurations:
  sentinel:
    schema: platform::sentinel::1.0
    status: STAGING
    enabled: true
    query: |
      SecurityEvent
      | where TimeGenerated > ago(1d)
    scheduling:
      interval: 1h
      fields: [proc.name, proc.pname]
`;

const ESQL_RULE = `name: HL ESQL

description: |
  # What it finds
  Elastic ESQL with \`code\` and a list:
  - one

configurations:
  elastic:
    schema: platform::elastic::1.0
    status: STAGING
    type: esql
    query: |
      FROM logs-* | WHERE process.name == "cmd.exe"
    scheduling:
      interval: PT1H
`;

/** What the server's semantic token type is for the text on a line, from a run of the server on these rules. */
const KQL_TYPES = [
  // [a text of the line, the text, the server's token type]
  ["name: HL KQL", "name", "property"],
  ["name: HL KQL", "HL KQL", "string"],
  ["uuid: 6bd65871", "uuid", "property"],
  ["uuid: 6bd65871", "6bd65871-e768-4bb7-875b-570909c287a5", "number"],
  ["schema: rule::1.0", "rule::1.0", "type"],
  ["version: 1", "1", "number"],
  ["created: 2026-11-22", "2026-11-22", "string"],
  ["tlp: amber", "amber", "enumMember"],
  ["author: qa", "qa", "string"],
  ["description: Processes", "Processes opening a handle to lsass.exe.", "string"],
  ["detection_model:", "00000000-0000-4000-8006-000000000007", "number"],
  ["alert_severity:", "Informational", "enumMember"],
  ["schema: platform::sentinel", "platform::sentinel::1.0", "string"],
  ["status: STAGING", "STAGING", "string"],
  ["enabled: true", "true", "enumMember"],
  ["interval: 1h", "1h", "string"],
  ["fields: [proc.name", "[proc.name, proc.pname]", "string"],
];

/** Keys, and the line each is on: the key is a property, the colon after it an operator. */
const KQL_KEYS = [
  ["uuid: 6bd65871", "uuid"],
  ["schema: rule::1.0", "schema"],
  ["status: STAGING", "status"],
  ["interval: 1h", "interval"],
  ["configurations:", "configurations"],
  ["sentinel:", "sentinel"],
  ["query: |", "query"],
];

describe("highlighting: the grammar's colours are the server's, for the YAML structure", () => {
  const tokenTypeScopes = pkg.contributes.semanticTokenScopes.find(
    (entry) => entry.language === "opentide-yaml",
  ).scopes;
  /** Whether `scope` is one a theme resolves like one of the scopes the semantic token type maps to. */
  const underType = (scope, type) =>
    tokenTypeScopes[type].some((mapped) => scope === mapped || scope.startsWith(`${mapped}.`));
  let kql;
  let esql;

  before(async () => {
    kql = await tokenize(KQL_RULE);
    esql = await tokenize(ESQL_RULE);
  });

  it("gives every construct a last scope under the scopes of the token type the server gives it", () => {
    for (const [row, text, type] of KQL_TYPES) {
      const scope = lastScope(kql, row, text);
      assert.ok(
        underType(scope, type),
        `${JSON.stringify(row)} ${JSON.stringify(text)}: the server says ${type} (${tokenTypeScopes[type]}), the grammar's last scope is ${scope}`,
      );
    }
  });

  it("splits a key from its colon: the key is a property, the colon an operator", () => {
    for (const [row, key] of KQL_KEYS) {
      assert.ok(underType(lastScope(kql, row, key), "property"), `${key}: ${lastScope(kql, row, key)}`);
      assert.ok(
        underType(lastScope(kql, row, ":"), "operator"),
        `${key}'s colon: ${lastScope(kql, row, ":")}`,
      );
    }
  });

  it("paints a date and a value that starts with digits as one string, not as numbers", () => {
    assert.equal(lastScope(kql, "created:", "2026-11-22"), "string.unquoted.plain.tide");
    assert.equal(lastScope(kql, "interval:", "1h"), "string.unquoted.plain.tide");
    // …and a UUID that starts with digits is a UUID, not a number followed by text.
    assert.equal(
      lastScope(kql, "detection_model:", "00000000-0000-4000-8006-000000000007"),
      "constant.numeric.uuid.tide",
    );
  });

  it("paints list items as the server does: the dash an operator, the value a string", () => {
    assert.ok(underType(lastScope(kql, "- Acme", "-"), "operator"), lastScope(kql, "- Acme", "-"));
    assert.equal(lastScope(kql, "- Acme", "Acme"), "string.unquoted.plain.tide");
  });

  it("paints Markdown text of a description as strings, with the marks the server gives them", () => {
    assert.ok(underType(lastScope(esql, "# What it finds", "# What it finds"), "type"));
    assert.ok(scopesOf(esql, "# What it finds", "What").includes("string.unquoted.block.tide"));
    assert.ok(underType(lastScope(esql, "Elastic ESQL with", "`code`"), "regexp"));
    assert.ok(underType(lastScope(esql, "- one", "- "), "operator"));
  });

  it("leaves a query to the embedded grammar, and the server", () => {
    const where = tokenAt(kql, "| where TimeGenerated", "where");
    assert.ok(where.scopes.includes("meta.embedded.block.kql"), JSON.stringify(where));
    // a keyword of a query grammar is the server's `keyword` too, not `keyword.control`
    assert.equal(where.scopes.at(-1), "keyword.other.opentide");
  });

  describe("Elastic queries", () => {
    const embeddedAt = (lines, row, text) =>
      scopesOf(lines, row, text).find((scope) => scope.startsWith("meta.embedded."));

    it("embeds ES|QL when `type: esql` comes before the query, and colours its keywords", () => {
      assert.equal(embeddedAt(esql, "FROM logs", "FROM"), "meta.embedded.block.esql");
      const from = tokenAt(esql, "FROM logs", "FROM");
      assert.ok(
        from.scopes.some((scope) => scope.startsWith("keyword")),
        `FROM: ${from.scopes}`,
      );
      assert.equal(from.scopes.at(-1), "keyword.other.opentide");
      // the type: line is the server's too: a key, a colon, an enumeration member
      assert.ok(underType(lastScope(esql, "type: esql", "esql"), "enumMember"));
      assert.ok(underType(lastScope(esql, "type: esql", ":"), "operator"));
    });

    it("embeds EQL for `type: eql`", async () => {
      const lines = await tokenize(
        'configurations:\n  elastic:\n    type: eql\n    query: |\n      process where process.name == "cmd.exe"\n',
      );
      assert.equal(embeddedAt(lines, "process where", "where"), "meta.embedded.block.eql");
    });

    it("embeds Kuery or Lucene for `language:` written before the query, in a block or inline", async () => {
      for (const [language, scope] of [
        ["kuery", "meta.embedded.block.kuery"],
        ["lucene", "meta.embedded.block.lucene"],
      ]) {
        const block = await tokenize(
          `configurations:\n  elastic:\n    type: query\n    language: ${language}\n    query: |\n      process.name: "cmd.exe"\n`,
        );
        assert.equal(embeddedAt(block, "process.name", '"cmd.exe"'), scope, `${language} block`);
        const inline = await tokenize(
          `configurations:\n  elastic:\n    language: ${language}\n    query: process.name: "cmd.exe"\n`,
        );
        assert.equal(embeddedAt(inline, "query: process.name", '"cmd.exe"'), scope, `${language} inline`);
        assert.ok(underType(lastScope(block, "language:", language), "enumMember"), language);
      }
    });

    it("falls back to the server when the language is written after the query, or not at all", async () => {
      for (const text of [
        "configurations:\n  elastic:\n    type: query\n    query: |\n      process.name: x\n    language: kuery\n",
        "configurations:\n  elastic:\n    status: STAGING\n    query: |\n      process.name: x\n",
        "configurations:\n  elastic:\n    query: process.name: x\n",
      ]) {
        for (const line of await tokenize(text))
          for (const token of line)
            assert.equal(
              token.scopes.some((scope) => scope.startsWith("meta.embedded.")),
              false,
              `${JSON.stringify(text)}: ${JSON.stringify(token)}`,
            );
      }
    });

    it("keeps the language to the Elastic block: another platform's `type: esql` embeds nothing esql", async () => {
      const lines = await tokenize(
        "configurations:\n  sentinel:\n    type: esql\n    query: |\n      FROM x\n",
      );
      assert.notEqual(embeddedAt(lines, "FROM x", "FROM"), "meta.embedded.block.esql");
    });

    it("ends the language with the Elastic block", async () => {
      const lines = await tokenize(
        "configurations:\n  elastic:\n    type: esql\n    query: |\n      FROM x\n  sentinel:\n    query: |\n      SecurityEvent\n",
      );
      assert.equal(embeddedAt(lines, "FROM x", "FROM"), "meta.embedded.block.esql");
      assert.equal(embeddedAt(lines, "SecurityEvent", "SecurityEvent"), "meta.embedded.block.kql");
    });
  });

  describe("the manifest", () => {
    it("maps every token type of the server's legend to scopes, for opentide-yaml", () => {
      assert.deepEqual(Object.keys(tokenTypeScopes).sort(), [...LEGEND].sort());
      for (const [type, scopes] of Object.entries(tokenTypeScopes)) {
        assert.ok(scopes.length > 0, type);
        for (const scope of scopes) assert.match(scope, /^[a-z][a-z.-]*[a-z]$/, `${type}: ${scope}`);
      }
    });

    it("tells VS Code the language of every embedded scope the grammar uses", () => {
      const grammar = pkg.contributes.grammars.find((g) => g.language === "opentide-yaml");
      const text = readFileSync(join(root, "syntaxes", "tide.tmLanguage.json"), "utf8");
      const used = new Set(text.match(/meta\.embedded\.block\.[a-z]+/g));
      assert.ok(used.size >= 8, [...used].join());
      for (const scope of used) assert.ok(grammar.embeddedLanguages[scope], `${scope} has no language id`);
      assert.equal(grammar.embeddedLanguages["meta.embedded.block.esql"], "esql");
      assert.equal(grammar.embeddedLanguages["meta.embedded.block.eql"], "eql");
      assert.equal(grammar.embeddedLanguages["meta.embedded.block.kuery"], "kuery");
    });

    it("lists the server's legend as the module declares it, when the module is built", async function () {
      const wasm = join(root, "dist", "wasi", "opentide.wasm");
      if (!existsSync(wasm)) this.skip();
      const child = spawn(
        process.execPath,
        [join(root, "dist", "wasi", "launcher.cjs"), wasm, "lsp", "start"],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      const legend = await new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const timer = setTimeout(() => reject(new Error("no initialize result in 30 s")), 30_000);
        child.stdout.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          const header = buffer.indexOf("\r\n\r\n");
          if (header < 0) return;
          const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString())[1]);
          if (buffer.length < header + 4 + length) return;
          clearTimeout(timer);
          const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString());
          resolve(message.result.capabilities.semanticTokensProvider.legend.tokenTypes);
        });
        const body = Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { processId: null, rootUri: null, capabilities: {} },
          }),
        );
        child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        child.stdin.write(body);
      }).finally(() => child.kill());
      assert.deepEqual(
        [...legend].sort(),
        Object.keys(tokenTypeScopes).sort(),
        "the server declares a token type that semanticTokenScopes does not map (or the reverse)",
      );
    });
  });

  it("refuses a grammar that already has the handoff rules, instead of applying them twice", () => {
    const aligned = JSON.parse(readFileSync(join(root, "syntaxes", "tide.tmLanguage.json"), "utf8"));
    assert.throws(() => alignTide(aligned, Error), /already has the handoff rules/);
  });
});
