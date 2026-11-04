// The query and deploy-plan command lines, run through the real Backend against the fake opentide.
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Backend } from "../../../src/core/backend/backend";
import { classify } from "../../../src/core/capabilities/classification";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { CancellationTokenSource } from "../../../src/core/util/cancellation";
import { DeployPlanner } from "../../../src/features/deploy-plan/argv";
import { planView } from "../../../src/features/deploy-plan/plan";
import { queryArgv, tenantChoices } from "../../../src/features/query/argv";
import { formatRows } from "../../../src/features/query/format";
import { PlatformInfoCache } from "../../../src/features/query/platforms";
import {
  applyProgress,
  pendingTabs,
  progressFromEvent,
  tabsFromDocument,
} from "../../../src/features/query/results";
import { COMMANDS_FIXTURE, fakeRuntime } from "../helpers";

const REPO = mkdtempSync(path.join(tmpdir(), "otide-panels-"));

function make(env: Record<string, string> = {}) {
  const runtime = fakeRuntime();
  const tree = CommandTree.parse(JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8")));
  return new Backend({
    runtime: () => runtime,
    commands: async () => tree,
    classify: (argv) => classify(argv),
    serveMode: () => "never",
    baseEnv: () => ({ ...process.env, ...env }),
    proxy: () => undefined,
    credentials: async () => ({ FAKE_SECRET: "s3cr3t-value" }),
    platform: process.platform,
    log: () => undefined,
  });
}

const options = {
  platform: "sentinel",
  source: { kind: "rule", file: "objects/rules/x.yaml", name: "X" } as const,
  window: { kind: "since", since: "24h" } as const,
  limit: 100,
};

describe("query and deploy plan through the backend (#17, #18)", () => {
  const backends: Backend[] = [];
  const backend = (env: Record<string, string> = {}) => {
    const instance = make(env);
    backends.push(instance);
    return instance;
  };
  afterEach(async () => {
    for (const instance of backends.splice(0)) await instance.dispose();
  });

  it("a Sentinel rule on two tenants, one returning 403: one result tab, one error tab, CSV of the first", async () => {
    const events: Record<string, unknown>[] = [];
    let tabs = pendingTabs(["prod", "dev"]);
    const result = await backend({ FAKE_QUERY_TENANTS: "prod,dev" }).run(
      REPO,
      queryArgv({ ...options, tenants: ["prod", "dev"] }),
      {
        onProgress: (event) => {
          events.push(event);
          const progress = progressFromEvent(event);
          if (progress) tabs = applyProgress(tabs, progress);
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.via, "spawn", "query runs in a process of its own");
    assert.deepEqual(
      events.map((e) => [e.tenant, e.status]),
      [
        ["prod", "ok"],
        ["dev", "failed"],
      ],
    );
    assert.deepEqual(
      tabs.map((t) => [t.tenant, t.status, t.rowCount]),
      [
        ["prod", "ok", 3],
        ["dev", "failed", 0],
      ],
    );
    const [ok, failed] = tabsFromDocument(result.document);
    assert.equal(ok?.status, "ok");
    assert.equal(failed?.error, "HTTP 403 Forbidden");
    assert.ok(ok);
    const csv = formatRows("csv", ok.columns, ok.rows);
    assert.equal(csv.split("\r\n")[0], "TimeGenerated,DeviceName,Count");
    assert.equal(csv.split("\r\n").length, 5);
  });

  it("gets credentials for query (it contacts tenants), and the choices when several tenants exist", async () => {
    const result = await backend({ FAKE_QUERY_TENANTS: "prod,dev" }).run(REPO, queryArgv(options));
    assert.equal(result.exitCode, 2);
    assert.deepEqual(tenantChoices(result.document), ["prod", "dev", "all"]);
    assert.ok(!result.argvDisplay.includes("s3cr3t"));
  });

  it("cancels a running query", async () => {
    const source = new CancellationTokenSource();
    const running = backend({ FAKE_QUERY_DELAY_MS: "5000" }).run(REPO, queryArgv(options), {
      cancellation: source.token,
    });
    setTimeout(() => source.cancel(), 300);
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.equal(result.exitCode, 130);
  });

  it("reads platform caps from info", async () => {
    const instance = backend();
    const cache = new PlatformInfoCache({ run: (folder) => instance.run(folder, ["info"]) });
    assert.equal((await cache.caps(REPO, "sysdig")).canQuery, false);
    assert.equal((await cache.caps(REPO, "sentinel")).canQuery, true);
    assert.equal((await cache.caps(REPO, "sentinel")).tenants, undefined);
  });

  it("previews a deploy and never reaches a real one", async () => {
    const instance = backend();
    const planner = new DeployPlanner((folder: string, argv: readonly string[], _extra: undefined) =>
      instance.run(folder, argv, { credentials: false }),
    );
    const result = await planner.plan(REPO, { strategies: ["PREVIEW"], scope: { kind: "all" } }, undefined);
    assert.equal(result.exitCode, 0, JSON.stringify(result.document.failure));
    assert.deepEqual(result.document.argv, ["--dry-run", "--strategy", "PREVIEW", "--all"]);
    assert.equal(planView(result.document).platforms.length, 2);
    // The fake answers a deploy without --dry-run with fake_real_deploy; the planner cannot send one.
    const unmatched = await planner.plan(
      REPO,
      { strategies: ["PREVIEW"], scope: { kind: "selected", uuids: ["nope"], files: [] } },
      undefined,
    );
    assert.deepEqual(planView(unmatched.document).unmatched, ["nope"]);
    assert.notEqual(unmatched.document.failure?.code, "fake_real_deploy");
  });
});
