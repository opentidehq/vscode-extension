// The runner's logic over the real backend and the fake opentide: explainable codes, the tenants a command
// reaches, and the credentials they need.
import * as assert from "node:assert/strict";
import { Backend } from "../../../src/core/backend/backend";
import { classify } from "../../../src/core/capabilities/classification";
import { explainCodes, isExplainable, summarize } from "../../../src/features/runner/result";
import { platformsOf } from "../../../src/features/runner/safety";
import { describeReach, missingVariables, reachOf } from "../../../src/features/runner/tenants";
import { fakeRuntime } from "../helpers";

function backend(env: Record<string, string> = {}, credentials: Record<string, string> = {}): Backend {
  return new Backend({
    runtime: () => fakeRuntime(),
    commands: async () => undefined,
    classify: (argv) => classify(argv),
    serveMode: () => "never",
    baseEnv: () => ({ ...process.env, ...env }),
    proxy: () => undefined,
    credentials: async () => credentials,
    platform: process.platform,
    log: () => {},
  });
}

describe("runner flow (fake opentide)", () => {
  it("offers Explain for a failure whose code explain knows", async () => {
    const instance = backend();
    try {
      const codes = explainCodes((await instance.run(process.cwd(), ["explain"])).document);
      const failed = await instance.run(process.cwd(), ["fail"]);
      const summary = summarize({ ...failed, cancelled: false });
      assert.equal(summary.failureCode, "workspace_not_found");
      assert.ok(isExplainable(summary.failureCode, codes));
      assert.ok(!isExplainable("usage_unknown_command", codes));
    } finally {
      await instance.dispose();
    }
  });

  it("names the tenants a query reaches and the credentials nothing sets", async () => {
    const instance = backend({ FAKE_TENANTS: "1", AZURE_CLIENT_ID: "id" });
    try {
      const argv = ["query", "--platform", "sentinel", "SecurityEvent"];
      const { document } = await instance.run(process.cwd(), ["info"], { credentials: false });
      const reach = reachOf(document, platformsOf(argv));
      assert.equal(describeReach(reach), "sentinel (prod)");
      assert.deepEqual(missingVariables(reach, new Set(), {}), ["FAKE_SECRET"]);
      const stored = new Set(
        Object.keys(await backend({}, { FAKE_SECRET: "s3cr3t" }).credentialEnv(process.cwd())),
      );
      assert.deepEqual(missingVariables(reach, stored, {}), []);
    } finally {
      await instance.dispose();
    }
  });

  it("reads platforms without tenants from an opentide that does not list them", async () => {
    const instance = backend();
    try {
      const { document } = await instance.run(process.cwd(), ["info"]);
      assert.deepEqual(reachOf(document), [{ platform: "sentinel", enabled: true }]);
      assert.equal(describeReach(reachOf(document)), "sentinel");
    } finally {
      await instance.dispose();
    }
  });
});
