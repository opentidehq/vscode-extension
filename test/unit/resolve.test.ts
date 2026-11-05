import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  type ProbeOptions,
  type ProbeResult,
  type ResolveInput,
  type RuntimeSettings,
  resolveRuntime,
  uvExecutable,
} from "../../src/core/runtime/resolve";
import { ROOT } from "./helpers";

const EXT = "/ext";
const FOLDER = "/work/detections";
const BUNDLED = path.join(EXT, "runtime", "bin", "python3");

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
    files: new Set([BUNDLED]),
    onPath: {},
    versions: {},
    probes: [],
    ...fake,
  };
  const value: ResolveInput = {
    trusted: true,
    platform: "linux",
    extensionPath: EXT,
    globalStoragePath: "/storage",
    folder: FOLDER,
    settings: {
      runtime: () => "auto",
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
      { versions: { "/opt/opentide": "opentide 0.21.0", [BUNDLED]: "opentide 0.20.1" } },
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
    const venv = path.join(FOLDER, ".venv", "bin", "opentide");
    const { value } = input(
      {},
      { path: () => "/missing/opentide" },
      { files: new Set([BUNDLED, venv]), versions: { [venv]: "opentide 0.20.1" } },
    );
    const { runtime, attempts } = await resolveRuntime(value);
    assert.equal(runtime?.source, "venv");
    assert.equal(attempts.find((a) => a.tier === 1)?.outcome, "failed");
  });

  it("tier 2: the Python Environments interpreter, using the opentide script beside it", async () => {
    const python = "/envs/a/bin/python";
    const script = "/envs/a/bin/opentide";
    const { value } = input(
      { pythonEnvironments: async () => python },
      {},
      { files: new Set([BUNDLED, script]), versions: { [script]: "opentide 0.20.1" } },
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

  it("refuses an opentide older than the minimum with its upgrade command, and tier 4 takes over", async () => {
    const { value } = input(
      {},
      {},
      {
        onPath: { opentide: "/usr/bin/opentide" },
        versions: { "/usr/bin/opentide": "opentide 0.19.2", [BUNDLED]: "opentide 0.20.1" },
      },
    );
    const { runtime, attempts } = await resolveRuntime(value);
    assert.equal(runtime?.tier, 4);
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
        versions: { "/usr/bin/opentide": "opentide 0.1.dev216+g0a65c49", [BUNDLED]: "opentide 0.21.0" },
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
      { onPath: { uv: "/usr/bin/uv" }, versions: { [BUNDLED]: "opentide 0.20.1" } },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.tier, 4);
    assert.ok(!state.probes.some((p) => p.command === "/usr/bin/uv"));
  });

  it("tier 4: the bundled interpreter, isolated, bytecode under global storage", async () => {
    const { value } = input({}, {}, { versions: { [BUNDLED]: "opentide 0.20.1" } });
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.tier, 4);
    assert.equal(runtime?.command, BUNDLED);
    assert.deepEqual(runtime?.args, [
      "-I",
      "-X",
      "utf8",
      "-X",
      `pycache_prefix=${path.join("/storage", "pycache")}`,
      "-m",
      "opentide",
    ]);
    assert.deepEqual(runtime?.binDirs, [path.join(EXT, "runtime", "bin")]);
    assert.equal(runtime?.restricted, false);
  });

  it("Windows: the bundled python.exe, with Scripts on PATH", async () => {
    const python = path.join(EXT, "runtime", "python.exe");
    const { value } = input(
      { platform: "win32" },
      {},
      { files: new Set([python]), versions: { [python]: "opentide 0.20.1" } },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.command, python);
    assert.deepEqual(runtime?.binDirs, [path.join(EXT, "runtime"), path.join(EXT, "runtime", "Scripts")]);
  });

  it("Windows on Arm: the same python.exe, whatever its architecture (the package's x64 runtime)", async () => {
    const python = path.join(EXT, "runtime", "python.exe");
    const { value } = input(
      { platform: "win32", arch: "arm64" },
      {},
      { files: new Set([python]), versions: { [python]: "opentide 0.22.0" } },
    );
    const { runtime, attempts } = await resolveRuntime(value);
    assert.equal(runtime?.tier, 4);
    assert.equal(runtime?.command, python);
    assert.doesNotMatch(attempts.at(-1)?.detail ?? "", /emulation/);
  });

  it("Windows on Arm: a bundled runtime that does not start says Windows 10 on Arm cannot run it", async () => {
    const python = path.join(EXT, "runtime", "python.exe");
    const failing = (platform: NodeJS.Platform, arch: string) =>
      input(
        { platform, arch },
        {},
        {
          files: new Set([python, BUNDLED]),
          versions: {
            [python]: { code: null, stdout: "", stderr: "", error: "spawn UNKNOWN" },
            [BUNDLED]: { code: null, stdout: "", stderr: "", error: "spawn UNKNOWN" },
          },
        },
      ).value;
    const arm = await resolveRuntime(failing("win32", "arm64"));
    assert.equal(arm.runtime, undefined);
    const last = arm.attempts.at(-1);
    assert.equal(last?.tier, 4);
    assert.equal(last?.outcome, "failed");
    assert.match(
      last?.detail ?? "",
      /spawn UNKNOWN\. This package's runtime is x64: .*Windows 10 on Arm cannot/,
    );
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["linux", "arm64"],
    ] as const) {
      const other = await resolveRuntime(failing(platform, arch));
      assert.doesNotMatch(other.attempts.at(-1)?.detail ?? "", /Windows 10 on Arm/, `${platform}-${arch}`);
    }
  });

  it("Windows on Arm: the hint's premise is pins.json's, an x64 runtime in the win32-arm64 package", () => {
    const pins = JSON.parse(readFileSync(path.join(ROOT, "pins.json"), "utf8")) as {
      emulatedTargets?: Record<string, { runtime: string }>;
    };
    // When win32-arm64 bundles a native runtime again, remove bundledEmulationHint (src/core/runtime/emulation.ts).
    assert.equal(pins.emulatedTargets?.["win32-arm64"]?.runtime, "win32-x64");
  });

  it("Restricted Mode: only tier 4, restricted, and no restricted setting is read", async () => {
    const { value, state } = input(
      { trusted: false, pythonEnvironments: throwing("python"), pythonExtension: throwing("python") },
      {
        path: throwing("opentide.path"),
        interpreter: throwing("opentide.interpreter"),
        uvUsePin: throwing("opentide.uv.usePin"),
        uvPath: throwing("opentide.uv.path"),
      },
      {
        onPath: { opentide: "/usr/bin/opentide" },
        versions: { "/usr/bin/opentide": "opentide 0.21.0", [BUNDLED]: "opentide 0.20.1" },
      },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.tier, 4);
    assert.equal(runtime?.restricted, true);
    assert.equal(state.probes.length, 1);
    assert.equal(state.probes[0]?.options.restricted, true, "the version probe runs locked down too");
  });

  it("opentide.runtime = bundled skips tiers 1 to 3", async () => {
    const { value } = input(
      {},
      { runtime: () => "bundled", path: throwing("opentide.path") },
      { versions: { [BUNDLED]: "opentide 0.20.1" } },
    );
    assert.equal((await resolveRuntime(value)).runtime?.tier, 4);
  });

  it("the universal package without opentide has no runtime, and says why", async () => {
    const { value } = input({}, {}, { files: new Set() });
    const { runtime, attempts } = await resolveRuntime(value);
    assert.equal(runtime, undefined);
    assert.match(attempts.at(-1)?.detail ?? "", /no bundled runtime/);
  });

  it("opentide.interpreter replaces the Python extensions and .venv lookup", async () => {
    const venv = path.join(FOLDER, ".venv", "bin", "opentide");
    const { value } = input(
      { pythonEnvironments: throwing("python") },
      { interpreter: () => ["$", "{workspaceFolder}/py/bin/python"].join("") },
      {
        files: new Set([BUNDLED, venv]),
        versions: { [`${FOLDER}/py/bin/python`]: "opentide 0.20.1", [venv]: "opentide 0.21.0" },
      },
    );
    const { runtime } = await resolveRuntime(value);
    assert.equal(runtime?.source, "interpreter-setting");
    assert.equal(runtime?.command, `${FOLDER}/py/bin/python`);
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
