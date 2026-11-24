// The extension's id differs between the stores (scripts/package-lib.mjs STORES, docs/RELEASING.md): the
// Visual Studio Marketplace's is opentide.opentide-vscode, Open VSX's opentidehq.opentide. The code takes it
// from `context.extension.id` and never names it, nor the store's `name`; settings and command ids are
// `opentide.*`, whatever the publisher and name.
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { EXTENSION_NAME, STORES, storeExtensionId } from "../../scripts/package-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function filesUnder(dir, accept) {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && accept(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

const escapeRegExp = (text) => text.replace(/[.-]/g, (c) => `\\${c}`);
/**
 * `<any store's publisher>.<any store's name>` used as an id: a literal, or a folder `<id>-<version>`; not a
 * setting such as `opentide.opentide.trace`.
 */
const PUBLISHER_QUALIFIED = new RegExp(
  `\\b(?:${STORES.map((store) => escapeRegExp(store.publisher)).join("|")})\\.(?:${[
    ...new Set(STORES.map((store) => store.name)),
  ]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")})\\b(?![.\\w])`,
  "g",
);

describe("the extension id is never a literal in the code", () => {
  it("matches each store's id (the check itself)", () => {
    for (const store of STORES) {
      const id = storeExtensionId(store);
      for (const text of [`"${id}"`, `getExtension('${id}')`, `${id}-0.3.1`, `globalStorage/${id}/`])
        assert.match(text, new RegExp(PUBLISHER_QUALIFIED.source), text);
    }
    assert.doesNotMatch("opentide.opentide.trace", new RegExp(PUBLISHER_QUALIFIED.source));
    assert.match("opentidehq.opentide-vscode", new RegExp(PUBLISHER_QUALIFIED.source), "every pairing");
    assert.doesNotMatch("github.com/opentidehq/opentide", new RegExp(PUBLISHER_QUALIFIED.source));
  });

  it("src/ names neither store's id: it uses context.extension.id", () => {
    const found = [];
    for (const file of filesUnder("src", (name) => /\.(ts|tsx|js|mjs|cjs|json)$/.test(name))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const match of line.matchAll(PUBLISHER_QUALIFIED))
          found.push(`${relative(root, file)}:${index + 1}: ${match[0]}`);
      });
    }
    assert.deepEqual(found, []);
  });

  it("src/ never names a store's own name (opentide-vscode): the name is the store's, not the code's", () => {
    const names = STORES.map((store) => store.name).filter((name) => name !== EXTENSION_NAME);
    assert.ok(names.length > 0);
    const found = filesUnder("src", (name) => /\.(ts|tsx|js|mjs|cjs|json)$/.test(name)).filter((file) => {
      const text = readFileSync(file, "utf8");
      return names.some((name) => text.includes(name));
    });
    assert.deepEqual(
      found.map((file) => relative(root, file)),
      [],
    );
  });

  it("contrib/ names neither store's id", () => {
    // A fresh RegExp per file: a /g one's lastIndex would carry over from one file to the next.
    const found = filesUnder("contrib", (name) => name.endsWith(".json")).filter((file) =>
      new RegExp(PUBLISHER_QUALIFIED.source).test(readFileSync(file, "utf8")),
    );
    assert.deepEqual(
      found.map((file) => relative(root, file)),
      [],
    );
  });
});

describe("settings, commands, views and MCP providers do not depend on the publisher", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const publishers = STORES.map((store) => store.publisher).filter(
    (publisher) => publisher !== EXTENSION_NAME,
  );

  it("every command id and setting key is opentide.*, with no publisher in it", () => {
    const configuration = [pkg.contributes.configuration].flat();
    const ids = [
      ...pkg.contributes.commands.map((command) => command.command),
      ...configuration.flatMap((section) => Object.keys(section.properties ?? {})),
    ];
    assert.ok(ids.length > 20);
    for (const id of ids) {
      assert.match(id, /^opentide\./, id);
      for (const publisher of publishers) assert.ok(!id.startsWith(`${publisher}.`), id);
    }
  });

  it("the MCP server definition provider and the view containers have publisher-free ids", () => {
    const ids = [
      ...(pkg.contributes.mcpServerDefinitionProviders ?? []).map((provider) => provider.id),
      ...Object.values(pkg.contributes.viewsContainers ?? {})
        .flat()
        .map((container) => container.id),
    ];
    assert.ok(ids.length > 0);
    for (const id of ids)
      for (const publisher of [...publishers, EXTENSION_NAME])
        assert.ok(!id.startsWith(`${publisher}.${EXTENSION_NAME}`), id);
  });
});
