// scripts/opentide-lib.mjs: @opentide/opentide staged into dist/opentide/ for a platform VSIX.
import * as assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  addonName,
  buildRequest,
  fromDirectory,
  fromRegistry,
  hostTarget,
  integrityOf,
  napiPlatform,
  OpentideError,
  PACKAGE,
  readTarball,
  stagedFiles,
  stageOpentide,
  TARGETS,
} from "../../scripts/opentide-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A gzipped ustar archive with `package/<name>` entries, as `npm pack` writes. */
function tarball(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const PLATFORM = "linux-x64-gnu";
const mainFiles = (version = "0.24.0") => ({
  "package.json": JSON.stringify({ name: PACKAGE, version, bin: { opentide: "cli.js" } }),
  "index.js": "module.exports = require('./opentide.linux-x64-gnu.node')",
  "cli.js": "#!/usr/bin/env node\n",
  "index.d.ts": "export {}",
  "README.md": "# opentide",
  LICENSE: "EUPL-1.2",
});
const nativeFiles = (version = "0.24.0", platform = PLATFORM) => ({
  "package.json": JSON.stringify({ name: `${PACKAGE}-${platform}`, version }),
  [addonName(platform)]: "\x7fELF addon",
  LICENSE: "EUPL-1.2",
});
const asMap = (files) => new Map(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)]));

describe("@opentide/opentide in a platform VSIX (scripts/opentide-lib.mjs)", () => {
  let temp;
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "opentide-npm-"));
  });
  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  it("maps the six VSIX targets to opentide's native packages, with no musl", () => {
    assert.deepEqual(Object.keys(TARGETS).sort(), [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
    assert.equal(napiPlatform("win32-arm64"), "win32-arm64-msvc");
    assert.equal(napiPlatform("linux-x64"), "linux-x64-gnu");
    assert.throws(() => napiPlatform("alpine-x64"), OpentideError);
    assert.equal(hostTarget("linux", "x64"), "linux-x64");
    assert.equal(hostTarget("linux", "x64", true), undefined, "musl gets the universal VSIX");
    assert.equal(hostTarget("darwin", "arm64"), "darwin-arm64");
    assert.equal(hostTarget("linux", "ia32"), undefined);
  });

  it("reads an npm tarball without its package/ prefix, refusing paths that climb out", () => {
    const files = readTarball(tarball({ "package.json": "{}", "lib/a.js": "a" }));
    assert.deepEqual([...files.keys()], ["package.json", "lib/a.js"]);
    assert.equal(files.get("lib/a.js")?.toString(), "a");
    assert.throws(() => readTarball(tarball({ "../evil": "x" })), /unsafe path/);
    assert.throws(() => readTarball(Buffer.from("not gzip")), OpentideError);
  });

  it("stages the loader, the bin, package.json, LICENSE and one addon, with opentide.json", () => {
    const out = stagedFiles(asMap(mainFiles()), asMap(nativeFiles()), PLATFORM, "local");
    assert.deepEqual([...out.keys()].sort(), [
      "LICENSE",
      "cli.js",
      "index.js",
      "opentide.json",
      "opentide.linux-x64-gnu.node",
      "package.json",
    ]);
    const manifest = JSON.parse(out.get("opentide.json").toString());
    assert.equal(manifest.version, "0.24.0");
    assert.equal(manifest.platform, PLATFORM);
    assert.equal(manifest.cli, "cli.js");
    assert.equal(manifest.native, "opentide.linux-x64-gnu.node");
    assert.equal(manifest.nativeBytes, "\x7fELF addon".length);
    assert.match(manifest.nativeSha256, /^[0-9a-f]{64}$/);
  });

  it("refuses a native package of another version or platform, or a package without its bin", () => {
    assert.throws(
      () => stagedFiles(asMap(mainFiles()), asMap(nativeFiles("0.23.0")), PLATFORM, "local"),
      /must match/,
    );
    assert.throws(
      () => stagedFiles(asMap(mainFiles()), asMap(nativeFiles("0.24.0", "darwin-x64")), PLATFORM, "local"),
      /has no opentide.linux-x64-gnu.node/,
    );
    const noBin = { ...mainFiles(), "package.json": JSON.stringify({ name: PACKAGE, version: "0.24.0" }) };
    assert.throws(() => stagedFiles(asMap(noBin), asMap(nativeFiles()), PLATFORM, "local"), /bin opentide/);
  });

  it("finds the two tarballs anywhere under a folder (opentide's npm-packages artifact)", () => {
    mkdirSync(join(temp, "1-native"));
    mkdirSync(join(temp, "2-package"));
    writeFileSync(
      join(temp, "1-native", "opentide-opentide-linux-x64-gnu-0.24.0.tgz"),
      tarball(nativeFiles()),
    );
    writeFileSync(
      join(temp, "1-native", "opentide-opentide-darwin-x64-0.24.0.tgz"),
      tarball(nativeFiles("0.24.0", "darwin-x64")),
    );
    writeFileSync(join(temp, "2-package", "opentide-opentide-0.24.0.tgz"), tarball(mainFiles()));
    const { main, native } = fromDirectory(temp, PLATFORM);
    assert.equal(JSON.parse(main.get("package.json")).name, PACKAGE);
    assert.ok(native.has("opentide.linux-x64-gnu.node"));
  });

  it("takes a built bindings/node checkout: the addon beside index.js", () => {
    for (const [name, text] of Object.entries(mainFiles())) writeFileSync(join(temp, name), text);
    writeFileSync(join(temp, addonName(PLATFORM)), "\x7fELF addon");
    const { main, native } = fromDirectory(temp, PLATFORM);
    const out = stagedFiles(main, native, PLATFORM, "local");
    assert.ok(out.has("opentide.linux-x64-gnu.node"));
    assert.throws(() => fromDirectory(temp, "darwin-arm64"), /has no @opentide\/opentide-darwin-arm64/);
  });

  it("writes dist/opentide at the pinned version, unless told any version will do", () => {
    for (const [name, text] of Object.entries(mainFiles("0.0.0"))) writeFileSync(join(temp, name), text);
    writeFileSync(join(temp, addonName(PLATFORM)), "\x7fELF addon");
    const out = join(temp, "out");
    const pin = { version: "0.24.0", npm: { integrity: {} } };
    assert.throws(
      () => stageOpentide(temp, pin, { target: "linux-x64", from: temp, out }),
      /pins.json opentide.version/,
    );
    const manifest = stageOpentide(temp, pin, { target: "linux-x64", from: temp, out, anyVersion: true });
    assert.equal(manifest.version, "0.0.0");
    assert.ok(existsSync(join(out, "cli.js")));
    assert.ok(existsSync(join(out, "opentide.json")));
  });

  it("takes the registry's tarballs only when pins.json pins their integrity, and checks it", () => {
    const main = tarball(mainFiles());
    const native = tarball(nativeFiles());
    const cache = join(temp, ".cache", "opentide-npm");
    const packs = [];
    const run = (_npm, args) => {
      packs.push(args[1]);
      const name = args[1].startsWith(`${PACKAGE}-`)
        ? "opentide-opentide-linux-x64-gnu"
        : "opentide-opentide";
      writeFileSync(join(cache, `${name}-0.24.0.tgz`), name.endsWith("gnu") ? native : main);
      return { status: 0, stdout: "", stderr: "" };
    };
    assert.throws(
      () => fromRegistry(temp, { version: "0.24.0", npm: { integrity: {} } }, PLATFORM, run),
      /is not pinned for the registry/,
    );
    assert.deepEqual(packs, []);
    const pin = {
      version: "0.24.0",
      npm: { integrity: { [PACKAGE]: integrityOf(main), [`${PACKAGE}-${PLATFORM}`]: integrityOf(native) } },
    };
    const fetched = fromRegistry(temp, pin, PLATFORM, run);
    assert.ok(fetched.native.has(addonName(PLATFORM)));
    assert.deepEqual(packs, [`${PACKAGE}@0.24.0`, `${PACKAGE}-${PLATFORM}@0.24.0`]);
    const tampered = { ...pin, npm: { integrity: { ...pin.npm.integrity, [PACKAGE]: integrityOf(native) } } };
    assert.throws(() => fromRegistry(temp, tampered, PLATFORM, run), /is not the pinned/);
  });

  it("stages nothing for a plain build or the universal VSIX; a target, or this machine's with OPENTIDE_NPM", () => {
    assert.equal(buildRequest({}, "linux-x64"), undefined);
    assert.equal(
      buildRequest({ OPENTIDE_TARGET: "universal", OPENTIDE_NPM: "/npm" }, "linux-x64"),
      undefined,
    );
    assert.deepEqual(buildRequest({ OPENTIDE_NPM: "/npm" }, "linux-x64"), {
      target: "linux-x64",
      from: "/npm",
      anyVersion: false,
    });
    assert.deepEqual(buildRequest({ OPENTIDE_TARGET: "win32-arm64" }, "linux-x64"), {
      target: "win32-arm64",
      from: undefined,
      anyVersion: false,
    });
    assert.equal(
      buildRequest({ OPENTIDE_TARGET: "host", OPENTIDE_ANY_VERSION: "1" }, "darwin-arm64").anyVersion,
      true,
    );
    assert.throws(() => buildRequest({ OPENTIDE_NPM: "/npm" }, undefined), /OPENTIDE_TARGET=universal/);
    assert.throws(() => buildRequest({ OPENTIDE_TARGET: "alpine-x64" }, "linux-x64"), OpentideError);
  });

  it("pins.json pins @opentide/opentide's version, and integrity only for that package and its six native ones", () => {
    const pins = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
    assert.match(pins.opentide.version, /^\d+\.\d+\.\d+/);
    assert.equal(pins.opentide.npm.package, PACKAGE);
    const allowed = new Set([PACKAGE, ...Object.values(TARGETS).map((platform) => `${PACKAGE}-${platform}`)]);
    for (const [name, integrity] of Object.entries(pins.opentide.npm.integrity)) {
      assert.ok(allowed.has(name), name);
      assert.match(integrity, /^sha512-[A-Za-z0-9+/]+=*$/, name);
    }
  });
});
