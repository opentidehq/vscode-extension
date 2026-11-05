import * as assert from "node:assert/strict";
import { type CatalogState, CatalogStore, type CatalogStoreDeps } from "../../src/core/catalog/store";
import { sleep, until } from "./helpers";

const catalogDocument = (n: number) => ({
  ok: true,
  exit_code: 0,
  objects: Array.from({ length: n }, (_, i) => ({ uuid: `u${i}`, name: `rule ${i}` })),
  edges: [],
  signals: [],
  attack: { tactics: [], techniques: {} },
});

function store(overrides: Partial<CatalogStoreDeps> = {}) {
  const calls = { runs: 0, concurrent: 0, maxConcurrent: 0 };
  const instance = new CatalogStore({
    availability: () => ({ available: true }),
    hasInfoCatalog: async () => true,
    runCatalog: async () => {
      calls.runs++;
      calls.concurrent++;
      calls.maxConcurrent = Math.max(calls.maxConcurrent, calls.concurrent);
      await sleep(40);
      calls.concurrent--;
      return { document: catalogDocument(calls.runs), exitCode: 0 };
    },
    symbols: async () => [
      {
        name: "Suspicious LSASS Access",
        family: "rule",
        uri: "file:///r/objects/rules/a.yaml",
        line: 2,
        character: 6,
      },
    ],
    log: () => {},
    debounceMs: 30,
    ...overrides,
  });
  return { instance, calls };
}

describe("catalogue store", () => {
  it("loads a folder on first get and reports ready", async () => {
    const { instance } = store();
    const states: CatalogState[] = [];
    instance.onDidChange((s) => states.push(s));
    assert.equal(instance.get("/r").status, "empty");
    await until(() => instance.get("/r").status === "ready");
    assert.equal(instance.get("/r").catalog?.objects.length, 1);
    assert.ok(states.some((s) => s.status === "loading"));
    instance.dispose();
  });

  it("debounces bursts into one refresh and never runs two at once", async () => {
    const { instance, calls } = store();
    await instance.refresh("/r", { immediate: true });
    calls.runs = 0;
    const waits = [instance.refresh("/r"), instance.refresh("/r"), instance.refresh("/r")];
    await Promise.all(waits);
    assert.equal(calls.runs, 1, "three saves within the debounce window: one run");
    // A refresh asked for during a run queues exactly one more.
    const first = instance.refresh("/r", { immediate: true });
    await sleep(10);
    const second = instance.refresh("/r", { immediate: true });
    const third = instance.refresh("/r", { immediate: true });
    await Promise.all([first, second, third]);
    assert.equal(calls.maxConcurrent, 1);
    assert.equal(calls.runs, 3, "1 from the burst, then one running and one queued");
    instance.dispose();
  });

  it("falls back to workspace/symbol names when the opentide has no `info catalog`, and says what it needs", async () => {
    const { instance, calls } = store({ hasInfoCatalog: async () => false });
    const state = await instance.refresh("/r", { immediate: true });
    assert.equal(state.status, "unavailable");
    assert.equal(state.unavailable?.reason, "needs-command");
    assert.equal(state.unavailable?.command, "info catalog");
    assert.equal(state.symbols?.[0]?.name, "Suspicious LSASS Access");
    assert.equal(calls.runs, 0);
    instance.dispose();
  });

  describe("an editor-only runtime (the engine, opentide-lsp)", () => {
    const serverDocument = { ...catalogDocument(2), message: "From the language server's index" };
    const editorOnly = () => ({ available: false as const, code: "editor-only" as const });

    it("serves the language server's index as the catalogue, and says what it lacks", async () => {
      let symbols = 0;
      const { instance, calls } = store({
        availability: editorOnly,
        serverCatalog: async () => serverDocument as never,
        unavailableMessage: (reason) =>
          reason === "editor-only" ? "The engine runs editor features only" : undefined,
        symbols: async () => {
          symbols++;
          return [];
        },
      });
      const state = await instance.refresh("/r", { immediate: true });
      assert.equal(state.status, "ready");
      assert.equal(state.source, "server");
      assert.equal(state.catalog?.objects.length, 2);
      assert.equal(state.unavailable?.reason, "editor-only");
      assert.equal(state.unavailable?.message, "The engine runs editor features only");
      assert.equal(calls.runs, 0, "no info catalog");
      assert.equal(symbols, 0, "no workspace/symbol either");
      instance.dispose();
    });

    it("falls back to workspace symbols when the server has no index of the folder", async () => {
      const { instance } = store({ availability: editorOnly, serverCatalog: async () => undefined });
      const state = await instance.refresh("/r", { immediate: true });
      assert.equal(state.status, "unavailable");
      assert.equal(state.source, undefined);
      assert.equal(state.symbols?.length, 1);
      assert.match(state.unavailable?.message ?? "", /opentide-lsp/);
    });

    it("falls back to workspace symbols when opentide/catalog fails", async () => {
      const { instance } = store({
        availability: editorOnly,
        serverCatalog: async () => {
          throw Object.assign(new Error("Unhandled method opentide/catalog"), { code: -32601 });
        },
      });
      const state = await instance.refresh("/r", { immediate: true });
      assert.equal(state.status, "unavailable");
      assert.equal(state.symbols?.length, 1);
    });

    it("never keeps the server's document once opentide runs, even when info catalog fails", async () => {
      let available = false;
      const { instance } = store({
        availability: () => (available ? { available: true } : editorOnly()),
        serverCatalog: async () => serverDocument as never,
        runCatalog: async () => {
          throw new Error("boom");
        },
      });
      assert.equal((await instance.refresh("/r", { immediate: true })).source, "server");
      available = true;
      const state = await instance.refresh("/r", { immediate: true });
      assert.equal(state.status, "error");
      assert.equal(state.catalog, undefined);
      assert.equal(state.source, undefined);
      instance.dispose();
    });
  });

  it("says to trust the folder in Restricted Mode", async () => {
    const { instance } = store({ availability: () => ({ available: false, code: "untrusted" }) });
    const state = await instance.refresh("/r", { immediate: true });
    assert.equal(state.unavailable?.reason, "untrusted");
    assert.match(state.unavailable?.message ?? "", /Trust this folder/);
    instance.dispose();
  });

  it("forgets folders no longer in the workspace, so refreshAll leaves them alone", async () => {
    const ran: string[] = [];
    const { instance } = store({
      runCatalog: async (folder) => {
        ran.push(folder);
        return { document: catalogDocument(1), exitCode: 0 };
      },
    });
    await instance.refresh("/a", { immediate: true });
    await instance.refresh("/b", { immediate: true });
    instance.retain(["/a"]);
    assert.deepEqual(instance.folders(), ["/a"]);
    ran.length = 0;
    instance.refreshAll({ immediate: true });
    await until(() => ran.length > 0);
    await sleep(60);
    assert.deepEqual(ran, ["/a"]);
    instance.dispose();
  });

  it("answers whoever waits for a refresh of a folder it forgets: debounced, immediate or queued", async () => {
    const settled = (promise: Promise<unknown>) =>
      Promise.race([promise.then(() => "settled"), sleep(500).then(() => "pending")]);
    const { instance, calls } = store();
    await instance.refresh("/a", { immediate: true });

    const debounced = instance.refresh("/a");
    instance.retain([]);
    assert.equal(await settled(debounced), "settled");

    await instance.refresh("/b", { immediate: true });
    const immediate = instance.refresh("/b", { immediate: true });
    instance.delete("/b");
    assert.equal(await settled(immediate), "settled");

    await instance.refresh("/c", { immediate: true });
    const running = instance.refresh("/c", { immediate: true });
    await until(() => calls.concurrent === 1);
    const queued = instance.refresh("/c", { immediate: true });
    await sleep(5); // its timer fires during the run: one more run is queued
    instance.retain([]);
    assert.equal(await settled(running), "settled");
    assert.equal(await settled(queued), "settled");
    instance.dispose();
  });

  it("keeps the last good catalogue when a refresh fails", async () => {
    let fail = false;
    const { instance } = store({
      runCatalog: async () => {
        if (fail)
          return {
            document: {
              ok: false,
              exit_code: 1,
              failure: { code: "config_parse", message: "bad paths.toml" },
            },
            exitCode: 1,
          };
        return { document: catalogDocument(2), exitCode: 0 };
      },
    });
    await instance.refresh("/r", { immediate: true });
    fail = true;
    const state = await instance.refresh("/r", { immediate: true });
    assert.equal(state.status, "error");
    assert.equal(state.error, "bad paths.toml");
    assert.equal(state.catalog?.objects.length, 2);
    instance.dispose();
  });
});
