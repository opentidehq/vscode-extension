import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { commonOptions } from "../../scripts/build-lib.mjs";
import {
  budgetFor,
  buildInfoProblem,
  formatReport,
  isPreReleaseVersion,
  largestDirectories,
  PackageError,
  sizeReport,
  sizeUnit,
  universalIgnore,
  vsixName,
  zipEntries,
  zipRead,
} from "../../scripts/package-lib.mjs";
import {
  bundledPython,
  checkCatalog,
  checkDoctor,
  checkEngineInitialize,
  checkInitialize,
  checkInterpreterPlatform,
  checkVersion,
  checkWebEntry,
  FrameReader,
  frame,
  median,
  opentideArgs,
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
  it("names the per-platform and universal VSIX", () => {
    assert.equal(vsixName("linux-x64", "0.2.0"), "opentide-linux-x64-0.2.0.vsix");
    assert.equal(vsixName(undefined, "0.2.0"), "opentide-universal-0.2.0.vsix");
  });

  it("packages an odd minor version as a pre-release", () => {
    assert.equal(isPreReleaseVersion("0.1.0"), true);
    assert.equal(isPreReleaseVersion("1.3.2"), true);
    assert.equal(isPreReleaseVersion("0.2.0"), false);
    assert.equal(isPreReleaseVersion("1.10.0"), false);
  });

  it("the universal ignore file excludes runtime/ even when one was built", () => {
    const text = readFileSync(join(root, ".vscodeignore"), "utf8");
    assert.match(
      text,
      /^!runtime\/!\(locks\)\/\*\*$/m,
      "the per-platform package includes runtime/, not its locks",
    );
    assert.match(text, /^!runtime\/!\(locks\|requirements\.in\)$/m);
    const universal = universalIgnore(text);
    assert.doesNotMatch(universal, /^!\s*runtime/m);
    assert.match(universal, /^runtime\/\*\*\n$/m);
    assert.match(universal, /^!dist\/\*\*$/m);
  });
});

describe("package: the runtime/ build a target needs", () => {
  const want = { target: "win32-arm64", runtime: "win32-x64", opentide: "0.22.0", cpython: "3.13.14" };
  const info = { target: "win32-arm64", runtime: "win32-x64", opentide: "0.22.0", cpython: "3.13.14" };

  it("accepts the target's build of its runtime, the pinned opentide and CPython", () => {
    assert.equal(buildInfoProblem(info, want), undefined);
    const native = { ...want, target: "linux-x64", runtime: "linux-x64" };
    assert.equal(buildInfoProblem({ ...native }, native), undefined);
    assert.equal(
      buildInfoProblem({ ...native, runtime: undefined }, native),
      undefined,
      "a build before `runtime`",
    );
  });

  it("refuses another target, another runtime, opentide or CPython", () => {
    assert.match(
      buildInfoProblem({ ...info, target: "win32-x64" }, want),
      /^runtime\/ holds win32-x64 \(opentide 0\.22\.0, CPython 3\.13\.14\), not win32-arm64 with the win32-x64 runtime/,
    );
    // The universal-era native arm64 build, or one from before BUILD-INFO had `runtime`.
    assert.match(
      buildInfoProblem({ ...info, runtime: undefined }, want),
      /holds win32-arm64 \(opentide.*not win32-arm64 with the win32-x64 runtime/,
    );
    assert.match(buildInfoProblem({ ...info, runtime: "win32-arm64" }, want), /holds win32-arm64 \(/);
    assert.match(buildInfoProblem({ ...info, opentide: "0.21.0" }, want), /opentide 0\.21\.0/);
    assert.match(buildInfoProblem({ ...info, cpython: "3.12.9" }, want), /CPython 3\.12\.9/);
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

  it("the committed budget and target are SPEC §3's 100 MiB and 70 MiB", () => {
    const committed = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
    assert.equal(committed.vsix.budgetBytes, 100 * 1024 * 1024);
    assert.equal(committed.vsix.targetBytes, 70 * 1024 * 1024);
    const spec = readFileSync(join(root, "docs", "SPEC.md"), "utf8");
    assert.match(spec, /100 MiB \(104,857,600 bytes\) per VSIX/);
    assert.doesNotMatch(spec, /\b(?:100|70) MB\b/, "SPEC says MiB, as pins.json and PACKAGING.md count");
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
  it("runs the bundled interpreter as the extension does", () => {
    assert.equal(
      bundledPython("/x/extension", "linux", join),
      join("/x/extension", "runtime", "bin", "python3"),
    );
    assert.equal(bundledPython("/x/extension", "win32", join), join("/x/extension", "runtime", "python.exe"));
    assert.deepEqual(opentideArgs("/p", ["--version"]), [
      "-I",
      "-X",
      "utf8",
      "-X",
      "pycache_prefix=/p",
      "-m",
      "opentide",
      "--version",
    ]);
  });

  it("frames and splits LSP messages across chunks", () => {
    const wire = Buffer.concat([frame({ id: 1, result: { é: 1 } }), frame({ id: 2 })]);
    const reader = new FrameReader();
    assert.deepEqual(reader.push(wire.subarray(0, 10)), []);
    assert.deepEqual(reader.push(wire.subarray(10)), [{ id: 1, result: { é: 1 } }, { id: 2 }]);
  });

  it("checks --version against the version the runtime was built with", () => {
    assert.deepEqual(checkVersion("opentide 0.21.0\n", "0.21.0"), []);
    assert.equal(checkVersion("opentide 0.20.1\n", "0.21.0").length, 1);
    assert.equal(checkVersion("Traceback", "0.21.0").length, 1);
  });

  it("doctor fails only on package checks; git on the host does not count", () => {
    const doc = (checks) => JSON.stringify({ ok: false, checks });
    assert.deepEqual(
      checkDoctor(
        doc([
          { code: "git", status: "fail", message: "git not found" },
          { code: "analysis_engine", status: "pass", message: "loads" },
        ]),
      ),
      [],
    );
    assert.deepEqual(checkDoctor(doc([{ code: "workspace", status: "fail", message: "No workspace" }])), [
      "doctor check workspace failed: No workspace",
    ]);
    assert.equal(
      checkDoctor(doc([{ code: "analysis_engine", status: "warn", message: "missing" }])).length,
      1,
    );
    assert.equal(checkDoctor("Traceback").length, 1);
    assert.equal(checkDoctor(doc([])).length, 1);
  });

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

  it("the interpreter is of the runtime's architecture, not the machine's", () => {
    const emulated = { target: "win32-arm64", runtime: "win32-x64" };
    assert.deepEqual(checkInterpreterPlatform("win-amd64\r\n", emulated), []);
    assert.match(
      checkInterpreterPlatform("win-arm64", emulated)[0],
      /"win-arm64", not the win32-x64 runtime's x64/,
    );
    assert.deepEqual(
      checkInterpreterPlatform("win-arm64", { target: "win32-arm64", runtime: "win32-arm64" }),
      [],
    );
    assert.deepEqual(
      checkInterpreterPlatform("linux-x86_64", { target: "linux-x64" }),
      [],
      "no runtime: its target's",
    );
    assert.deepEqual(checkInterpreterPlatform("linux-aarch64", { target: "alpine-arm64" }), []);
    assert.deepEqual(checkInterpreterPlatform("macosx-11.0-arm64", { target: "darwin-arm64" }), []);
    assert.equal(checkInterpreterPlatform("macosx-11.0-arm64", { target: "darwin-x64" }).length, 1);
    assert.equal(checkInterpreterPlatform("win-amd64", {}).length, 1);
  });

  it("times with the median", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
  });

  it("info catalog lists the fixture's objective and rule, loaded and linked", () => {
    const fixture = {
      objective: { uuid: "o-1", type: "objective" },
      rule: { uuid: "r-1", type: "rule" },
    };
    const objects = [
      { uuid: "o-1", type: "objective", load_error: null },
      { uuid: "r-1", type: "rule", load_error: null },
    ];
    const edges = [{ from: "r-1", to: "o-1", kind: "implements" }];
    const doc = (fields) => JSON.stringify({ objects, edges, summary: { load_errors: 0 }, ...fields });
    assert.deepEqual(checkCatalog(doc({}), fixture), []);
    assert.deepEqual(checkCatalog(doc({ objects: [objects[0]] }), fixture), ["info catalog has no rule r-1"]);
    assert.match(
      checkCatalog(doc({ objects: [objects[0], { ...objects[1], type: "threat" }] }), fixture)[0],
      /lists r-1 as threat, not rule/,
    );
    assert.match(
      checkCatalog(
        doc({ objects: [objects[0], { ...objects[1], load_error: { message: "bad" } }] }),
        fixture,
      )[0],
      /r-1 failed to load/,
    );
    assert.match(
      checkCatalog(doc({ edges: [] }), fixture)[0],
      /no edge from the rule r-1 to the objective o-1/,
    );
    assert.match(checkCatalog(doc({ summary: { load_errors: 2 } }), fixture)[0], /2 load errors/);
    assert.deepEqual(checkCatalog("Traceback", fixture).length, 1);
    assert.deepEqual(checkCatalog("{}", fixture), ["info catalog has no objects and edges"]);
  });

  it("the smoke fixture's objects are the ones the catalogue check expects", () => {
    const read = (file) => readFileSync(join(root, "test", "fixtures", "workspace", "objects", file), "utf8");
    assert.match(read("objectives/detect-lsass-access.yaml"), /^\s+uuid:\s*\S+\s*$/m);
    const rule = read("rules/suspicious-lsass-access.yaml");
    const objective = /^\s+uuid:\s*(\S+)\s*$/m.exec(read("objectives/detect-lsass-access.yaml"))?.[1];
    assert.ok(objective && rule.includes(objective), "the rule implements the objective");
  });

  it("initialize must name host opentide with the built version and the pinned engine", () => {
    const response = (opentide) => ({ id: 1, result: { capabilities: { experimental: { opentide } } } });
    const expected = { opentide: "0.21.0", engine: "0.9.1" };
    assert.deepEqual(
      checkInitialize(response({ host: { name: "opentide", version: "0.21.0" }, engine: "0.9.1" }), expected),
      [],
    );
    assert.deepEqual(
      checkInitialize(response({ host: { name: "opentide" } }), expected),
      [],
      "no engine reported: not checked",
    );
    assert.equal(
      checkInitialize(response({ host: { name: "opentide-lsp" }, engine: "0.9.0" }), expected).length,
      2,
    );
    assert.equal(checkInitialize({ id: 1, result: { capabilities: {} } }, expected).length, 1);
    assert.equal(checkInitialize({ id: 1, error: { message: "boom" } }, expected).length, 1);
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
