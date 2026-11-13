// scripts/pins-lib.mjs: pins.json moved to an opentide release (engine assets and npm integrity).
import * as assert from "node:assert/strict";
import {
  assetUrl,
  enginePins,
  integrityFrom,
  npmPackages,
  PinsError,
  parseSha256Sums,
  registryUrl,
  updatedPins,
} from "../../scripts/pins-lib.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const SUMS = [
  `${A}  highlights-v0.24.0.zip`,
  `${B} *opentide-wasm-web-v0.24.0.zip`,
  `${C}  ./THIRD-PARTY-LICENSES.html`,
  `${"d".repeat(64)}  opentide-lsp-x86_64-unknown-linux-gnu.tar.gz`,
  "",
].join("\n");

describe("pins.json from an opentide release (scripts/pins-lib.mjs)", () => {
  it("reads SHA256SUMS in text and binary mode", () => {
    const sums = parseSha256Sums(SUMS.replaceAll("\n", "\r\n"));
    assert.equal(sums.get("highlights-v0.24.0.zip"), A);
    assert.equal(sums.get("opentide-wasm-web-v0.24.0.zip"), B);
    assert.equal(sums.get("THIRD-PARTY-LICENSES.html"), C);
  });

  it("pins the highlights zip, the engine and its licences from opentide's own release", () => {
    const pins = enginePins("0.24.0", "0.12.0", SUMS);
    assert.deepEqual(pins.highlights, {
      version: "0.24.0",
      url: "https://github.com/opentidehq/opentide/releases/download/v0.24.0/highlights-v0.24.0.zip",
      sha256: A,
    });
    assert.equal(pins.engine.version, "0.12.0", "the version the engine reports");
    assert.equal(pins.engine.release, "0.24.0");
    assert.equal(pins.engine.url, assetUrl("0.24.0", "opentide-wasm-web-v0.24.0.zip"));
    assert.equal(pins.engine.sha256, B);
    assert.deepEqual(pins.engine.thirdPartyLicenses, {
      url: "https://github.com/opentidehq/opentide/releases/download/v0.24.0/THIRD-PARTY-LICENSES.html",
      sha256: C,
    });
    assert.throws(
      () => enginePins("0.24.0", "0.12.0", `${A}  highlights-v0.24.0.zip\n`),
      /has no opentide-wasm-web/,
    );
    assert.throws(() => enginePins("latest", "0.12.0", SUMS), PinsError);
    assert.throws(() => enginePins("0.24.0", undefined, SUMS), PinsError);
  });

  it("reads each npm package's sha512 integrity, checking the registry answered for that version", () => {
    assert.equal(npmPackages().length, 7);
    assert.equal(
      registryUrl("@opentide/opentide", "0.24.0"),
      "https://registry.npmjs.org/@opentide%2fopentide/0.24.0",
    );
    const document = { name: "@opentide/opentide", version: "0.24.0", dist: { integrity: "sha512-xyz==" } };
    assert.equal(integrityFrom(document, "@opentide/opentide", "0.24.0"), "sha512-xyz==");
    assert.throws(
      () => integrityFrom({ ...document, version: "0.23.0" }, "@opentide/opentide", "0.24.0"),
      PinsError,
    );
    assert.throws(
      () => integrityFrom({ ...document, dist: { integrity: "sha1-abc" } }, "@opentide/opentide", "0.24.0"),
      /sha512/,
    );
  });

  it("writes the version and integrity, keeps the rest, and drops the source build", () => {
    const pins = {
      opentide: {
        version: "0.24.0",
        npm: { package: "@opentide/opentide", integrity: {} },
        source: { ref: "abc" },
      },
      highlights: { version: "0.10.0", url: "u", sha256: "s" },
      engine: {
        $comment: "kept",
        version: "0.10.0",
        url: "u",
        sha256: "s",
        thirdPartyLicenses: { url: "u", sha256: "s" },
      },
      vsix: { budgetBytes: 1 },
    };
    const next = updatedPins(pins, {
      version: "0.25.0",
      integrity: { "@opentide/opentide": "sha512-x" },
      engine: enginePins("0.25.0", "0.13.0", SUMS.replaceAll("0.24.0", "0.25.0")),
    });
    assert.equal(next.opentide.version, "0.25.0");
    assert.equal(next.opentide.source, undefined);
    assert.equal(next.opentide.npm.package, "@opentide/opentide");
    assert.deepEqual(next.opentide.npm.integrity, { "@opentide/opentide": "sha512-x" });
    assert.equal(next.engine.$comment, "kept");
    assert.equal(next.engine.version, "0.13.0");
    assert.equal(next.highlights.version, "0.25.0");
    assert.deepEqual(next.vsix, pins.vsix);
    assert.deepEqual(updatedPins(pins, { version: "0.25.0", integrity: {} }).engine, pins.engine);
  });
});
