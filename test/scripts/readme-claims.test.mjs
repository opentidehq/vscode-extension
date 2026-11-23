import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("README claims", () => {
  it("says which rule queries are embedded regions, as the grammar has them", () => {
    const embedded = Object.values(
      pkg.contributes.grammars.find((g) => g.language === "opentide-yaml")?.embeddedLanguages ?? {},
    );
    // Elastic's queries are embedded once `type:` or `language:` has named their language (scripts/tide-align.mjs).
    for (const language of ["esql", "eql", "kuery", "lucene"])
      assert.ok(embedded.includes(language), language);
    assert.match(readme, /An Elastic query's language depends on its `type` and `language` keys/);
    assert.doesNotMatch(readme, /Queries embedded in a rule \([^)]*\) are highlighted,\s+commented/);
  });
});
