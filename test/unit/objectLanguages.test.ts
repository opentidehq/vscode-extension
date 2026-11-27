// The object languages: opentide-yaml, and one per type so that the Explorer and tabs draw each type's icon.
import * as assert from "node:assert/strict";
import * as path from "node:path";

import { DEFAULT_OBJECT_FOLDERS, objectTypeOf } from "../../src/core/folders";
import {
  isObjectLanguage,
  LANGUAGES,
  OBJECT_LANGUAGES,
  OBJECT_TYPE_LANGUAGES,
  objectLanguageOf,
} from "../../src/engine/languages";
import { objectTypeAt } from "../../src/engine/workspace";

describe("object languages", () => {
  it("are opentide-yaml and one language per type", () => {
    assert.deepEqual(OBJECT_LANGUAGES, [
      "opentide-yaml",
      "opentide-threat",
      "opentide-objective",
      "opentide-rule",
    ]);
    for (const id of OBJECT_LANGUAGES) assert.ok(isObjectLanguage(id), id);
    for (const id of ["yaml", "opentide-config", "kql", undefined])
      assert.ok(!isObjectLanguage(id), String(id));
  });

  it("names a type's language, and opentide-yaml for no type or one it does not know", () => {
    assert.equal(objectLanguageOf("rule"), "opentide-rule");
    assert.equal(objectLanguageOf("threat"), "opentide-threat");
    assert.equal(objectLanguageOf("objective"), "opentide-objective");
    assert.equal(objectLanguageOf(undefined), "opentide-yaml");
    assert.equal(objectLanguageOf("actor"), "opentide-yaml");
    assert.equal(objectLanguageOf("toString"), "opentide-yaml");
  });

  it("gives each type's language a pattern longer than opentide-yaml's, so VS Code picks it in that folder", () => {
    const byId = Object.fromEntries(LANGUAGES.map((l) => [l.id, l.patterns]));
    const yaml = byId["opentide-yaml"]?.[0] ?? "";
    for (const [type, language] of Object.entries(OBJECT_TYPE_LANGUAGES)) {
      const patterns = byId[language] ?? [];
      assert.deepEqual(patterns, [
        `**/${DEFAULT_OBJECT_FOLDERS[type]}**/*.yaml`,
        `**/${DEFAULT_OBJECT_FOLDERS[type]}**/*.yml`,
      ]);
      assert.ok((patterns[0] ?? "").length > yaml.length, language);
    }
  });
});

describe("an object file's type", () => {
  it("is the type whose folder holds it, at any depth, from the defaults or paths.toml", () => {
    assert.equal(objectTypeAt("objects/rules/a.yaml", DEFAULT_OBJECT_FOLDERS), "rule");
    assert.equal(objectTypeAt("objects/rules/sentinel/a.yml", DEFAULT_OBJECT_FOLDERS), "rule");
    assert.equal(objectTypeAt("objects/threats/a.yaml", DEFAULT_OBJECT_FOLDERS), "threat");
    assert.equal(objectTypeAt("objects/objectives/a.yaml", DEFAULT_OBJECT_FOLDERS), "objective");
    assert.equal(objectTypeAt("objects/other/a.yaml", DEFAULT_OBJECT_FOLDERS), undefined);
    assert.equal(objectTypeAt("objects/rules/a.toml", DEFAULT_OBJECT_FOLDERS), undefined);
    // CoreTIDE's layout, named in paths.toml
    const coretide = { threat: "Objects/TVM/", objective: "Objects/DOM/", rule: "Objects/MDR/" };
    assert.equal(objectTypeAt("Objects/MDR/x.yaml", coretide), "rule");
    assert.equal(objectTypeAt("objects/rules/x.yaml", coretide), undefined);
  });

  it("takes the longest folder first, and nothing outside the workspace folder", () => {
    const nested = { threat: "objects/", objective: "objects/objectives/", rule: "objects/rules/" };
    assert.equal(objectTypeAt("objects/rules/a.yaml", nested), "rule");
    assert.equal(objectTypeAt("objects/a.yaml", nested), "threat");
    const root = path.resolve("/w");
    assert.equal(
      objectTypeOf(root, path.join(root, "objects", "rules", "a.yaml"), DEFAULT_OBJECT_FOLDERS),
      "rule",
    );
    assert.equal(
      objectTypeOf(root, path.resolve("/elsewhere/objects/rules/a.yaml"), DEFAULT_OBJECT_FOLDERS),
      undefined,
    );
  });
});
