// The sidebar and setup flows end to end against test/fixtures/fake-opentide.mjs, through the real backend.
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Backend } from "../../../src/core/backend/backend";
import { classify } from "../../../src/core/capabilities/classification";
import { CommandTree } from "../../../src/core/capabilities/tree";
import { CredentialStore } from "../../../src/core/credentials";
import {
  defaultAnswers,
  type OptionSource,
  setupCommands,
  setupSupport,
} from "../../../src/features/setup/answers";
import { apply, type Runner, review } from "../../../src/features/setup/flow";
import { parseChecks } from "../../../src/features/sidebar/health";
import {
  PRESENCE_PLACEHOLDER,
  parsePlatforms,
  platformNodes,
  presenceEnv,
  tenantCheck,
  tenantVariableNames,
} from "../../../src/features/sidebar/platforms";
import { COMMANDS_FIXTURE, fakeRuntime } from "../helpers";

const REPO = mkdtempSync(path.join(tmpdir(), "otide-sidebar-"));

function secrets() {
  const map = new Map<string, string>();
  return {
    map,
    store: new CredentialStore({
      get: async (key) => map.get(key),
      store: async (key, value) => void map.set(key, value),
      delete: async (key) => void map.delete(key),
    }),
  };
}

function backend(credentials: CredentialStore, env: Record<string, string> = {}) {
  const runtime = fakeRuntime({ env: {} });
  return new Backend({
    runtime: () => runtime,
    commands: async () => CommandTree.parse(JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8"))),
    classify: (argv) => classify(argv),
    serveMode: () => "never",
    baseEnv: () => {
      const base: Record<string, string | undefined> = { ...process.env, ...env };
      delete base.AZURE_CLIENT_ID;
      delete base.AZURE_CLIENT_SECRET;
      return base;
    },
    proxy: () => undefined,
    credentials: (folder) => credentials.env(folder),
    platform: process.platform,
    log: () => {},
  });
}

describe("sidebar and setup against the fake opentide", function () {
  this.timeout(30_000);
  after(() => rmSync(REPO, { recursive: true, force: true }));

  it("turns a tenant's credentials check green once its secrets are stored, writing no file (#15)", async () => {
    const { store, map } = secrets();
    const instance = backend(store, { FAKE_TENANTS: "1" });
    const before = await instance.run(REPO, ["doctor", "--offline"], { credentials: true });
    assert.equal(tenantCheck(parseChecks(before.document), "sentinel", "prod")?.status, "warn");
    await store.set(REPO, "AZURE_CLIENT_ID", "id-value");
    await store.set(REPO, "AZURE_CLIENT_SECRET", "secret-value");
    const after = await instance.run(REPO, ["doctor", "--offline"], { credentials: true });
    assert.equal(tenantCheck(parseChecks(after.document), "sentinel", "prod")?.status, "pass");
    assert.ok(!after.argvDisplay.includes("secret-value"));
    // The platforms view shows them as stored in VS Code.
    const info = await instance.run(REPO, ["info"], { credentials: true });
    const nodes = platformNodes(parsePlatforms(info.document), new Set(await store.names(REPO)), REPO);
    const tenant = nodes.find((n) => n.label === "Microsoft Sentinel")?.children?.[0];
    assert.equal(tenant?.description, "2 of 2 credentials set · PREVIEW, RELEASE");
    assert.ok([...map.values()].includes("secret-value"), "the secret lives in SecretStorage only");
    await instance.dispose();
  });

  it("reads the env file's repository for info, with the credentials only by name", async () => {
    const { store } = secrets();
    await store.set(REPO, "AZURE_CLIENT_SECRET", "secret-value");
    // `setup env`'s .env, in opentide.envFile, sets OPENTIDE_REPO_ROOT next to the tenant's variables.
    const envFile = { OPENTIDE_REPO_ROOT: REPO, AZURE_CLIENT_ID: "id-value" };
    const instance = backend(store, { FAKE_TENANTS: "1" });
    try {
      const credentialEnv = { ...envFile, ...(await instance.credentialEnv(REPO)) };
      const first = presenceEnv(credentialEnv, new Set(await store.names(REPO)));
      const info = await instance.run(REPO, ["info"], { credentials: false, env: first });
      assert.equal(info.document.repo, REPO, "the repository is the env file's, not the placeholder");
      const platforms = parsePlatforms(info.document);
      assert.ok(platforms.find((p) => p.name === "sentinel")?.enabled);
      const tenant = platforms.find((p) => p.name === "sentinel")?.tenants?.[0];
      assert.deepEqual(
        tenant?.variables.map((v) => v.set),
        [true, true],
        "both credentials count as set",
      );
      const known = new Set([...(await store.names(REPO)), ...tenantVariableNames(platforms)]);
      const echo = await instance.run(REPO, ["echo"], {
        credentials: false,
        env: presenceEnv({ ...credentialEnv, FAKE_SECRET: "fake-secret" }, known),
      });
      const seen = echo.document.env as Record<string, string>;
      assert.equal(seen.OPENTIDE_REPO_ROOT, REPO);
      assert.equal(seen.FAKE_SECRET, PRESENCE_PLACEHOLDER);
      assert.ok(!JSON.stringify(echo.document).includes("secret-value"));
      assert.ok(!JSON.stringify(echo.document).includes("id-value"));
    } finally {
      await instance.dispose();
    }
  });

  for (const plan of [false, true]) {
    it(`reviews then applies the wizard's commands (${plan ? "with" : "without"} setup --plan)`, async () => {
      const document = JSON.parse(readFileSync(COMMANDS_FIXTURE, "utf8"));
      if (plan) {
        for (const command of document.commands)
          if (String(command.path).startsWith("setup"))
            command.options.push({ name: "plan", flags: ["--plan"], type: "boolean", is_flag: true });
      }
      const tree = CommandTree.parse(document);
      const source: OptionSource = {
        hasCommand: (p) => tree.hasCommand(p),
        hasOption: (p, f) => tree.hasOption(p, f),
        choices: (p, f) => tree.option(p, f)?.choices ?? undefined,
      };
      const { store } = secrets();
      const instance = backend(store, plan ? { FAKE_SETUP_PLAN: "1" } : {});
      const run: Runner = async (argv, token) =>
        instance.run(REPO, argv, token ? { cancellation: token } : {});
      const answers = { ...defaultAnswers("demo"), platforms: ["sentinel"], mcp: ["cursor" as const] };
      const support = setupSupport(source);
      const reviewed = await review({ answers, mode: "new", support, enabled: [], run });
      assert.deepEqual(reviewed.problems, []);
      assert.equal(reviewed.error, undefined);
      if (plan) {
        assert.ok(reviewed.totals && reviewed.totals.create > 0);
        assert.equal(reviewed.note, undefined);
      } else assert.ok(reviewed.note);
      const progress = await apply({
        commands: setupCommands(answers, "new", support),
        run,
        onProgress: () => {},
      });
      assert.equal(progress.ok, true);
      assert.ok(progress.commands[0]?.steps.some((s) => s.files.includes("README.md")));
      await instance.dispose();
    });
  }
});
