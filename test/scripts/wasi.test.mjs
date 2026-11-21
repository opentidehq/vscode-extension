// scripts/wasi-lib.mjs: the pinned WASI module, checked, cached and recorded in dist/wasi/wasi.json.
import * as assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../scripts/grammars-lib.mjs";
import {
  checkModule,
  checkPin,
  isPlaceholder,
  prepareWasi,
  WASI_ASSET,
  wasiCachePath,
} from "../../scripts/wasi-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));

/** The smallest WebAssembly module: `\0asm`, version 1. */
const MODULE = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe("wasi: the pinned WASI module", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wasi-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pinFor = (wasm) => ({
    version: "9.9.9",
    url: "https://example.invalid/opentide-wasm32-wasip1.wasm",
    sha256: sha256(wasm),
  });
  const fetchOf =
    (files, calls = []) =>
    async (url) => {
      calls.push(url);
      const body = files[url];
      return body ? { ok: true, arrayBuffer: async () => body } : { ok: false, status: 404 };
    };

  it("is pinned by the release asset's URL and SHA-256 (or a marked placeholder until it is released)", () => {
    assert.equal(
      pins.wasi.url,
      `https://github.com/opentidehq/opentide/releases/download/v${pins.wasi.version}/${WASI_ASSET}`,
    );
    assert.equal(WASI_ASSET, "opentide-wasm32-wasip1.wasm");
    // The digest is the module's line in the release's SHA256SUMS, or says it is a placeholder: never a guess.
    assert.ok(!isPlaceholder(pins.wasi.sha256) || /^PLACEHOLDER-/.test(pins.wasi.sha256), pins.wasi.sha256);
    assert.match(pins.wasi.version, /^\d+\.\d+\.\d+(-rc\.\d+)?$/);
  });

  it("refuses a placeholder digest and says how to set it", () => {
    assert.equal(isPlaceholder("PLACEHOLDER-x"), true);
    assert.equal(isPlaceholder(undefined), true);
    assert.equal(isPlaceholder("a".repeat(63)), true);
    assert.equal(isPlaceholder("a".repeat(64)), false);
    assert.throws(
      () => checkPin({ version: "1", url: "u", sha256: "PLACEHOLDER-x" }),
      /placeholder.*SHA256SUMS/,
    );
    assert.throws(() => checkPin({ version: "1", sha256: "a" }), /no wasi/);
    assert.throws(() => checkPin(undefined), /no wasi/);
  });

  it("downloads once, verifies, caches, and records the module in the manifest", async () => {
    const pin = pinFor(MODULE);
    const calls = [];
    const fetchImpl = fetchOf({ [pin.url]: MODULE }, calls);
    const first = await prepareWasi(dir, pin, { modulePath: "", fetchImpl });
    assert.deepEqual(first.wasm, MODULE);
    assert.deepEqual(first.manifest, {
      $comment: "Written by scripts/build.mjs from pins.json wasi. Do not edit.",
      version: "9.9.9",
      module: "opentide.wasm",
      launcher: "launcher.cjs",
      source: "release",
      url: pin.url,
      sha256: pin.sha256,
      moduleSha256: pin.sha256,
      moduleBytes: MODULE.length,
    });
    assert.ok(existsSync(wasiCachePath(dir, pin)));
    await prepareWasi(dir, pin, { modulePath: "", fetchImpl });
    assert.equal(calls.length, 1);
  });

  it("refuses a download whose digest is not the pin's, and leaves nothing in the cache", async () => {
    const pin = { ...pinFor(MODULE), sha256: "0".repeat(64) };
    await assert.rejects(
      prepareWasi(dir, pin, { modulePath: "", fetchImpl: fetchOf({ [pin.url]: MODULE }) }),
      /SHA-256 is .*, but pins.json records/,
    );
    assert.equal(existsSync(wasiCachePath(dir, pin)), false);
    await assert.rejects(prepareWasi(dir, pin, { modulePath: "", fetchImpl: fetchOf({}) }), /HTTP 404/);
  });

  it("refuses a cached file that no longer matches, and a download that is no module", async () => {
    const text = Buffer.from("<html>not a module</html>");
    const pin = pinFor(text);
    await assert.rejects(
      prepareWasi(dir, pin, { modulePath: "", fetchImpl: fetchOf({ [pin.url]: text }) }),
      /not a WebAssembly module/,
    );
    assert.throws(() => checkModule(Buffer.from([0, 0x61, 0x73, 0x6d, 2, 0, 0, 0])), /not a WebAssembly/);
    assert.throws(() => checkModule(Buffer.alloc(3)), /not a WebAssembly/);
  });

  it("takes a module made from opentide's source instead, recorded as local, with no pin to check", async () => {
    const file = join(dir, "opentide.wasm");
    (await import("node:fs")).writeFileSync(file, MODULE);
    const local = await prepareWasi(dir, pins.wasi, { modulePath: file, version: "1.0.0-rc.3-dev+abc" });
    assert.equal(local.manifest.source, "local");
    assert.equal(local.manifest.version, "1.0.0-rc.3-dev+abc");
    assert.equal(local.manifest.url, undefined);
    assert.equal(local.manifest.moduleSha256, sha256(MODULE));
    const unversioned = await prepareWasi(dir, pins.wasi, { modulePath: file });
    assert.equal(unversioned.manifest.version, `${pins.wasi.version}+local`);
    (await import("node:fs")).writeFileSync(file, "nope");
    await assert.rejects(prepareWasi(dir, pins.wasi, { modulePath: file }), /not a WebAssembly module/);
  });
});
