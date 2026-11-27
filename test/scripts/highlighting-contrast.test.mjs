// The highlighting contrast gate. Every sample of test/fixtures/highlighting (opentide's query corpora, real rules,
// a description in Markdown) is tokenized by the extension's grammars under VS Code's default themes, with the language
// server's semantic tokens (a snapshot of a real `opentide lsp start`) laid over them as VS Code resolves them. Each
// theme x language x token type must stay readable (WCAG contrast), coloured (not the default foreground) and apart
// from the types a reader tells it from (CIEDE2000); a query in a rule must not be painted as one YAML string; and what
// the grammars alone leave plain may not grow (baseline.json, lowered as opentide's grammars improve). Under popular
// themes of the Marketplace, whose palettes are their authors' choice, a rule must look no plainer than a YAML file.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TYPE_LANGUAGES } from "../../scripts/grammars-lib.mjs";
import {
  DEFAULT_THEMES,
  mainColour,
  measure,
  MIN_DELTA_E,
  minDeltaE,
  plainShare,
  POPULAR_THEMES,
  semanticFailures,
  yamlColour,
  yamlFailures,
} from "../../scripts/highlighting-contrast-lib.mjs";
import { measureDefaults, sampleNames } from "../../scripts/highlighting-contrast.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = join(root, "test", "fixtures", "highlighting");
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const pins = read(join(root, "pins.json"));
const snapshot = read(join(fixtures, "semantic-tokens.json"));
const baseline = read(join(fixtures, "baseline.json"));

describe("highlighting contrast: VS Code's default themes on opentide's grammars and semantic tokens", function () {
  this.timeout(60_000);
  let rows;

  before(async () => {
    rows = await measureDefaults();
  });

  it("has the server's tokens of the opentide the grammars come from, for every sample", () => {
    assert.equal(
      snapshot.server.version,
      pins.highlights.version,
      "pins.json's highlights moved: run `node scripts/highlighting-contrast.mjs capture <opentide>` with that opentide",
    );
    assert.deepEqual(Object.keys(snapshot.files).sort(), sampleNames());
    for (const [name, tokens] of Object.entries(snapshot.files))
      assert.ok(tokens.length > 0, `${name} has no tokens`);
  });

  it("covers every theme, and every language with a grammar but the configuration's", () => {
    assert.deepEqual(
      [...new Set(rows.map((r) => r.theme.label))],
      DEFAULT_THEMES.map((t) => t.label),
    );
    const pkg = read(join(root, "package.json"));
    const groups = new Set(rows.map((r) => r.group));
    for (const { language } of pkg.contributes.grammars)
      // A type's language is opentide-yaml's grammar whole (highlighting.test.mjs checks it token by token).
      if (language !== "opentide-config" && !TYPE_LANGUAGES.includes(language))
        assert.ok(groups.has(language), `no sample in ${language}`);
  });

  it("keeps every token type readable, coloured and distinct once the server's tokens land", () => {
    const failures = semanticFailures(rows);
    assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
  });

  it("leaves no more of a language plain before the server answers than baseline.json allows", () => {
    const share = plainShare(rows, "textmate");
    const worse = Object.entries(share)
      .filter(([group, value]) => value > (baseline.textmate[group] ?? 0) + 1e-9)
      .map(
        ([group, value]) =>
          `${group}: ${(100 * value).toFixed(1)}% plain, baseline ${(100 * (baseline.textmate[group] ?? 0)).toFixed(1)}%`,
      );
    assert.deepEqual(
      worse,
      [],
      `\n${worse.join("\n")}\n(an improvement? run \`node scripts/highlighting-contrast.mjs baseline\`)`,
    );
  });

  it("keeps a rule no plainer than a YAML file in popular themes", async () => {
    const failures = yamlFailures(await measureDefaults(POPULAR_THEMES));
    assert.deepEqual(failures, [], `\n${failures.join("\n")}`);
  });

  it("holds a key and a value apart no less than the theme's own YAML does", () => {
    // High Contrast Light gives YAML keys and values one colour: a rule may too, and no other pair relaxes.
    const hcLight = rows.find((r) => r.theme.label === "High Contrast Light").theme;
    assert.equal(yamlColour(hcLight, "property"), yamlColour(hcLight, "string"));
    const lightPlus = rows.find(
      (r) => r.theme.label === "Light+" && r.group === "opentide-yaml" && r.type === "property",
    );
    assert.equal(mainColour(lightPlus.semantic), yamlColour(lightPlus.theme, "property"));
  });

  it("relaxes ΔE only for two YAML types in a rule, and only to a bound the theme's own YAML sets", () => {
    const hcLight = rows.find((r) => r.theme.label === "High Contrast Light").theme;
    assert.equal(minDeltaE(hcLight, "opentide-yaml", "property", "string"), 0);
    assert.equal(minDeltaE(hcLight, "kql", "property", "string"), MIN_DELTA_E);
    assert.equal(minDeltaE(hcLight, "opentide-yaml", "keyword", "string"), MIN_DELTA_E);
    // A theme that leaves YAML plain sets no bound of its own.
    const plain = { ...hcLight, tokenColors: [] };
    assert.equal(minDeltaE(plain, "opentide-yaml", "property", "string"), MIN_DELTA_E);
  });

  it("fails a rule whose keys are plain where a YAML file's are not (GitHub Dark, opentide 1.0.0's scope)", async () => {
    const pkg = read(join(root, "package.json"));
    pkg.contributes.semanticTokenScopes[0].scopes.property = ["variable.other.property"];
    const failures = yamlFailures(
      await measure({
        root,
        pkg,
        themesDir: join(fixtures, "themes"),
        themes: POPULAR_THEMES.filter((t) => t.label === "GitHub Dark Default"),
        samples: join(fixtures, "samples"),
        snapshot,
      }),
    );
    assert.ok(
      failures.some((f) =>
        f.startsWith(
          "GitHub Dark Default | opentide-yaml | property: #E6EDF3 is the default foreground for 559 token(s), a YAML file's is #7EE787",
        ),
      ),
      failures.join("\n"),
    );
  });

  it("fails a mapping that breaks contrast, and a language left to its grammar", async () => {
    const pkg = read(join(root, "package.json"));
    pkg.contributes.semanticTokenScopes[0].scopes.regexp = ["constant.regexp"];
    // a language whose grammar leaves most of a query plain (cql's grammar does not, since opentide 1.0.0-rc.5)
    delete pkg.contributes.configurationDefaults["[kuery]"];
    const failures = semanticFailures(
      await measure({
        root,
        pkg,
        themesDir: join(fixtures, "themes"),
        themes: DEFAULT_THEMES.filter((t) => ["Dark+", "High Contrast Light"].includes(t.label)),
        samples: join(fixtures, "samples"),
        snapshot,
      }),
    );
    assert.ok(
      failures.some((f) => f.startsWith("Dark+ | yaml>markdown | regexp: #646695 is 3.08:1")),
      failures.join("\n"),
    );
    assert.ok(
      failures.some((f) =>
        f.startsWith("High Contrast Light | kuery | string: #292929 is the default foreground"),
      ),
      failures.join("\n"),
    );
  });
});
