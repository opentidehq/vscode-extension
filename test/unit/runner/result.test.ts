import * as assert from "node:assert/strict";
import * as path from "node:path";
import { cancelledEnvelope, type Envelope } from "../../../src/core/backend/types";
import { ProgressModel } from "../../../src/features/runner/progress";
import {
  changedFiles,
  commandLabel,
  explainCodes,
  isExplainable,
  renderDocument,
  resultPath,
  summarize,
} from "../../../src/features/runner/result";
import { RESULT_LIMIT, ResultStore } from "../../../src/features/runner/resultStore";
import { describeReach, missingVariables, reachOf } from "../../../src/features/runner/tenants";

const envelope = (extra: Partial<Envelope> = {}): Envelope => ({
  ok: true,
  status: "completed",
  message: "501 objects checked",
  schema_version: 1,
  command: "validate",
  duration_ms: 3,
  exit_code: 0,
  summary: {},
  next_actions: [],
  failure: null,
  ...extra,
});

describe("runner results", () => {
  it("summarises success, issues, failure and cancellation in one line", () => {
    const argvDisplay = "opentide --json validate";
    assert.deepEqual(summarize({ document: envelope(), exitCode: 0, cancelled: false, argvDisplay }), {
      level: "info",
      text: "opentide validate: 501 objects checked",
    });
    assert.equal(
      summarize({ document: envelope({ status: "issues" }), exitCode: 0, cancelled: false, argvDisplay })
        .level,
      "warning",
    );
    const failed = summarize({
      document: envelope({
        ok: false,
        status: "failed",
        message: "no workspace",
        exit_code: 1,
        failure: { code: "workspace_not_found", message: "no workspace" },
      }),
      exitCode: 1,
      cancelled: false,
      argvDisplay,
    });
    assert.deepEqual(failed, {
      level: "error",
      text: "opentide validate failed (exit 1, workspace_not_found): no workspace",
      failureCode: "workspace_not_found",
    });
    assert.equal(
      summarize({ document: cancelledEnvelope("validate"), exitCode: 130, cancelled: true, argvDisplay })
        .text,
      "opentide validate: cancelled",
    );
    const long = summarize({
      document: envelope({ message: "x".repeat(500) }),
      exitCode: 0,
      cancelled: false,
      argvDisplay,
    });
    assert.ok(long.text.length <= 200 && long.text.endsWith("…"));
  });

  it("keeps the document exactly, and names its virtual path after the command", () => {
    const document = envelope({ extra: { nested: [1, 2] } });
    assert.deepEqual(JSON.parse(renderDocument(document)), document);
    assert.equal(resultPath(7, "opentide --json validate query --file 'a b.yaml'"), "/7/validate-query.json");
    assert.equal(resultPath(8, "opentide --json --debug"), "/8/result.json");
    assert.equal(commandLabel("opentide --json lint --fix"), "opentide lint --fix");
  });

  it("knows which failure codes explain explains", () => {
    const codes = explainCodes({ codes: [{ code: "vocab_unknown" }, { code: 3 }, {}] });
    assert.deepEqual([...codes], ["vocab_unknown"]);
    assert.ok(isExplainable("vocab_unknown", codes));
    assert.ok(!isExplainable("cancelled", codes));
    assert.ok(!isExplainable(undefined, codes));
    assert.equal(explainCodes(null).size, 0);
  });

  it("lists the files a writing run changed, inside the folder only", () => {
    const folder = path.resolve("/ws");
    assert.deepEqual(
      changedFiles(folder, [
        path.join(folder, "objects", "rules", "b.yaml"),
        path.join(folder, "objects", "rules", "a.yaml"),
        path.join(folder, "objects", "rules", "a.yaml"),
        path.join(folder, ".git", "index"),
        path.join(folder, ".opentide", "lsp", "cache.json"),
        path.resolve("/elsewhere/x.yaml"),
      ]),
      ["objects/rules/a.yaml", "objects/rules/b.yaml"],
    );
  });

  it("keeps the newest documents and the last result", () => {
    const store = new ResultStore(2);
    const fired: string[] = [];
    store.onDidChange((p) => fired.push(p));
    store.set("/1/a.json", "a");
    store.set("/2/explain.md", "b", false);
    assert.equal(store.lastResult, "/1/a.json");
    store.set("/3/c.json", "c");
    assert.equal(store.get("/1/a.json"), undefined, "the oldest went");
    assert.equal(store.get("/3/c.json"), "c");
    assert.equal(store.lastResult, "/3/c.json");
    assert.deepEqual(fired, ["/1/a.json", "/2/explain.md", "/3/c.json"]);
    const first = store.id();
    assert.equal(store.id(), first + 1);
    assert.ok(RESULT_LIMIT >= 10);
  });
});

describe("runner progress", () => {
  it("moves the bar forward only, with a message per step and tenant", () => {
    const model = new ProgressModel();
    assert.deepEqual(model.report({ event: "progress", step: "schemas", done: 3, total: 6 }), {
      message: "schemas 3/6",
      increment: 50,
    });
    assert.deepEqual(model.report({ event: "progress", step: "objects", done: 1, total: 6 }), {
      message: "objects 1/6",
    });
    assert.deepEqual(model.report({ event: "progress", step: "done", done: 6, total: 6 }), {
      message: "done 6/6",
      increment: 50,
    });
    assert.deepEqual(model.report({ event: "progress", step: "load" }), { message: "load" });
    assert.deepEqual(
      model.report({
        event: "tenant",
        platform: "sentinel",
        tenant: "prod",
        status: "ok",
        rows: 120,
        elapsed_ms: 1800,
      }),
      { message: "sentinel/prod: 120 rows, 1800 ms" },
    );
    assert.deepEqual(model.report({ event: "tenant", platform: "splunk", tenant: "dev", status: "failed" }), {
      message: "splunk/dev: failed",
    });
    assert.equal(model.report({ event: "log", text: "x" }), undefined);
  });
});

describe("runner tenants", () => {
  const info = {
    platforms: [
      {
        name: "sentinel",
        enabled: true,
        tenants: [
          {
            name: "prod",
            description: "Production",
            variables: [
              { name: "AZURE_CLIENT_ID", set: true },
              { name: "AZURE_CLIENT_SECRET", set: false },
            ],
          },
          { name: "dev", variables: [{ name: "DEV_TOKEN", set: false }] },
        ],
      },
      { name: "splunk", enabled: false, tenants: [] },
      { name: "elastic", enabled: true },
    ],
  };

  it("reads the enabled platforms, or the ones the argv names", () => {
    const enabled = reachOf(info);
    assert.deepEqual(
      enabled.map((r) => r.platform),
      ["sentinel", "elastic"],
    );
    assert.equal(enabled[1]?.tenants, undefined, "an opentide without tenants in info");
    assert.deepEqual(
      reachOf(info, ["splunk"]).map((r) => r.platform),
      ["splunk"],
    );
    assert.deepEqual(reachOf({ nope: true }), []);
  });

  it("names platforms and tenants for the confirmation", () => {
    assert.equal(describeReach(reachOf(info)), "sentinel (prod, dev) · elastic");
    assert.equal(describeReach(reachOf(info, ["splunk"])), "splunk (no tenants configured)");
    assert.equal(describeReach([], ["crowdstrike"]), "crowdstrike");
    assert.equal(describeReach([]), "the enabled platforms");
  });

  it("finds the credentials nothing sets", () => {
    const reach = reachOf(info);
    assert.deepEqual(missingVariables(reach, new Set(), {}), ["AZURE_CLIENT_SECRET", "DEV_TOKEN"]);
    assert.deepEqual(missingVariables(reach, new Set(["DEV_TOKEN"]), { AZURE_CLIENT_SECRET: "x" }), []);
  });
});
