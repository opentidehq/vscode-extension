// `$opentide` (the task problem matcher) owns its own markers. VS Code clears every marker of a matcher's
// `owner` when a task with it starts; an owner equal to a diagnostic collection's name (the language
// client's `opentide`, `opentide validate`, …) wiped that collection's problems from every file (#43).
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith(".ts") ? [file] : [];
  });
}

/** Every diagnostic collection name (and diagnostic source) the extension's sources give. */
function collectionNames() {
  const names = new Set();
  for (const file of sources(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/new LanguageClient\(\s*"([^"]+)"/g)) names.add(m[1]);
    for (const m of text.matchAll(/diagnosticCollectionName:\s*"([^"]+)"/g)) names.add(m[1]);
    for (const m of text.matchAll(/createDiagnosticCollection\(\s*"([^"]+)"/g)) names.add(m[1]);
    for (const m of text.matchAll(/\b(?:SERVER_SOURCE|COLLECTION)\b[^=]*=\s*("[^"]+"|\{[^}]*\})/g))
      for (const name of m[1].matchAll(/"([^"]+)"/g)) names.add(name[1]);
  }
  return names;
}

describe("the $opentide problem matcher", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const matcher = manifest.contributes.problemMatchers.find((m) => m.name === "opentide");

  it("has an owner and a source no diagnostic collection uses, so a task never clears the server's", () => {
    const names = collectionNames();
    assert.ok(names.has("opentide"), "the language client's collection is found");
    assert.ok(names.has("opentide validate"));
    assert.ok(!names.has(matcher.owner), `owner ${matcher.owner} is a diagnostic collection's name`);
    assert.ok(!names.has(matcher.source), `source ${matcher.source} is another collection's source`);
  });
});
