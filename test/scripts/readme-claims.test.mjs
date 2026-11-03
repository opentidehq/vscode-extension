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
    assert.ok(
      !embedded.some((language) => ["esql", "eql", "kuery"].includes(language)),
      "Elastic is embedded now: update the README",
    );
    assert.match(readme, /Elastic query's language depends on its `language` key/);
    assert.doesNotMatch(readme, /Queries embedded in a rule \([^)]*\) are highlighted,\s+commented/);
  });
});
