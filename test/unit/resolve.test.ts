import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  opentideForInterpreter,
  type PackageLayout,
  type ProbeOptions,
  type ProbeResult,
  pythonsOnPath,
  type ResolveInput,
  type RuntimeSettings,
  readEngineManifest,
  readPackageManifest,
  resolveRuntime,
  uvExecutable,
} from "../../src/core/runtime/resolve";

const EXT = "/ext";
const FOLDER = "/work/detections";
const VENV_PYTHON = path.posix.join(FOLDER, ".venv", "bin", "python");
const BLOCKED: ProbeResult = {
  code: null,
  stdout: "",
  stderr: "",
  error: "spawn EACCES",
};

interface Fake {
  files: Set<string>;
  onPath: Record<string, string>;
  /** command (joined with args) -> stdout, or a ProbeResult. */
  versions: Record<string, string | ProbeResult>;
  probes: { command: string; args: readonly string[]; options: ProbeOptions }[];
}

function input(
  overrides: Partial<ResolveInput> = {},
  settings: Partial<RuntimeSettings> = {},
  fake?: Partial<Fake>,
) {
  const state: Fake = {
    files: new Set<string>(),
    onPath: {},
    versions: {},
    probes: [],
    ...fake,
  };
  const value: ResolveInput = {
    trusted: true,
    platform: "linux",
    folder: FOLDER,
    settings: {
      path: () => undefined,
      interpreter: () => undefined,
      uvUsePin: () => false,
      uvPath: () => undefined,
      ...settings,
    },
    pin: undefined,
    proxy: undefined,
    homeDir: "/home/me",
    exists: (file) => state.files.has(file),
    which: (name) => state.onPath[name],
    probe: async (command, args, options) => {
      state.probes.push({ command, args, options });
      const answer = state.versions[command];
      if (answer === undefined) return { code: null, stdout: "", stderr: "", error: "ENOENT" };
      return typeof answer === "string" ? { code: 0, stdout: answer, stderr: "" } : answer;
    },
    pythonEnvironments: async () => undefined,
    pythonExtension: async () => undefined,
    ...overrides,
  };
  return { value, state };
}

const throwing = (name: string) => () => {
  throw new Error(`${name} must not be read in Restricted Mode`);
};

describe("runtime resolution", () => {
  it("tier 1: opentide.path wins, run with `lsp start` later", async () => {
    const { value } = input(
      {},
      { path: () => "/opt/opentide" },
      { versions: { "/opt/opentide": "opentide 0.21.0" } },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.tier, 1);
    assert.equal(runtime?.kind, "opentide");
    assert.equal(runtime?.version, "0.21.0");
  });

  it("tier 1: an opentide-lsp path is editor-only and checked with --version --json against the engine minimum", async () => {
    const { value, state } = input(
      {},
      { path: () => "/opt/opentide-lsp" },
      { versions: { "/opt/opentide-lsp": '{"host":null,"engine":"0.9.1"}' } },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.kind, "opentide-lsp");
    assert.equal(runtime?.version, "0.9.1");
    assert.deepEqual(state.probes[0]?.args, ["--version", "--json"]);
  });

  it("falls through a failing tier 1 to the workspace's .venv", async () => {
    const venv = path.posix.join(FOLDER, ".venv", "bin", "opentide");
    const { value } = input(
      {},
      { path: () => "/missing/opentide" },
      { files: new Set([VENV_PYTHON, venv]), versions: { [venv]: "opentide 0.20.1" } },
    );
    const { runtime, attempts } = await resolveRuntime(value);
    assert.equal(runtime?.source, "venv");
    assert.equal(runtime?.interpreter, VENV_PYTHON);
    assert.equal(attempts.find((a) => a.tier === 1)?.outcome, "failed");
  });

  it("tier 2: the Python Environments interpreter, using the opentide script beside it", async () => {
    const python = "/envs/a/bin/python";
    const script = "/envs/a/bin/opentide";
    const { value } = input(
      { pythonEnvironments: async () => python },
      {},
      { files: new Set([script]), versions: { [script]: "opentide 0.20.1" } },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.source, "python-environments");
    assert.equal(runtime?.command, script);
    assert.equal(runtime?.interpreter, python);
  });

  it("tier 2: the Python extension's interpreter runs `python -m opentide` when no script is beside it", async () => {
    const python = "/envs/b/bin/python";
    const { value, state } = input(
      { pythonExtension: async () => python },
      {},
      { versions: { [python]: "opentide 0.20.1" } },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.source, "python-extension");
    assert.deepEqual(runtime?.args, ["-m", "opentide"]);
    assert.deepEqual(state.probes.at(-1)?.args, ["-m", "opentide", "--version"]);
  });

  it("tier 2: opentide on PATH", async () => {
    const { value } = input(
      {},
      {},
      {
        onPath: { opentide: "/usr/local/bin/opentide" },
        versions: { "/usr/local/bin/opentide": "opentide 0.20.1" },
      },
    );
    assert.equal((await resolveRuntime(value)).runtime?.source, "path");
  });

  it("refuses an opentide older than the minimum with its upgrade command, and the next tier takes over", async () => {
    const { value } = input(
      {},
      {},
      {
        onPath: { opentide: "/usr/bin/opentide", python3: "/opt/py/bin/python3" },
        versions: { "/usr/bin/opentide": "opentide 0.19.2", "/opt/py/bin/python3": "opentide 0.20.1" },
      },
    );
    const { runtime, attempts } = await resolveRuntime(value);
    assert.equal(runtime?.source, "python");
    const old = attempts.find((a) => a.outcome === "too-old");
    assert.equal(old?.version, "0.19.2");
    assert.match(old?.upgrade ?? "", /opentide>=0\.20\.1/);
  });

  it("accepts an untagged dev build (0.1.devN, hatch-vcs without a tag) with a note, still refusing old releases", async () => {
    const { value } = input(
      {},
      {},
      {
        onPath: { opentide: "/usr/bin/opentide" },
        versions: { "/usr/bin/opentide": "opentide 0.1.dev216+g0a65c49" },
      },
    );
    const { runtime, attempts } = await resolveRuntime(value);
    assert.equal(runtime?.tier, 2);
    assert.equal(runtime?.version, "0.1.dev216+g0a65c49");
    const used = attempts.find((a) => a.outcome === "ok");
    assert.match(used?.note ?? "", /no release tag.*0\.20\.1/);
    assert.equal(
      attempts.find((a) => a.outcome === "too-old"),
      undefined,
    );
  });

  it("tier 3: uv with the repository's pin when opted in, before the workspace's environment", async () => {
    const { value, state } = input(
      { pin: { version: "0.20.1", source: "uv.lock" }, proxy: "http://proxy:3128" },
      { uvUsePin: () => true },
      {
        onPath: { uv: "/usr/bin/uv", opentide: "/usr/bin/opentide" },
        versions: { "/usr/bin/uv": "opentide 0.20.1", "/usr/bin/opentide": "opentide 0.21.0" },
      },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.tier, 3);
    assert.deepEqual(runtime?.args, ["tool", "run", "--from", "opentide==0.20.1", "opentide"]);
    assert.equal(runtime?.env.HTTPS_PROXY, "http://proxy:3128");
    assert.equal(runtime?.env.UV_SYSTEM_CERTS, "1");
    assert.ok((state.probes[0]?.options.timeoutMs ?? 0) > 60_000, "uv may download: a longer timeout");
  });

  it("tiers 1 to 3 run opentide in UTF-8 mode, probe included: Windows pipes are otherwise ANSI", async () => {
    const { value, state } = input(
      {},
      { path: () => "/opt/opentide/bin/opentide" },
      { versions: { "/opt/opentide/bin/opentide": "opentide 0.21.0" } },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.tier, 1);
    assert.equal(runtime?.env.PYTHONUTF8, "1");
    assert.equal(runtime?.env.PYTHONIOENCODING, "utf-8");
    assert.equal(state.probes[0]?.options.env.PYTHONUTF8, "1");
  });

  it("tier 3 is never tried without the opt-in", async () => {
    const { value, state } = input(
      { pin: { version: "0.20.1", source: "uv.lock" } },
      {},
      {
        onPath: { uv: "/usr/bin/uv", opentide: "/usr/bin/opentide" },
        versions: { "/usr/bin/opentide": "opentide 0.20.1" },
      },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.source, "path");
    assert.ok(!state.probes.some((p) => p.command === "/usr/bin/uv"));
  });

  describe("python -m opentide where the opentide command cannot run", () => {
    it("an interpreter whose opentide script is blocked runs `python -m opentide`", async () => {
      const python = "/envs/a/bin/python";
      const script = "/envs/a/bin/opentide";
      const { value, state } = input(
        { pythonExtension: async () => python },
        {},
        { files: new Set([script]), versions: { [script]: BLOCKED, [python]: "opentide 0.22.0" } },
      );
      const { runtime, attempts } = await resolveRuntime(value);
      assert.equal(runtime?.source, "python-extension");
      assert.equal(runtime?.command, python);
      assert.deepEqual(runtime?.args, ["-m", "opentide"]);
      assert.deepEqual(state.probes.at(-1)?.args, ["-m", "opentide", "--version"]);
      const blocked = attempts.find((a) => a.path === script);
      assert.equal(blocked?.outcome, "failed");
      assert.match(blocked?.detail ?? "", /EACCES/);
    });

    it("a too-old script is not retried as a module: it is the same install", async () => {
      const python = "/envs/a/bin/python";
      const script = "/envs/a/bin/opentide";
      const { value, state } = input(
        { pythonExtension: async () => python },
        {},
        { files: new Set([script]), versions: { [script]: "opentide 0.19.0", [python]: "opentide 0.19.0" } },
      );
      await resolveRuntime(value);
      assert.equal(
        state.probes.some((p) => p.command === python),
        false,
      );
    });

    it("the .venv's python runs `-m opentide` when its opentide script is blocked", async () => {
      const script = path.posix.join(FOLDER, ".venv", "bin", "opentide");
      const { value } = input(
        {},
        {},
        {
          files: new Set([VENV_PYTHON, script]),
          versions: { [script]: BLOCKED, [VENV_PYTHON]: "opentide 0.22.0" },
        },
      );
      const { runtime } = await resolveRuntime(value);
      assert.equal(runtime?.source, "venv");
      assert.equal(runtime?.command, VENV_PYTHON);
      assert.deepEqual(runtime?.args, ["-m", "opentide"]);
    });

    it("python on PATH runs `-m opentide` when no opentide is on PATH (pip --user, Scripts not on PATH)", async () => {
      const { value } = input(
        {},
        {},
        { onPath: { python3: "/usr/bin/python3" }, versions: { "/usr/bin/python3": "opentide 0.22.0" } },
      );
      const { runtime, attempts } = await resolveRuntime(value);
      assert.equal(runtime?.tier, 2);
      assert.equal(runtime?.source, "python");
      assert.equal(runtime?.command, "/usr/bin/python3");
      assert.deepEqual(runtime?.args, ["-m", "opentide"]);
      assert.equal(runtime?.interpreter, "/usr/bin/python3");
      assert.equal(runtime?.env.PYTHONUTF8, "1");
      assert.equal(attempts.find((a) => a.source === "path")?.outcome, "missing");
    });

    it("python on PATH runs `-m opentide` when the opentide on PATH is blocked", async () => {
      const { value } = input(
        {},
        {},
        {
          onPath: { opentide: "/home/me/.local/bin/opentide", python3: "/usr/bin/python3" },
          versions: { "/home/me/.local/bin/opentide": BLOCKED, "/usr/bin/python3": "opentide 0.22.0" },
        },
      );
      const { runtime } = await resolveRuntime(value);
      assert.equal(runtime?.source, "python");
    });

    it("Windows: python, then the py launcher with -3", async () => {
      const python = "C:\\Python313\\python.exe";
      const py = "C:\\Windows\\py.exe";
      const { value, state } = input(
        { platform: "win32" },
        {},
        {
          onPath: { python, py },
          versions: {
            [python]: { code: 1, stdout: "", stderr: "No module named opentide" },
            [py]: "opentide 0.22.0",
          },
        },
      );
      const { runtime } = await resolveRuntime(value);
      assert.equal(runtime?.command, py);
      assert.deepEqual(runtime?.args, ["-3", "-m", "opentide"]);
      assert.deepEqual(state.probes.at(-1)?.args, ["-3", "-m", "opentide", "--version"]);
    });

    it("an interpreter without opentide installed is reported, not used", async () => {
      const { value } = input(
        {},
        {},
        {
          onPath: { python3: "/usr/bin/python3" },
          versions: {
            "/usr/bin/python3": { code: 1, stdout: "", stderr: "/usr/bin/python3: No module named opentide" },
          },
        },
      );
      const { runtime, attempts } = await resolveRuntime(value);
      assert.equal(runtime, undefined);
      assert.match(attempts.find((a) => a.source === "python")?.detail ?? "", /No module named opentide/);
    });

    it("the interpreters on PATH, each once", () => {
      assert.deepEqual(
        pythonsOnPath("linux", (name) => ({ python3: "/usr/bin/python3", python: "/usr/bin/python3" })[name]),
        [{ command: "/usr/bin/python3", args: [] }],
      );
      assert.deepEqual(
        pythonsOnPath("win32", () => undefined),
        [],
      );
    });

    it("the ways to run opentide with an interpreter: its script, then the module", () => {
      const exists = (file: string) => file === "C:\\venv\\Scripts\\opentide.exe";
      assert.deepEqual(opentideForInterpreter("C:\\venv\\Scripts\\python.exe", "win32", exists), [
        { command: "C:\\venv\\Scripts\\opentide.exe", args: [] },
        { command: "C:\\venv\\Scripts\\python.exe", args: ["-m", "opentide"] },
      ]);
      assert.deepEqual(
        opentideForInterpreter("/usr/bin/python3", "linux", () => false),
        [{ command: "/usr/bin/python3", args: ["-m", "opentide"] }],
      );
    });
  });

  it("Restricted Mode: no opentide is probed and no restricted setting is read; the engine runs", async () => {
    const ENGINE = { module: path.join(EXT, "dist", "engine", "opentide_wasm_bg.wasm"), version: "0.10.0" };
    const { value, state } = input(
      {
        trusted: false,
        engine: ENGINE,
        pythonEnvironments: throwing("python"),
        pythonExtension: throwing("python"),
      },
      {
        path: throwing("opentide.path"),
        interpreter: throwing("opentide.interpreter"),
        uvUsePin: throwing("opentide.uv.usePin"),
        uvPath: throwing("opentide.uv.path"),
      },
      {
        files: new Set([ENGINE.module]),
        onPath: { opentide: "/usr/bin/opentide" },
        versions: { "/usr/bin/opentide": "opentide 0.21.0" },
      },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.tier, 4);
    assert.equal(runtime?.kind, "engine");
    assert.equal(runtime?.restricted, true);
    assert.equal(state.probes.length, 0);
  });

  it("a build without the engine and no opentide has no runtime, and says why", async () => {
    const { value } = input({}, {}, { files: new Set() });
    const { runtime, attempts } = await resolveRuntime(value);
    assert.equal(runtime, undefined);
    assert.equal(attempts.at(-1)?.tier, 4);
    assert.match(attempts.at(-1)?.detail ?? "", /carries no engine/);
  });

  describe("tier 4: the engine (WASM)", () => {
    const ENGINE = { module: path.join(EXT, "dist", "engine", "opentide_wasm_bg.wasm"), version: "0.10.0" };

    it("is the runtime when no opentide answers", async () => {
      const { value, state } = input({ engine: ENGINE }, {}, { files: new Set([ENGINE.module]) });
      const { runtime, attempts } = await resolveRuntime(value);
      assert.equal(runtime?.tier, 4);
      assert.equal(runtime?.source, "engine");
      assert.equal(runtime?.kind, "engine");
      assert.equal(runtime?.command, ENGINE.module);
      assert.equal(runtime?.version, "0.10.0");
      assert.equal(runtime?.restricted, false);
      assert.deepEqual(
        attempts.map((a) => [a.tier, a.outcome]),
        [
          [1, "missing"],
          [3, "skipped"],
          [2, "missing"],
          [2, "missing"],
          [2, "missing"],
          [2, "missing"],
          [2, "missing"],
          [2, "missing"],
          [4, "ok"],
        ],
      );
      // The engine is not probed: nothing is spawned for it.
      assert.equal(
        state.probes.some((p) => p.command === ENGINE.module),
        false,
      );
    });

    it("takes over from an opentide that does not answer", async () => {
      const { value } = input(
        { engine: ENGINE },
        {},
        {
          files: new Set([ENGINE.module]),
          onPath: { opentide: "/usr/bin/opentide" },
          versions: { "/usr/bin/opentide": { code: 1, stdout: "", stderr: "ImportError: libssl.so.3" } },
        },
      );
      const { runtime, attempts } = await resolveRuntime(value);
      assert.equal(runtime?.kind, "engine");
      const path = attempts.find((a) => a.source === "path");
      assert.equal(path?.outcome, "failed");
      assert.match(path?.detail ?? "", /libssl/);
    });

    it("takes over when opentide.path names nothing", async () => {
      const { value } = input(
        { engine: ENGINE },
        { path: () => "/nowhere/opentide" },
        { files: new Set([ENGINE.module]) },
      );
      assert.equal((await resolveRuntime(value)).runtime?.tier, 4);
    });

    it("never replaces a tier that answers", async () => {
      const { value } = input(
        { engine: ENGINE },
        {},
        {
          files: new Set([ENGINE.module]),
          onPath: { python3: "/usr/bin/python3" },
          versions: { "/usr/bin/python3": "opentide 0.22.0" },
        },
      );
      const { runtime } = await resolveRuntime(value);
      assert.equal(runtime?.tier, 2);
    });

    it("is missing when its module is", async () => {
      const { value } = input({ engine: ENGINE }, {}, { files: new Set() });
      const { runtime, attempts } = await resolveRuntime(value);
      assert.equal(runtime, undefined);
      assert.match(attempts.at(-1)?.detail ?? "", /does not exist/);
    });
  });

  it("reads dist/engine/engine.json", () => {
    const dir = path.join(EXT, "dist", "engine");
    assert.deepEqual(readEngineManifest('{"version":"0.10.0","module":"opentide_wasm_bg.wasm"}', dir), {
      module: path.join(dir, "opentide_wasm_bg.wasm"),
      version: "0.10.0",
    });
    assert.equal(readEngineManifest(undefined, dir), undefined);
    assert.equal(readEngineManifest("not json", dir), undefined);
    assert.equal(readEngineManifest('{"version":"0.10.0","module":"../x.wasm"}', dir), undefined);
    assert.equal(readEngineManifest('{"module":"x.wasm"}', dir), undefined);
  });

  it("opentide.interpreter replaces the Python extensions and .venv lookup", async () => {
    const venv = path.posix.join(FOLDER, ".venv", "bin", "opentide");
    const { value } = input(
      { pythonEnvironments: throwing("python") },
      { interpreter: () => ["$", "{workspaceFolder}/py/bin/python"].join("") },
      {
        files: new Set([VENV_PYTHON, venv]),
        versions: { [`${FOLDER}/py/bin/python`]: "opentide 0.20.1", [venv]: "opentide 0.21.0" },
      },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.source, "interpreter-setting");
    assert.equal(runtime?.command, `${FOLDER}/py/bin/python`);
  });
});

describe("tier 2: the @opentide/opentide the extension carries", () => {
  const NODE = "/opt/code/code";
  const PKG: PackageLayout = {
    cli: "/ext/dist/opentide/cli.js",
    native: "/ext/dist/opentide/opentide.linux-x64-gnu.node",
    version: "0.24.0",
    platform: "linux-x64-gnu",
  };
  const VENV_OPENTIDE = path.posix.join(FOLDER, ".venv", "bin", "opentide");
  /** A machine with the package, a .venv with opentide and opentide on PATH. */
  const machine = (versions: Record<string, string | ProbeResult> = {}) => ({
    files: new Set([PKG.cli, PKG.native, VENV_PYTHON, VENV_OPENTIDE]),
    onPath: { opentide: "/usr/bin/opentide" },
    versions: {
      [NODE]: "opentide 0.24.0",
      [VENV_OPENTIDE]: "opentide 0.22.0",
      "/usr/bin/opentide": "opentide 0.22.0",
      ...versions,
    },
  });

  it("runs before the environment it discovers: the host's executable on cli.js, as Node.js, no Python", async () => {
    const { value, state } = input({ package: PKG, nodeExecutable: NODE }, {}, machine());
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.tier, 2);
    assert.equal(runtime?.source, "package");
    assert.equal(runtime?.kind, "opentide");
    assert.equal(runtime?.command, NODE);
    assert.deepEqual(runtime?.args, [PKG.cli]);
    assert.equal(runtime?.version, "0.24.0");
    assert.deepEqual(runtime?.env, { ELECTRON_RUN_AS_NODE: "1" });
    assert.equal(runtime?.interpreter, undefined);
    assert.deepEqual(runtime?.binDirs, ["/ext/dist/opentide"]);
    assert.deepEqual(state.probes.at(-1)?.args, [PKG.cli, "--version"]);
    assert.deepEqual(state.probes.at(-1)?.options.env, { ELECTRON_RUN_AS_NODE: "1" });
    // Nothing Python was probed.
    assert.equal(
      state.probes.some((probe) => probe.command !== NODE),
      false,
    );
  });

  it("is not held to the minimum opentide version: it is the extension's own pin", async () => {
    const { value } = input(
      { package: { ...PKG, version: "0.0.0" }, nodeExecutable: NODE },
      {},
      machine({ [NODE]: "opentide 0.0.0" }),
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.source, "package");
    assert.equal(runtime?.version, "0.0.0");
  });

  it("an explicit choice wins: opentide.path, opentide.interpreter, the repository's pin with uv", async () => {
    const byPath = await resolveRuntime(
      input(
        { package: PKG, nodeExecutable: NODE },
        { path: () => "/opt/opentide" },
        machine({ "/opt/opentide": "opentide 0.23.0" }),
      ).value,
    );
    assert.equal(byPath.runtime?.source, "setting");

    const python = `${FOLDER}/py/bin/python`;
    const byInterpreter = await resolveRuntime(
      input(
        { package: PKG, nodeExecutable: NODE },
        { interpreter: () => python },
        machine({ [python]: "opentide 0.22.0" }),
      ).value,
    );
    assert.equal(byInterpreter.runtime?.source, "interpreter-setting");

    const byPin = await resolveRuntime(
      input(
        { package: PKG, nodeExecutable: NODE, pin: { version: "0.22.0", source: "uv.lock" } },
        { uvUsePin: () => true },
        { ...machine({ "/usr/bin/uv": "opentide 0.22.0" }), onPath: { uv: "/usr/bin/uv" } },
      ).value,
    );
    assert.equal(byPin.runtime?.source, "uv");
  });

  it("one that reports another version than its opentide.json fails, and the workspace's .venv takes over", async () => {
    const { value } = input(
      { package: PKG, nodeExecutable: NODE },
      {},
      machine({ [NODE]: "opentide 0.23.0" }),
    );
    const { runtime, attempts } = await resolveRuntime(value);
    assert.equal(runtime?.source, "venv");
    const failed = attempts.find((attempt) => attempt.source === "package");
    assert.equal(failed?.outcome, "failed");
    assert.match(failed?.detail ?? "", /reports opentide 0\.23\.0, its opentide\.json says 0\.24\.0/);
  });

  it("one whose addon is missing is not run", async () => {
    const fake = machine();
    fake.files.delete(PKG.native);
    const { value, state } = input({ package: PKG, nodeExecutable: NODE }, {}, fake);
    const { runtime, attempts } = await resolveRuntime(value);
    assert.equal(runtime?.source, "venv");
    assert.equal(attempts.find((attempt) => attempt.source === "package")?.outcome, "missing");
    assert.equal(
      state.probes.some((probe) => probe.command === NODE),
      false,
    );
  });

  it("the universal package carries none: the discovered environment, as before", async () => {
    const { value } = input({ nodeExecutable: NODE }, {}, machine());
    const { runtime, attempts } = await resolveRuntime(value);
    assert.equal(runtime?.source, "venv");
    assert.match(attempts.find((attempt) => attempt.source === "package")?.detail ?? "", /universal/);
  });

  it("Restricted Mode runs no package: the engine", async () => {
    const { value, state } = input(
      {
        trusted: false,
        package: PKG,
        nodeExecutable: NODE,
        engine: { module: "/ext/dist/engine/m.wasm", version: "0.10.0" },
      },
      {},
      { ...machine(), files: new Set([PKG.cli, PKG.native, "/ext/dist/engine/m.wasm"]) },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.source, "engine");
    assert.equal(state.probes.length, 0);
  });

  it("reads dist/opentide/opentide.json, refusing other shapes and paths out of the folder", () => {
    const manifest = {
      version: "0.24.0",
      cli: "cli.js",
      native: "opentide.linux-x64-gnu.node",
      platform: "linux-x64-gnu",
    };
    assert.deepEqual(readPackageManifest(JSON.stringify(manifest), "/ext/dist/opentide"), {
      cli: path.join("/ext/dist/opentide", "cli.js"),
      native: path.join("/ext/dist/opentide", "opentide.linux-x64-gnu.node"),
      version: "0.24.0",
      platform: "linux-x64-gnu",
    });
    assert.equal(readPackageManifest(undefined, "/d"), undefined);
    assert.equal(readPackageManifest("not json", "/d"), undefined);
    assert.equal(readPackageManifest(JSON.stringify({ ...manifest, version: 1 }), "/d"), undefined);
    assert.equal(readPackageManifest(JSON.stringify({ ...manifest, cli: "../cli.js" }), "/d"), undefined);
    assert.equal(readPackageManifest(JSON.stringify({ ...manifest, native: "a\\b.node" }), "/d"), undefined);
  });
});

describe("the uv executable (tier 3 and Create .venv with the pinned version)", () => {
  const which = (name: string) => (name === "uv" ? "/usr/bin/uv" : undefined);

  it("expands ~ and the workspace folder variable in opentide.uv.path, relative to the folder", () => {
    assert.equal(
      uvExecutable("~/.local/bin/uv", FOLDER, "/home/me", which),
      path.join("/home/me", ".local/bin/uv"),
    );
    assert.equal(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code's variable syntax, matched literally
      uvExecutable("${workspaceFolder}/tools/uv", FOLDER, "/home/me", which),
      `${FOLDER}/tools/uv`,
    );
    assert.equal(uvExecutable("tools/uv", FOLDER, "/home/me", which), path.resolve(FOLDER, "tools/uv"));
  });

  it("falls back to uv on PATH", () => {
    assert.equal(uvExecutable(undefined, FOLDER, "/home/me", which), "/usr/bin/uv");
    assert.equal(uvExecutable("  ", FOLDER, "/home/me", which), "/usr/bin/uv");
    assert.equal(
      uvExecutable(undefined, FOLDER, "/home/me", () => undefined),
      undefined,
    );
  });
});
