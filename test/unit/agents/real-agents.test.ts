// The agents' MCP server against a real opentide: OPENTIDE_TEST_BIN and OPENTIDE_TEST_WORKSPACE (see
// test/unit/real-opentide.test.ts). Skipped when either is missing.
import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { spawnRun } from "../../../src/core/backend/spawn";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { processEnv } from "../../../src/core/runtime/env";
import type { Runtime } from "../../../src/core/runtime/types";
import { decideMcp } from "../../../src/features/agents/mcp";

const BIN = process.env.OPENTIDE_TEST_BIN;
const WORKSPACE = process.env.OPENTIDE_TEST_WORKSPACE;
const available = Boolean(BIN && WORKSPACE && existsSync(BIN) && existsSync(WORKSPACE));

describe("agents against a real opentide (OPENTIDE_TEST_BIN)", function () {
  this.timeout(120_000);
  let runtime: Runtime;
  let tree: CommandTree;
  let workspace: string;

  before(async function () {
    if (!available) this.skip();
    workspace = WORKSPACE as string;
    const version = spawnSync(BIN as string, ["--version"], { encoding: "utf8" })
      .stdout.trim()
      .split(/\s+/)
      .pop();
    runtime = {
      tier: 1,
      source: "setting",
      kind: "opentide",
      command: BIN as string,
      args: [],
      version: version ?? "",
      env: {},
      restricted: false,
      binDirs: [path.dirname(BIN as string)],
    };
    const commands = await spawnRun({
      command: runtime.command,
      args: ["--json", "commands"],
      commandName: "commands",
      env: processEnv(process.env, runtime, process.platform, { NO_COLOR: "1" }),
      cwd: workspace,
      platform: process.platform,
    });
    tree = CommandTree.parse(commands.document);
  });

  it("starts the MCP server it provides, which answers initialize", async () => {
    const decision = decideMcp({
      trusted: true,
      mode: "auto",
      runtime,
      hasMcpStart: tree.hasCommand("mcp start"),
      folder: workspace,
      workspaceDefines: false,
    });
    assert.ok(decision.provide);
    const { server } = decision;
    const child = spawn(server.command, [...server.args], {
      cwd: server.cwd,
      env: { ...process.env, ...server.env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
          const line = out.split("\n").find((l) => l.includes('"id":1'));
          if (line) resolve(line);
        });
        child.on("error", reject);
        child.on("exit", (code) => reject(new Error(`mcp start exited ${code}: ${out}`)));
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
          })}\n`,
        );
      });
      const message = JSON.parse(answer) as { result?: { capabilities?: { tools?: unknown } } };
      assert.ok(message.result?.capabilities?.tools, answer);
    } finally {
      child.kill();
    }
  });
});
