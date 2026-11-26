// The bridge from opentide's opentide-yaml TextMate grammar (the highlights zip) to the colours the language server's
// semantic tokens give the same text. Since opentide 1.0.0-rc.5 the zip's grammar has the YAML structure itself:
// keys, the colon, list dashes, plain values, enumerations, UUIDs, booleans, Markdown in descriptions, and the
// embedded queries of the platforms whose path fixes their language (opentide#1840, #1841, #1842).
//
// What it has not: the language of an Elastic rule's query, which `type:` (esql, eql) or `language:` (kuery,
// lucene) names on an earlier line (opentide#1809, item 2). This script embeds that language's grammar, with the
// scopes and the shape of the zip's own inline query rule. Run by scripts/grammars-lib.mjs on `tide.tmLanguage.json`,
// so `npm run grammars --check` still tells a stale copy.
//
// When the zip has the Elastic rules, `alignTide` finds its anchors changed and fails instead of applying them twice:
// delete that part then.
//
// It also renames the zip's scopes of keys, values and enumerations (RENAMES), so that a rule looks like a YAML file in
// every theme, not only in VS Code's own; the rename belongs in opentide's generator too:
// - A key is `entity.name.tag.yaml`, a YAML key. The zip's `variable.other.property` is the default foreground in
//   GitHub, Dracula, Monokai and Catppuccin, which leave `variable.other` plain.
// - A value, plain, quoted or block, is a YAML value (`string.unquoted.plain.out.yaml`): Light+ and Light Modern
//   colour those blue apart from other strings, which are dark red like their keys.
// - An enumeration value adds `support.constant` under the zip's `variable.other.enummember`, which Dracula and
//   Monokai leave plain: a theme with no rule for `support.constant` keeps the enummember colour.

/** The scopes of the zip's grammar, which contrib/highlighting.json maps the semantic token types to. */
export const PROPERTY = "variable.other.property.tide";
export const OPERATOR = "punctuation.separator.key-value.tide";
export const OPERATOR_LIST = "punctuation.definition.list.begin.tide";
export const STRING = "string.unquoted.plain.tide";
export const ENUM_MEMBER = "variable.other.enummember.tide";
export const UUID_NUMBER = "constant.numeric.uuid.tide";
export const STRING_BLOCK = "string.unquoted.block.tide";
export const HEADING = "entity.name.type.markdown.tide";
export const CODE = "variable.other.constant.markdown.tide";

/** The zip's scope of a quoted value. */
export const STRING_QUOTED = "string.quoted.opentide";

/** What a key, a value and an enumeration value are once aligned; contrib/highlighting.json lists them first. */
export const KEY = "entity.name.tag.yaml.tide";
export const VALUE = "string.unquoted.plain.out.yaml.tide";
export const VALUE_BLOCK = "string.unquoted.block.yaml.tide";
export const ENUM_VALUE = "support.constant.enum.tide";

/** The zip's scope → the scope(s) the aligned grammar has instead (a space pushes both, the last innermost). */
export const RENAMES = {
  [PROPERTY]: KEY,
  [STRING]: VALUE,
  [STRING_BLOCK]: VALUE_BLOCK,
  // The server's `string` is the text between the quotes: the quotes take its colour too.
  [STRING_QUOTED]: `${STRING_QUOTED} ${VALUE}`,
  [ENUM_MEMBER]: `${ENUM_MEMBER} ${ENUM_VALUE}`,
};

/** The embedded-language scope names the added rules use, with the language id VS Code needs for each. */
export const EMBEDDED = {
  "meta.embedded.block.eql": "eql",
  "meta.embedded.block.esql": "esql",
  "meta.embedded.block.kuery": "kuery",
};

const CAPTURE = (name) => ({ name });

export const QUOTE_BEGIN = "string.quoted.yaml punctuation.definition.string.begin.yaml";
export const QUOTE_END = "string.quoted.yaml punctuation.definition.string.end.yaml";

/**
 * An inline query value from capture group `n` on: `'…'` or `"…"` with its quotes apart and the text between them
 * embedded, or a plain value. A trailing comment is left to the comment rule that follows, as in the zip.
 */
function inlineQuery(n, embedded, scope) {
  const query = { name: embedded, patterns: [{ include: scope }] };
  return {
    regex: `(?:(['"])(.*)(\\${n})|(.+?))(?=[ \\t]+#|[ \\t]*$)`,
    captures: {
      [n]: CAPTURE(QUOTE_BEGIN),
      [n + 1]: query,
      [n + 2]: CAPTURE(QUOTE_END),
      [n + 3]: query,
    },
  };
}

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

/** An Elastic rule's query, embedded once `type:` or `language:` has said which language it is. */
function languageRule({ key, value, scope, embedded }, comment) {
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
          match: `^(\\s+)(query)(\\s*)(:)\\s+(?![|>])${inlineQuery(5, embedded, scope).regex}`,
          captures: {
            2: CAPTURE(PROPERTY),
            4: CAPTURE(OPERATOR),
            ...inlineQuery(5, embedded, scope).captures,
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
    patterns: [query("block"), query("inline"), comment, { include: "$self" }],
  };
}

const ELASTIC_LANGUAGES = [
  { key: "type", value: "esql", scope: "source.opentide.esql", embedded: "meta.embedded.block.esql" },
  { key: "type", value: "eql", scope: "source.eql", embedded: "meta.embedded.block.eql" },
  { key: "language", value: "kuery", scope: "source.kuery", embedded: "meta.embedded.block.kuery" },
  { key: "language", value: "lucene", scope: "source.lucene", embedded: "meta.embedded.block.lucene" },
];

/**
 * Apply the bridge to the parsed `tide.tmLanguage.json`. Throws `Failure` (an error class) with what changed when the
 * grammar is not the one this was written for.
 */
export function alignTide(grammar, Failure = Error) {
  // What the zip must have: the structure rules this bridge no longer adds.
  const property = ruleOf(grammar, "capture:tide.property", Failure);
  if (property.captures?.[4]?.name !== PROPERTY || property.captures?.[6]?.name !== OPERATOR)
    fail(Failure, "the key rule does not scope the key and its colon as expected");
  const configurations = grammar.patterns[0];
  if (!configurations?.begin?.startsWith("^(configurations)"))
    fail(Failure, "the first rule is not configurations");
  // The rule that colours a comment after a value, which the zip's platform blocks carry.
  const comment = configurations.patterns
    .flatMap((platform) => platform.patterns ?? [])
    .find((rule) => rule.comment === "capture:comment");
  if (!comment) fail(Failure, "no trailing-comment rule under configurations");
  const last = configurations.patterns.at(-1);
  if (last?.include !== "$self") fail(Failure, "the configurations rule does not end with $self");
  if (configurations.patterns.some((pattern) => /elastic/.test(pattern.begin ?? "")))
    fail(Failure, "the zip has Elastic rules of its own");

  // Elastic: the language of the query, once `type:` or `language:` has said it.
  configurations.patterns.splice(-1, 0, {
    comment:
      "configurations.elastic: the query's language follows `type:` (esql, eql) or `language:` (kuery, lucene) when that line is first",
    begin: "^(\\s+)(elastic)(\\s*)(:)\\s*(?:#.*)?$",
    beginCaptures: { 2: CAPTURE(PROPERTY), 4: CAPTURE(OPERATOR) },
    end: "^(?!\\1\\s+\\S|\\s*$)",
    patterns: [
      ...ELASTIC_LANGUAGES.map((language) => languageRule(language, structuredClone(comment))),
      { include: "$self" },
    ],
  });

  renameScopes(grammar);
  grammar.opentideHandoff = "the language of an Elastic rule's query";
  return grammar;
}

/** Apply RENAMES to every `name` and `contentName`, in place, scope by scope. */
export function renameScopes(node) {
  if (Array.isArray(node)) {
    for (const item of node) renameScopes(item);
    return node;
  }
  if (node === null || typeof node !== "object") return node;
  for (const [key, value] of Object.entries(node)) {
    if ((key === "name" || key === "contentName") && typeof value === "string")
      node[key] = value
        .split(" ")
        .map((scope) => RENAMES[scope] ?? scope)
        .join(" ");
    else renameScopes(value);
  }
  return node;
}
