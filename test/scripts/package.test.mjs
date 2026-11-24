import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import { commonOptions } from "../../scripts/build-lib.mjs";
import {
  budgetFor,
  committedManifestProblem,
  EXTENSION_NAME,
  formatReport,
  isPreReleaseVersion,
  largestDirectories,
  PackageError,
  STORE_FIELDS,
  STORES,
  sizeReport,
  sizeUnit,
  storeExtensionId,
  storeManifest,
  vsixName,
  zipEntries,
  zipRead,
} from "../../scripts/package-lib.mjs";
import {
  checkEngineInitialize,
  checkKnowledgePackage,
  checkMcpBridge,
  checkWasiPackage,
  checkWasiServe,
  checkWebEntry,
  releaseOf,
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
  it("names each store's VSIX, and no other", () => {
    assert.equal(vsixName("marketplace", "0.3.1"), "opentide-marketplace-0.3.1.vsix");
    assert.equal(vsixName("openvsx", "0.3.1"), "opentide-openvsx-0.3.1.vsix");
    assert.throws(() => vsixName("linux-x64", "0.3.1"), /no store "linux-x64"/);
    assert.throws(() => vsixName(undefined, "0.3.1"), /no store/);
  });

  it("refuses a package.json an interrupted run left with the Marketplace name, publisher or display name", () => {
    const committed = { name: "opentide", publisher: "opentidehq", displayName: "opentide" };
    assert.equal(committedManifestProblem(committed), undefined);
    assert.match(
      committedManifestProblem({ ...committed, name: "opentide-vscode" }),
      /name is "opentide-vscode", not "opentide".*git checkout package\.json/,
    );
    assert.match(
      committedManifestProblem({ ...committed, publisher: "opentide" }),
      /publisher is "opentide", not "opentidehq".*git checkout package\.json/,
    );
    assert.match(
      committedManifestProblem({ ...committed, displayName: "opentide for VS Code" }),
      /displayName is "opentide for VS Code", not "opentide".*git checkout package\.json/,
    );
  });

  it("gives each store its id and display name, the Open VSX ones being package.json's", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.deepEqual(
      STORES.map((store) => [store.store, storeExtensionId(store), store.displayName]),
      [
        ["marketplace", "opentide.opentide-vscode", "opentide for VS Code"],
        ["openvsx", "opentidehq.opentide", "opentide"],
      ],
    );
    assert.equal(pkg.name, EXTENSION_NAME);
    const openvsx = STORES.find((store) => store.store === "openvsx");
    for (const field of STORE_FIELDS) assert.equal(openvsx?.[field], pkg[field], field);
    const text = readFileSync(join(root, "package.json"), "utf8");
    for (const store of STORES) {
      const manifest = JSON.parse(storeManifest(text, store));
      for (const field of STORE_FIELDS)
        assert.equal(manifest[field], store[field], `${store.store} ${field}`);
      assert.deepEqual(
        { ...manifest, name: pkg.name, publisher: pkg.publisher, displayName: pkg.displayName },
        pkg,
        "only the name, publisher and display name change",
      );
    }
  });

  it("the Marketplace manifest contributes exactly what package.json does: no id depends on the name", () => {
    const text = readFileSync(join(root, "package.json"), "utf8");
    const pkg = JSON.parse(text);
    const marketplace = JSON.parse(
      storeManifest(
        text,
        STORES.find((store) => store.store === "marketplace"),
      ),
    );
    assert.equal(marketplace.name, "opentide-vscode");
    // Everything VS Code registers from the manifest, the same in both packages.
    for (const key of ["contributes", "activationEvents", "main", "browser", "extensionKind", "capabilities"])
      assert.deepEqual(marketplace[key], pkg[key], key);
    const c = marketplace.contributes;
    const ids = {
      commands: (c.commands ?? []).map((command) => command.command),
      settings: [c.configuration].flat().flatMap((section) => Object.keys(section?.properties ?? {})),
      views: Object.values(c.views ?? {}).flatMap((views) => views.map((view) => view.id)),
      viewsContainers: Object.values(c.viewsContainers ?? {}).flatMap((list) => list.map((item) => item.id)),
      languages: (c.languages ?? []).map((language) => language.id),
      mcpProviders: (c.mcpServerDefinitionProviders ?? []).map((provider) => provider.id),
      walkthroughs: (c.walkthroughs ?? []).map((walkthrough) => walkthrough.id),
    };
    for (const [kind, list] of Object.entries(ids)) {
      assert.ok(list.length > 0, `${kind}: some`);
      for (const id of list) {
        assert.ok(!id.includes("opentide-vscode") && !id.includes("opentidehq"), `${kind}: ${id}`);
        assert.ok(id.startsWith("opentide") || kind === "languages", `${kind}: ${id}`);
      }
    }
    assert.deepEqual(ids.mcpProviders, ["opentide"]);
    // Nothing in the contributions names either id or the store-specific name.
    for (const store of STORES)
      assert.ok(!JSON.stringify(c).includes(storeExtensionId(store)), storeExtensionId(store));
    assert.ok(!JSON.stringify(c).includes("opentide-vscode"));
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

  it("the committed budget and target are PACKAGING.md's 20 MiB and 16 MiB: the WASI module, no runtime", () => {
    const committed = JSON.parse(readFileSync(join(root, "pins.json"), "utf8"));
    assert.equal(committed.vsix.budgetBytes, 20 * 1024 * 1024);
    assert.equal(committed.vsix.targetBytes, 16 * 1024 * 1024);
    const packaging = readFileSync(join(root, "docs", "PACKAGING.md"), "utf8");
    assert.match(packaging, /The size gate \(20 MiB\) and the target \(16 MiB\)/);
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

  it("the engine reports the crate's version, without the release candidate's suffix", () => {
    const answer = (engine) => ({
      jsonrpc: "2.0",
      id: 1,
      result: {
        serverInfo: { name: "opentide-lsp" },
        capabilities: { experimental: { opentide: { host: null, engine } } },
      },
    });
    assert.deepEqual(checkEngineInitialize(answer("1.0.0"), "1.0.0-rc.2", 0), []);
    assert.equal(checkEngineInitialize(answer("1.0.1"), "1.0.0-rc.2", 0).length, 1);
    assert.equal(releaseOf("1.0.0-rc.3-dev+8b55d0c"), "1.0.0");
    assert.equal(releaseOf("0.10.0"), "0.10.0");
  });

  it("the package carries the WASI module, its launcher, its manifest, its licence set and the MCP bridge", () => {
    assert.deepEqual(
      checkWasiPackage(() => true),
      [],
    );
    assert.deepEqual(
      checkWasiPackage((file) => file === "dist/wasi/wasi.json"),
      [
        "the package has no dist/wasi/opentide.wasm",
        "the package has no dist/wasi/launcher.cjs",
        "the package has no dist/wasi/THIRD-PARTY-LICENSES.html",
        "the package has no dist/wasi/WASI-LIBC-LICENSES.txt",
        "the package has no dist/wasi/LICENSE",
        "the package has no dist/wasi/NOTICE",
        "the package has no dist/wasi/THIRD-PARTY-DATA-LICENSES.txt",
        "the package has no dist/mcp-wasi.js",
        "the package has no dist/mcp-launcher.js",
      ],
    );
  });

  it("the package carries the skills and instructions its manifest contributes", () => {
    const pkg = {
      contributes: {
        chatSkills: [{ path: "./skills/a/SKILL.md" }],
        chatInstructions: [{ path: "./instructions/opentide.instructions.md" }],
      },
    };
    assert.deepEqual(
      checkKnowledgePackage(pkg, () => true),
      [],
    );
    assert.deepEqual(
      checkKnowledgePackage(pkg, (file) => file === "skills/LICENSE"),
      [
        "package.json contributes ./skills/a/SKILL.md, which the package lacks",
        "package.json contributes ./instructions/opentide.instructions.md, which the package lacks",
      ],
    );
    assert.deepEqual(
      checkKnowledgePackage({ contributes: {} }, () => true),
      ["package.json contributes no chatSkills", "package.json contributes no chatInstructions"],
    );
    assert.deepEqual(
      checkKnowledgePackage(pkg, (file) => file !== "skills/LICENSE"),
      ["the package has no skills/LICENSE"],
    );
  });

  it("the MCP bridge answers as opentide and writes only an MCP server's messages", () => {
    const good = [
      '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"opentide"}}}',
      '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"search"}]}}',
    ];
    assert.deepEqual(checkMcpBridge(good, 0), []);
    assert.equal(checkMcpBridge(["not json", ...good], 0).length, 1);
    assert.match(
      checkMcpBridge([...good, '{"jsonrpc":"2.0","id":"h1","method":"opentide/fetch","params":{}}'], 0)[0],
      /no message of an MCP server/,
    );
    assert.match(checkMcpBridge([good[1]], 0)[0], /did not answer as opentide/);
    assert.match(checkMcpBridge([good[0]], 0)[0], /no `search` tool/);
    assert.match(checkMcpBridge(good, 3)[0], /exited with 3/);
  });

  it("the WASI module's serve offers opentide/fetch, agrees with wasi.json and runs a command", () => {
    const manifest = { version: "1.0.0-rc.3" };
    const digest = "a".repeat(64);
    const initialize = (extra = {}) => ({
      id: 1,
      result: {
        protocol: 1,
        version: "1.0.0-rc.3",
        commands_digest: digest,
        capabilities: { fetch: true },
        ...extra,
      },
    });
    const run = { id: 2, result: { document: { command: "commands" }, exit_code: 0 } };
    assert.deepEqual(checkWasiServe(initialize(), run, manifest, 0), []);
    // A development build's suffix does not matter, the release does.
    assert.deepEqual(checkWasiServe(initialize({ version: "1.0.0-rc.3-dev+8b55d0c" }), run, manifest, 0), []);
    assert.match(checkWasiServe(initialize({ version: "1.0.1" }), run, manifest, 0)[0], /wasi.json says/);
    assert.match(checkWasiServe(initialize({ capabilities: {} }), run, manifest, 0)[0], /opentide\/fetch/);
    assert.match(checkWasiServe(initialize({ protocol: 2 }), run, manifest, 0)[0], /protocol 2/);
    assert.match(
      checkWasiServe(initialize({ commands_digest: "x" }), run, manifest, 0)[0],
      /commands_digest/,
    );
    assert.match(
      checkWasiServe(initialize(), { id: 2, result: { exit_code: 1 } }, manifest, 0)[0],
      /did not run/,
    );
    assert.match(checkWasiServe(initialize(), run, manifest, 1)[0], /exited with 1/);
    assert.match(checkWasiServe({ id: 1, error: { message: "trap" } }, run, manifest, 0)[0], /trap/);
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
