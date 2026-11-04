import * as assert from "node:assert/strict";
import { type LensTarget, lensesFor, tenantPhrase } from "../../../src/features/query/lenses";
import {
  fallbackCaps,
  missingVariables,
  type PlatformCaps,
  PlatformInfoCache,
  parseInfoPlatforms,
} from "../../../src/features/query/platforms";

// `opentide --json info` 0.21.0 (no tenants) and with opentide#754's tenants.
const INFO_021 = {
  platforms: [
    { name: "sentinel", enabled: true, can_deploy: true, can_validate: true, can_query: true },
    { name: "crowdstrike", enabled: false, can_deploy: true, can_validate: false, can_query: true },
    { name: "sysdig", enabled: false, can_deploy: true, can_validate: false, can_query: false },
  ],
};
const INFO_TENANTS = {
  platforms: [
    {
      name: "splunk",
      enabled: true,
      can_deploy: true,
      can_validate: true,
      can_query: true,
      tenants: [
        {
          name: "prod",
          description: "Production",
          strategies: ["RELEASE"],
          manual: false,
          variables: [
            { name: "SPLUNK_TOKEN", set: false },
            { name: "SPLUNK_URL", set: true },
          ],
        },
        { name: "dev", description: "", strategies: ["PREVIEW", "RELEASE"], manual: true, variables: [] },
      ],
    },
  ],
};

const target = (over: Partial<LensTarget> = {}): LensTarget => ({
  uri: "file:///w/objects/rules/r.yaml",
  range: { start: { line: 4, character: 6 }, end: { line: 6, character: 0 } },
  platform: "sentinel",
  language: "kql",
  kind: "rule",
  ...over,
});

describe("platform caps and query lenses (#17)", () => {
  it("reads can_query and can_validate, without tenants on 0.21.0", () => {
    const caps = parseInfoPlatforms(INFO_021);
    assert.equal(caps?.get("sentinel")?.canQuery, true);
    assert.equal(caps?.get("sysdig")?.canQuery, false);
    assert.equal(caps?.get("crowdstrike")?.canValidate, false);
    assert.equal(caps?.get("sentinel")?.tenants, undefined);
    assert.equal(parseInfoPlatforms({ ok: false }), undefined);
  });

  it("reads tenants and the variables each still needs", () => {
    const splunk = parseInfoPlatforms(INFO_TENANTS)?.get("splunk");
    assert.deepEqual(
      splunk?.tenants?.map((t) => t.name),
      ["prod", "dev"],
    );
    const prod = splunk?.tenants?.[0];
    assert.ok(prod);
    assert.deepEqual(missingVariables(prod, new Set()), ["SPLUNK_TOKEN"]);
    assert.deepEqual(missingVariables(prod, new Set(["SPLUNK_TOKEN"])), []);
  });

  it("falls back to the capability matrix", () => {
    assert.equal(fallbackCaps("sysdig").canQuery, false);
    assert.equal(fallbackCaps("harfanglab").canValidate, false);
    assert.equal(fallbackCaps("unknown").canQuery, false);
  });

  it("loads info once per folder, and again after invalidate or a failure", async () => {
    let runs = 0;
    let fail = true;
    const cache = new PlatformInfoCache({
      run: async () => {
        runs++;
        if (fail) throw new Error("no runtime");
        return { document: INFO_021, exitCode: 0 };
      },
    });
    assert.equal((await cache.caps("/w", "sysdig")).canQuery, false, "fallback when info fails");
    await new Promise((r) => setImmediate(r));
    fail = false;
    await cache.get("/w");
    await cache.get("/w");
    assert.equal(runs, 2);
    cache.invalidate("/w");
    await cache.get("/w");
    assert.equal(runs, 3);
  });

  it("offers Run, Validate live and Compiled query on a Sentinel rule", () => {
    const caps: PlatformCaps = { ...fallbackCaps("sentinel"), tenants: undefined };
    const lenses = lensesFor(target(), { canRun: true, caps });
    assert.deepEqual(
      lenses.map((l) => [l.command, l.title]),
      [
        ["opentide.query.run", "$(globe) Run on Sentinel…"],
        ["opentide.query.validateLive", "$(globe) Validate live"],
        ["opentide.query.showCompiled", "$(file-code) Compiled query"],
      ],
    );
  });

  it("names the tenant, or asks, when info lists tenants", () => {
    const one = parseInfoPlatforms({
      platforms: [{ ...INFO_TENANTS.platforms[0], tenants: [INFO_TENANTS.platforms[0]?.tenants[0]] }],
    });
    const lens = lensesFor(target({ platform: "splunk", language: "spl" }), {
      canRun: true,
      caps: one?.get("splunk"),
    });
    assert.equal(lens[0]?.title, "$(globe) Run on prod");
    const live = lens.find((l) => l.command === "opentide.query.validateLive");
    assert.equal(
      live?.title,
      "$(globe) Validate live on prod",
      "a run that contacts tenants names them (P5)",
    );
    assert.match(live?.tooltip ?? "", /sends this rule's Splunk query to prod/);
    const two = parseInfoPlatforms(INFO_TENANTS)?.get("splunk");
    assert.equal(
      lensesFor(target({ platform: "splunk", language: "spl" }), { canRun: true, caps: two })[0]?.title,
      "$(globe) Run on Splunk tenants…",
    );
    const none = { ...fallbackCaps("splunk"), tenants: [] };
    const empty = lensesFor(target({ platform: "splunk", language: "spl" }), { canRun: true, caps: none });
    assert.equal(empty[0]?.command, "opentide.query.configureTenant");
    assert.ok(
      !empty.some((l) => l.command === "opentide.query.validateLive"),
      "no tenant: nothing to validate on",
    );
  });

  it("gives Sysdig no run button, CrowdStrike no validate, and query files no live validation", () => {
    assert.deepEqual(
      lensesFor(target({ platform: "sysdig", language: "falco" }), {
        canRun: true,
        caps: fallbackCaps("sysdig"),
      }),
      [],
    );
    const crowdstrike = lensesFor(target({ platform: "crowdstrike", language: "cql" }), {
      canRun: true,
      caps: fallbackCaps("crowdstrike"),
    });
    assert.deepEqual(
      crowdstrike.map((l) => l.command),
      ["opentide.query.run"],
    );
    const file = lensesFor(target({ kind: "query-file", platform: "splunk", language: "spl" }), {
      canRun: true,
      caps: fallbackCaps("splunk"),
    });
    assert.deepEqual(
      file.map((l) => l.command),
      ["opentide.query.run", "opentide.query.showCompiled"],
    );
  });

  it("says Kuery writes preview alerts", () => {
    const [run] = lensesFor(target({ platform: "elastic", language: "kuery" }), {
      canRun: true,
      caps: fallbackCaps("elastic"),
    });
    assert.match(run?.title ?? "", /writes preview alerts/);
    assert.match(run?.tooltip ?? "", /preview index/);
  });

  it("keeps only the compiled lens when commands cannot run (Restricted Mode)", () => {
    assert.deepEqual(
      lensesFor(target(), { canRun: false }).map((l) => l.command),
      ["opentide.query.showCompiled"],
    );
  });

  it("never puts a lens on the rule's UUID: lenses sit on the query's range only", () => {
    for (const lens of lensesFor(target(), { canRun: true, caps: fallbackCaps("sentinel") }))
      assert.deepEqual(lens.range, target().range);
  });

  it("phrases tenants", () => {
    assert.equal(tenantPhrase(["prod"]), "prod");
    assert.equal(tenantPhrase(["prod", "dev"]), "prod and dev");
    assert.equal(tenantPhrase(["a", "b", "c"]), "3 tenants");
  });
});
