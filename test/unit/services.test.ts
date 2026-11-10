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
import {
  isFamilyFile,
  isObjectFile,
  isOpentideFolder,
  objectFolders,
  objectsOnlyByCase,
  readTomlTable,
} from "../../src/core/folders";
import {
  menuSections,
  problemsText,
  serveText,
  statusLabel,
  statusText,
  sumCounts,
} from "../../src/core/statusText";
import { editorOnlyText, unavailableActions } from "../../src/core/unavailable";
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

  it("keeps a variable named `index` apart from the index of names", async () => {
    const store = new CredentialStore(secrets());
    await store.set("/ws", "A", "alpha");
    await store.set("/ws", "index", "hunter2-secret");
    assert.deepEqual(await store.env("/ws"), { A: "alpha", index: "hunter2-secret" });
    await store.delete("/ws", "index");
    assert.deepEqual(await store.names("/ws"), ["A"]);
    assert.deepEqual(await store.env("/ws"), { A: "alpha" });
  });
});

describe("credential store: values stored before they had a namespace", () => {
  const legacy = () => {
    const map = new Map<string, string>();
    const storage = {
      map,
      get: async (k: string) => map.get(k),
      store: async (k: string, v: string) => void map.set(k, v),
      delete: async (k: string) => void map.delete(k),
    };
    return { map, storage };
  };

  it("does not list an old `$index` whose value the index overwrote, so it is asked for again", async () => {
    const { map, storage } = legacy();
    const store = new CredentialStore(storage);
    await store.set("/ws", "A", "alpha");
    const prefix = [...map.keys()][0]?.replace(/\.var\.A$/, "") ?? "";
    // The old scheme: `set("index", v)` stored v at <prefix>.index, then the index over it.
    map.set(`${prefix}.index`, JSON.stringify(["A", "index"]));
    assert.deepEqual(await store.names("/ws"), ["A"], "no value: not shown as stored");
    assert.deepEqual(await store.env("/ws"), { A: "alpha" });
    await store.set("/ws", "index", "new-value");
    assert.deepEqual(await store.names("/ws"), ["A", "index"]);
    assert.deepEqual(await store.env("/ws"), { A: "alpha", index: "new-value" });
  });

  it("drops a value's old-scheme key when it is stored again", async () => {
    const { map, storage } = legacy();
    const store = new CredentialStore(storage);
    await store.set("/ws", "A", "alpha");
    const prefix = [...map.keys()][0]?.replace(/\.var\.A$/, "") ?? "";
    map.set(`${prefix}.TOKEN`, "old");
    map.set(`${prefix}.index`, JSON.stringify(["A", "TOKEN"]));
    assert.equal(await store.get("/ws", "TOKEN"), "old", "still read");
    await store.set("/ws", "TOKEN", "new");
    assert.equal(map.has(`${prefix}.TOKEN`), false);
    assert.equal(await store.get("/ws", "TOKEN"), "new");
    assert.ok(map.has(`${prefix}.index`), "the index stays");
  });
});

describe("opentide folders", () => {
  it("is a folder with .opentide/ or objects/", () => {
    const root = mkdtempSync(path.join(tmpdir(), "otide-f-"));
    assert.ok(!isOpentideFolder(root));
    mkdirSync(path.join(root, "objects"));
    assert.ok(isOpentideFolder(root));
  });

  it("is not a CoreTIDE folder's Objects/, also where the filesystem ignores case", () => {
    const coretide = [
      { name: "Objects", directory: true },
      { name: "Configurations", directory: true },
    ];
    assert.ok(!isOpentideFolder("/repo", () => coretide));
    assert.ok(isOpentideFolder("/repo", () => [...coretide, { name: ".opentide", directory: true }]));
    assert.ok(
      !isOpentideFolder("/repo", () => [{ name: "objects", directory: false }]),
      "a file named objects",
    );
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

  it("knows a file validate --file and lint --file accept: directly in a family folder", () => {
    const defaults = objectFolders(undefined);
    assert.ok(isFamilyFile("/r", "/r/objects/rules/a.yaml", defaults));
    assert.ok(isFamilyFile("/r", "/r/objects/threats/t.yml", defaults));
    assert.ok(!isFamilyFile("/r", "/r/objects/rules/sub/a.yaml", defaults), "a subfolder fails lint --file");
    assert.ok(!isFamilyFile("/r", "/r/objects/a.yaml", defaults));
    assert.ok(!isFamilyFile("/r", "/r/objects/rules/notes.md", defaults));
    const custom = objectFolders(`[paths.objects]\nrule = "detections/rules/"\n`);
    assert.ok(isFamilyFile("/r", "/r/detections/rules/a.yaml", custom));
    assert.ok(!isFamilyFile("/r", "/r/detections/rules/x/a.yaml", custom));
  });

  it("knows a file the objects/ glob matches only without case (CoreTIDE's Objects/)", () => {
    assert.ok(objectsOnlyByCase("/repo/Objects/Rules/a.yaml"));
    assert.ok(objectsOnlyByCase("C:\\repo\\OBJECTS\\a.yml"));
    assert.ok(!objectsOnlyByCase("/repo/objects/rules/a.yaml"));
    assert.ok(
      !objectsOnlyByCase("/Objects/repo/objects/rules/a.yaml"),
      "one folder spelled objects is enough",
    );
    assert.ok(!objectsOnlyByCase("/repo/detections/a.yaml"));
    assert.ok(!objectsOnlyByCase("/repo/Objects.yaml"), "only folders count");
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

describe("status item: the engine (WASM)", () => {
  const engine = fakeRuntime({ tier: 4, source: "engine", kind: "engine", version: "0.10.0" });
  const counts = { errors: 1, warnings: 0 };

  it("reads 'opentide engine (WASM): editor features only', and says there is no backend", () => {
    const model = { runtime: engine, resolving: false, pin: undefined, counts, trusted: true };
    assert.equal(statusText(model), "$(shield) opentide engine (WASM): editor features only ✗ 1");
    assert.equal(statusLabel(model), "opentide engine (WASM): editor features only, engine 0.10.0, 1 error");
    assert.match(serveText(model), /need opentide/);
    assert.match(serveText({ ...model, trusted: false }), /Restricted Mode/);
    // A repository pin is about opentide, which the engine is not.
    assert.equal(
      statusText({
        ...model,
        counts: { errors: 0, warnings: 0 },
        pin: { version: "0.20.1", source: "uv.lock" },
      }),
      "$(shield) opentide engine (WASM): editor features only",
    );
  });

  it("says why a command cannot run, with the way out", () => {
    assert.match(
      editorOnlyText(engine, "this command"),
      /^The opentide engine \(WASM\) runs editor features only: this command needs opentide\. Install opentide/,
    );
    assert.match(
      editorOnlyText(fakeRuntime({ kind: "opentide-lsp" }), "setup"),
      /opentide\.path names opentide-lsp.*setup needs opentide/,
    );
    assert.deepEqual(unavailableActions("editor-only"), ["Install opentide", "Switch Runtime…"]);
    assert.deepEqual(unavailableActions("no-runtime"), ["Install opentide", "Switch Runtime…"]);
    assert.deepEqual(unavailableActions("untrusted"), []);
  });
});

describe("status item: one clear opentide item", () => {
  const runtime = fakeRuntime({ version: "0.21.0" });
  const counts = { errors: 2, warnings: 5 };

  it("shows the warm backend, and says it all to screen readers", () => {
    const model = { runtime, resolving: false, pin: undefined, counts, trusted: true, serve: true };
    assert.equal(statusText(model), "$(shield) 0.21.0 $(zap) ✗ 2 ! 5");
    assert.equal(statusLabel(model), "opentide 0.21.0, warm backend, 2 errors, 5 warnings");
    assert.equal(
      statusLabel({
        ...model,
        serve: false,
        counts: { errors: 0, warnings: 0 },
        pin: { version: "0.20.1", source: "uv.lock" },
      }),
      "opentide 0.21.0, the repository pins 0.20.1",
    );
    assert.equal(statusLabel({ ...model, runtime: undefined, resolving: true }), "opentide: starting");
    assert.equal(serveText(model), "Warm backend: `opentide serve` answers commands");
    assert.equal(serveText({ ...model, serve: false }), "Backend: one opentide process per command");
    assert.match(serveText({ ...model, trusted: false }), /Restricted Mode/);
  });

  it("counts problems in words", () => {
    assert.equal(problemsText({ errors: 0, warnings: 0 }), "No problems");
    assert.equal(problemsText({ errors: 1, warnings: 0 }), "1 error");
    assert.equal(problemsText({ errors: 2, warnings: 1 }), "2 errors, 1 warning");
  });

  it("orders the menu in two sections: the features' actions, then the core's", () => {
    const sections = menuSections([
      { label: "Switch runtime", order: 120 },
      { label: "Run command", order: 90 },
      { label: "Show output", order: 100 },
      { label: "Show Problems", order: 99 },
      { label: "Validate" },
    ]);
    assert.deepEqual(
      sections.map((s) => [s.label, s.items.map((i) => i.label)]),
      [
        ["Actions", ["Validate", "Run command", "Show Problems"]],
        ["opentide", ["Show output", "Switch runtime"]],
      ],
    );
    assert.deepEqual(
      menuSections([{ label: "x", order: 100 }]).map((s) => s.label),
      ["opentide"],
    );
  });
});
