// The colours VS Code gives opentide's highlighting, measured without VS Code: the TextMate grammars run with
// vscode-textmate under a theme, and the language server's semantic tokens (a snapshot, test/fixtures/highlighting)
// are laid over them the way VS Code resolves them (ColorThemeData.getTokenStyle: the theme's semanticTokenColors, then
// contributes.semanticTokenScopes, then VS Code's own TextMate fallbacks). Used by test/scripts/highlighting-contrast.test.mjs
// and scripts/highlighting-contrast.mjs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** The themes the gate holds to its thresholds: VS Code's defaults (test/fixtures/highlighting/themes). */
export const DEFAULT_THEMES = [
  { label: "Dark Modern", file: "dark_modern.json", uiTheme: "vs-dark" },
  { label: "Light Modern", file: "light_modern.json", uiTheme: "vs" },
  { label: "Dark+", file: "dark_plus.json", uiTheme: "vs-dark" },
  { label: "Light+", file: "light_plus.json", uiTheme: "vs" },
  { label: "High Contrast Dark", file: "hc_black.json", uiTheme: "hc-black" },
  { label: "High Contrast Light", file: "hc_light.json", uiTheme: "hc-light" },
];

/**
 * Popular themes of the Marketplace (test/fixtures/highlighting/themes/popular). Their palettes are their authors'
 * choice, contrast included: a rule is held to look no plainer than a YAML file in the same theme (yamlFailures).
 */
export const POPULAR_THEMES = [
  { label: "GitHub Dark Default", file: "popular/github-dark-default.json", uiTheme: "vs-dark" },
  { label: "GitHub Light Default", file: "popular/github-light-default.json", uiTheme: "vs" },
  { label: "One Dark Pro", file: "popular/one-dark-pro.json", uiTheme: "vs-dark" },
  { label: "Dracula", file: "popular/dracula.json", uiTheme: "vs-dark" },
  { label: "Catppuccin Mocha", file: "popular/catppuccin-mocha.json", uiTheme: "vs-dark" },
  { label: "Monokai", file: "popular/monokai-color-theme.json", uiTheme: "vs-dark" },
  { label: "Solarized Dark", file: "popular/solarized-dark-color-theme.json", uiTheme: "vs-dark" },
  { label: "Solarized Light", file: "popular/solarized-light-color-theme.json", uiTheme: "vs" },
];

/** The scope VS Code's own YAML grammar gives what a token type is in a rule: a key, a plain value, `true`, `1`. */
export const YAML_SCOPES = {
  property: "entity.name.tag.yaml",
  string: "string.unquoted.plain.out.yaml",
  enumMember: "constant.language.boolean.yaml",
  number: "constant.numeric.integer.yaml",
};

/** The server's token types that carry meaning, so must be coloured; `operator` is punctuation as much as operators. */
export const MEANINGFUL = [
  "keyword",
  "function",
  "property",
  "variable",
  "type",
  "string",
  "number",
  "enumMember",
  "macro",
  "regexp",
  "decorator",
];

/** Pairs of token types a reader must tell apart (CIEDE2000 at least MIN_DELTA_E in each language). */
export const DISTINCT = [
  ["keyword", "function"],
  ["keyword", "property"],
  ["keyword", "string"],
  ["keyword", "type"],
  ["keyword", "variable"],
  ["function", "property"],
  ["function", "variable"],
  ["property", "string"],
  ["type", "property"],
  ["string", "number"],
  ["variable", "string"],
  ["enumMember", "string"],
  ["comment", "string"],
  // Markdown `code` against the prose of a description
  ["regexp", "string"],
];

export const MIN_CONTRAST = 4.5;
export const MIN_CONTRAST_COMMENT = 3;
export const MIN_DELTA_E = 10;
/** Below this CIEDE2000 distance two colours read as one. */
export const SAME_COLOUR = 3;

const UI_DEFAULTS = {
  "vs-dark": { background: "#1E1E1E", foreground: "#D4D4D4" },
  vs: { background: "#FFFFFF", foreground: "#000000" },
  "hc-black": { background: "#000000", foreground: "#FFFFFF" },
  "hc-light": { background: "#FFFFFF", foreground: "#292929" },
};

/** JSON with comments and trailing commas, as VS Code's theme files are. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function normalize(color) {
  if (typeof color !== "string" || !color.startsWith("#")) return undefined;
  const hex = color.slice(1).toUpperCase();
  return `#${hex.length <= 4 ? [...hex].map((x) => x + x).join("") : hex}`;
}

/** A theme file with its `include` chain merged, as VS Code loads it. */
export function loadTheme(path, uiTheme, label = path) {
  const chain = [];
  for (let file = path; file;) {
    const json = parseJsonc(readFileSync(file, "utf8"));
    chain.unshift(json);
    file = json.include ? join(dirname(file), json.include) : undefined;
  }
  const theme = {
    label,
    uiTheme,
    colors: {},
    tokenColors: [],
    semanticTokenColors: {},
    semanticHighlighting: false,
  };
  for (const json of chain) {
    Object.assign(theme.colors, json.colors);
    if (Array.isArray(json.tokenColors))
      theme.tokenColors.push(...json.tokenColors.filter((r) => r?.settings));
    Object.assign(theme.semanticTokenColors, json.semanticTokenColors);
    if (json.semanticHighlighting !== undefined) theme.semanticHighlighting = json.semanticHighlighting;
  }
  const defaults = UI_DEFAULTS[uiTheme];
  theme.background = normalize(theme.colors["editor.background"]) ?? defaults.background;
  const editorForeground = normalize(theme.colors["editor.foreground"]) ?? defaults.foreground;
  // VS Code puts the editor colours first, as the scope-less rule; a scope-less rule of the theme overrides it.
  theme.textmateSettings = [
    { settings: { foreground: editorForeground, background: theme.background } },
    ...theme.tokenColors.map((rule) => ({
      ...rule,
      settings: { ...rule.settings, foreground: normalize(rule.settings.foreground) },
    })),
  ];
  theme.foreground = editorForeground;
  for (const rule of theme.textmateSettings)
    if (!rule.scope && rule.settings.foreground) theme.foreground = rule.settings.foreground;
  // The colours a reader takes for "not highlighted": the default, and VS Code's reset inside embedded code.
  theme.plain = [theme.foreground, resolveScopes(theme, ["meta.embedded"])?.foreground].filter(Boolean);
  return theme;
}

function rgba(hex) {
  const h = normalize(hex).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  return [r, g, b, h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1];
}

/** A colour composed over the background, as the editor paints it. */
function opaque(color, background) {
  const [r, g, b, a] = rgba(color);
  if (a === 1) return [r, g, b];
  const [br, bg, bb] = rgba(background);
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

const linear = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

function luminance(rgb) {
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of a foreground over a background. */
export function contrast(foreground, background) {
  const a = luminance(opaque(foreground, background));
  const b = luminance(opaque(background, "#000000"));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function lab(rgb) {
  const [r, g, b] = rgb.map(linear);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 difference of two colours, each composed over the background. */
export function deltaE(c1, c2, background) {
  const [L1, a1, b1] = lab(opaque(c1, background));
  const [L2, a2, b2] = lab(opaque(c2, background));
  const rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const [a1p, a2p] = [(1 + G) * a1, (1 + G) * a2];
  const [C1p, C2p] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)];
  const hue = (a, b) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const [h1p, h2p] = [hue(a1p, b1), hue(a2p, b2)];
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    else hbp = (h1p + h2p) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * rad) +
    0.24 * Math.cos(2 * hbp * rad) +
    0.32 * Math.cos((3 * hbp + 6) * rad) -
    0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  const [dL, dC, dH] = [(L2 - L1) / Sl, (C2p - C1p) / Sc, dHp / Sh];
  return Math.sqrt(dL ** 2 + dC ** 2 + dH ** 2 + Rt * dC * dH);
}

/** VS Code's own TextMate fallbacks of the standard semantic token types (tokenClassificationRegistry.ts). */
export const VSCODE_DEFAULT_SCOPES = {
  comment: ["comment"],
  string: ["string"],
  keyword: ["keyword.control"],
  number: ["constant.numeric"],
  regexp: ["constant.regexp"],
  operator: ["keyword.operator"],
  namespace: ["entity.name.namespace"],
  type: ["entity.name.type", "support.type"],
  struct: ["entity.name.type.struct"],
  class: ["entity.name.type.class", "support.class"],
  interface: ["entity.name.type.interface"],
  enum: ["entity.name.type.enum"],
  typeParameter: ["entity.name.type.parameter"],
  function: ["entity.name.function", "support.function"],
  method: ["entity.name.function.member", "support.function"],
  macro: ["entity.name.function.preprocessor"],
  variable: ["variable.other.readwrite", "entity.name.variable"],
  parameter: ["variable.parameter"],
  property: ["variable.other.property"],
  enumMember: ["variable.other.enummember"],
  event: ["variable.other.event"],
  decorator: ["entity.name.decorator", "entity.name.function"],
  label: ["entity.name.label"],
  modifier: ["storage.modifier"],
};

const matches = (scope, selector) =>
  scope === selector || (scope.startsWith(selector) && scope[selector.length] === ".");

/** colorThemeData.ts nameMatcher: the score of a selector (its space-separated parts) against a scope stack. */
function nameMatcher(parts, stack) {
  if (stack.length < parts.length) return -1;
  let score;
  const every = parts.every((part) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (matches(stack[i], part)) {
        score = (i + 1) * 0x10000 + part.length;
        return true;
      }
    }
    return false;
  });
  return every && score !== undefined ? score : -1;
}

function selectors(rule) {
  const list = Array.isArray(rule.scope) ? rule.scope : String(rule.scope ?? "").split(",");
  return list
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+/));
}

/** colorThemeData.ts resolveScopes: the first probe some rule colours gives the foreground. */
export function resolveScopes(theme, probes) {
  for (const probe of probes) {
    let foreground;
    let best = -1;
    for (const rule of theme.tokenColors) {
      if (!rule.settings.foreground) continue;
      for (const parts of selectors(rule)) {
        const score = nameMatcher(parts, [probe]);
        if (score >= 0 && score >= best) {
          best = score;
          foreground = normalize(rule.settings.foreground);
        }
      }
    }
    if (foreground) return { foreground, probe };
  }
  return undefined;
}

const styleOf = (value) => normalize(typeof value === "string" ? value : value?.foreground);

/** The foreground of a semantic token, or undefined when VS Code keeps the TextMate colour. */
export function semanticForeground(theme, type, language, languageScopes) {
  for (const key of [`${type}:${language}`, type]) {
    const foreground = styleOf(theme.semanticTokenColors[key]);
    if (foreground) return foreground;
  }
  // The language's list outranks VS Code's, and VS Code's still applies when the language's colours nothing.
  for (const probes of [languageScopes?.[type], VSCODE_DEFAULT_SCOPES[type]]) {
    const resolved = probes && resolveScopes(theme, probes);
    if (resolved) return resolved.foreground;
  }
  return undefined;
}

export function semanticHighlightingOn(pkg, theme, language) {
  const setting =
    pkg.contributes.configurationDefaults?.[`[${language}]`]?.["editor.semanticHighlighting.enabled"];
  return setting === true || (setting !== false && theme.semanticHighlighting === true);
}

const LANGUAGE_OF_EXTENSION = {
  yaml: "opentide-yaml",
  cql: "cql",
  eql: "eql",
  esql: "esql",
  exabeam: "exabeam",
  falco: "falco",
  kql: "kql",
  kuery: "kuery",
  lucene: "lucene",
  spl: "spl",
  yara: "yara",
  yaral: "yaral",
};

export const languageOfSample = (name) => LANGUAGE_OF_EXTENSION[name.split(".").pop()];

/** A TextMate registry over the extension's grammars, with `theme` set. */
async function registryFor(root, pkg, theme) {
  const textmate = require("vscode-textmate");
  const oniguruma = require("vscode-oniguruma");
  const paths = new Map(pkg.contributes.grammars.map((g) => [g.scopeName, join(root, g.path)]));
  const registry = new textmate.Registry({
    onigLib: onigLib(oniguruma),
    loadGrammar: async (scope) =>
      paths.has(scope)
        ? textmate.parseRawGrammar(readFileSync(paths.get(scope), "utf8"), paths.get(scope))
        : null,
  });
  registry.setTheme({ name: theme.label, settings: theme.textmateSettings });
  return { textmate, registry };
}

let onigLoaded;
function onigLib(oniguruma) {
  onigLoaded ??= (async () => {
    const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  })();
  return onigLoaded.then(() => ({
    createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
    createOnigString: (text) => new oniguruma.OnigString(text),
  }));
}

/** Per line: the TextMate tokens with their scopes and the theme's foreground. */
async function paint(textmate, registry, pkg, language, text) {
  const entry = pkg.contributes.grammars.find((g) => g.language === language);
  const ids = {};
  for (const id of Object.values(entry.embeddedLanguages ?? {})) ids[id] ??= Object.keys(ids).length + 2;
  const embeddedLanguages = Object.fromEntries(
    Object.entries(entry.embeddedLanguages ?? {}).map(([scope, id]) => [scope, ids[id]]),
  );
  const grammar = await registry.loadGrammarWithConfiguration(entry.scopeName, 1, { embeddedLanguages });
  const colorMap = registry.getColorMap();
  let state = textmate.INITIAL;
  return text.split("\n").map((line) => {
    const binary = grammar.tokenizeLine2(line, state);
    const { tokens } = grammar.tokenizeLine(line, state);
    state = binary.ruleStack;
    // tokenizeLine2 merges neighbours of the same style: its tokens are not tokenizeLine's.
    const metadataAt = (offset) => {
      let metadata = binary.tokens[1];
      for (let i = 0; i < binary.tokens.length && binary.tokens[i] <= offset; i += 2)
        metadata = binary.tokens[i + 1];
      return metadata;
    };
    return tokens.map((token) => ({
      ...token,
      scopes: token.scopes.slice(1),
      foreground: normalize(colorMap[(metadataAt(token.startIndex) >>> 15) & 0x1ff]),
    }));
  });
}

const TEXT_KEYS = /^\s*(?:-\s+)?(?:description|analysis|investigation|setup)\s*:\s*[|>]/;
const QUERY_KEYS = /^\s*(?:-\s+)?query\s*:\s*[|>]/;

/** Whether line `row` is in the block scalar of a key `key` matches (a less indented line above it). */
function inBlock(lines, row, key) {
  const indent = (s) => /^\s*/.exec(s)[0].length;
  for (let i = row - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    if (indent(lines[i]) < indent(lines[row])) return key.test(lines[i]);
  }
  return false;
}

/**
 * What a reader sees the token as part of: the language of a query file, and in a rule `opentide-yaml` (its structure),
 * `yaml>markdown` (a description), `yaml><language>` (an embedded query) or `yaml>query` (a query the grammar cannot
 * name).
 */
function groupOf(language, scopes, lines, row) {
  if (language !== "opentide-yaml") return language;
  const embedded = scopes.find((s) => s.startsWith("meta.embedded.block."));
  if (embedded) return `yaml>${embedded.split(".").pop()}`;
  if (inBlock(lines, row, TEXT_KEYS)) return "yaml>markdown";
  if (inBlock(lines, row, QUERY_KEYS)) return "yaml>query";
  return language;
}

/**
 * Measure every theme: rows of { theme, group, type, n, textmate: Map<colour, count>, semantic: Map<colour, count>,
 * yamlStrings: tokens of an embedded query the YAML grammar paints as a string }.
 * `snapshot` is test/fixtures/highlighting/semantic-tokens.json; `samples` the directory its files are in.
 */
export async function measure({ root, pkg, themesDir, themes, samples, snapshot }) {
  const rows = [];
  for (const spec of themes) {
    const theme = loadTheme(join(themesDir, spec.file), spec.uiTheme, spec.label);
    const { textmate, registry } = await registryFor(root, pkg, theme);
    const byKey = new Map();
    for (const [name, tokens] of Object.entries(snapshot.files)) {
      const language = languageOfSample(name);
      const text = readFileSync(join(samples, name), "utf8");
      const lines = text.split("\n");
      const painted = await paint(textmate, registry, pkg, language, text);
      const languageScopes = pkg.contributes.semanticTokenScopes?.find(
        (e) => e.language === language,
      )?.scopes;
      const on = semanticHighlightingOn(pkg, theme, language);
      for (const [row, column, , type] of tokens) {
        const token =
          painted[row].find((t) => t.startIndex <= column && column < t.endIndex) ?? painted[row].at(-1);
        const group = groupOf(language, token.scopes, lines, row);
        const textmateColour = token.foreground;
        const semanticColour =
          (on && semanticForeground(theme, type, language, languageScopes)) || textmateColour;
        const key = `${group}\u0000${type}`;
        if (!byKey.has(key)) {
          byKey.set(key, {
            theme,
            group,
            type,
            n: 0,
            textmate: new Map(),
            semantic: new Map(),
            yamlStrings: [],
          });
        }
        const r = byKey.get(key);
        r.n += 1;
        r.textmate.set(textmateColour, (r.textmate.get(textmateColour) ?? 0) + 1);
        r.semantic.set(semanticColour, (r.semantic.get(semanticColour) ?? 0) + 1);
        if (group.startsWith("yaml>") && group !== "yaml>markdown" && type !== "string") {
          if (
            token.scopes.some((s) => s.startsWith("string.") && s.endsWith(".tide")) ||
            isWholeValueString(token, lines[row])
          )
            r.yamlStrings.push(`${name}:${row + 1}:${column + 1}`);
        }
      }
    }
    rows.push(...byKey.values());
  }
  return rows;
}

/** A token that is a string and runs from a quote right after `key: ` to the end of the value: a query as one string. */
function isWholeValueString(token, line) {
  if (!token.scopes.some((s) => s.startsWith("string."))) return false;
  const value = /^\s*(?:-\s+)?[\w.-]+\s*:\s+/.exec(line);
  return value !== null && token.startIndex === value[0].length && /^['"]/.test(line.slice(token.startIndex));
}

/** The colour most tokens of a row have. */
export function mainColour(counts) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const isPlain = (theme, colour) =>
  theme.plain.some((plain) => deltaE(colour, plain, theme.background) < SAME_COLOUR);

/** The share of meaningful tokens a view paints in a plain colour, per group (max over the themes). */
export function plainShare(rows, view) {
  const totals = new Map();
  for (const r of rows) {
    if (!MEANINGFUL.includes(r.type)) continue;
    const key = `${r.theme.label}\u0000${r.group}`;
    const t = totals.get(key) ?? { group: r.group, all: 0, plain: 0 };
    for (const [colour, n] of r[view]) {
      t.all += n;
      if (isPlain(r.theme, colour)) t.plain += n;
    }
    totals.set(key, t);
  }
  const share = {};
  for (const { group, all, plain } of totals.values())
    share[group] = Math.max(share[group] ?? 0, plain / all);
  return share;
}

/** The colour `theme` gives `type` in a plain YAML file (YAML_SCOPES). */
export function yamlColour(theme, type) {
  return resolveScopes(theme, [YAML_SCOPES[type]])?.foreground ?? theme.foreground;
}

/** A rule's structure or a query in a rule: where `property` is a YAML key's colour. */
const inRule = (group) => group === "opentide-yaml" || group.startsWith("yaml>");

/**
 * How far apart `a` and `b` must be. Where both are YAML (a key, a value, `true`, a number) in a rule, no further
 * than the theme sets them in a YAML file: High Contrast Light gives keys and values one colour, Light+ 7.5 apart.
 */
export function minDeltaE(theme, group, a, b) {
  if (!inRule(group) || !YAML_SCOPES[a] || !YAML_SCOPES[b]) return MIN_DELTA_E;
  const [ya, yb] = [yamlColour(theme, a), yamlColour(theme, b)];
  // A theme that leaves YAML plain sets no bound of its own: hold it to the threshold.
  if (isPlain(theme, ya) || isPlain(theme, yb)) return MIN_DELTA_E;
  return Math.min(MIN_DELTA_E, deltaE(ya, yb, theme.background));
}

/** Rows by theme and group, then by token type. */
function cellsOf(rows) {
  const cells = new Map();
  for (const r of rows) {
    const key = `${r.theme.label}\u0000${r.group}`;
    if (!cells.has(key)) cells.set(key, {});
    cells.get(key)[r.type] = r;
  }
  return cells.values();
}

function distinctFailures(byType, pairs) {
  const failures = [];
  for (const [a, b] of pairs) {
    if (!byType[a] || !byType[b]) continue;
    const { theme, group } = byType[a];
    const [ca, cb] = [mainColour(byType[a].semantic), mainColour(byType[b].semantic)];
    const d = deltaE(ca, cb, theme.background);
    const min = minDeltaE(theme, group, a, b);
    if (d < min - 1e-9)
      failures.push(
        `${theme.label} | ${group} | ${a} ${ca} and ${b} ${cb}: ΔE ${d.toFixed(1)} (< ${min.toFixed(1)})`,
      );
  }
  return failures;
}

/**
 * Every way a rule looks plainer than a YAML file in the same theme: a key, value, enumeration or number in the
 * default foreground where the theme colours its YAML counterpart, or two of them closer than the theme sets those.
 */
export function yamlFailures(rows) {
  const failures = [];
  for (const r of rows) {
    if (!inRule(r.group) || !YAML_SCOPES[r.type]) continue;
    const colour = mainColour(r.semantic);
    const yaml = yamlColour(r.theme, r.type);
    if (isPlain(r.theme, colour) && !isPlain(r.theme, yaml))
      failures.push(
        `${r.theme.label} | ${r.group} | ${r.type}: ${colour} is the default foreground for ${r.n} token(s), a YAML file's is ${yaml}`,
      );
  }
  const pairs = DISTINCT.filter(([a, b]) => YAML_SCOPES[a] && YAML_SCOPES[b]);
  for (const byType of cellsOf(rows.filter((r) => inRule(r.group))))
    failures.push(...distinctFailures(byType, pairs));
  return failures;
}

/** Every way the semantic view (what users see once the server answers) breaks the thresholds. */
export function semanticFailures(rows) {
  const failures = [];
  for (const r of rows) {
    const where = `${r.theme.label} | ${r.group} | ${r.type}`;
    const min = r.type === "comment" ? MIN_CONTRAST_COMMENT : MIN_CONTRAST;
    for (const [colour, n] of r.semantic) {
      const ratio = contrast(colour, r.theme.background);
      if (ratio < min)
        failures.push(`${where}: ${colour} is ${ratio.toFixed(2)}:1 (< ${min}) for ${n} token(s)`);
    }
    const colour = mainColour(r.semantic);
    if (MEANINGFUL.includes(r.type) && isPlain(r.theme, colour))
      failures.push(`${where}: ${colour} is the default foreground for ${r.n} token(s)`);
  }
  for (const byType of cellsOf(rows)) failures.push(...distinctFailures(byType, DISTINCT));
  for (const r of rows)
    if (r.yamlStrings.length > 0)
      failures.push(
        `${r.theme.label} | ${r.group} | ${r.type}: the YAML grammar paints the query as a string at ${r.yamlStrings.slice(0, 3).join(", ")}`,
      );
  return failures;
}
