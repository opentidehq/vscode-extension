// scripts/wasi-lib.mjs: the pinned WASI module, checked, cached and recorded in dist/wasi/wasi.json.
import * as assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../../scripts/grammars-lib.mjs";
import {
  checkModule,
  checkPin,
  isPlaceholder,
  localLicences,
  prepareWasi,
  WASI_ASSET,
  WASI_LICENCES,
  wasiCachePath,
  wasiLicenceCachePath,
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

  /** The licence files of a release of this test: their text by name. */
  const LICENCE_TEXTS = Object.fromEntries(
    WASI_LICENCES.map((name) => [name, Buffer.from(`${name} of 9.9.9`)]),
  );
  const pinFor = (wasm) => ({
    version: "9.9.9",
    url: "https://example.invalid/opentide-wasm32-wasip1.wasm",
    sha256: sha256(wasm),
    licences: Object.fromEntries(
      WASI_LICENCES.map((name) => [
        name,
        { url: `https://example.invalid/${name}`, sha256: sha256(LICENCE_TEXTS[name]) },
      ]),
    ),
  });
  const releaseFiles = (pin, wasm) => ({
    [pin.url]: wasm,
    ...Object.fromEntries(WASI_LICENCES.map((name) => [pin.licences[name].url, LICENCE_TEXTS[name]])),
  });
  /** A folder with the four licence files, as a build from opentide's source has them. */
  const licenceFolder = () => {
    const folder = join(dir, "licences");
    mkdirSync(folder, { recursive: true });
    for (const name of WASI_LICENCES) writeFileSync(join(folder, name), LICENCE_TEXTS[name]);
    return folder;
  };
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
    const fetchImpl = fetchOf(releaseFiles(pin, MODULE), calls);
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
      licences: WASI_LICENCES,
      moduleSha256: pin.sha256,
      moduleBytes: MODULE.length,
    });
    assert.ok(existsSync(wasiCachePath(dir, pin)));
    // The module's own licence set, as pinned: never the engine's.
    assert.deepEqual([...first.licences.keys()], WASI_LICENCES);
    for (const name of WASI_LICENCES) assert.deepEqual(first.licences.get(name), LICENCE_TEXTS[name]);
    await prepareWasi(dir, pin, { modulePath: "", fetchImpl });
    assert.equal(calls.length, 1 + WASI_LICENCES.length);
  });

  it("refuses a download whose digest is not the pin's, and leaves nothing in the cache", async () => {
    const pin = { ...pinFor(MODULE), sha256: "0".repeat(64) };
    await assert.rejects(
      prepareWasi(dir, pin, { modulePath: "", fetchImpl: fetchOf(releaseFiles(pin, MODULE)) }),
      /SHA-256 is .*, but pins.json records/,
    );
    assert.equal(existsSync(wasiCachePath(dir, pin)), false);
    await assert.rejects(prepareWasi(dir, pin, { modulePath: "", fetchImpl: fetchOf({}) }), /HTTP 404/);
  });

  it("refuses a cached file that no longer matches, and a download that is no module", async () => {
    const text = Buffer.from("<html>not a module</html>");
    const pin = pinFor(text);
    await assert.rejects(
      prepareWasi(dir, pin, { modulePath: "", fetchImpl: fetchOf(releaseFiles(pin, text)) }),
      /not a WebAssembly module/,
    );
    assert.throws(() => checkModule(Buffer.from([0, 0x61, 0x73, 0x6d, 2, 0, 0, 0])), /not a WebAssembly/);
    assert.throws(() => checkModule(Buffer.alloc(3)), /not a WebAssembly/);
  });

  it("takes a module made from opentide's source instead, recorded as local, with no pin to check", async () => {
    const file = join(dir, "opentide.wasm");
    (await import("node:fs")).writeFileSync(file, MODULE);
    const local = await prepareWasi(dir, pins.wasi, {
      modulePath: file,
      version: "1.0.0-rc.3-dev+abc",
      licencesDir: licenceFolder(),
    });
    assert.equal(local.manifest.source, "local");
    assert.equal(local.manifest.version, "1.0.0-rc.3-dev+abc");
    assert.equal(local.manifest.url, undefined);
    assert.equal(local.manifest.moduleSha256, sha256(MODULE));
    // Without a version of its own, the pin's, marked local: whatever OPENTIDE_WASI_VERSION says in the environment
    // (the test build sets it) is not the test's input.
    const named = process.env.OPENTIDE_WASI_VERSION;
    delete process.env.OPENTIDE_WASI_VERSION;
    try {
      const unversioned = await prepareWasi(dir, pins.wasi, {
        modulePath: file,
        licencesDir: licenceFolder(),
      });
      assert.equal(unversioned.manifest.version, `${pins.wasi.version}+local`);
    } finally {
      if (named !== undefined) process.env.OPENTIDE_WASI_VERSION = named;
    }
    (await import("node:fs")).writeFileSync(file, "nope");
    await assert.rejects(
      prepareWasi(dir, pins.wasi, { modulePath: file, licencesDir: licenceFolder() }),
      /not a WebAssembly module/,
    );
  });

  describe("the module's licence set (#92)", () => {
    it("is pinned next to the module: four files of the same release, each with a URL and a digest", () => {
      assert.deepEqual(WASI_LICENCES, [
        "THIRD-PARTY-LICENSES.html",
        "WASI-LIBC-LICENSES.txt",
        "LICENSE",
        "NOTICE",
      ]);
      for (const name of WASI_LICENCES) {
        const entry = pins.wasi.licences[name];
        assert.equal(
          entry.url,
          `https://github.com/opentidehq/opentide/releases/download/v${pins.wasi.version}/${name}`,
        );
        // A real digest, or marked as the placeholder it is until the release exists.
        assert.ok(
          !isPlaceholder(entry.sha256) || /^PLACEHOLDER-/.test(entry.sha256),
          `${name}: ${entry.sha256}`,
        );
      }
      // Not the engine's copies: those are another build's.
      assert.notEqual(
        pins.wasi.licences["THIRD-PARTY-LICENSES.html"].url,
        pins.engine.thirdPartyLicenses.url,
      );
    });

    it("refuses a pin whose licence digests are placeholders, naming them", () => {
      const pin = { ...pinFor(MODULE) };
      assert.doesNotThrow(() => checkPin(pin));
      pin.licences = { ...pin.licences, NOTICE: { url: "u", sha256: "PLACEHOLDER-x" } };
      assert.throws(() => checkPin(pin), /placeholder digest \(licences\.NOTICE\)/);
      delete pin.licences;
      assert.throws(() => checkPin(pin), /licences\.THIRD-PARTY-LICENSES\.html/);
    });

    it("refuses a licence file whose digest is not the pin's, and caches nothing of it", async () => {
      const pin = pinFor(MODULE);
      const files = releaseFiles(pin, MODULE);
      files[pin.licences.NOTICE.url] = Buffer.from("another NOTICE");
      await assert.rejects(
        prepareWasi(dir, pin, { modulePath: "", fetchImpl: fetchOf(files) }),
        /NOTICE.*SHA-256/s,
      );
      assert.equal(existsSync(wasiLicenceCachePath(dir, pin, "NOTICE")), false);
    });

    it("a module made from source needs the four files of its own build, none empty", () => {
      assert.throws(() => localLicences(undefined), /OPENTIDE_WASI_LICENCES/);
      const folder = licenceFolder();
      assert.deepEqual([...localLicences(folder).keys()], WASI_LICENCES);
      rmSync(join(folder, "NOTICE"));
      assert.throws(() => localLicences(folder), /NOTICE does not exist/);
      writeFileSync(join(folder, "NOTICE"), "");
      assert.throws(() => localLicences(folder), /NOTICE is empty/);
    });
  });
});
