// Names the design documents give: every `opentide.*` in SPEC.md and CONTRACTS.md is a setting, a
// command, a view or a context key the extension has. A renamed or never-built setting otherwise
// lives on in the docs (SPEC once named `opentide.queryResults.retain` and `opentide.validate.strict`).
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const contributes = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).contributes;
const settings = [contributes.configuration].flat().flatMap((c) => Object.keys(c?.properties ?? {}));
const commands = (contributes.commands ?? []).map((c) => c.command);
const views = Object.values(contributes.views ?? {}).flatMap((list) => list.map((v) => v.id));
const known = new Set([...settings, ...commands, ...views]);

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith(".ts") ? [readFileSync(file, "utf8")] : [];
  });
}
const src = sources(join(ROOT, "src")).join("\n");

/** Not extension names: the project's domain, and the Python module of the engine. */
const NOT_NAMES = new Set(["opentide.org", "opentide._native"]);

/** `opentide.x.y` is known, or `opentide.x.*` names known settings; else a string the sources use (a context key). */
function exists(name) {
  if (known.has(name)) return true;
  if (name.endsWith(".*")) return settings.some((s) => s.startsWith(name.slice(0, -1)));
  return src.includes(`"${name}"`);
}

describe("names in the design documents", () => {
  for (const doc of ["docs/SPEC.md", "docs/CONTRACTS.md"]) {
    it(`every opentide.* name in ${doc} exists`, () => {
      const text = readFileSync(join(ROOT, doc), "utf8");
      const names = new Set(
        [...text.matchAll(/`(opentide\.[A-Za-z0-9_.]*[A-Za-z0-9_*])`/g)].map((m) => m[1]),
      );
      const missing = [...names].filter((name) => !NOT_NAMES.has(name) && !exists(name));
      assert.deepEqual(missing, []);
    });
  }

  it("catches a setting that does not exist", () => {
    assert.equal(exists("opentide.queryResults.retain"), false);
    assert.equal(exists("opentide.query.retainResults"), true);
    assert.equal(exists("opentide.uv.*"), true);
  });
});
