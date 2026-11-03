// The small vscode-free services: activity log, credentials, folders, feature host, status text.
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ACTIVITY_LIMIT, ActivityLog } from "../../src/core/activity";
import type { RunRecord } from "../../src/core/backend/backend";
import { CredentialStore } from "../../src/core/credentials";
import { defineFeature } from "../../src/core/feature";
import { activateFeatures } from "../../src/core/featureHost";
import { isObjectFile, isOpentideFolder, objectFolders, readTomlTable } from "../../src/core/folders";
import { isDirectory } from "../../src/core/runtime/process";
import { statusText, sumCounts } from "../../src/core/statusText";
import { fakeRuntime } from "./helpers";

const record = (id: number, status: RunRecord["status"], extra: Partial<RunRecord> = {}): RunRecord => ({
  id,
  folder: "/r",
  argv: ["validate"],
  argvDisplay: "opentide --json validate",
  startedAt: id,
  status,
  classification: { class: "read-only", writes: false, contactsTenant: false, spawn: false },
  ...extra,
});

describe("activity log", () => {
  it("keeps the last 50 runs, newest first, updating a run when it ends", () => {
    const log = new ActivityLog();
    log.record(record(1, "running"));
    log.record(record(1, "failed", { exitCode: 1, failureCode: "schema", durationMs: 12 }));
    assert.equal(log.list().length, 1);
    assert.deepEqual(
      {
        status: log.list()[0]?.status,
        exitCode: log.list()[0]?.exitCode,
        failureCode: log.list()[0]?.failureCode,
      },
      { status: "failed", exitCode: 1, failureCode: "schema" },
    );
    for (let id = 2; id <= 60; id++) log.record(record(id, "ok"));
    assert.equal(log.list().length, ACTIVITY_LIMIT);
    assert.equal(log.list()[0]?.id, 60);
  });
});

describe("credential store", () => {
  const secrets = () => {
    const map = new Map<string, string>();
    return {
      map,
      get: async (k: string) => map.get(k),
      store: async (k: string, v: string) => void map.set(k, v),
      delete: async (k: string) => void map.delete(k),
    };
  };

  it("keeps credentials per folder, by variable name, and lists names without values", async () => {
    const storage = secrets();
    const store = new CredentialStore(storage);
    await store.set("/a", "AZURE_CLIENT_SECRET", "one");
    await store.set("/b", "AZURE_CLIENT_SECRET", "two");
    assert.deepEqual(await store.env("/a"), { AZURE_CLIENT_SECRET: "one" });
    assert.deepEqual(await store.env("/b"), { AZURE_CLIENT_SECRET: "two" });
    assert.deepEqual(await store.names("/a"), ["AZURE_CLIENT_SECRET"]);
    await store.delete("/a", "AZURE_CLIENT_SECRET");
    assert.deepEqual(await store.env("/a"), {});
    assert.ok(![...storage.map.keys()].some((key) => key.includes("/a")), "folder paths are hashed in keys");
    await assert.rejects(store.set("/a", "not a name", "x"));
  });
});

describe("opentide folders", () => {
  it("is a folder with .opentide/ or objects/", () => {
    const root = mkdtempSync(path.join(tmpdir(), "otide-f-"));
    assert.ok(!isOpentideFolder(root, isDirectory));
    mkdirSync(path.join(root, "objects"));
    assert.ok(isOpentideFolder(root, isDirectory));
  });

  it("reads the object folders from paths.toml, as opentide does", () => {
    assert.deepEqual(objectFolders(undefined), {
      threat: "objects/threats/",
      objective: "objects/objectives/",
      rule: "objects/rules/",
    });
    const toml = `objects = ["threat"]\n[paths.opentide]\nroot = ".opentide/"\n\n[paths.objects]\nrule = "detections/rules"  # custom\nthreat = './intel/'\nsnippet_file = "x"\n`;
    assert.deepEqual(objectFolders(toml), {
      threat: "intel/",
      objective: "objects/objectives/",
      rule: "detections/rules/",
    });
    assert.deepEqual(readTomlTable(`[paths]\nobjects.rule = "r/"\n`, ["paths", "objects"]), { rule: "r/" });
    assert.deepEqual(
      readTomlTable(`[paths]\nobjects = { rule = "r/", threat = "t/" }\n`, ["paths", "objects"]),
      { rule: "r/", threat: "t/" },
    );
    assert.deepEqual(objectFolders("not = [valid"), objectFolders(undefined));
  });

  it("knows an object file: YAML under objects/ or a paths.toml folder; Cargo.toml and others are not", () => {
    const folders = objectFolders(`[paths.objects]\nrule = "detections/rules/"\n`);
    assert.ok(isObjectFile("/r", "/r/objects/rules/a.yaml", folders));
    assert.ok(isObjectFile("/r", "/r/detections/rules/a.yml", folders));
    assert.ok(!isObjectFile("/r", "/r/detections/other/a.yaml", folders));
    assert.ok(!isObjectFile("/r", "/r/objects/rules/notes.md", folders));
    assert.ok(!isObjectFile("/r", "/elsewhere/objects/a.yaml", folders));
  });
});

describe("feature host", () => {
  it("activates every feature, isolating one that throws", async () => {
    const errors: string[] = [];
    const activated: string[] = [];
    const subscriptions: { dispose(): void }[] = [];
    const outcomes = await activateFeatures(
      [
        defineFeature({ id: "good", activate: () => void activated.push("good") }),
        defineFeature({
          id: "bad",
          activate: () => {
            throw new Error("boom");
          },
        }),
        defineFeature({ id: "async-bad", activate: async () => Promise.reject(new Error("later")) }),
        defineFeature({ id: "disposable", activate: () => ({ dispose: () => {} }) }),
        defineFeature({ id: "good", activate: () => void activated.push("dup") }),
      ],
      {
        subscriptions: subscriptions as never,
        log: { info: () => {}, error: (m) => void errors.push(String(m)) },
      },
    );
    assert.deepEqual(activated, ["good"]);
    assert.deepEqual(
      outcomes.map((o) => [o.id, o.ok]),
      [
        ["good", true],
        ["bad", false],
        ["async-bad", false],
        ["disposable", true],
        ["good", false],
      ],
    );
    assert.equal(subscriptions.length, 1);
    assert.ok(errors.some((e) => e.includes("feature bad failed to activate") && e.includes("boom")));
  });
});

describe("status text", () => {
  it("shows version, counts and the pin mismatch", () => {
    const runtime = fakeRuntime({ version: "0.21.0" });
    const counts = sumCounts([
      { errors: 1, warnings: 2 },
      { errors: 1, warnings: 3 },
    ]);
    assert.equal(
      statusText({ runtime, resolving: false, pin: undefined, counts, trusted: true }),
      "$(shield) 0.21.0 ✗ 2 ! 5",
    );
    assert.equal(
      statusText({
        runtime,
        resolving: false,
        pin: { version: "0.20.1", source: "uv.lock" },
        counts: sumCounts([]),
        trusted: true,
      }),
      "$(shield) 0.21.0 · repo pins 0.20.1",
    );
    assert.equal(
      statusText({ runtime: undefined, resolving: false, pin: undefined, counts, trusted: true }),
      "$(shield) opentide: no runtime",
    );
  });
});
