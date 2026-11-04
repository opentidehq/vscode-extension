import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  compileCommand,
  nodePrecompileDeps,
  type PrecompileDeps,
  type PrecompileProcess,
  Precompiler,
  parseBuildId,
  parseStamps,
  pycachePrefix,
  pycacheTree,
  stampFile,
  stampKey,
  stdlibDir,
} from "../../src/core/runtime/precompile";
import { bundledArgs, bundledLayout } from "../../src/core/runtime/resolve";
import { fakeRuntime } from "./helpers";

const EXT = "/ext/opentidehq.opentide-0.2.0-linux-x64";
const STORAGE = "/storage";
// pycachePrefix joins with the host's node:path: so does the expected prefix.
const PREFIX = path.join(STORAGE, "pycache");
const bundled = fakeRuntime({ tier: 4, source: "bundled", command: `${EXT}/runtime/bin/python3`, args: [] });

interface Fake {
  deps: PrecompileDeps;
  files: Map<string, string>;
  spawned: { command: string; args: readonly string[] }[];
  removed: string[];
  lowered: number[];
  finish(code: number | null): void;
  killed: () => number;
}

function fake(
  files: Record<string, string> = {},
  existing: string[] = [],
  links: Record<string, string> = {},
  extensionPath = EXT,
): Fake {
  const state = new Map(Object.entries(files));
  const spawned: { command: string; args: readonly string[] }[] = [];
  const removed: string[] = [];
  const lowered: number[] = [];
  let finish: (code: number | null) => void = () => undefined;
  let kills = 0;
  const deps: PrecompileDeps = {
    platform: "linux",
    extensionPath,
    globalStoragePath: STORAGE,
    readFile: async (file) => state.get(file),
    writeFile: async (file, text) => {
      state.set(file, text);
    },
    readdir: async (dir) => (dir.endsWith("/runtime/lib") ? ["python3.13", "libfoo.so"] : []),
    exists: (file) => existing.includes(file),
    realpath: async (file) => links[file] ?? file,
    remove: async (dir) => {
      removed.push(dir);
    },
    spawn: (command, args): PrecompileProcess => {
      spawned.push({ command, args });
      const exited = new Promise<number | null>((resolve) => {
        finish = resolve;
      });
      return {
        pid: 4242,
        exited,
        kill: () => {
          kills++;
          finish(null);
        },
      };
    },
    lowerPriority: (pid) => lowered.push(pid),
    log: () => undefined,
    now: () => 0,
  };
  return {
    deps,
    files: state,
    spawned,
    removed,
    lowered,
    finish: (code) => finish(code),
    killed: () => kills,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("bundled runtime bytecode precompile", () => {
  it("uses the same pycache prefix as the bundled runtime's arguments", () => {
    assert.ok(bundledArgs(STORAGE).includes(`pycache_prefix=${pycachePrefix(STORAGE)}`));
  });

  it("finds the standard library on POSIX and Windows", () => {
    assert.equal(stdlibDir("/r", "linux", ["python3.13", "pkgconfig"]), "/r/lib/python3.13");
    assert.equal(stdlibDir("/r", "darwin", []), undefined);
    assert.equal(stdlibDir("C:\\r", "win32", []), "C:\\r\\Lib");
  });

  it("maps a source root to its pycache tree as importlib does (drive and leading separators removed)", () => {
    assert.equal(
      pycacheTree("/s/pycache", "/home/u/.vscode/ext/runtime", "linux"),
      "/s/pycache/home/u/.vscode/ext/runtime",
    );
    assert.equal(
      pycacheTree("C:\\s\\pycache", "C:\\Users\\u\\ext\\runtime", "win32"),
      "C:\\s\\pycache\\Users\\u\\ext\\runtime",
    );
  });

  it("reads the build id and tolerates broken stamp and build files", () => {
    assert.equal(parseBuildId('{"buildId":"9026253f7990b9d0"}'), "9026253f7990b9d0");
    assert.equal(parseBuildId('{"buildId":"../x y"}'), undefined);
    assert.equal(parseBuildId("not json"), undefined);
    assert.deepEqual(parseStamps("{"), { builds: {} });
    assert.deepEqual(parseStamps(undefined), { builds: {} });
  });

  it("compiles the bundled runtime once per build: isolated, into the pycache prefix, at low priority", async () => {
    const f = fake({ [`${EXT}/runtime/BUILD-INFO.json`]: '{"buildId":"b1"}' });
    const precompiler = new Precompiler(f.deps);
    const first = precompiler.ensure(bundled);
    const again = precompiler.ensure(bundled);
    await settle();
    assert.equal(f.spawned.length, 1, "a second ensure shares the running compile");
    assert.deepEqual(f.spawned[0], compileCommand(bundled, `${EXT}/runtime/lib/python3.13`, PREFIX));
    assert.deepEqual(f.spawned[0]?.args.slice(0, 6), [
      "-I",
      "-X",
      `pycache_prefix=${PREFIX}`,
      "-m",
      "compileall",
      "-q",
    ]);
    assert.deepEqual(f.lowered, [4242]);
    f.finish(1); // some file did not compile: still done
    assert.equal(await first, "compiled");
    assert.equal(await again, "compiled");
    assert.ok(parseStamps(f.files.get(stampFile(PREFIX))).builds[stampKey("b1", `${EXT}/runtime`)]);

    assert.equal(await precompiler.ensure(bundled), "already-compiled");
    assert.equal(f.spawned.length, 1);
  });

  it("does nothing for a runtime that is not the bundled one", async () => {
    const f = fake();
    assert.equal(await new Precompiler(f.deps).ensure(fakeRuntime()), "not-bundled");
    assert.equal(await new Precompiler(f.deps).ensure(undefined), "not-bundled");
    assert.equal(f.spawned.length, 0);
  });

  it("is cancellable, and compiles again next time", async () => {
    const f = fake({ [`${EXT}/runtime/BUILD-INFO.json`]: '{"buildId":"b1"}' });
    const precompiler = new Precompiler(f.deps);
    const run = precompiler.ensure(bundled);
    await settle();
    precompiler.cancel();
    assert.equal(await run, "cancelled");
    assert.equal(f.killed(), 1);
    assert.equal(f.files.get(stampFile(PREFIX)), undefined);

    const retry = precompiler.ensure(bundled);
    await settle();
    assert.equal(f.spawned.length, 2);
    f.finish(0);
    assert.equal(await retry, "compiled");
  });

  it("dispose stops a running compile and later calls do nothing", async () => {
    const f = fake();
    const precompiler = new Precompiler(f.deps);
    const run = precompiler.ensure(bundled);
    await settle();
    precompiler.dispose();
    assert.equal(await run, "cancelled");
    assert.equal(await precompiler.ensure(bundled), "not-bundled");
  });

  it("a crash is a failure and leaves no stamp", async () => {
    const f = fake();
    const precompiler = new Precompiler(f.deps);
    const run = precompiler.ensure(bundled);
    await settle();
    f.finish(139);
    assert.equal(await run, "failed");
    assert.equal(f.files.get(stampFile(PREFIX)), undefined);
  });

  it("drops the bytecode of builds whose runtime folder is gone, keeps the others", async () => {
    const oldRoot = "/ext/opentidehq.opentide-0.1.0-linux-x64/runtime";
    const liveRoot = "/ext/other/runtime";
    const f = fake(
      {
        [`${EXT}/runtime/BUILD-INFO.json`]: '{"buildId":"new"}',
        [stampFile(PREFIX)]: JSON.stringify({
          builds: { old: { root: oldRoot, compiledAt: "x" }, live: { root: liveRoot, compiledAt: "y" } },
        }),
      },
      [liveRoot],
    );
    const run = new Precompiler(f.deps).ensure(bundled);
    await settle();
    f.finish(0);
    assert.equal(await run, "compiled");
    assert.deepEqual(f.removed, [pycacheTree(PREFIX, oldRoot, "linux")]);
    assert.deepEqual(Object.keys(parseStamps(f.files.get(stampFile(PREFIX))).builds).sort(), [
      "live",
      stampKey("new", `${EXT}/runtime`),
    ]);
  });

  it("compiles an update with the same build in its new folder, and drops the old folder's tree", async () => {
    const oldRoot = "/ext/opentidehq.opentide-0.1.0-linux-x64/runtime";
    const f = fake({
      [`${EXT}/runtime/BUILD-INFO.json`]: '{"buildId":"b1"}',
      // As an earlier version wrote it: keyed by the build id alone.
      [stampFile(PREFIX)]: JSON.stringify({ builds: { b1: { root: oldRoot, compiledAt: "x" } } }),
    });
    const run = new Precompiler(f.deps).ensure(bundled);
    await settle();
    assert.equal(f.spawned.length, 1, "the new folder's runtime has no bytecode yet");
    assert.equal(f.spawned[0]?.args.at(-1), `${EXT}/runtime/lib/python3.13`);
    f.finish(0);
    assert.equal(await run, "compiled");
    assert.deepEqual(f.removed, [pycacheTree(PREFIX, oldRoot, "linux")]);
    const builds = parseStamps(f.files.get(stampFile(PREFIX))).builds;
    assert.deepEqual(
      Object.values(builds).map((b) => [b.buildId, b.root]),
      [["b1", `${EXT}/runtime`]],
    );
  });

  it("drops the old folder's tree once VS Code removes it, after the update already compiled", async () => {
    // VS Code keeps the previous version's folder until a later start: the update's compile keeps it.
    const oldRoot = "/ext/opentidehq.opentide-0.1.0-linux-x64/runtime";
    const existing = [oldRoot];
    const f = fake(
      {
        [`${EXT}/runtime/BUILD-INFO.json`]: '{"buildId":"b1"}',
        [stampFile(PREFIX)]: JSON.stringify({
          builds: { [stampKey("b1", oldRoot)]: { buildId: "b1", root: oldRoot, compiledAt: "x" } },
        }),
      },
      existing,
    );
    const first = new Precompiler(f.deps).ensure(bundled);
    await settle();
    f.finish(0);
    assert.equal(await first, "compiled");
    assert.deepEqual(f.removed, [], "the old folder is still on disk");
    existing.splice(0); // a later start: VS Code deleted it
    assert.equal(await new Precompiler(f.deps).ensure(bundled), "already-compiled");
    assert.deepEqual(f.removed, [pycacheTree(PREFIX, oldRoot, "linux")]);
    assert.deepEqual(Object.keys(parseStamps(f.files.get(stampFile(PREFIX))).builds), [
      stampKey("b1", `${EXT}/runtime`),
    ]);
    // Nothing left to drop: the stamp file is not written again.
    let writes = 0;
    const counting = { ...f.deps, writeFile: async () => void writes++ };
    assert.equal(await new Precompiler(counting).ensure(bundled), "already-compiled");
    assert.equal(writes, 0);
    assert.equal(f.removed.length, 1);
  });

  it("compiles and stamps the resolved folder of a symlinked extension path", async () => {
    const link = "/home/u/.vscode/extensions/opentidehq.opentide-0.2.0-linux-x64";
    const real = "/data/vscode-ext/opentidehq.opentide-0.2.0-linux-x64";
    const f = fake(
      { [`${real}/runtime/BUILD-INFO.json`]: '{"buildId":"b1"}' },
      [],
      { [`${link}/runtime`]: `${real}/runtime` },
      link,
    );
    const run = new Precompiler(f.deps).ensure(bundled);
    await settle();
    assert.equal(
      f.spawned[0]?.args.at(-1),
      `${real}/runtime/lib/python3.13`,
      "Python imports from the real path",
    );
    f.finish(0);
    assert.equal(await run, "compiled");
    const [build] = Object.values(parseStamps(f.files.get(stampFile(PREFIX))).builds);
    assert.equal(build?.root, `${real}/runtime`);
  });
});

// Against a real bundled runtime, when one is given: OPENTIDE_TEST_BUNDLED is a folder holding the
// runtime/ that `npm run runtime:build` writes (the repository root after a build).
const BUNDLED = process.env.OPENTIDE_TEST_BUNDLED;

describe("bundled runtime bytecode precompile (OPENTIDE_TEST_BUNDLED)", function () {
  this.timeout(300_000);
  before(function () {
    if (!BUNDLED) this.skip();
  });

  it("compiles the real runtime into the pycache prefix, then skips the same build", async () => {
    const extension = BUNDLED ?? "";
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "opentide-precompile-"));
    try {
      const python = bundledLayout(extension, process.platform).python;
      const runtime = fakeRuntime({
        tier: 4,
        source: "bundled",
        command: python,
        args: bundledArgs(storage),
        binDirs: [],
      });
      const precompiler = new Precompiler(nodePrecompileDeps(extension, storage, () => undefined));
      assert.equal(await precompiler.ensure(runtime), "compiled");
      const tree = pycacheTree(pycachePrefix(storage), path.join(extension, "runtime"), process.platform);
      const stdlib = stdlibDir(
        path.join(extension, "runtime"),
        process.platform,
        fs.readdirSync(path.join(extension, "runtime", "lib")),
      );
      assert.ok(stdlib);
      // With a pycache_prefix, Python writes the .pyc files without __pycache__ folders.
      const json = path.join(tree, path.relative(path.join(extension, "runtime"), stdlib), "json");
      assert.ok(
        fs.readdirSync(json).some((file) => file.endsWith(".pyc")),
        `no bytecode in ${json}`,
      );
      assert.ok(
        !fs.existsSync(path.join(stdlib, "json", "__pycache__")),
        "the extension folder stays read-only",
      );
      assert.equal(await precompiler.ensure(runtime), "already-compiled");
    } finally {
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });
});
