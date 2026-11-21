// The bundled opentide cannot make tenant requests itself (WebAssembly has no network): the docs must not
// say "every command" works with nothing installed (#91). Where a tenant request can be made is in the README's
// table; the claims elsewhere agree with it.
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (file) => readFileSync(join(root, file), "utf8");

const FILES = [
  "README.md",
  "CHANGELOG.md",
  "contrib/core.json",
  "src/core/services/runtime.ts",
  ...readdirSync(join(root, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
];

describe("documentation: what the bundled opentide does with nothing installed (#91)", () => {
  it("never claims every command works, or that MCP needs no install, without the tenant caveat", () => {
    const claims = [
      /Every command works/,
      /every command,? (?:the )?language server(?:,[^.]*)? and MCP,? (?:work|with)[^.]*(?:nothing installed|no install)/i,
      /Everything works with no opentide installed/i,
    ];
    for (const file of FILES) {
      const text = read(file);
      for (const claim of claims) assert.doesNotMatch(text, claim, `${file}: ${claim}`);
    }
  });

  it("says in the README which surface makes tenant requests and what MCP needs", () => {
    const readme = read("README.md");
    assert.match(readme, /#### The bundled opentide: what runs where/);
    assert.match(readme, /dist\/mcp-wasi\.js/);
    assert.match(readme, /opentide 1\.0\.0-rc\.3 or later/);
    assert.match(readme, /`network_unavailable`/);
  });

  it("the setting's description keeps the caveat", () => {
    const configuration = JSON.parse(read("contrib/core.json")).contributes.configuration;
    const sections = Array.isArray(configuration) ? configuration : [configuration];
    const description = sections
      .map((section) => section.properties?.["opentide.wasi.enabled"])
      .find(Boolean)?.markdownDescription;
    assert.match(description ?? "", /no network of its own/);
  });
});
