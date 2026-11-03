import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Backend, type BackendDeps, type RunRecord } from "../../src/core/backend/backend";
import { BackendError } from "../../src/core/backend/types";
import { type Classification, classify } from "../../src/core/capabilities/classification";
import { CommandTree } from "../../src/core/capabilities/tree";
import { COMMANDS_FIXTURE, fakeRuntime } from "./helpers";

const REPO = mkdtempSync(path.join(tmpdir(), "otide-repo-"));

const READ: Classification = { class: "read-only", writes: false, contactsTenant: false, spawn: false };
const WRITE: Classification = {
  class: "writes-workspace",
  writes: true,
  contactsTenant: false,
  spawn: false,
};
const TENANT: Classification = {
  class: "contacts-tenant",
  writes: false,
  contactsTenant: true,
  spawn: false,
};

function tree(withServe: boolean): CommandTree {
  const document = JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8"));
  if (withServe)
    document.commands.push({
      path: "serve",
      name: "serve",
      summary: "",
      group: false,
      subcommands: [],
      deprecated: false,
      arguments: [],
      options: [],
    });
  return CommandTree.parse(document);
}

function backend(overrides: Partial<BackendDeps> = {}, env: Record<string, string> = {}) {
  const logs: string[] = [];
  const runtime = fakeRuntime();
  const instance = new Backend({
    runtime: () => runtime,
    commands: async () => tree(true),
    classify: (argv) =>
      argv[0] === "write" || argv.includes("--write") ? WRITE : argv.includes("--tenant") ? TENANT : READ,
    serveMode: () => "auto",
    baseEnv: () => ({ ...process.env, ...env }),
    proxy: () => "http://proxy:3128",
    credentials: async () => ({ FAKE_SECRET: "s3cr3t-value" }),
    platform: process.platform,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...overrides,
  });
  return { instance, logs };
}

describe("backend", () => {
  const instances: Backend[] = [];
  const make = (...args: Parameters<typeof backend>) => {
    const made = backend(...args);
    instances.push(made.instance);
    return made;
  };
  afterEach(async () => {
    for (const instance of instances.splice(0)) await instance.dispose();
  });

  it("answers through opentide serve when the command tree has it", async () => {
    const { instance } = make();
    const result = await instance.run(REPO, ["echo", "--file", "a.yaml"]);
    assert.equal(result.via, "serve");
    assert.equal(result.exitCode, 0);
    assert.equal(result.argvDisplay, "opentide --json echo --file a.yaml");
    assert.equal(instance.serveRunning, true);
    const env = result.document.env as Record<string, string>;
    assert.equal(env.OPENTIDE_REPO_ROOT, REPO);
    assert.equal(env.NO_COLOR, "1");
    assert.equal(env.OPENTIDE_PROXY, "http://proxy:3128");
  });

  it("spawns `opentide --json` when the tree has no serve, with the same environment", async () => {
    const { instance } = make({ commands: async () => tree(false) });
    const result = await instance.run(process.cwd(), ["echo"]);
    assert.equal(result.via, "spawn");
    const env = result.document.env as Record<string, string>;
    assert.equal(env.OPENTIDE_REPO_ROOT, process.cwd());
    assert.equal(env.NO_COLOR, "1");
    assert.equal(env.OPENTIDE_PROXY, "http://proxy:3128");
  });

  it("produces the same document through both paths", async () => {
    const serve = await make().instance.run(process.cwd(), ["fail"]);
    const spawn = await make({ serveMode: () => "never" }).instance.run(process.cwd(), ["fail"]);
    assert.deepEqual(serve.document, spawn.document);
    assert.equal(serve.exitCode, spawn.exitCode);
  });

  it("spawns commands whose classification wants a process of their own", async () => {
    const { instance } = make({ classify: (argv) => classify(argv) });
    const result = await instance.run(process.cwd(), ["doctor", "--offline"]);
    assert.equal(result.via, "spawn");
  });

  it("gives the credential environment for processes of its own, only when commands can run", async () => {
    const { instance } = make();
    assert.deepEqual(await instance.credentialEnv(process.cwd()), { FAKE_SECRET: "s3cr3t-value" });
    const restricted = make({ runtime: () => fakeRuntime({ restricted: true }) }).instance;
    assert.deepEqual(await restricted.credentialEnv(process.cwd()), {});
  });

  it("injects credentials only into runs that contact a tenant, and redacts them", async () => {
    const { instance, logs } = make({ serveMode: () => "never" });
    const plain = await instance.run(process.cwd(), ["echo"]);
    assert.equal((plain.document.env as Record<string, string>).FAKE_SECRET, undefined);
    const tenant = await instance.run(process.cwd(), ["echo", "--tenant", "s3cr3t-value"]);
    assert.equal((tenant.document.env as Record<string, string>).FAKE_SECRET, "s3cr3t-value");
    assert.equal(tenant.argvDisplay, "opentide --json echo --tenant ***");
    assert.ok(!logs.some((line) => line.includes("s3cr3t-value")), "no secret in the output channel");
    const forced = await instance.run(process.cwd(), ["echo"], { credentials: true });
    assert.equal((forced.document.env as Record<string, string>).FAKE_SECRET, "s3cr3t-value");
    const never = await instance.run(process.cwd(), ["echo", "--tenant", "x"], { credentials: false });
    assert.equal((never.document.env as Record<string, string>).FAKE_SECRET, undefined);
  });

  it("runs writers one at a time and readers concurrently", async () => {
    const { instance } = make({ serveMode: () => "never" });
    const spans: [number, number][] = [];
    const timed = async (argv: string[]) => {
      const started = Date.now();
      await instance.run(process.cwd(), argv);
      spans.push([started, Date.now()]);
    };
    await Promise.all([timed(["slow", "300", "--write"]), timed(["slow", "300", "--write"])]);
    const [a, b] = spans.sort((x, y) => x[1] - y[1]);
    assert.ok(a && b && b[1] - a[1] >= 250, "the second writer finished at least one run later");
    spans.length = 0;
    const started = Date.now();
    await Promise.all([timed(["slow", "400"]), timed(["slow", "400"])]);
    assert.ok(Date.now() - started < 800 + 600, "readers overlap");
  });

  it("retries a read-only request once when the backend dies under it", async () => {
    const marker = path.join(mkdtempSync(path.join(tmpdir(), "otide-")), "crashed");
    const { instance, logs } = make({}, { FAKE_CRASH_FILE: marker });
    const result = await instance.run(REPO, ["crash-once"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.via, "serve");
    assert.ok(logs.some((line) => line.includes("crashed")));
  });

  it("does not retry a writer when the backend dies under it", async () => {
    const marker = path.join(mkdtempSync(path.join(tmpdir(), "otide-")), "crashed");
    const { instance } = make({}, { FAKE_CRASH_FILE: marker });
    await assert.rejects(
      instance.run(REPO, ["crash-once", "--write"]),
      (e: unknown) => e instanceof BackendError && e.code === "crashed",
    );
    const next = await instance.run(REPO, ["echo"]);
    assert.equal(next.via, "serve", "the next request starts a new backend");
  });

  it("falls back to spawning when serve cannot start", async () => {
    const { instance, logs } = make({}, { FAKE_SERVE_BROKEN: "1" });
    const result = await instance.run(process.cwd(), ["echo"]);
    assert.equal(result.via, "spawn");
    assert.ok(logs.some((line) => line.includes("spawning instead")));
    assert.equal((await instance.run(process.cwd(), ["echo"])).via, "spawn");
  });

  it("reports each run when it starts and when it ends", async () => {
    const { instance } = make();
    const records: RunRecord[] = [];
    instance.onDidRun((record) => records.push(record));
    await instance.run(REPO, ["fail"]);
    assert.deepEqual(
      records.map((r) => r.status),
      ["running", "failed"],
    );
    assert.equal(records[1]?.exitCode, 1);
    assert.equal(records[1]?.failureCode, "workspace_not_found");
    assert.equal(records[0]?.id, records[1]?.id);
  });

  it("refuses to run in Restricted Mode, without a runtime, and with opentide-lsp", async () => {
    for (const [runtime, code] of [
      [fakeRuntime({ restricted: true }), "untrusted"],
      [undefined, "no-runtime"],
      [fakeRuntime({ kind: "opentide-lsp" }), "editor-only"],
    ] as const) {
      const { instance } = make({ runtime: () => runtime });
      assert.deepEqual(instance.availability(), { available: false, code });
      await assert.rejects(
        instance.run(REPO, ["echo"]),
        (e: unknown) => e instanceof BackendError && e.code === code,
      );
    }
  });
});
