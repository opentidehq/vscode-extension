// The query panel's host side with a fake webview and backend: a run whose tenant picker is open must
// not overwrite a newer run, nor run again once the panel is closed.
import * as assert from "node:assert/strict";
import type { RunResult } from "../../../src/core/backend/backend";
import type { FeatureContext, OpentideFolder } from "../../../src/core/context";
import { type PanelHooks, QueryPanels, type RunSpec } from "../../../src/features/query/panel";
import type { QueryPanelState } from "../../../src/features/query/protocol";
import { stubState } from "../../stubs/vscode";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

const FOLDER = { path: "/repo", objectFolders: {} } as unknown as OpentideFolder;

const SPEC: RunSpec = {
  folder: FOLDER,
  options: {
    platform: "sentinel",
    source: { kind: "text", text: "SigninLogs", name: "Signins" },
    window: { kind: "since", since: "24h" },
    limit: 100,
  },
  title: "Signins",
  writesPreviewAlerts: false,
};

function result(document: Record<string, unknown>, exitCode: number): RunResult {
  return {
    document: document as RunResult["document"],
    exitCode,
    argvDisplay: "opentide --json query",
    folder: "/repo",
    durationMs: 5,
    via: "spawn",
    cancelled: false,
  };
}

/** Exit 2: several tenants, none named. */
const CHOICES = result(
  {
    exit_code: 2,
    message: "pick a tenant",
    failure: { code: "usage_invalid_value", argument: "--tenant" },
    choices: ["prod", "dev"],
  },
  2,
);

const ROWS = result(
  {
    exit_code: 0,
    message: "1 row",
    results: [{ tenant: "prod", status: "ok", columns: [{ name: "a" }], rows: [{ a: 1 }] }],
  },
  0,
);

interface FakePanel {
  readonly options: Record<string, unknown>;
  readonly handlers: Map<string, (payload: unknown) => unknown>;
  readonly panel: { title: string; reveals: boolean[] };
  dispose(): void;
}

function harness(runs: Promise<RunResult>[]) {
  const panels: FakePanel[] = [];
  const posted: QueryPanelState[] = [];
  const argvs: string[][] = [];
  const picker = deferred<readonly string[] | undefined>();
  const ctx = {
    webview: {
      createPanel: (options: Record<string, unknown>) => {
        const handlers = new Map<string, (payload: unknown) => unknown>();
        let disposePanel: () => void = () => undefined;
        const panel = {
          title: String(options.title),
          reveals: [] as boolean[],
          reveal(_column: unknown, preserveFocus: boolean) {
            panel.reveals.push(preserveFocus);
          },
          onDidChangeViewState() {
            return { dispose() {} };
          },
          onDidDispose(listener: () => void) {
            disposePanel = listener;
            return { dispose() {} };
          },
        };
        const fake: FakePanel = { options, handlers, panel, dispose: () => disposePanel() };
        panels.push(fake);
        return {
          channel: {
            on(type: string, handler: (payload: unknown) => unknown) {
              handlers.set(type, handler);
              return { dispose() {} };
            },
            post(type: string, payload: unknown) {
              if (type === "state") posted.push(payload as QueryPanelState);
              return Promise.resolve(true);
            },
            dispose() {},
          },
          panel,
          dispose: () => fake.dispose(),
        };
      },
    },
    backend: {
      run(_folder: string, argv: string[]) {
        argvs.push(argv);
        const next = runs.shift();
        if (!next) throw new Error(`no run left for ${argv.join(" ")}`);
        return next;
      },
    },
    log: { show() {} },
  } as unknown as FeatureContext;
  let picks = 0;
  const hooks: PanelHooks = {
    pickTenants: () => {
      picks++;
      return picker.promise;
    },
    edit: async () => undefined,
    action: async () => undefined,
  };
  const pool = new QueryPanels(ctx, hooks);
  return {
    panels: pool,
    created: panels,
    picker,
    argvs,
    posted,
    picks: () => picks,
    send: (type: string, payload?: unknown, index = 0) => panels[index]?.handlers.get(type)?.(payload),
    last: () => posted.at(-1),
  };
}

const spec = (name: string, platform = "sentinel"): RunSpec => ({
  ...SPEC,
  options: { ...SPEC.options, platform, source: { kind: "text", text: name, name } },
  title: name,
});

describe("query panel", () => {
  it("lets a Re-run started while the tenant picker is open keep its results", async () => {
    const h = harness([Promise.resolve(CHOICES), Promise.resolve(ROWS)]);
    h.panels.run(SPEC);
    await flush();
    assert.equal(h.last()?.phase, "choosing");
    await h.send("rerun");
    assert.equal(h.last()?.phase, "done");
    // The first run's picker is dismissed after the newer run finished.
    h.picker.resolve(undefined);
    await flush();
    assert.equal(h.last()?.phase, "done", "the abandoned run does not overwrite the newer one");
    assert.equal(h.last()?.tabs.length, 1);
    h.panels.dispose();
  });

  it("does not run again when the tenants are picked after the panel closed", async () => {
    const h = harness([Promise.resolve(CHOICES)]);
    h.panels.run(SPEC);
    await flush();
    assert.equal(h.picks(), 1);
    h.panels.dispose();
    h.picker.resolve(["prod"]);
    await flush();
    assert.equal(h.argvs.length, 1, "a closed panel contacts no tenant");
  });

  it("opens beside the editor, keeping the focus there, with the object in its title", async () => {
    const h = harness([Promise.resolve(ROWS)]);
    h.panels.run(spec("LSASS handle opened by unsigned process"));
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0]?.options.beside, true, "beside the rule, not over it");
    assert.equal(h.created[0]?.options.kit, true);
    assert.equal(h.created[0]?.panel.title, "Query · LSASS handle opened by… · Sentinel");
    h.panels.dispose();
  });

  it("reuses its panel for the next query (retarget, not a new tab), and keeps the editor's focus", async () => {
    const h = harness([Promise.resolve(ROWS), Promise.resolve(ROWS), Promise.resolve(ROWS)]);
    h.panels.run(spec("First rule"));
    await flush();
    h.panels.run(spec("Second rule", "splunk"));
    await flush();
    assert.equal(h.created.length, 1, "one panel per kind");
    assert.equal(h.panels.size, 1);
    assert.equal(h.created[0]?.panel.title, "Query · Second rule · Splunk");
    assert.deepEqual(h.created[0]?.panel.reveals, [true], "revealed without taking the focus");
    // The same query again runs in the panel that shows it.
    h.panels.run(spec("Second rule", "splunk"));
    await flush();
    assert.equal(h.created.length, 1);
    assert.equal(h.argvs.length, 3);
    h.panels.dispose();
  });

  it("keeps a locked panel on its query: the next query opens a panel of its own", async () => {
    const h = harness([Promise.resolve(ROWS), Promise.resolve(ROWS), Promise.resolve(ROWS)]);
    h.panels.run(spec("Pinned rule"));
    await flush();
    await h.send("lock", true);
    assert.equal(h.last()?.locked, true, "the webview shows the lock");
    h.panels.run(spec("Other rule"));
    await flush();
    assert.equal(h.created.length, 2);
    assert.deepEqual(
      h.panels.describe().map((p) => [p.title, p.locked]),
      [
        ["Query · Pinned rule · Sentinel", true],
        ["Query · Other rule · Sentinel", false],
      ],
    );
    // Running the pinned query again reveals its panel instead of retargeting the free one.
    h.panels.run(spec("Pinned rule"));
    await flush();
    assert.equal(h.created.length, 2);
    assert.equal(h.created[1]?.panel.title, "Query · Other rule · Sentinel");
    h.panels.dispose();
  });

  describe("with opentide.query.retainResults", () => {
    beforeEach(() => {
      stubState.config["opentide.query.retainResults"] = true;
    });
    afterEach(() => {
      delete stubState.config["opentide.query.retainResults"];
    });

    const CANCELLED: RunResult = {
      ...result({ exit_code: 130, message: "Interrupted" }, 130),
      cancelled: true,
    };

    it("shows kept results in a retargeted panel, and the run they replaced does not overwrite them", async () => {
      const running = deferred<RunResult>();
      const h = harness([Promise.resolve(ROWS), running.promise]);
      h.panels.run(spec("Kept rule"));
      await flush();
      h.created[0]?.dispose();
      assert.equal(h.panels.size, 0);
      h.panels.run(spec("Running rule"));
      await flush();
      assert.equal(h.last()?.phase, "running");
      // The kept query retargets the running panel, which shows its results without running.
      h.panels.run(spec("Kept rule"));
      await flush();
      assert.equal(h.last()?.name, "Kept rule");
      assert.equal(h.last()?.phase, "done");
      running.resolve(CANCELLED);
      await flush();
      assert.equal(h.last()?.name, "Kept rule", "the cancelled run is over");
      assert.equal(h.last()?.phase, "done", "not 'Cancelled. Nothing was kept.'");
      assert.equal(h.argvs.length, 2);
      h.panels.dispose();
    });

    it("does not run the replaced query again when its tenant picker answers afterwards", async () => {
      const h = harness([Promise.resolve(ROWS), Promise.resolve(CHOICES)]);
      h.panels.run(spec("Kept rule"));
      await flush();
      h.created[0]?.dispose();
      h.panels.run(spec("Picking rule"));
      await flush();
      assert.equal(h.last()?.phase, "choosing");
      h.panels.run(spec("Kept rule"));
      await flush();
      h.picker.resolve(["prod"]);
      await flush();
      assert.equal(h.argvs.length, 2, "no third run, of the old query, in the retargeted panel");
      assert.equal(h.last()?.name, "Kept rule");
      h.panels.dispose();
    });
  });
});
