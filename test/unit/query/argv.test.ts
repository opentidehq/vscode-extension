import * as assert from "node:assert/strict";
import {
  clampLimit,
  isDuration,
  queryArgv,
  sourceKey,
  tenantChoices,
  validateLiveArgv,
  windowLabel,
} from "../../../src/features/query/argv";
import { failureAction } from "../../../src/features/query/panel";

describe("query argv (#17)", () => {
  it("runs a rule's query by file, with tenants, window and limit", () => {
    assert.deepEqual(
      queryArgv({
        platform: "sentinel",
        source: { kind: "rule", file: "objects/rules/x.yaml", uuid: "u-1", name: "X" },
        tenants: ["prod", "dev"],
        window: { kind: "since", since: "7d" },
        limit: 100,
      }),
      [
        "query",
        "--platform",
        "sentinel",
        "--tenant",
        "prod",
        "--tenant",
        "dev",
        "--file",
        "objects/rules/x.yaml",
        "--since",
        "7d",
        "--limit",
        "100",
      ],
    );
  });

  it("runs a catalogue rule by UUID, a query file, and text after --", () => {
    const base = {
      platform: "elastic",
      window: { kind: "range", from: "2026-11-01T00:00:00Z" } as const,
      limit: 9000,
    };
    assert.deepEqual(queryArgv({ ...base, source: { kind: "rule", uuid: "u-1", name: "X" } }).slice(3, 5), [
      "--rule",
      "u-1",
    ]);
    assert.deepEqual(
      queryArgv({
        ...base,
        source: { kind: "query-file", path: "/w/q.eql", name: "q.eql" },
        language: "eql",
      }),
      [
        "query",
        "--platform",
        "elastic",
        "--query-file",
        "/w/q.eql",
        "--from",
        "2026-11-01T00:00:00Z",
        "--limit",
        "5000",
        "--language",
        "eql",
      ],
    );
    const text = queryArgv({
      ...base,
      platform: "splunk",
      source: { kind: "text", text: "-x", name: "q" },
      language: "eql",
    });
    assert.deepEqual(text.slice(-2), ["--", "-x"]);
    assert.ok(!text.includes("--language"), "--language is Elastic only");
  });

  it("never sends a tenant flag when none was picked, so opentide picks the only one", () => {
    const argv = queryArgv({
      platform: "splunk",
      source: { kind: "rule", file: "r.yaml", name: "r" },
      window: { kind: "since", since: "24h" },
      limit: 100,
    });
    assert.ok(!argv.includes("--tenant"));
  });

  it("validates live by UUID, else by file", () => {
    assert.deepEqual(validateLiveArgv("splunk", { file: "r.yaml", uuid: "u" }), [
      "validate",
      "query",
      "--live",
      "--platform",
      "splunk",
      "--uuid",
      "u",
    ]);
    assert.deepEqual(validateLiveArgv("splunk", { file: "r.yaml" }).slice(-2), ["--file", "r.yaml"]);
    assert.throws(() => validateLiveArgv("splunk", {}));
  });

  it("reads the CLI's exit-2 tenant choices (captured from opentide 0.21.0)", () => {
    const document = {
      platform: "splunk",
      choices: ["prod", "dev", "all"],
      exit_code: 2,
      failure: { code: "usage_invalid_value", argument: "--tenant" },
    };
    assert.deepEqual(tenantChoices(document), ["prod", "dev", "all"]);
    assert.equal(tenantChoices({ ...document, exit_code: 1 }), undefined);
    assert.equal(tenantChoices({ ...document, failure: { argument: "--platform" } }), undefined);
    assert.deepEqual(failureAction("usage_invalid_value", "--tenant"), { action: "Configure tenants…" });
    assert.equal(failureAction("command_failed", null), undefined);
  });

  it("checks durations and limits, and labels windows", () => {
    for (const ok of ["15m", "24h", "7d", "PT1H", "P1D"]) assert.ok(isDuration(ok), ok);
    for (const bad of ["", "yesterday", "24", "P"]) assert.ok(!isDuration(bad), bad);
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(12000), 5000);
    assert.equal(clampLimit(Number.NaN), 100);
    assert.equal(windowLabel({ kind: "since", since: "24h" }), "last 24h");
    assert.equal(windowLabel({ kind: "range", from: "a" }), "a → now");
  });

  it("keys a panel by platform and query", () => {
    assert.notEqual(
      sourceKey("sentinel", { kind: "rule", file: "r.yaml", name: "r" }),
      sourceKey("splunk", { kind: "rule", file: "r.yaml", name: "r" }),
    );
  });
});
