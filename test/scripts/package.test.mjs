import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { commonOptions } from "../../scripts/build-lib.mjs";
import {
  budgetFor,
  formatReport,
  isPreReleaseVersion,
  largestDirectories,
  PackageError,
  sizeReport,
  sizeUnit,
  targetBytesFor,
  vsixName,
  zipEntries,
  zipRead,
} from "../../scripts/package-lib.mjs";
import {
  checkEngineInitialize,
  checkPackageCommands,
  checkPackageInitialize,
  checkPackageLayout,
  checkWebEntry,
  commandPaths,
  versionOf,
} from "../../scripts/smoke-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A minimal zip writer (deflate, Unix modes), like a VSIX. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, text, mode = 0o100644 } of entries) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("package: names, ignore file and pre-release", () => {
  it("names the VSIX (universal; a target name for a VSIX from before 0.1.2)", () => {
    assert.equal(vsixName("linux-x64", "0.2.0"), "opentide-linux-x64-0.2.0.vsix");
    assert.equal(vsixName(undefined, "0.2.0"), "opentide-universal-0.2.0.vsix");
  });

  it("packages an odd minor version as a pre-release", () => {
    assert.equal(isPreReleaseVersion("0.1.0"), true);
    assert.equal(isPreReleaseVersion("1.3.2"), true);
    assert.equal(isPreReleaseVersion("0.2.0"), false);
    assert.equal(isPreReleaseVersion("1.10.0"), false);
  });

  it("the package carries no runtime/", () => {
    const text = readFileSync(join(root, ".vscodeignore"), "utf8");
    assert.doesNotMatch(text, /^!\s*runtime/m);
  });
});

describe("package: the size gate", () => {
  const pins = { opentide: { version: "0.21.0" }, vsix: { budgetBytes: 100, targetBytes: 70 } };

  it("uses vsix.budgetBytes, or an override only for the opentide version it names", () => {
    assert.deepEqual(budgetFor(pins), { bytes: 100, budgetBytes: 100 });
    const override = { opentide: "0.21.0", bytes: 120, reason: "opentide#747" };
    assert.equal(budgetFor({ ...pins, vsix: { ...pins.vsix, budgetOverrideBytes: override } }).bytes, 120);
    const stale = budgetFor({
      ...pins,
      opentide: { version: "0.22.0" },
      vsix: { ...pins.vsix, budgetOverrideBytes: override },
    });
    assert.equal(stale.bytes, 100);
    assert.equal(stale.staleOverride, override);
    assert.throws(() => budgetFor({ opentide: pins.opentide }), PackageError);
  });

  it("gives a platform VSIX, which carries @opentide/opentide's addon, a budget of its own", () => {
    const pins = {
      opentide: { version: "0.24.0" },
      vsix: { budgetBytes: 100, targetBytes: 50, platform: { budgetBytes: 300, targetBytes: 250 } },
    };
    assert.deepEqual(budgetFor(pins, "linux-x64"), { bytes: 300, budgetBytes: 300 });
    assert.deepEqual(budgetFor(pins), { bytes: 100, budgetBytes: 100 });
    assert.equal(targetBytesFor(pins, "darwin-arm64"), 250);
    assert.equal(targetBytesFor(pins, undefined), 50);
    assert.throws(
      () => budgetFor({ ...pins, vsix: { budgetBytes: 100 } }, "linux-x64"),
      /vsix.platform.budgetBytes/,
    );
    const committed = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
    assert.equal(committed.vsix.platform.budgetBytes, 30 * 1024 * 1024);
  });

  it("names a platform VSIX after its target", () => {
    assert.equal(vsixName("linux-x64", "0.2.0"), "opentide-linux-x64-0.2.0.vsix");
    assert.equal(vsixName(undefined, "0.2.0"), "opentide-universal-0.2.0.vsix");
  });

  it("smoke: reads a version line, the command paths with first-argument choices, and dist/opentide's layout", () => {
    assert.equal(versionOf("opentide 0.24.0\n"), "0.24.0");
    assert.equal(versionOf("0.24.0-rc.1"), "0.24.0-rc.1");
    assert.equal(versionOf("nothing"), undefined);
    const document = {
      commands: [
        { path: "info", arguments: [{ name: "section", choices: ["rules", "catalog"] }] },
        { path: "serve", arguments: [] },
        { path: "lsp start" },
        { path: "mcp start" },
        { path: "validate" },
      ],
    };
    assert.ok(commandPaths(document).has("info catalog"));
    assert.deepEqual(checkPackageCommands(document), []);
    assert.deepEqual(checkPackageCommands({ commands: [{ path: "validate" }] }), [
      "the bundled opentide has no `serve`",
      "the bundled opentide has no `lsp start`",
      "the bundled opentide has no `mcp start`",
      "the bundled opentide has no `info catalog`",
    ]);
    const manifest = {
      name: "@opentide/opentide",
      platform: "linux-x64-gnu",
      cli: "cli.js",
      native: "opentide.linux-x64-gnu.node",
    };
    assert.deepEqual(
      checkPackageLayout(manifest, "linux-x64-gnu", () => true),
      [],
    );
    assert.deepEqual(
      checkPackageLayout(manifest, "darwin-x64", () => true),
      ["dist/opentide is for linux-x64-gnu, expected darwin-x64"],
    );
    assert.deepEqual(
      checkPackageLayout(undefined, "linux-x64-gnu", () => true),
      ["the package has no dist/opentide/opentide.json"],
    );
    assert.deepEqual(checkPackageInitialize({ result: { capabilities: { textDocumentSync: 2 } } }), []);
    assert.equal(checkPackageInitialize({ error: { code: -1 } }).length, 1);
  });

  it("the committed budget and target are PACKAGING.md's 20 MiB and 10 MiB: no runtime", () => {
    const committed = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
    assert.equal(committed.vsix.budgetBytes, 20 * 1024 * 1024);
    assert.equal(committed.vsix.targetBytes, 10 * 1024 * 1024);
    const packaging = readFileSync(join(root, "docs", "PACKAGING.md"), "utf8");
    assert.match(packaging, /The universal package.s size gate \(20 MiB\) and target \(10 MiB\)/);
  });

  it("counts bytes per distribution under site-packages, else per folder", () => {
    assert.equal(
      sizeUnit("extension/runtime/lib/python3.13/site-packages/botocore/data/ec2/x.json"),
      "extension/runtime/lib/python3.13/site-packages/botocore",
    );
    assert.equal(
      sizeUnit("extension/runtime/lib/python3.13/json/decoder.py"),
      "extension/runtime/lib/python3.13",
    );
    assert.equal(sizeUnit("extension/runtime/bin/python3"), "extension/runtime/bin");
    assert.equal(sizeUnit("extension.vsixmanifest"), "(root)");
    const largest = largestDirectories(
      [
        { name: "extension/runtime/bin/python3", compressedSize: 50, size: 90 },
        { name: "extension/runtime/lib/python3.13/site-packages/a/x.py", compressedSize: 10, size: 20 },
        { name: "extension/runtime/lib/python3.13/site-packages/a/y.py", compressedSize: 30, size: 40 },
        { name: "extension/dist/extension.js", compressedSize: 5, size: 9 },
      ],
      2,
    );
    assert.deepEqual(largest, [
      { path: "extension/runtime/bin", bytes: 50, size: 90, files: 1 },
      { path: "extension/runtime/lib/python3.13/site-packages/a", bytes: 40, size: 60, files: 2 },
    ]);
  });

  it("reports the size, the budget and the five largest directories", () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({
      name: `extension/d${i}/f`,
      compressedSize: 10 + i,
      size: 20,
    }));
    const report = sizeReport({
      file: "opentide-linux-x64-0.2.0.vsix",
      target: "linux-x64",
      bytes: 150,
      entries,
      budget: { bytes: 100, budgetBytes: 100 },
      targetBytes: 70,
      opentide: "0.21.0",
    });
    assert.equal(report.withinBudget, false);
    assert.equal(report.withinTarget, false);
    assert.equal(report.installedBytes, 140);
    assert.deepEqual(
      report.largest.map((unit) => unit.path),
      ["extension/d6", "extension/d5", "extension/d4", "extension/d3", "extension/d2"],
    );
    const lines = formatReport(report);
    assert.match(lines[0], /opentide-linux-x64-0\.2\.0\.vsix: 0\.0 MiB \(150 bytes, 7 files/);
    assert.equal(lines.length, 3 + 5);
  });
});

describe("package: zip reading", () => {
  it("reads entries with their Unix modes and contents", () => {
    const buffer = zip([
      { name: "extension/runtime/bin/python3", text: "#!binary", mode: 0o100755 },
      { name: "extension/package.json", text: "{}" },
    ]);
    const entries = zipEntries(buffer);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].mode, 0o755);
    assert.equal(entries[1].mode, 0o644);
    assert.equal(zipRead(buffer, entries[0]).toString(), "#!binary");
  });

  it("refuses paths that escape the folder", () => {
    assert.throws(() => zipEntries(zip([{ name: "../evil", text: "x" }])), /unsafe path/);
    assert.throws(() => zipEntries(zip([{ name: "/abs", text: "x" }])), /unsafe path/);
    assert.throws(() => zipEntries(Buffer.from("not a zip")), PackageError);
  });
});

describe("smoke: checks", () => {
  it("every package carries the web extension: browser, the engine's Web Worker and the module", () => {
    const pkg = {
      browser: "./dist/web/extension.js",
      capabilities: { virtualWorkspaces: { supported: "limited" } },
    };
    const files = new Set([
      "dist/web/extension.js",
      "dist/web/engine-worker.js",
      "dist/engine/opentide_wasm_bg.wasm",
    ]);
    assert.deepEqual(
      checkWebEntry(pkg, (file) => files.has(file)),
      [],
    );
    assert.deepEqual(
      checkWebEntry({}, () => false),
      [
        "package.json has no browser entry",
        "the package has no dist/web/engine-worker.js",
        "the package has no dist/engine/opentide_wasm_bg.wasm",
      ],
    );
    assert.match(checkWebEntry(pkg, (file) => file !== "dist/web/extension.js")[0], /lacks/);
  });

  it("the engine (WASM) worker must answer as opentide-lsp at engine.json's version, with no host", () => {
    const answer = (opentide, name = "opentide-lsp") => ({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name }, capabilities: { experimental: { opentide } } },
    });
    assert.deepEqual(checkEngineInitialize(answer({ host: null, engine: "0.10.0" }), "0.10.0", 0), []);
    assert.deepEqual(checkEngineInitialize(answer({ host: null, engine: "0.9.1" }), "0.10.0", 0), [
      "engine is 0.9.1, engine.json says 0.10.0",
    ]);
    assert.equal(
      checkEngineInitialize(answer({ host: { name: "opentide" }, engine: "0.10.0" }), "0.10.0", 0).length,
      1,
    );
    assert.equal(checkEngineInitialize(answer({ host: null, engine: "0.10.0" }), "0.10.0", 1).length, 1);
    assert.match(
      checkEngineInitialize(
        { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "did not load" } },
        "0.10.0",
        0,
      )[0],
      /did not load/,
    );
  });
});

describe("the packaged bundles are minified", () => {
  it("vsce's vscode:prepublish runs the production build, which minifies without source maps", () => {
    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
    assert.equal(scripts["vscode:prepublish"], "npm run build:production");
    assert.match(scripts["build:production"], /node scripts\/build\.mjs --production$/);
    const build = readFileSync(join(root, "scripts", "build.mjs"), "utf8");
    assert.match(build, /const common = commonOptions\(production\);/);
    assert.deepEqual(
      [commonOptions(true).minify, commonOptions(true).sourcemap, commonOptions(false).sourcemap],
      [true, false, true],
    );
    assert.match(readFileSync(join(root, ".vscodeignore"), "utf8"), /^dist\/\*\*\/\*\.map$/m);
  });
});
