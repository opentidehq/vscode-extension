// The @opentide/opentide a platform VSIX carries, resolved and run as the extension runs it: tier 2
// `package`, `<node> dist/opentide/cli.js` with ELECTRON_RUN_AS_NODE, no Python. Runs when
// OPENTIDE_TEST_PACKAGE names a staged dist/opentide (`OPENTIDE_NPM=<dir> npm run build`), with
// OPENTIDE_TEST_WORKSPACE; skipped otherwise.
import * as assert from "node:assert/strict";
import * as cp from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { ServeClient } from "../../src/core/backend/serve";
import { spawnRun } from "../../src/core/backend/spawn";
import { processEnv } from "../../src/core/runtime/env";
import { isFile, probe } from "../../src/core/runtime/process";
import { readPackageManifest, resolveRuntime } from "../../src/core/runtime/resolve";
import { cliCommand, languageServerCommand, type Runtime } from "../../src/core/runtime/types";

const DIR = process.env.OPENTIDE_TEST_PACKAGE;
const WORKSPACE = process.env.OPENTIDE_TEST_WORKSPACE;
const available = Boolean(
  DIR && WORKSPACE && existsSync(path.join(DIR, "opentide.json")) && existsSync(WORKSPACE),
);

describe("the bundled @opentide/opentide (OPENTIDE_TEST_PACKAGE)", function () {
  this.timeout(120_000);
  let runtime: Runtime;

  before(async function () {
    if (!available || !DIR) this.skip();
    const layout = readPackageManifest(readFileSync(path.join(DIR, "opentide.json"), "utf8"), DIR);
    assert.ok(layout, "opentide.json reads");
    const result = await resolveRuntime({
      trusted: true,
      platform: process.platform,
      folder: WORKSPACE,
      settings: {
        path: () => undefined,
        interpreter: () => undefined,
        uvUsePin: () => false,
        uvPath: () => undefined,
      },
      pin: undefined,
      proxy: undefined,
      homeDir: "/root",
      exists: isFile,
      // No PATH: nothing but the package can answer before the engine.
      which: () => undefined,
      probe: (command, args, options) => probe(command, args, options),
      pythonEnvironments: async () => undefined,
      pythonExtension: async () => undefined,
      package: layout,
      nodeExecutable: process.execPath,
    });
    assert.ok(result.runtime, JSON.stringify(result.attempts));
    runtime = result.runtime;
  });

  it("is tier 2's package, at opentide.json's version, run by the host's executable", () => {
    assert.equal(runtime.source, "package");
    assert.equal(runtime.tier, 2);
    assert.equal(runtime.command, process.execPath);
    assert.equal(runtime.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(runtime.env.PYTHONUTF8, undefined);
  });

  it("runs a command and returns its --json document", async () => {
    const { command, args } = cliCommand(runtime, ["--json", "info"]);
    const result = await spawnRun({
      command,
      args,
      commandName: "info",
      env: processEnv(process.env, runtime, process.platform, {
        NO_COLOR: "1",
        OPENTIDE_REPO_ROOT: WORKSPACE as string,
      }),
      cwd: WORKSPACE,
      platform: process.platform,
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result.document).slice(0, 400));
    assert.equal(result.document.ok, true);
  });

  it("serves the backend (`opentide serve`, CONTRACTS.md): initialize, then a run", async () => {
    const { command, args } = cliCommand(runtime, ["serve"]);
    const serve = new ServeClient({
      start: () =>
        cp.spawn(command, args, {
          cwd: WORKSPACE,
          env: processEnv(process.env, runtime, process.platform, { NO_COLOR: "1" }),
          stdio: ["pipe", "pipe", "pipe"],
        }),
    });
    try {
      const init = await serve.start();
      assert.equal(init.protocol, 1);
      assert.equal(init.version, runtime.version);
      const result = await serve.run({
        argv: ["info", "catalog"],
        cwd: WORKSPACE as string,
        env: { OPENTIDE_REPO_ROOT: WORKSPACE as string },
      });
      assert.equal(result.exit_code, 0);
      assert.equal(result.document.ok, true);
    } finally {
      await serve.stop();
    }
  });

  it("starts the language server with `lsp start`", async () => {
    const { command, args } = languageServerCommand(runtime);
    assert.deepEqual(args.slice(-2), ["lsp", "start"]);
    const child = cp.spawn(command, args, {
      cwd: WORKSPACE,
      env: processEnv(process.env, runtime, process.platform),
      stdio: ["pipe", "pipe", "inherit"],
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { processId: null, rootUri: null, capabilities: {} },
    });
    const answer = await new Promise<string>((resolve, reject) => {
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (/"id":1/.test(out)) resolve(out);
      });
      child.on("error", reject);
      child.on("exit", () => reject(new Error(`exited before answering: ${out}`)));
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
    child.kill();
    assert.match(answer, /"capabilities"/);
  });
});
