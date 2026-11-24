// The highlighting contrast gate. Every sample of test/fixtures/highlighting (opentide's query corpora, real rules,
// a description in Markdown) is tokenized by the extension's grammars under VS Code's default themes, with the language
// server's semantic tokens (a snapshot of a real `opentide lsp start`) laid over them as VS Code resolves them. Each
// theme x language x token type must stay readable (WCAG contrast), coloured (not the default foreground) and apart
// from the types a reader tells it from (CIEDE2000); a query in a rule must not be painted as one YAML string; and what
// the grammars alone leave plain may not grow (baseline.json, lowered as opentide's grammars improve).
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_THEMES,
  measure,
  plainShare,
  semanticFailures,
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
      if (language !== "opentide-config") assert.ok(groups.has(language), `no sample in ${language}`);
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

  it("fails a mapping that breaks contrast, and a language left to its grammar", async () => {
    const pkg = read(join(root, "package.json"));
    pkg.contributes.semanticTokenScopes[0].scopes.regexp = ["constant.regexp"];
    delete pkg.contributes.configurationDefaults["[cql]"];
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
        f.startsWith("High Contrast Light | cql | property: #292929 is the default foreground"),
      ),
      failures.join("\n"),
    );
  });
});
