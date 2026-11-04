// The query panel's host side with a fake webview and backend: a run whose tenant picker is open must
// not overwrite a newer run, nor run again once the panel is closed.
import * as assert from "node:assert/strict";
import type { RunResult } from "../../../src/core/backend/backend";
import type { FeatureContext, OpentideFolder } from "../../../src/core/context";
import { type PanelHooks, QueryPanels, type RunSpec } from "../../../src/features/query/panel";
import type { QueryPanelState } from "../../../src/features/query/protocol";

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

function harness(runs: Promise<RunResult>[]) {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const posted: QueryPanelState[] = [];
  let disposePanel: () => void = () => undefined;
  const argvs: string[][] = [];
  const picker = deferred<readonly string[] | undefined>();
  const ctx = {
    webview: {
      createPanel: () => ({
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
        panel: {
          title: "",
          reveal() {},
          onDidDispose(listener: () => void) {
            disposePanel = listener;
            return { dispose() {} };
          },
        },
        dispose: () => disposePanel(),
      }),
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
  const panels = new QueryPanels(ctx, hooks);
  return {
    panels,
    picker,
    argvs,
    posted,
    picks: () => picks,
    send: (type: string, payload?: unknown) => handlers.get(type)?.(payload),
    last: () => posted.at(-1),
  };
}

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
});
