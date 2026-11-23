// Aligns the opentide-yaml TextMate grammar of the highlights zip with the colours the language server's semantic
// tokens give the same text, so that when the server's tokens land (seconds after the grammar's; measured in VS Code 1.147 by
// the QA report docs/qa/highlighting-v0.3.0.md, on the branch test/wasi-e2e-2026-11-21 only) the YAML structure does not change colour. Run by
// scripts/grammars-lib.mjs on `tide.tmLanguage.json`, so `npm run grammars --check` still tells a stale copy.
//
// The rule it keeps: for each construct, the grammar's last scope is one VS Code's theme resolves like the default
// TextMate scope of the semantic token type the server gives that construct (the table in HANDOFF below), in every
// theme, not only in Dark+ and Light+.
//
//   construct                                server token type    grammar scope (last)
//   `key`                                    property             variable.other.property.tide
//   the `:` after a key, a list dash         operator             keyword.operator.*.tide
//   a plain value, a flow collection         string               string.unquoted.plain.tide
//   a date, `1h`, `platform::x::1.0`         string               (a plain value, as above)
//   a UUID                                   number               constant.numeric.uuid.tide
//   true, false                              enumMember           variable.other.enummember.tide
//   tlp, alert_severity, language and an
//   Elastic `type:` value from their sets    enumMember           variable.other.enummember.tide
//   a schema such as rule::1.0               type                 entity.name.type.schema.tide
//
// What a grammar cannot know stays with the server: which other fields hold an enumeration (their values are
// `enumMember` there, plain strings here), and the language of a query that no earlier line of its rule names.
//
// It also names the language of an Elastic rule's query when `type:` (esql, eql) or `language:` (kuery, lucene) is
// written before `query:`, as the templates write `type`, and embeds that language's grammar.
//
// The fix belongs upstream: the generator of `tide.tmLanguage.json` in opentide (`crates/opentide-highlight`, from
// `highlights/spec.toml`) should emit these scopes and rules itself. This script is the bridge until it does; when the
// zip already has them, `alignTide` finds its anchors changed and fails instead of applying them twice.

export const PROPERTY = "variable.other.property.tide";
export const OPERATOR = "keyword.operator.key-value.tide";
export const OPERATOR_LIST = "keyword.operator.list.markdown.tide";
export const STRING = "string.unquoted.plain.tide";
export const ENUM_MEMBER = "variable.other.enummember.tide";
export const UUID_NUMBER = "constant.numeric.uuid.tide";
export const STRING_BLOCK = "string.unquoted.block.tide";
export const HEADING = "entity.name.type.markdown.tide";
export const CODE = "constant.regexp.markdown.tide";
export const KEYWORD = "keyword.other.opentide";

/** The embedded-language scope names the added rules use, with the language id VS Code needs for each. */
export const EMBEDDED = {
  "meta.embedded.block.eql": "eql",
  "meta.embedded.block.esql": "esql",
  "meta.embedded.block.kuery": "kuery",
};

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const SCHEMA = "[A-Za-z][A-Za-z0-9_]*::[0-9.]+";
/** End of a value: blanks, then a comment or the end of the line. */
const END = "[ \\t]*(?:#.*)?$";
/** A value of one of these kinds is left to the rules for numbers, UUIDs, booleans and schemas. */
const NOT_PLAIN =
  `(?!["'|>&*!%@\`#])` +
  `(?!(?:true|false|null|~)${END})` +
  `(?![0-9]+(?:\\.[0-9]+)?${END})` +
  `(?!${UUID}${END})` +
  `(?!${SCHEMA}${END})`;
/** Fields whose block scalar is Markdown text, which the server colours as strings (with its Markdown marks). */
const TEXT_KEYS = "description|analysis|investigation|setup";
const KEY = "[A-Za-z0-9_][A-Za-z0-9_.-]*";
const PLAIN_VALUE = "(\\S.*?)(?=[ \\t]+#|[ \\t]*$)";

/** Values that are enumerations in every rule, from their documented vocabularies. */
const ENUMS = [
  { key: "tlp", values: "clear|white|green|amber\\+strict|amber|red" },
  { key: "alert_severity", values: "Informational|Low|Medium|High|Critical" },
  { key: "language", values: "kuery|lucene" },
];

const CAPTURE = (name) => ({ name });

function fail(Failure, message) {
  throw new Failure(
    `tide.tmLanguage.json: ${message}; the highlights zip changed, update scripts/tide-align.mjs`,
  );
}

/** The top-level rule with this `comment`, or a failure naming it. */
function ruleOf(grammar, comment, Failure) {
  const rule = grammar.patterns.find((pattern) => pattern.comment === comment);
  if (!rule) fail(Failure, `no rule with comment ${JSON.stringify(comment)}`);
  return rule;
}

/** `old` -> `old new` on a rule's name, so another consumer of the old scope still finds it. */
function addScope(rule, old, added, Failure) {
  if (rule.name !== old)
    fail(Failure, `rule ${rule.comment} is named ${JSON.stringify(rule.name)}, expected ${old}`);
  rule.name = `${old} ${added}`;
}

/**
 * Give the colon after the key its own capture in a rule whose regex is `<key group>\s*:` and whose captures name the
 * key `variable.other.property.tide`: `\s*:` becomes `\s*(:)` and the captures after the key shift by one.
 */
function splitColon(rule, mapKey, Failure) {
  const captures = rule[mapKey];
  const regexKey = mapKey === "beginCaptures" ? "begin" : "match";
  if (!captures) return;
  const keyGroup = Number(
    Object.entries(captures).find(([, capture]) => capture.name === PROPERTY)?.[0] ?? Number.NaN,
  );
  if (!Number.isInteger(keyGroup)) return;
  const regex = rule[regexKey];
  // The key group is followed at once by `\s*:`: the groups before the colon are the ones counted.
  let groups = 0;
  let at = -1;
  for (let i = 0; i < regex.length; i++) {
    if (regex[i] === "\\") {
      i += 1;
      continue;
    }
    if (regex[i] === "[") {
      while (i < regex.length && regex[i] !== "]") i += regex[i] === "\\" ? 2 : 1;
      continue;
    }
    if (regex[i] === "(" && regex[i + 1] !== "?") {
      groups += 1;
      if (groups === keyGroup) {
        let depth = 0;
        for (let j = i; j < regex.length; j++) {
          if (regex[j] === "\\") j += 1;
          else if (regex[j] === "(") depth += 1;
          else if (regex[j] === ")" && --depth === 0) {
            at = j + 1;
            break;
          }
        }
        break;
      }
    }
  }
  if (at < 0 || !regex.startsWith("\\s*:", at))
    fail(Failure, `rule ${rule.comment ?? regex} has no \`\\s*:\` after its key`);
  rule[regexKey] = `${regex.slice(0, at)}\\s*(:)${regex.slice(at + "\\s*:".length)}`;
  const shifted = {};
  for (const [index, capture] of Object.entries(captures)) {
    const n = Number(index);
    shifted[n > keyGroup ? n + 1 : n] = capture;
  }
  shifted[keyGroup + 1] = CAPTURE(OPERATOR);
  rule[mapKey] = Object.fromEntries(Object.entries(shifted).sort(([a], [b]) => Number(a) - Number(b)));
}

/** Every begin/end and match rule below `rules` that names a key, with its colon split off. */
function splitColons(rules, Failure) {
  for (const rule of rules) {
    if (typeof rule !== "object" || rule === null) continue;
    if (rule.beginCaptures) splitColon(rule, "beginCaptures", Failure);
    else if (rule.captures && rule.match) splitColon(rule, "captures", Failure);
    if (rule.patterns) splitColons(rule.patterns, Failure);
  }
}

/** `key: value` and `- key: value` lines: the key, its colon and a plain value. */
function keyRule() {
  return {
    comment: "handoff:key-value",
    match: `^(\\s*)(?:(-)(\\s+))?(${KEY})(\\s*)(:)(?=\\s|$)` + `(?:([ \\t]+)${NOT_PLAIN}${PLAIN_VALUE})?`,
    captures: {
      2: CAPTURE(OPERATOR_LIST),
      4: CAPTURE(PROPERTY),
      6: CAPTURE(OPERATOR),
      8: CAPTURE(STRING),
    },
  };
}

/** A list item that is a plain value: `- text`. */
function sequenceRule() {
  return {
    comment: "handoff:sequence-item",
    match: `^(\\s*)(-)(\\s+)(?!${KEY}[ \\t]*:(?:\\s|$))${NOT_PLAIN}${PLAIN_VALUE}`,
    captures: { 2: CAPTURE(OPERATOR_LIST), 4: CAPTURE(STRING) },
  };
}

/** The value of an enumerated field: `tlp: amber`. */
function enumRules() {
  return ENUMS.map(({ key, values }) => ({
    comment: `handoff:enum:${key}`,
    match: `^(\\s*)(?:(-)(\\s+))?(${key})(\\s*)(:)([ \\t]+)(${values})(?=${END})`,
    captures: {
      2: CAPTURE(OPERATOR_LIST),
      4: CAPTURE(PROPERTY),
      6: CAPTURE(OPERATOR),
      8: CAPTURE(ENUM_MEMBER),
    },
  }));
}

/**
 * `key: |` and `key: >`. The text below is not YAML. A description is Markdown text, which the server colours as strings
 * with its own marks for headings, code and lists. Any other (a query, a Falco output, YARA strings) is left to the
 * server: only the old rules for numbers, strings and the rest apply in it.
 */
function blockScalarRules(otherText, markdown) {
  // `- key: |`: the text is deeper than the key, which is two columns past the dash.
  const begin = (key, dash) =>
    dash
      ? `^(\\s*)(-)(\\s)(${key})(\\s*)(:)(\\s*)[|>][-+0-9]*\\s*(?:#.*)?$`
      : `^(\\s*)(${key})(\\s*)(:)(\\s*)[|>][-+0-9]*\\s*(?:#.*)?$`;
  const captures = (dash) =>
    dash
      ? { 2: CAPTURE(OPERATOR_LIST), 4: CAPTURE(PROPERTY), 6: CAPTURE(OPERATOR) }
      : { 2: CAPTURE(PROPERTY), 4: CAPTURE(OPERATOR) };
  const end = (dash) => (dash ? "^(?!\\1\\s\\s\\s+\\S|\\s*$)" : "^(?!\\1\\s+\\S|\\s*$)");
  const rules = [];
  for (const dash of [false, true]) {
    rules.push(
      {
        comment: `handoff:block-scalar:text${dash ? ":item" : ""}`,
        begin: begin(TEXT_KEYS, dash),
        beginCaptures: captures(dash),
        contentName: STRING_BLOCK,
        end: end(dash),
        patterns: markdown,
      },
      {
        comment: `handoff:block-scalar${dash ? ":item" : ""}`,
        begin: begin(KEY, dash),
        beginCaptures: captures(dash),
        end: end(dash),
        patterns: otherText,
      },
    );
  }
  return rules;
}

/** An Elastic rule's query, embedded once `type:` or `language:` has said which language it is. */
function languageRule({ key, value, scope, embedded }) {
  const query = (indicator) => ({
    comment: `elastic ${key}: ${value} query (${indicator})`,
    ...(indicator === "block"
      ? {
          begin: "^(\\s+)(query)(\\s*)(:)\\s*[|>][-+0-9]*\\s*(?:#.*)?$",
          beginCaptures: { 2: CAPTURE(PROPERTY), 4: CAPTURE(OPERATOR) },
          contentName: embedded,
          end: "^(?!\\1\\s+\\S|\\s*$)",
          patterns: [{ include: scope }],
        }
      : {
          match: "^(\\s+)(query)(\\s*)(:)\\s+(?![|>])(.+?)(?=[ \\t]+#|[ \\t]*$)",
          captures: {
            2: CAPTURE(PROPERTY),
            4: CAPTURE(OPERATOR),
            5: { name: embedded, patterns: [{ include: scope }] },
          },
        }),
  });
  return {
    comment: `configurations.elastic ${key}: ${value}: the query is ${embedded.split(".").pop()} (written after it)`,
    begin: `^(\\s+)(${key})(\\s*)(:)(\\s*)(${value})(\\s*)(?:#.*)?$`,
    beginCaptures: {
      2: CAPTURE(PROPERTY),
      4: CAPTURE(OPERATOR),
      6: CAPTURE(ENUM_MEMBER),
    },
    // The rest of the Elastic block: the lines at the indentation of this one or deeper.
    end: "^(?!\\1|\\s*$)",
    patterns: [query("block"), query("inline"), { include: "$self" }],
  };
}

/** A query of an Elastic rule whose language no earlier line names: the key, and the value left to the server. */
function elasticQueryRule() {
  return {
    comment: "configurations.elastic: a query with no language written before it is left to the server",
    // not a block scalar: `query: |` is the generic block rule's, so its text is not read as YAML
    match: "^(\\s*)(?:(-)(\\s+))?(query)(\\s*)(:)(?!\\s*[|>][-+0-9]*\\s*(?:#.*)?$)",
    captures: { 2: CAPTURE(OPERATOR_LIST), 4: CAPTURE(PROPERTY), 6: CAPTURE(OPERATOR) },
  };
}

const ELASTIC_LANGUAGES = [
  { key: "type", value: "esql", scope: "source.opentide.esql", embedded: "meta.embedded.block.esql" },
  { key: "type", value: "eql", scope: "source.eql", embedded: "meta.embedded.block.eql" },
  { key: "language", value: "kuery", scope: "source.kuery", embedded: "meta.embedded.block.kuery" },
  { key: "language", value: "lucene", scope: "source.lucene", embedded: "meta.embedded.block.lucene" },
];

/**
 * The query-language grammars: the server gives a keyword the type `keyword`, whose scope is `keyword`, not
 * `keyword.control` (purple in Dark+, blue for `keyword`), so a keyword the grammar colours does not change colour
 * when the server's tokens land.
 */
export function alignQuery(grammar) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    if (node.name === "keyword.control.opentide") node.name = `keyword.control.opentide ${KEYWORD}`;
    for (const value of Object.values(node)) walk(value);
  };
  walk(grammar);
  return grammar;
}

/**
 * Apply the alignment to the parsed `tide.tmLanguage.json`. Throws `Failure` (an error class) with what changed when the
 * grammar is not the one this was written for.
 */
export function alignTide(grammar, Failure = Error) {
  if (grammar.patterns?.some((pattern) => pattern.comment?.startsWith("handoff:"))) {
    fail(Failure, "the grammar already has the handoff rules");
  }
  // 1. Scopes: a colon of its own, a UUID as a number, booleans as enumeration members, list dashes as operators.
  const known = ruleOf(grammar, "capture:tide.property", Failure);
  if (known.name !== PROPERTY) fail(Failure, `the known-keys rule is named ${known.name}`);
  const keys = /^\(\?m\)\^\\s\*\(\?:(.+)\)\\s\*:$/s.exec(known.match);
  if (!keys) fail(Failure, "the known-keys rule is not `(?m)^\\s*(?:keys)\\s*:`");
  known.match = `(?m)^\\s*((?:${keys[1]}))\\s*(:)`;
  known.captures = { 1: CAPTURE(PROPERTY), 2: CAPTURE(OPERATOR) };
  delete known.name;
  addScope(ruleOf(grammar, "capture:tide.uuid", Failure), "constant.other.uuid.tide", UUID_NUMBER, Failure);
  addScope(
    ruleOf(grammar, "capture:boolean", Failure),
    "constant.language.boolean.opentide",
    ENUM_MEMBER,
    Failure,
  );
  addScope(
    ruleOf(grammar, "capture:markdown.list", Failure),
    "punctuation.definition.list.markdown.tide",
    OPERATOR_LIST,
    Failure,
  );
  addScope(
    ruleOf(grammar, "capture:markdown.heading", Failure),
    "markup.heading.markdown.tide",
    HEADING,
    Failure,
  );
  addScope(
    ruleOf(grammar, "capture:markdown.code", Failure),
    "markup.inline.raw.markdown.tide",
    CODE,
    Failure,
  );
  // A UUID that starts with digits would be taken for a number if the number rule came first.
  const uuid = ruleOf(grammar, "capture:tide.uuid", Failure);
  const number = ruleOf(grammar, "capture:number", Failure);
  grammar.patterns.splice(grammar.patterns.indexOf(uuid), 1);
  grammar.patterns.splice(grammar.patterns.indexOf(number), 0, uuid);

  // 2. The colon of every key the embedded-query rules name.
  const configurations = grammar.patterns[0];
  if (!configurations?.begin?.startsWith("^(configurations)"))
    fail(Failure, "the first rule is not configurations");
  splitColons([configurations], Failure);

  // 3. Elastic: the language of the query, once `type:` or `language:` has said it.
  const last = configurations.patterns.at(-1);
  if (last?.include !== "$self") fail(Failure, "the configurations rule does not end with $self");
  configurations.patterns.splice(-1, 0, {
    comment:
      "configurations.elastic: the query's language follows `type:` (esql, eql) or `language:` (kuery, lucene) when that line is first",
    begin: "^(\\s+)(elastic)(\\s*)(:)\\s*(?:#.*)?$",
    beginCaptures: { 2: CAPTURE(PROPERTY), 4: CAPTURE(OPERATOR) },
    end: "^(?!\\1\\s+\\S|\\s*$)",
    patterns: [...ELASTIC_LANGUAGES.map(languageRule), elasticQueryRule(), { include: "$self" }],
  });

  // 4. YAML structure: keys, plain values and list items. Inside a block scalar only the rules for text apply.
  const index = grammar.patterns.findIndex((pattern) => pattern.comment === "capture:comment");
  if (index < 0) fail(Failure, "no comment rule");
  const otherText = structuredClone(
    grammar.patterns.filter((pattern) => pattern !== configurations && pattern !== known),
  );
  const markdown = structuredClone(
    ["capture:markdown.heading", "capture:markdown.code", "capture:markdown.list"].map((comment) =>
      ruleOf(grammar, comment, Failure),
    ),
  );
  grammar.patterns.splice(
    index + 1,
    0,
    ...blockScalarRules(otherText, markdown),
    ...enumRules(),
    keyRule(),
    sequenceRule(),
  );

  grammar.opentideHandoff = "keys, colons and values as the server's semantic tokens colour them";
  return grammar;
}
