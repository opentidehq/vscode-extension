import * as assert from "node:assert/strict";
import type { ActivityEntry } from "../../../src/core/activity";
import { newObjectHandover } from "../../../src/features/sidebar/actions";
import { activityNodes, ago, canRerun, duration, runningCount } from "../../../src/features/sidebar/activity";
import { folderViewModel } from "../../../src/features/sidebar/folderView";
import {
  type DoctorCheck,
  fixArgv,
  healthNodes,
  parseChecks,
  redact,
  report,
  summarize,
  summaryText,
} from "../../../src/features/sidebar/health";
import { debounce, Loader } from "../../../src/features/sidebar/loader";
import { platformFlag, platformName, platformToml } from "../../../src/features/sidebar/platformNames";
import {
  parsePlatforms,
  platformNodes,
  tenantCheck,
  variableSource,
} from "../../../src/features/sidebar/platforms";
import { sleep, until } from "../helpers";

// `opentide --json info` with tenants (opentide#754), as the branch prints it.
const INFO = {
  platforms: [
    {
      name: "carbon_black_cloud",
      enabled: false,
      can_deploy: true,
      can_validate: true,
      can_query: true,
      tenants: [],
    },
    {
      name: "sentinel",
      enabled: true,
      can_deploy: true,
      can_validate: true,
      can_query: true,
      tenants: [
        {
          name: "prod",
          description: "Production",
          strategies: ["PREVIEW", "RELEASE"],
          manual: false,
          variables: [
            { name: "AZURE_CLIENT_ID", set: true },
            { name: "AZURE_CLIENT_SECRET", set: false },
          ],
        },
      ],
    },
    { name: "splunk", enabled: true, can_deploy: true, can_validate: true, can_query: true, tenants: [] },
  ],
};

// `opentide --json doctor --offline` from 0.21.0 (trimmed).
const DOCTOR = {
  checks: [
    { code: "python_version", status: "pass", message: "Python 3.13.18", fix: null, subject: null },
    {
      code: "templates_fresh",
      status: "warn",
      message: "2 template(s) differ",
      fix: "opentide generate templates schemas snippets",
      subject: null,
    },
    {
      code: "credentials",
      status: "warn",
      message: "sentinel/prod: 1 of 2 variables unset: AZURE_CLIENT_SECRET",
      fix: "set AZURE_CLIENT_SECRET in the environment (or a .env file you load)",
      subject: "sentinel/prod",
    },
    { code: "proxy", status: "skip", message: "Not checked: --offline", fix: null, subject: null },
    { code: "configuration", status: "fail", message: "bad.toml line 3", fix: "git init ./", subject: null },
    { code: "bogus", status: "unknown", message: "dropped" },
  ],
};

describe("sidebar: platforms & tenants", () => {
  it("parses info's platforms, with tenants when this opentide lists them", () => {
    const platforms = parsePlatforms(INFO);
    assert.equal(platforms.length, 3);
    assert.equal(platforms[1]?.tenants?.[0]?.variables[1]?.name, "AZURE_CLIENT_SECRET");
    const old = parsePlatforms({ platforms: [{ name: "sentinel", enabled: true, can_deploy: true }] });
    assert.equal(old[0]?.tenants, undefined);
    assert.deepEqual(parsePlatforms({ nope: true }), []);
  });

  it("says where each credential comes from, stored first", () => {
    const stored = new Set(["AZURE_CLIENT_SECRET"]);
    assert.equal(variableSource({ name: "AZURE_CLIENT_SECRET", set: true }, stored), "stored");
    assert.equal(variableSource({ name: "AZURE_CLIENT_ID", set: true }, stored), "environment");
    assert.equal(variableSource({ name: "X", set: false }, stored), "unset");
  });

  it("lists enabled platforms first with their tenants and credential state", () => {
    const nodes = platformNodes(parsePlatforms(INFO), new Set(), "/repo");
    assert.deepEqual(
      nodes.map((n) => n.label),
      ["Microsoft Sentinel", "Splunk", "Carbon Black Cloud"],
    );
    const sentinel = nodes[0];
    assert.equal(sentinel?.contextValue, "platform.enabled");
    assert.equal(sentinel?.description, "enabled · 1 tenant · deploy, validate, query");
    const tenant = sentinel?.children?.[0];
    assert.equal(tenant?.description, "1 of 2 credentials set · PREVIEW, RELEASE");
    assert.equal(tenant?.contextValue, "tenant.credentials");
    assert.equal(tenant?.collapsed, "expanded");
    assert.deepEqual(
      tenant?.children?.map((v) => [v.label, v.description, v.contextValue]),
      [
        ["AZURE_CLIENT_ID", "set · from the environment", "variable.environment"],
        ["AZURE_CLIENT_SECRET", "not set", "variable.unset"],
      ],
    );
    assert.equal(nodes[1]?.children?.[0]?.label, "No tenant configured");
    assert.equal(nodes[2]?.contextValue, "platform.disabled");
    assert.equal(nodes[2]?.collapsed, undefined);
    // Setting the secret in VS Code turns the tenant complete.
    const after = platformNodes(parsePlatforms(INFO), new Set(["AZURE_CLIENT_SECRET"]), "/repo");
    assert.equal(after[0]?.children?.[0]?.description, "2 of 2 credentials set · PREVIEW, RELEASE");
    assert.equal(after[0]?.children?.[0]?.iconColor, "testing.iconPassed");
  });

  it("says tenants need a newer opentide when info has none", () => {
    const nodes = platformNodes(
      parsePlatforms({ platforms: [{ name: "sentinel", enabled: true }] }),
      new Set(),
      "/r",
    );
    assert.equal(nodes[0]?.children?.[0]?.label, "Tenants need a newer opentide");
  });

  it("finds doctor's credentials check of a tenant", () => {
    const checks = parseChecks(DOCTOR);
    assert.equal(tenantCheck(checks, "sentinel", "prod")?.status, "warn");
    assert.equal(tenantCheck(checks, "splunk", "x"), undefined);
  });

  it("names platforms and their setup flags and files", () => {
    assert.equal(platformName("defender_for_endpoint").short, "Defender");
    assert.equal(platformName("new_thing").long, "new_thing");
    assert.equal(platformFlag("defender_for_endpoint"), "--defender-for-endpoint");
    assert.equal(platformToml("sentinel"), ".opentide/configurations/platforms/sentinel.toml");
  });
});

describe("sidebar: health", () => {
  it("parses doctor's checks and drops unknown statuses", () => {
    const checks = parseChecks(DOCTOR);
    assert.equal(checks.length, 5);
    assert.deepEqual(summarize(checks), { passed: 1, warnings: 2, failed: 1, skipped: 1 });
    assert.equal(summaryText(summarize(checks)), "✓ 1  ! 2  ✗ 1");
    assert.deepEqual(parseChecks({}), []);
  });

  it("turns a fix into argv only when it is an opentide command", () => {
    assert.deepEqual(fixArgv("opentide generate templates schemas snippets"), [
      "generate",
      "templates",
      "schemas",
      "snippets",
    ]);
    assert.deepEqual(fixArgv("opentide setup mcp --vscode (or --cursor, --claude-code, --generic)"), [
      "setup",
      "mcp",
      "--vscode",
    ]);
    assert.deepEqual(fixArgv("opentide --json generate schemas"), ["generate", "schemas"]);
    assert.equal(fixArgv("git init ./"), undefined);
    assert.equal(fixArgv("add a [[tenants]] entry in sentinel.toml"), undefined);
    assert.equal(fixArgv("opentide validate; rm -rf /"), undefined);
    assert.equal(fixArgv("opentide"), undefined);
    assert.equal(fixArgv(null), undefined);
  });

  it("orders failures first and offers runnable fixes", () => {
    const nodes = healthNodes(parseChecks(DOCTOR), "/repo");
    assert.deepEqual(
      nodes.map((n) => n.ref?.kind === "check" && n.ref.check.code),
      ["configuration", "templates_fresh", "credentials", "python_version", "proxy"],
    );
    assert.equal(nodes[0]?.contextValue, "check.fix");
    assert.equal(nodes[0]?.collapsed, "expanded");
    assert.equal(nodes[1]?.contextValue, "check.runnable");
    assert.equal(nodes[1]?.children?.[0]?.command?.command, "opentide.sidebar.runFix");
    assert.equal(nodes[3]?.children, undefined);
  });

  it("writes a report with paths and secrets redacted", () => {
    const checks: DoctorCheck[] = [
      {
        code: "workspace",
        status: "pass",
        message: "Workspace /home/me/repo has .opentide/",
        fix: null,
        subject: null,
      },
      {
        code: "x",
        status: "warn",
        message: "token s3cr3t-value seen in /home/me/other",
        fix: "opentide doctor",
        subject: null,
      },
    ];
    const text = report(checks, {
      opentide: "0.21.0",
      editor: "VS Code 1.99",
      home: "/home/me",
      folder: "/home/me/repo",
      secrets: ["s3cr3t-value", "ab"],
    });
    assert.ok(text.includes("opentide 0.21.0 · VS Code 1.99"));
    assert.ok(text.includes("Workspace <workspace> has .opentide/"));
    assert.ok(text.includes("token *** seen in ~/other"));
    assert.ok(text.includes("  → opentide doctor"));
    assert.ok(!text.includes("/home/me"));
    assert.equal(redact("ab", { secrets: ["ab"] }), "ab", "too short to redact safely");
  });
});

describe("sidebar: activity", () => {
  const entry = (partial: Partial<ActivityEntry>): ActivityEntry => ({
    id: 1,
    argv: ["validate", "--file", "x.yaml"],
    argvDisplay: "opentide --json validate --file x.yaml",
    folder: "/repo",
    startedAt: 1_000_000,
    status: "ok",
    via: "serve",
    durationMs: 1234,
    exitCode: 0,
    ...partial,
  });

  it("shows status, duration and age, and the command line in the tooltip", () => {
    const [node] = activityNodes(
      [entry({})],
      1_000_000 + 125_000,
      () => ({ class: "read-only" }),
      () => "repo",
    );
    assert.equal(node?.label, "validate --file x.yaml");
    assert.equal(node?.description, "ok · 1.2 s · 2 min ago");
    assert.ok(node?.tooltip?.startsWith("opentide --json validate --file x.yaml\nin repo"));
    assert.equal(node?.contextValue, "run.rerunnable");
  });

  it("never offers to repeat a deploy or a share, or a run still going", () => {
    assert.equal(canRerun({ class: "deploys" }), false);
    assert.equal(canRerun({ class: "shares" }), false);
    assert.equal(canRerun({ class: "contacts-tenant" }), true);
    const [deploy] = activityNodes(
      [entry({ argv: ["deploy"] })],
      0,
      () => ({ class: "deploys" }),
      () => undefined,
    );
    assert.equal(deploy?.contextValue, "run");
    const [running] = activityNodes(
      [entry({ status: "running" })],
      0,
      () => ({ class: "read-only" }),
      () => undefined,
    );
    assert.equal(running?.contextValue, "run");
    assert.equal(running?.icon, "loading~spin");
    const [failed] = activityNodes(
      [entry({ status: "failed", exitCode: 1, failureCode: "issues_found" })],
      1_000_000,
      () => ({ class: "read-only" }),
      () => undefined,
    );
    assert.equal(failed?.description, "failed · exit 1 · 1.2 s · just now");
    assert.ok(failed?.tooltip?.includes("failure: issues_found"));
    assert.equal(runningCount([entry({ status: "running" }), entry({})]), 1);
  });

  it("formats durations and ages", () => {
    assert.equal(duration(undefined), "");
    assert.equal(duration(340), "340 ms");
    assert.equal(duration(125_000), "2 min 5 s");
    assert.equal(ago(0, 30_000), "30 s ago");
    assert.equal(ago(0, 7_200_000), "2 h ago");
    assert.equal(ago(0, 172_800_000), "2 d ago");
  });
});

describe("sidebar: loader and folder views", () => {
  it("loads only when visible, debounced and one at a time, and reloads when shown after a change", async () => {
    let visible = false;
    let loads = 0;
    let concurrent = 0;
    let max = 0;
    const loader = new Loader<number>({
      isVisible: () => visible,
      debounceMs: 20,
      load: async () => {
        loads++;
        concurrent++;
        max = Math.max(max, concurrent);
        await sleep(30);
        concurrent--;
        return loads;
      },
    });
    loader.request();
    await sleep(40);
    assert.equal(loads, 0, "hidden: nothing runs");
    visible = true;
    loader.shown();
    await until(() => loader.state.status === "ready");
    assert.equal(loader.state.value, 1);
    for (let i = 0; i < 5; i++) loader.request();
    await sleep(25);
    loader.request({ immediate: true });
    await sleep(5);
    loader.request({ immediate: true });
    await until(() => loads >= 3 && loader.state.status === "ready", 2000);
    assert.equal(max, 1);
    loader.shown();
    await sleep(30);
    assert.ok(loads <= 3, "shown without a change does not reload");
    loader.dispose();
  });

  it("keeps the last value when a reload fails", async () => {
    let fail = false;
    const loader = new Loader<string>({
      isVisible: () => true,
      load: async () => {
        if (fail) throw new Error("boom");
        return "ok";
      },
    });
    await loader.reload();
    fail = true;
    const state = await loader.reload();
    assert.equal(state.status, "error");
    assert.equal(state.value, "ok");
    assert.equal(state.error, "boom");
    loader.dispose();
  });

  it("debounces", async () => {
    let calls = 0;
    const call = debounce(() => calls++, 10);
    call();
    call();
    call();
    await sleep(30);
    assert.equal(calls, 1);
    call();
    call.cancel();
    await sleep(20);
    assert.equal(calls, 1);
  });

  it("shows loading, retry, per-folder errors, and nothing when commands cannot run", () => {
    const base = {
      view: "health",
      availability: { available: true } as const,
      folders: [{ path: "/a", name: "a" }],
      loadingLabel: "Running opentide doctor…",
      nodes: (value: string[], folder: string, prefix: string) =>
        value.map((v) => ({ id: `${prefix}${folder}:${v}`, label: v })),
    };
    assert.equal(
      folderViewModel({ ...base, state: { status: "loading" } }).nodes[0]?.label,
      "Running opentide doctor…",
    );
    const error = folderViewModel({ ...base, state: { status: "error", error: "spawn failed" } });
    assert.equal(error.nodes[0]?.command?.command, "opentide.sidebar.refresh");
    assert.deepEqual(error.nodes[0]?.command?.args, ["health"]);
    assert.deepEqual(
      folderViewModel({
        ...base,
        availability: { available: false, code: "untrusted" },
        state: { status: "idle" },
      }).nodes,
      [],
    );
    const multi = folderViewModel({
      ...base,
      state: {
        status: "ready",
        value: [
          { folder: "/a", name: "a", value: ["x"] },
          { folder: "/b", name: "b", error: "no workspace" },
        ],
      },
    });
    assert.deepEqual(
      multi.nodes.map((n) => [n.label, n.children?.[0]?.label]),
      [
        ["a", "x"],
        ["b", "Did not load. Retry"],
      ],
    );
    const stale = folderViewModel({
      ...base,
      state: { status: "error", error: "x", value: [{ folder: "/a", name: "a", value: ["v"] }] },
    });
    assert.equal(stale.message, "The last refresh failed (x).");
    assert.equal(stale.nodes[0]?.label, "v");
  });
});

describe("sidebar: handovers", () => {
  it("creates a rule for an objective, an objective for a threat, else the generic flow", () => {
    const object = (type: string) =>
      ({ kind: "object", folder: "/r", uuid: "u1", type, name: "n", file: "/r/x.yaml" }) as const;
    assert.deepEqual(newObjectHandover(object("objective")), {
      command: "opentide.newObject.ruleForObjective",
      uuid: "u1",
    });
    assert.deepEqual(newObjectHandover(object("threat")), {
      command: "opentide.newObject.objectiveForThreat",
      uuid: "u1",
    });
    assert.deepEqual(newObjectHandover(object("rule")), { command: "opentide.newObject", folder: "/r" });
    assert.deepEqual(newObjectHandover({ kind: "technique", folder: "/r", id: "T1003" }), {
      command: "opentide.newObject.objective",
    });
    assert.deepEqual(newObjectHandover(undefined), { command: "opentide.newObject" });
  });
});
