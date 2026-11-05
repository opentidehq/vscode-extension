// scripts/engine-lib.mjs: the pinned opentide-wasm-web zip, checked, unpacked and shipped in dist/engine/.
import * as assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
  checkEntries,
  engineCacheDir,
  engineManifest,
  GLUE,
  isShipped,
  prepareEngine,
  shippedFiles,
  THIRD_PARTY,
  WASM,
} from "../../scripts/engine-lib.mjs";
import { sha256 } from "../../scripts/grammars-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));

/** A minimal deflate zip, enough for readZip. */
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

const ENTRIES = {
  [GLUE]: "export function version() {}",
  [WASM]: "\0asm",
  "opentide_wasm.d.ts": "",
  "opentide_wasm_bg.wasm.d.ts": "",
  LICENSE: "EUPL-1.2",
  NOTICE: "notice",
  "licenses/wasi-libc/LICENSE": "wasi",
};

describe("engine: the pinned WebAssembly build of the language server", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pinFor = (archive, licenses = Buffer.from("<html>")) => ({
    version: "9.9.9",
    url: "https://example.invalid/opentide-wasm-web-v9.9.9.zip",
    sha256: sha256(archive),
    thirdPartyLicenses: {
      url: "https://example.invalid/THIRD-PARTY-LICENSES.html",
      sha256: sha256(licenses),
    },
  });
  const fetchOf =
    (files, calls = []) =>
    async (url) => {
      calls.push(url);
      const body = files[url];
      return body ? { ok: true, arrayBuffer: async () => body } : { ok: false, status: 404 };
    };

  it("is pinned by URL and SHA-256 from the same language-server release as the highlights", () => {
    assert.equal(pins.engine.version, pins.highlights.version);
    assert.equal(
      pins.engine.url,
      `https://github.com/opentidehq/language-server/releases/download/v${pins.engine.version}/opentide-wasm-web-v${pins.engine.version}.zip`,
    );
    assert.match(pins.engine.sha256, /^[0-9a-f]{64}$/);
    assert.match(
      pins.engine.thirdPartyLicenses.url,
      new RegExp(`/v${pins.engine.version}/THIRD-PARTY-LICENSES\\.html$`),
    );
    assert.match(pins.engine.thirdPartyLicenses.sha256, /^[0-9a-f]{64}$/);
  });

  it("downloads once, checks both files' SHA-256, and unpacks what it ships", async () => {
    const archive = zip(ENTRIES);
    const licenses = Buffer.from("<html>licences</html>");
    const pin = pinFor(archive, licenses);
    const calls = [];
    const files = { [pin.url]: archive, [pin.thirdPartyLicenses.url]: licenses };
    const out = await prepareEngine(dir, pin, { fetchImpl: fetchOf(files, calls) });
    assert.equal(out, engineCacheDir(dir, pin));
    assert.equal(readFileSync(join(out, GLUE), "utf8"), ENTRIES[GLUE]);
    assert.equal(readFileSync(join(out, THIRD_PARTY), "utf8"), "<html>licences</html>");
    assert.equal(calls.length, 2);
    await prepareEngine(dir, pin, { fetchImpl: fetchOf(files, calls) });
    assert.equal(calls.length, 2, "the cache serves the second build");
    const shipped = shippedFiles(out, join(dir, "dist", "engine")).map(([, to]) =>
      to.slice(join(dir, "dist", "engine").length + 1).replaceAll("\\", "/"),
    );
    assert.deepEqual(
      shipped.sort(),
      [THIRD_PARTY, "LICENSE", "NOTICE", "licenses/wasi-libc/LICENSE", WASM].sort(),
    );
  });

  it("refuses a zip or a licence file whose SHA-256 is not the pin's", async () => {
    const archive = zip(ENTRIES);
    const pin = { ...pinFor(archive), sha256: "0".repeat(64) };
    await assert.rejects(
      prepareEngine(dir, pin, { fetchImpl: fetchOf({ [pin.url]: archive }) }),
      /SHA-256 is .* but pins\.json records 0000/,
    );
    const good = pinFor(archive);
    const files = { [good.url]: archive, [good.thirdPartyLicenses.url]: Buffer.from("tampered") };
    await assert.rejects(
      prepareEngine(dir, good, { fetchImpl: fetchOf(files) }),
      /THIRD-PARTY-LICENSES.*SHA-256/,
    );
    assert.equal(existsSync(join(engineCacheDir(dir, good), ".complete")), false);
  });

  it("refuses a zip without the module, the glue or the licences, or with files it does not know", () => {
    assert.throws(
      () => checkEntries(Object.keys(ENTRIES).filter((n) => n !== WASM)),
      /no opentide_wasm_bg\.wasm/,
    );
    assert.throws(() => checkEntries(Object.keys(ENTRIES).filter((n) => n !== "LICENSE")), /no LICENSE/);
    assert.throws(() => checkEntries([...Object.keys(ENTRIES), "run-me.sh"]), /unexpected files: run-me\.sh/);
    checkEntries(Object.keys(ENTRIES));
  });

  it("ships the module and every licence, never the glue (bundled into the worker) or the typings", () => {
    assert.equal(isShipped(WASM), true);
    assert.equal(isShipped("LICENSE"), true);
    assert.equal(isShipped("licenses/wasi-libc/musl-COPYRIGHT"), true);
    assert.equal(isShipped(THIRD_PARTY), true);
    assert.equal(isShipped(GLUE), false);
    assert.equal(isShipped("opentide_wasm.d.ts"), false);
  });

  it("writes engine.json with the version and both checksums", () => {
    const manifest = engineManifest(pins.engine, Buffer.from("\0asm"));
    assert.equal(manifest.version, pins.engine.version);
    assert.equal(manifest.module, WASM);
    assert.equal(manifest.zipSha256, pins.engine.sha256);
    assert.equal(manifest.moduleSha256, sha256(Buffer.from("\0asm")));
    assert.equal(manifest.moduleBytes, 4);
  });

  it("every package carries dist/engine/ (the .vscodeignore keeps dist/**, maps aside)", () => {
    const ignore = readFileSync(join(root, ".vscodeignore"), "utf8").split(/\r?\n/);
    assert.ok(ignore.includes("!dist/**"));
    assert.equal(
      ignore.some((line) => /engine|\.wasm/.test(line)),
      false,
    );
  });
});
