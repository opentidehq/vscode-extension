// Context keys across features: every opentide.* key a when clause or a walkthrough completion event
// reads is a view, a setting, or a key some module sets. A key set by nobody hides its menu forever.
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const contributes = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).contributes;
const text = JSON.stringify(contributes);
const views = new Set(Object.values(contributes.views ?? {}).flatMap((list) => list.map((v) => v.id)));
const configuration = Array.isArray(contributes.configuration)
  ? contributes.configuration
  : [contributes.configuration];
const settings = new Set(configuration.flatMap((c) => Object.keys(c?.properties ?? {})));

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith(".ts") ? [readFileSync(file, "utf8")] : [];
  });
}
const src = sources(join(ROOT, "src")).join("\n");

describe("context keys across features", () => {
  it("every opentide.* key a when clause reads is set somewhere", () => {
    const read = new Set();
    for (const m of text.matchAll(/"(?:when|enablement)":"([^"]*)"/g))
      for (const key of m[1].matchAll(/(?<!config\.)\b(opentide\.[A-Za-z0-9_.]+)/g)) read.add(key[1]);
    for (const m of text.matchAll(/onContext:([A-Za-z0-9_.]+)/g)) read.add(m[1]);
    const unset = [...read].filter((key) => !views.has(key) && !src.includes(`"${key}"`));
    assert.deepEqual(unset, []);
  });

  it("every config.opentide.* a when clause reads is a declared setting", () => {
    const missing = [...text.matchAll(/config\.(opentide\.[A-Za-z0-9_.]+)/g)]
      .map((m) => m[1])
      .filter((key) => !settings.has(key));
    assert.deepEqual(missing, []);
  });
});

describe("welcome views across features", () => {
  it("gives each view one welcome per exact state (two features do not both fill it)", () => {
    const seen = new Map();
    for (const welcome of contributes.viewsWelcome ?? []) {
      const key = `${welcome.view} | ${welcome.when ?? ""}`;
      assert.ok(!seen.has(key), `${key}: "${seen.get(key)}" and "${welcome.contents}"`);
      seen.set(key, welcome.contents);
    }
  });
});
