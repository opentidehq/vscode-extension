// The README is the Marketplace and Open VSX Overview, and CHANGELOG.md their Changelog tab. Both
// stores render raw HTML in Markdown, so a placeholder written as text ("Explain <code>",
// "Add <platform> block") opens an element that never closes: in 0.1.0 everything after "Explain
// <code>" on the Overview rendered as code. Placeholders are written `&lt;name&gt;` or inside a code span.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The HTML elements these pages use on purpose. */
const ALLOWED = new Set(["kbd", "br", "img", "a", "details", "summary", "sub", "sup", "picture", "source"]);

/** Each `<tag …>` outside fenced blocks and code spans whose tag is not one of ALLOWED, as `line: tag`. */
function strayTags(markdown) {
  const found = [];
  let fenced = false;
  markdown.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const prose = line.replace(/`[^`]*`/g, "");
    for (const match of prose.matchAll(/<\/?([A-Za-z][\w-]*)[^>]*>/g)) {
      const tag = match[1];
      if (tag && !ALLOWED.has(tag.toLowerCase())) found.push(`${index + 1}: ${match[0]}`);
    }
  });
  return found;
}

describe("store pages (README, CHANGELOG)", () => {
  it("finds a placeholder written as a tag, and leaves code spans, fences and kbd alone", () => {
    assert.deepEqual(strayTags("**Explain <code>** opens it"), ["1: <code>"]);
    assert.deepEqual(strayTags("**Explain &lt;code&gt;** and `<platform>` and <kbd>Ctrl</kbd>"), []);
    assert.deepEqual(strayTags("```\n<tenant>\n```"), []);
  });

  for (const file of ["README.md", "CHANGELOG.md"]) {
    it(`${file} has no stray HTML tags`, () => {
      assert.deepEqual(strayTags(readFileSync(join(ROOT, file), "utf8")), []);
    });
  }
});
