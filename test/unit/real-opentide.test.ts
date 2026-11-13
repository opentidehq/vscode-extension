// Against a real opentide, when one is given: OPENTIDE_TEST_BIN (an `opentide` executable) and
// OPENTIDE_TEST_WORKSPACE (a workspace with objects/rules). Skipped when either is missing.
import * as assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { Backend } from "../../src/core/backend/backend";
import { spawnRun } from "../../src/core/backend/spawn";
import { Capabilities } from "../../src/core/capabilities/capabilities";
import { COMMAND_CLASSES, classify } from "../../src/core/capabilities/classification";
import { CommandTree } from "../../src/core/capabilities/tree";
import { CatalogStore } from "../../src/core/catalog/store";
import { cliRange, linesOf } from "../../src/core/positions";
import { processEnv } from "../../src/core/runtime/env";
import { isFile, probe, which } from "../../src/core/runtime/process";
import { resolveRuntime } from "../../src/core/runtime/resolve";
import type { Runtime } from "../../src/core/runtime/types";
import { CancellationTokenSource } from "../../src/core/util/cancellation";
import { sleep } from "./helpers";

const BIN = process.env.OPENTIDE_TEST_BIN;

/** Whether two paths name the same file: Windows paths ignore case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  return norm(a) === norm(b);
}
const WORKSPACE = process.env.OPENTIDE_TEST_WORKSPACE;
const available = Boolean(BIN && WORKSPACE && existsSync(BIN) && existsSync(WORKSPACE));

describe("real opentide (OPENTIDE_TEST_BIN)", function () {
  this.timeout(120_000);
  let runtime: Runtime;
  let tree: CommandTree;

  before(async function () {
    if (!available) this.skip();
    const result = await resolveRuntime({
      trusted: true,
      platform: process.platform,
      folder: WORKSPACE,
      settings: {
        path: () => BIN,
        interpreter: () => undefined,
        uvUsePin: () => false,
        uvPath: () => undefined,
      },
      pin: undefined,
      proxy: undefined,
      homeDir: "/root",
      exists: isFile,
      which: (name) => which(name, process.env.PATH, process.platform),
      probe: (command, args, options) => probe(command, args, options),
      pythonEnvironments: async () => undefined,
      pythonExtension: async () => undefined,
    });
    assert.ok(result.runtime, JSON.stringify(result.attempts));
    runtime = result.runtime;
    const commands = await spawnRun({
      command: runtime.command,
      args: [...runtime.args, "--json", "commands"],
      commandName: "commands",
      env: processEnv(process.env, runtime, process.platform, { NO_COLOR: "1" }),
      cwd: WORKSPACE,
      platform: process.platform,
    });
    tree = CommandTree.parse(commands.document);
  });

  it("resolves opentide.path (tier 1) and reads its version", () => {
    assert.equal(runtime.tier, 1);
    assert.match(runtime.version, /^\d+\.\d+\.\d+/);
  });

  it("runs `python -m opentide` with the interpreter beside it when its opentide script does not run", async function () {
    const bin = BIN ?? "";
    // A venv's or a Unix install's python is beside the script; a Windows install's is above Scripts.
    const dir = path.dirname(bin);
    const python = (
      process.platform === "win32"
        ? [path.join(dir, "python.exe"), path.join(dir, "..", "python.exe")]
        : [path.join(dir, "python"), path.join(dir, "python3")]
    )
      .map((file) => path.resolve(file))
      .find((file) => existsSync(file));
    if (!python) this.skip();
    const result = await resolveRuntime({
      trusted: true,
      platform: process.platform,
      folder: WORKSPACE,
      settings: {
        path: () => undefined,
        interpreter: () => python,
        uvUsePin: () => false,
        uvPath: () => undefined,
      },
      pin: undefined,
      proxy: undefined,
      homeDir: "/root",
      exists: isFile,
      which: (name) => which(name, process.env.PATH, process.platform),
      // The script is blocked, as an application-control policy would: it fails to start.
      probe: (command, args, options) =>
        samePath(command, bin)
          ? Promise.resolve({ code: null, stdout: "", stderr: "", error: "spawn EPERM" })
          : probe(command, args, options),
      pythonEnvironments: async () => undefined,
      pythonExtension: async () => undefined,
    });
    assert.equal(result.runtime?.command, python, JSON.stringify(result.attempts));
    assert.deepEqual(result.runtime?.args, ["-m", "opentide"]);
    assert.equal(result.runtime?.version, runtime.version);
    const tree = await spawnRun({
      command: python,
      args: ["-m", "opentide", "--json", "commands"],
      commandName: "commands",
      env: processEnv(process.env, result.runtime as Runtime, process.platform, { NO_COLOR: "1" }),
      cwd: WORKSPACE ?? ".",
      platform: process.platform,
    });
    assert.equal(CommandTree.parse(tree.document).version, runtime.version);
  });

  it("parses its command tree, which matches its version", () => {
    assert.equal(tree.version, runtime.version);
    assert.ok(tree.hasCommand("validate"));
    assert.ok(tree.hasOption("validate", "--file"));
    assert.ok(tree.hasCommand("new rule"));
  });

  it("classifies every command it has (contract test)", () => {
    const missing = tree.commands.map((c) => c.path).filter((p) => !Object.hasOwn(COMMAND_CLASSES, p));
    assert.deepEqual(missing, []);
  });

  it("spawns validate --file and converts a finding's range against the file", async () => {
    const backend = new Backend({
      runtime: () => runtime,
      commands: async () => tree,
      classify: (argv) => classify(argv),
      serveMode: () => "auto",
      baseEnv: () => process.env,
      proxy: () => undefined,
      credentials: async () => ({}),
      platform: process.platform,
      log: () => {},
    });
    const rules = path.join(WORKSPACE as string, "objects", "rules");
    const file = path.join(
      rules,
      readdirSync(rules)
        .filter((n) => n.endsWith(".yaml"))
        .sort()[0] as string,
    );
    const result = await backend.run(WORKSPACE as string, ["validate", "--file", file]);
    assert.equal(result.via, tree.hasCommand("serve") ? "serve" : "spawn");
    assert.equal(result.document.command, "validate");
    assert.equal(typeof result.document.exit_code, "number");
    assert.equal(result.exitCode, result.document.exit_code);
    const report = result.document.report as
      | { issues?: { line?: number; column?: number; end_column?: number; context?: { value?: string } }[] }
      | undefined;
    const vocab = report?.issues?.find((issue) => issue.context?.value && issue.column && issue.end_column);
    if (vocab?.line && vocab.context?.value) {
      const text = readFileSync(file, "utf8");
      const range = cliRange(linesOf(text), vocab as { line: number; column: number; end_column: number });
      const line = text.split(/\r?\n/)[range.start.line] ?? "";
      assert.equal(line.slice(range.start.character, range.end.character), vocab.context.value);
    }
    await backend.dispose();
  });

  it("returns a usage failure as a document, not an error", async () => {
    const result = await spawnRun({
      command: runtime.command,
      args: [...runtime.args, "--json", "info", "no-such-section"],
      commandName: "info",
      env: processEnv(process.env, runtime, process.platform, { NO_COLOR: "1" }),
      cwd: WORKSPACE,
      platform: process.platform,
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.document.failure?.code, "usage_invalid_choice");
  });

  it("decodes non-ASCII output where Python's pipes are not UTF-8 (Windows' ANSI code page)", async () => {
    // PYTHONIOENCODING=cp1252 makes Python write pipes as Windows does by default.
    const file = "objects/rules/détection-josé-missing.yaml";
    const result = await spawnRun({
      command: runtime.command,
      args: [...runtime.args, "--json", "validate", "--file", file],
      commandName: "validate",
      env: processEnv({ ...process.env, PYTHONIOENCODING: "cp1252" }, runtime, process.platform, {
        NO_COLOR: "1",
      }),
      cwd: WORKSPACE,
      platform: process.platform,
    });
    const text = JSON.stringify(result.document);
    assert.ok(text.includes("détection-josé"), text.slice(0, 400));
    assert.ok(!text.includes("\uFFFD") && !text.includes("\ufffd") && !text.includes("�"));
  });

  it("gates the catalogue on `info catalog` in the tree", async () => {
    const capabilities = new Capabilities({
      fetch: async () => tree.document,
      cache: { read: async () => undefined, write: async () => {} },
      log: () => {},
    });
    await capabilities.load(runtime);
    const store = new CatalogStore({
      availability: () => ({ available: true }),
      hasInfoCatalog: async () => capabilities.hasCommand("info catalog"),
      runCatalog: async () => ({ document: {}, exitCode: 0 }),
      symbols: async () => [],
      log: () => {},
    });
    const state = await store.refresh(WORKSPACE as string, { immediate: true });
    if (tree.hasCommand("info catalog")) assert.notEqual(state.unavailable?.reason, "needs-command");
    else assert.equal(state.unavailable?.reason, "needs-command");
    store.dispose();
  });

  it("cancels a whole-workspace validate with SIGINT", async function () {
    if (process.platform === "win32") this.skip();
    const source = new CancellationTokenSource();
    const started = Date.now();
    const pending = spawnRun({
      command: runtime.command,
      args: [...runtime.args, "--json", "validate"],
      commandName: "validate",
      env: processEnv(process.env, runtime, process.platform, {
        NO_COLOR: "1",
        OPENTIDE_REPO_ROOT: WORKSPACE as string,
      }),
      cwd: WORKSPACE,
      platform: process.platform,
      token: source.token,
    });
    // Soon after it starts: the Rust core validates a small workspace in well under a second, so a
    // later cancel would find the run already finished.
    await sleep(50);
    source.cancel();
    const result = await pending;
    assert.ok(result.cancelled);
    assert.ok(Date.now() - started < 8000, "it stopped soon after the cancel");
  });
});
