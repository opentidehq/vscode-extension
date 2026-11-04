import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
  GrammarError,
  readZip,
  sha256,
  transformHighlights,
  transformToml,
  verifySha256,
} from "../../scripts/grammars-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A minimal zip writer (deflate), enough for readZip. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = deflateRawSync(Buffer.from(text));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const contributions = JSON.stringify({
  contributes: {
    grammars: [
      {
        language: "opentide-yaml",
        scopeName: "source.opentide-yaml",
        path: "./tide.tmLanguage.json",
        embeddedLanguages: { "meta.embedded.block.kql": "kql" },
      },
    ],
  },
});
const grammar = (scopeName, extra = {}) => JSON.stringify({ name: "x", scopeName, patterns: [], ...extra });

describe("grammar build", () => {
  it("fails when the zip's checksum does not match pins.json", () => {
    const buffer = Buffer.from("not the zip");
    assert.throws(
      () => verifySha256(buffer, "0".repeat(64), "highlights"),
      (e) => e instanceof GrammarError && /SHA-256/.test(e.message),
    );
    assert.doesNotThrow(() => verifySha256(buffer, sha256(buffer), "highlights"));
  });

  it("renames the ES|QL scope off Elastic's source.esql and applies embeddedLanguages", () => {
    const files = readZip(
      zip({
        "generated/package-contributions.json": contributions,
        "generated/esql.tmLanguage.json": grammar("source.esql"),
        "generated/tide.tmLanguage.json": grammar("source.opentide-yaml", {
          patterns: [{ include: "source.kql" }],
        }),
        LICENSE: "EUPL",
      }),
    );
    const { outputs, grammars } = transformHighlights(files);
    assert.equal(JSON.parse(outputs.get("esql.tmLanguage.json")).scopeName, "source.opentide.esql");
    const tide = grammars.find((g) => g.language === "opentide-yaml");
    assert.deepEqual(tide.embeddedLanguages, { "meta.embedded.block.kql": "kql" });
    assert.equal(tide.path, "./syntaxes/tide.tmLanguage.json");
  });

  it("fails when source.esql remains anywhere after the rename", () => {
    const files = readZip(
      zip({
        "generated/package-contributions.json": contributions,
        "generated/esql.tmLanguage.json": grammar("source.esql", {
          patterns: [{ include: "source.esql#inner" }],
        }),
      }),
    );
    assert.throws(() => transformHighlights(files), /still refers to source\.esql/);
  });

  it("copies the TOML grammar under source.opentide.toml", () => {
    const { text, entry } = transformToml(
      Buffer.from(grammar("source.toml", { patterns: [{ include: "#comment" }] })),
    );
    assert.equal(JSON.parse(text).scopeName, "source.opentide.toml");
    assert.equal(entry.language, "opentide-config");
    assert.throws(
      () => transformToml(Buffer.from(grammar("source.toml", { patterns: [{ include: "source.toml#x" }] }))),
      /still refers/,
    );
  });

  it("the committed grammars came from the pinned zip: no source.esql or source.toml anywhere", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const { path } of pkg.contributes.grammars) {
      const text = readFileSync(join(root, path), "utf8");
      assert.ok(!text.includes("source.esql"), path);
      assert.ok(!text.includes("source.toml"), path);
    }
    const scopes = pkg.contributes.grammars.map((g) => g.scopeName);
    assert.ok(scopes.includes("source.opentide.esql"));
    assert.ok(scopes.includes("source.opentide.toml"));
  });
});
