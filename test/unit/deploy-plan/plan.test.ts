import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { cancelledEnvelope } from "../../../src/core/backend/types";
import {
  assertDryRun,
  ciStep,
  ciVariables,
  DeployPlanner,
  type DeployPlanOptions,
  deployCommand,
  dryRunArgv,
  dryRunCommand,
  neededVariables,
} from "../../../src/features/deploy-plan/argv";
import { deployPanelTitle, parseTargetArgs, targetKey } from "../../../src/features/deploy-plan/index";
import { deployedRequest, payloadDocuments, planView } from "../../../src/features/deploy-plan/plan";
import {
  cancelledState,
  type DeployPanelState,
  hostValidators,
  noPlanBox,
  withoutPlan,
} from "../../../src/features/deploy-plan/protocol";
import { parsePlatforms } from "../../../src/features/sidebar/platforms";
import { ROOT } from "../helpers";

/** `opentide --json deploy --dry-run --strategy PREVIEW --all` from opentide 0.21.0 (captured). */
const REAL = JSON.parse(
  readFileSync(path.join(ROOT, "test", "fixtures", "panels", "deploy-dry-run.json"), "utf8"),
);

const every: DeployPlanOptions[] = [];
for (const strategies of [["PREVIEW"], ["RELEASE"], ["PREVIEW", "RELEASE"], []] as const)
  for (const scope of [
    { kind: "changed" },
    { kind: "all" },
    { kind: "selected", uuids: ["u-1"], files: ["objects/rules/a.yaml"] },
  ] as const)
    for (const platform of [undefined, "sentinel"])
      every.push({ strategies, scope, ...(platform ? { platform } : {}) });

describe("deploy plan (#18)", () => {
  it("only ever runs deploy --dry-run, for every choice the panel offers (D6)", async () => {
    const sent: (readonly string[])[] = [];
    const planner = new DeployPlanner(async (_folder: string, argv: readonly string[], _extra: undefined) => {
      sent.push(argv);
      return argv;
    });
    for (const options of every) await planner.plan("/w", options, undefined);
    assert.equal(sent.length, every.length);
    for (const argv of sent) {
      assert.equal(argv[0], "deploy");
      assert.equal(argv[1], "--dry-run");
      assert.ok(!argv.includes("migrate-state"));
    }
  });

  it("refuses an argv without --dry-run", () => {
    assert.throws(() => assertDryRun(["deploy", "--strategy", "PREVIEW"]), /only previews/);
    assert.throws(() => assertDryRun(["deploy", "migrate-state", "--dry-run"]));
    assert.throws(() => assertDryRun(["query", "--dry-run"]));
    assert.doesNotThrow(() => assertDryRun(["deploy", "--dry-run"]));
  });

  it("builds the dry run, the deploy command to copy, and the CI step", () => {
    const options: DeployPlanOptions = {
      strategies: ["RELEASE"],
      scope: { kind: "selected", uuids: ["u-1"], files: ["objects/rules/my rule.yaml"] },
      platform: "splunk",
    };
    assert.deepEqual(dryRunArgv(options), [
      "deploy",
      "--dry-run",
      "--strategy",
      "RELEASE",
      "--uuid",
      "u-1",
      "--file",
      "objects/rules/my rule.yaml",
      "--platform",
      "splunk",
    ]);
    assert.equal(
      deployCommand(options),
      "opentide deploy --strategy RELEASE --uuid u-1 --file 'objects/rules/my rule.yaml' --platform splunk",
    );
    assert.ok(!deployCommand(options).includes("--dry-run"));
    assert.equal(
      dryRunCommand({ strategies: ["PREVIEW"], scope: { kind: "all" } }),
      "opentide deploy --dry-run --strategy PREVIEW --all",
    );
    assert.equal(
      ciStep({ strategies: ["PREVIEW"], scope: { kind: "changed" } }, ["SPLUNK_TOKEN"]),
      `- name: Deploy detections (PREVIEW)\n  run: |\n    opentide deploy --strategy PREVIEW\n  env:\n    SPLUNK_TOKEN: \${{ secrets.SPLUNK_TOKEN }}\n`,
    );
    // ` #` starts a YAML comment and `: ` a mapping in a plain scalar: the block scalar keeps both.
    const tricky = {
      strategies: ["PREVIEW" as const],
      scope: { kind: "selected" as const, uuids: [], files: ["objects/rules/lsass #2: v2.yaml"] },
    };
    const step = ciStep(tricky).split("\n");
    assert.equal(step[1], "  run: |");
    assert.equal(step[2], `    ${deployCommand(tricky)}`);
    assert.ok(deployCommand(tricky).includes("'objects/rules/lsass #2: v2.yaml'"));
    assert.deepEqual(dryRunArgv({ strategies: [], scope: { kind: "changed" } }), [
      "deploy",
      "--dry-run",
      "--strategy",
      "PREVIEW",
    ]);
  });

  it("reads the variables a real deploy needs from the plan's warnings", () => {
    assert.deepEqual(neededVariables(REAL.warnings), ["SPLUNK_TOKEN"]);
    assert.deepEqual(neededVariables(["sentinel has no tenants configured"]), []);
  });

  it("names every secret of the tenants the plan deploys to in the CI step, set here or not", () => {
    const tenant = (name: string, strategies: string[], variables: string[]) => ({
      name,
      strategies,
      manual: false,
      variables: variables.map((v) => ({ name: v, set: v === "SPLUNK_HOST" })),
    });
    // `opentide --json info` with tenants (opentide#754): the splunk tenants the plan names, and a
    // sentinel tenant only for RELEASE.
    const info = parsePlatforms({
      platforms: [
        {
          name: "splunk",
          enabled: true,
          tenants: [
            tenant("prod", ["PREVIEW"], ["SPLUNK_HOST", "SPLUNK_TOKEN"]),
            tenant("dev", ["PREVIEW"], ["SPLUNK_DEV_TOKEN"]),
            tenant("lab", ["PREVIEW"], ["SPLUNK_LAB_TOKEN"]),
          ],
        },
        { name: "sentinel", enabled: true, tenants: [tenant("prod", ["RELEASE"], ["AZURE_CLIENT_SECRET"])] },
      ],
    });
    const plan = planView(REAL);
    const preview: DeployPlanOptions = { strategies: ["PREVIEW"], scope: { kind: "all" } };
    // The warning names only SPLUNK_TOKEN (the unset one); SPLUNK_HOST is set here but CI needs it too,
    // and the `lab` tenant is not in the plan.
    assert.deepEqual(ciVariables(preview, info, plan.platforms, plan.warnings), [
      "SPLUNK_DEV_TOKEN",
      "SPLUNK_HOST",
      "SPLUNK_TOKEN",
    ]);
    // With no plan yet: each tenant whose strategies include the deploy's.
    const release: DeployPlanOptions = { strategies: ["RELEASE"], scope: { kind: "all" } };
    assert.deepEqual(ciVariables(release, info, [], []), ["AZURE_CLIENT_SECRET"]);
    assert.deepEqual(ciVariables({ ...preview, platform: "splunk" }, info, [], []), [
      "SPLUNK_DEV_TOKEN",
      "SPLUNK_HOST",
      "SPLUNK_LAB_TOKEN",
      "SPLUNK_TOKEN",
    ]);
    // An opentide whose info lists no tenants: the warnings, as before.
    assert.deepEqual(
      ciVariables(
        preview,
        parsePlatforms({ platforms: [{ name: "splunk" }] }),
        plan.platforms,
        plan.warnings,
      ),
      ["SPLUNK_TOKEN"],
    );
  });

  it("keeps the plan shown when a re-run is cancelled, and stops saying Planning after a cancelled first run", () => {
    const plan = planView(REAL);
    const running: DeployPanelState = {
      phase: "running",
      locked: false,
      folder: "/repo",
      folderName: "repo",
      platformLabels: { splunk: "Splunk" },
      strategies: ["PREVIEW"],
      scope: "all",
      platform: null,
      selection: null,
      canSelect: true,
      focus: [],
      platforms: ["splunk"],
      argvDisplay: "opentide --json deploy --dry-run --all",
      dryRunCommand: "",
      deployCommand: "",
      plan,
      failure: null,
      progress: "splunk 1/2",
      note: null,
      startedAt: 0,
      durationMs: null,
    };
    // Retargeted to other rules, then cancelled: no plan of the previous rules under the new title.
    const retargeted = cancelledState(withoutPlan(running), 300);
    assert.equal(retargeted.plan, null);
    assert.equal(noPlanBox(retargeted).title, "Cancelled");
    assert.equal(withoutPlan({ ...running, failure: { code: "x", message: "y" } }).failure, null);
    const cancelled = cancelledState(running, 1200);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.plan, plan, "the previous plan, not the cancelled envelope's empty one");
    assert.equal(cancelled.durationMs, 1200);
    assert.equal(cancelled.progress, null);
    // The cancelled envelope has no payloads: replacing them with it would empty the payload documents.
    assert.equal(payloadDocuments(cancelledEnvelope("deploy")).size, 0);
    assert.ok(payloadDocuments(REAL).size > 0);
    const first = cancelledState({ ...running, plan: null }, 300);
    assert.equal(noPlanBox(first).kind, "info", "a cancelled first run is not still planning");
    assert.equal(noPlanBox(running).kind, "loading");
  });

  it("matches opentide's changes: platform → tenant → rule → action, with counts", () => {
    const plan = planView(REAL);
    assert.equal(plan.message, REAL.message);
    assert.deepEqual(
      plan.platforms.map((p) => p.platform),
      ["splunk", "sentinel"],
    );
    const splunk = plan.platforms[0];
    assert.deepEqual(
      splunk?.tenants.map((t) => [t.tenant, t.changes.map((c) => [c.name, c.action, c.status])]),
      [
        ["prod", [["Suspicious LSASS Access 0", "upsert", "STAGING"]]],
        ["dev", [["Suspicious LSASS Access 0", "upsert", "STAGING"]]],
      ],
    );
    const sentinel = plan.platforms[1];
    assert.equal(sentinel?.tenants[0]?.tenant, null, "no tenant configured yet");
    assert.equal(sentinel?.missingTenants, ".opentide/configurations/platforms/sentinel.toml");
    assert.equal(plan.counts.upsert, REAL.summary.upsert);
    assert.equal(
      plan.platforms.flatMap((p) => p.tenants.flatMap((t) => t.changes)).length,
      REAL.changes.length,
      "every change of the document is shown",
    );
    assert.deepEqual(
      plan.skipped.map((s) => [s.rule, s.status, s.strategy]),
      [["Suspicious LSASS Access 1", "DESIGN", "INERT"]],
    );
  });

  it("opens every payload as a document", () => {
    const plan = planView(REAL);
    const documents = payloadDocuments(REAL);
    const rows = plan.platforms.flatMap((p) => p.payloads);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.hasRequest);
      assert.ok(documents.get(row.key)?.request, row.key);
      assert.equal(row.hasDeployed, false, "0.21.0 plans carry no deployed state");
    }
  });

  it("shows compile failures, diagnostics and unmatched selections", () => {
    const plan = planView({
      ok: false,
      exit_code: 1,
      message: "1 rule would fail",
      changes: [
        {
          platform: "sentinel",
          tenant: "prod",
          uuid: "u",
          name: "R",
          status: "STAGING",
          action: "create",
          fails: true,
        },
      ],
      payloads: {
        sentinel: [
          {
            uuid: "u",
            name: "R",
            api_request: null,
            status: "failed",
            code: "compile_missing_field",
            error: "no grouping",
            help: "add grouping",
          },
        ],
      },
      diagnostics: [
        {
          code: "compile_missing_field",
          severity: "error",
          message: "no grouping",
          help: "add grouping",
          path: "objects/rules/r.yaml",
          file_path: "/w/objects/rules/r.yaml",
          platform: "sentinel",
          uuid: "u",
          name: "R",
        },
      ],
      unmatched: ["nope.yaml"],
      failure: { code: "command_failed", message: "1 rule would fail" },
    });
    assert.equal(plan.counts.create, 0, "a failing rule is not counted");
    assert.equal(plan.platforms[0]?.payloads[0]?.failed, true);
    assert.equal(plan.platforms[0]?.payloads[0]?.hasRequest, false);
    assert.equal(plan.diagnostics[0]?.filePath, "/w/objects/rules/r.yaml");
    assert.deepEqual(plan.unmatched, ["nope.yaml"]);
    assert.equal(plan.failure?.code, "command_failed");
  });

  it("diffs against what is deployed when a payload carries it", () => {
    assert.deepEqual(deployedRequest({ deployed_request: { a: 1 } }), { a: 1 });
    assert.equal(deployedRequest({ api_request: {} }), undefined);
    const documents = payloadDocuments({
      payloads: { splunk: [{ uuid: "u", name: "R", api_request: { b: 2 }, deployed: { b: 1 } }] },
    });
    assert.deepEqual(documents.get("splunk/u")?.deployed, { b: 1 });
  });

  it("parses the command's arguments", () => {
    const uri = (p: string) => ({ fsPath: p, scheme: "file" });
    assert.deepEqual(parseTargetArgs(uri("/w/a.yaml"), [uri("/w/a.yaml"), uri("/w/b.yaml")]).uris, [
      "/w/a.yaml",
      "/w/b.yaml",
    ]);
    assert.deepEqual(parseTargetArgs(uri("/w/a.yaml"), undefined).uris, ["/w/a.yaml"]);
    assert.deepEqual(parseTargetArgs({ uuid: "u", folder: "/w" }, undefined), {
      uris: [],
      uuids: ["u"],
      files: [],
      folder: "/w",
    });
    assert.deepEqual(parseTargetArgs(undefined, undefined), { uris: [], uuids: [], files: [] });
  });

  it("validates the webview's run requests", () => {
    assert.ok(hostValidators.run({ strategies: ["PREVIEW"], scope: "all", platform: null }));
    assert.ok(!hostValidators.run({ strategies: ["PRODUCTION"], scope: "all", platform: null }));
    assert.ok(!hostValidators.run({ strategies: [], scope: "all", platform: null }));
    assert.ok(!hostValidators.run({ strategies: ["PREVIEW"], scope: "everything", platform: null }));
    assert.ok(!hostValidators.run({ strategies: ["PREVIEW"], scope: "all", platform: "x; rm" }));
    assert.ok(hostValidators.copy("ci"));
    assert.ok(!hostValidators.copy("deployNow"));
  });
});

describe("deploy plan: one panel per kind, retargeted to the rules asked for", () => {
  it("keys a preview by its folder and rules, in any order", () => {
    const a = targetKey({ folder: "/r", uuids: ["B", "a"], files: ["objects/rules/x.yaml"] });
    const b = targetKey({ folder: "/r", uuids: ["a", "b"], files: ["objects/rules/x.yaml"] });
    assert.equal(a, b);
    assert.notEqual(targetKey({ folder: "/r", uuids: [], files: [] }), a);
    assert.notEqual(
      targetKey({ folder: "/other", uuids: [], files: [] }),
      targetKey({ folder: "/r", uuids: [], files: [] }),
    );
  });

  it("names the rules in the tab title", () => {
    assert.equal(deployPanelTitle(null), "Deploy Plan");
    assert.equal(
      deployPanelTitle("Suspicious LSASS access by an unsigned binary"),
      "Deploy Plan · Suspicious LSASS access by…",
    );
    assert.equal(deployPanelTitle("3 rules"), "Deploy Plan · 3 rules");
  });

  it("validates the lock toggle", () => {
    assert.equal(hostValidators.lock(true), true);
    assert.equal(hostValidators.lock("yes"), false);
  });
});
