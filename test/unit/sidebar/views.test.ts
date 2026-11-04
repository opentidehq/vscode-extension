import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ActivityEntry } from "../../../src/core/activity";
import { classify } from "../../../src/core/capabilities/classification";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { newObjectHandover, ruleHandover } from "../../../src/features/sidebar/actions";
import {
  activityNodes,
  ago,
  canRerun,
  duration,
  rerunPlan,
  runningCount,
} from "../../../src/features/sidebar/activity";
import { folderViewModel } from "../../../src/features/sidebar/folderView";
import {
  type DoctorCheck,
  fixArgv,
  healthNodes,
  parseChecks,
  planFix,
  redact,
  report,
  summarize,
  summaryText,
} from "../../../src/features/sidebar/health";
import { debounce, Loader } from "../../../src/features/sidebar/loader";
import { uniqueIds, walk } from "../../../src/features/sidebar/node";
import { platformFlag, platformName, platformToml } from "../../../src/features/sidebar/platformNames";
import {
  PRESENCE_PLACEHOLDER,
  parsePlatforms,
  platformNodes,
  presenceEnv,
  tenantCheck,
  tenantVariableNames,
  variableSource,
} from "../../../src/features/sidebar/platforms";
import { COMMANDS_FIXTURE, sleep, until } from "../helpers";

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

  it("counts credentials for info and doctor --offline by name, never with their values", () => {
    const env = presenceEnv({ AZURE_CLIENT_SECRET: "s3cr3t", SPLUNK_TOKEN: "tok" }, new Set());
    assert.deepEqual(env, { AZURE_CLIENT_SECRET: PRESENCE_PLACEHOLDER, SPLUNK_TOKEN: PRESENCE_PLACEHOLDER });
    assert.ok(!JSON.stringify(env).includes("s3cr3t"));
  });

  it("passes the env file's configuration to info and doctor --offline as it is", () => {
    const configuration = {
      OPENTIDE_REPO_ROOT: "/repo",
      OPENTIDE_DATA_ROOT: "/data",
      OPENTIDE_TIDE_WORKSPACE: "/repo/tide",
      OPENTIDE_PROXY: "http://proxy:3128",
      HTTPS_PROXY: "http://proxy:3128",
      https_proxy: "http://proxy:3128",
      NO_PROXY: "localhost",
      PYTHONUTF8: "1",
      SSL_CERT_FILE: "/ca.pem",
      REQUESTS_CA_BUNDLE: "/ca.pem",
    };
    const credentials = {
      AZURE_CLIENT_ID: "client-id",
      OPENTIDE_REPO_TOKEN: "ghp_x",
      OPENTIDE_PUSH_SSH_KEY: "-----BEGIN",
      OPENTIDE_SENTINEL_TENANT: "tenant-guid",
    };
    const env = presenceEnv(
      { ...configuration, ...credentials },
      new Set(["OPENTIDE_SENTINEL_TENANT"]), // a stored or tenant-listed name, whatever its prefix
    );
    assert.deepEqual(env, {
      ...configuration,
      ...Object.fromEntries(Object.keys(credentials).map((name) => [name, PRESENCE_PLACEHOLDER])),
    });
  });

  it("gives info and doctor --offline no secret under a configuration name or in a URL", () => {
    const env = presenceEnv(
      {
        OPENTIDE_PUSH_URL: "https://gitlab-ci-token:glpat-SECRET1@gitlab.example.com/d/c.git",
        HTTPS_PROXY: "http://alice:SECRET2@p:3128",
        https_proxy: "alice:SECRET3@p:3128",
        OPENTIDE_PROXY: "http://alice:SECRET4@p:3128",
        UV_INDEX_URL: "https://__token__:SECRET5@pypi.example.com/simple",
        UV_EXTRA_INDEX_URL: "https://a.example/simple https://u:SECRET6@b.example/simple",
        OPENTIDE_SPLUNK_PASS: "SECRET7",
        OPENTIDE_SENTINEL_CLIENT: "SECRET8",
        AZURE_CLIENT_SECRET: "SECRET9",
      },
      new Set(),
    );
    assert.ok(!Object.values(env).some((v) => v.includes("SECRET")), JSON.stringify(env));
    assert.equal(env.HTTPS_PROXY, "http://p:3128", "a proxy keeps its host, without its user and password");
    assert.equal(env.https_proxy, "p:3128");
    assert.equal(env.OPENTIDE_PROXY, "http://p:3128");
    assert.equal(env.UV_INDEX_URL, "https://pypi.example.com/simple");
    assert.equal(env.UV_EXTRA_INDEX_URL, "https://a.example/simple https://b.example/simple");
    assert.equal(env.OPENTIDE_PUSH_URL, PRESENCE_PLACEHOLDER, "the sharing remote is a credential");
    assert.equal(env.OPENTIDE_SPLUNK_PASS, PRESENCE_PLACEHOLDER);
    assert.equal(
      env.OPENTIDE_SENTINEL_CLIENT,
      PRESENCE_PLACEHOLDER,
      "an OPENTIDE_ name opentide does not read",
    );
  });

  it("names every tenant's credential variables, for the placeholders", () => {
    assert.deepEqual(tenantVariableNames(parsePlatforms(INFO)), ["AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]);
  });

  it("gives two tenants of one name distinct ids (a copied [[tenants]] block)", () => {
    const splunk = {
      name: "splunk",
      enabled: true,
      can_deploy: true,
      can_validate: true,
      can_query: true,
      tenants: [1, 2].map(() => ({
        name: "Prod Splunk",
        description: null,
        strategies: ["RELEASE"],
        manual: false,
        variables: [{ name: "SPLUNK_TOKEN", set: false }],
      })),
    };
    const ids: string[] = [];
    walk(platformNodes(parsePlatforms({ platforms: [splunk] }), new Set(), "/r"), (node) =>
      ids.push(node.id),
    );
    assert.equal(new Set(ids).size, ids.length, ids.join("\n"));
  });

  it("makes every id of a view unique, whatever a view model gives", () => {
    const leaf = (id: string) => ({ id, label: id });
    const nodes = uniqueIds([
      { ...leaf("a"), children: [leaf("a/x")] },
      { ...leaf("a"), children: [leaf("a/x")] },
      leaf("b"),
    ]);
    const ids: string[] = [];
    walk(nodes, (node) => ids.push(node.id));
    assert.deepEqual(ids, ["a", "a/x", "a#2", "a/x#2", "b"]);
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

  it("plans doctor's real fixes: confirm and --yes for writers, nothing for setup vscode", () => {
    const tree = CommandTree.parse(JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8")));
    const context = {
      pathOf: (argv: readonly string[]) => tree.commandPathOf(argv).path,
      classify,
      hasOption: (path: string, flag: string) => tree.hasOption(path, flag),
    };
    assert.deepEqual(
      planFix("opentide setup mcp --vscode (or --cursor, --claude-code, --generic)", context),
      {
        kind: "run",
        argv: ["setup", "mcp", "--vscode", "--yes"],
        confirm: true,
      },
    );
    assert.deepEqual(planFix("opentide setup platforms --sentinel (or another platform)", context), {
      kind: "run",
      argv: ["setup", "platforms", "--sentinel", "--yes"],
      confirm: true,
    });
    assert.equal(planFix("opentide setup vscode", context)?.kind, "replaced");
    assert.deepEqual(planFix("opentide doctor --offline", context), {
      kind: "run",
      argv: ["doctor", "--offline"],
      confirm: false,
    });
    assert.deepEqual(planFix("opentide doctor", context), { kind: "copy" }, "contacts tenants");
    assert.deepEqual(planFix("opentide frobnicate", context), { kind: "copy" }, "not in this opentide");
    assert.equal(planFix("git init ./", context), undefined);
    const [vscodeFix] = healthNodes(
      [
        {
          code: "vscode_settings",
          status: "skip",
          message: "no settings",
          fix: "opentide setup vscode",
          subject: null,
        },
      ],
      "/repo",
    );
    assert.equal(vscodeFix?.contextValue, "check.fix", "no play button for what the extension replaces");
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

  it("asks before running again a command that writes files or contacts a tenant", () => {
    const argv = ["setup", "ci", "github", "--staging", "--yes"];
    const setup = rerunPlan(classify(argv), `opentide --json ${argv.join(" ")}`);
    assert.equal(setup.kind, "confirm");
    assert.ok(setup.kind === "confirm" && setup.message.includes("writes files in the workspace"));
    assert.ok(setup.kind === "confirm" && setup.message.endsWith("setup ci github --staging --yes"));
    const live = rerunPlan(classify(["validate", "query", "--live", "--platform", "sentinel", "x"]), "q");
    assert.ok(live.kind === "confirm" && live.message.includes("contacts a tenant"));
    assert.deepEqual(rerunPlan(classify(["validate"]), "v"), { kind: "run" });
    assert.deepEqual(rerunPlan(classify(["deploy"]), "d"), { kind: "refuse" });
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
    // Ordered by events, not by wall-clock windows: each load runs until the test finishes it, and
    // `timersRan` waits for every timer the loader has due by now (Node runs timers of the same delay in
    // the order they were set, and the loader's immediate timer is set first).
    const timersRan = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    let visible = false;
    let concurrent = 0;
    let max = 0;
    const finishes: Array<() => void> = [];
    const loader = new Loader<number>({
      isVisible: () => visible,
      debounceMs: 20,
      load: () => {
        concurrent++;
        max = Math.max(max, concurrent);
        const load = finishes.length + 1;
        return new Promise<number>((resolve) =>
          finishes.push(() => {
            concurrent--;
            resolve(load);
          }),
        );
      },
    });
    const loads = () => finishes.length;
    /** Finish a load and let the loader settle (its follow-up load, if any, starts within the turn). */
    const finish = async (load: number) => {
      finishes[load - 1]?.();
      await timersRan();
    };

    loader.request();
    await sleep(40);
    assert.equal(loads(), 0, "hidden: nothing runs, however long it waits");
    visible = true;
    loader.shown();
    await until(() => loads() === 1);
    await finish(1);
    assert.deepEqual([loader.state.status, loader.state.value], ["ready", 1]);

    for (let i = 0; i < 5; i++) loader.request();
    // Debounced: a zero-delay timer set now runs first even on a stalled loop (Node runs expired timers
    // by expiry, and this test's continuation before the next one), so no load has started yet.
    await timersRan();
    assert.equal(loads(), 1, "debounced: no load starts before debounceMs");
    await until(() => loads() === 2);
    loader.request({ immediate: true });
    await timersRan();
    loader.request({ immediate: true });
    await timersRan();
    assert.equal(loads(), 2, "five requests make one load; two more while it runs wait for it");
    assert.equal(loader.state.status, "loading");
    await finish(2);
    assert.equal(loads(), 3, "the requests during load 2 make one more load, right after it");
    assert.equal(loader.state.status, "loading");
    await finish(3);
    assert.deepEqual([loads(), loader.state.status, loader.state.value], [3, "ready", 3]);
    assert.equal(max, 1, "one load at a time");

    loader.shown();
    await timersRan();
    assert.equal(loads(), 3, "shown without a change does not reload");
    assert.equal(loader.state.status, "ready");

    visible = false;
    loader.request();
    await timersRan();
    assert.equal(loads(), 3, "a change while hidden waits");
    visible = true;
    loader.shown();
    await until(() => loads() === 4);
    await finish(4);
    assert.deepEqual([loader.state.status, loader.state.value], ["ready", 4]);
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
      args: { uuid: "u1", folder: "/r" },
    });
    assert.deepEqual(newObjectHandover(object("threat")), {
      command: "opentide.newObject.objectiveForThreat",
      args: { uuid: "u1", folder: "/r" },
    });
    assert.deepEqual(newObjectHandover(object("rule")), { command: "opentide.newObject", folder: "/r" });
    // A coverage gap: the objective flow in the node's folder (an object, not a URI, which means --path).
    assert.deepEqual(newObjectHandover({ kind: "technique", folder: "/r", id: "T1003" }), {
      command: "opentide.newObject.objective",
      args: { folder: "/r" },
    });
    assert.deepEqual(newObjectHandover(undefined), { command: "opentide.newObject" });
  });
});

describe("sidebar: rule handovers", () => {
  const rule = {
    kind: "object",
    folder: "/r",
    uuid: "u1",
    type: "rule",
    name: "n",
    file: "/r/x.yaml",
  } as const;
  it("hands a rule to Run query and Preview Deploy as {uuid, folder}", () => {
    assert.deepEqual(ruleHandover(rule, "opentide.query.run"), {
      command: "opentide.query.run",
      args: { uuid: "u1", folder: "/r" },
    });
    assert.deepEqual(ruleHandover(rule, "opentide.deployPlan.open"), {
      command: "opentide.deployPlan.open",
      args: { uuid: "u1", folder: "/r" },
    });
  });
  it("hands nothing over for other nodes", () => {
    assert.equal(ruleHandover({ ...rule, type: "objective" }, "opentide.query.run"), undefined);
    assert.equal(
      ruleHandover({ kind: "technique", folder: "/r", id: "T1003" }, "opentide.query.run"),
      undefined,
    );
    assert.equal(ruleHandover(undefined, "opentide.query.run"), undefined);
  });
});
