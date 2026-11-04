import * as assert from "node:assert/strict";
import { SettledWindow, UnreviewedCache } from "../../../src/features/search/unreviewed";
import { sleep } from "../helpers";

describe("unreviewed cache", () => {
  it("runs rules unreviewed once per folder and window, then answers from memory", async () => {
    const runs: string[] = [];
    const cache = new UnreviewedCache({
      hasCommand: () => true,
      run: async (folder, window) => {
        runs.push(`${folder} ${window}`);
        return { rules: [{ path: `objects/rules/${folder.slice(1)}.yaml` }] };
      },
      log: () => {},
    });
    let ready = 0;
    assert.equal(
      cache.get("90d", ["/a", "/b"], () => ready++),
      undefined,
    );
    assert.equal(
      cache.get("90d", ["/a", "/b"], () => ready++),
      undefined,
      "a second ask joins the run",
    );
    await sleep(5);
    assert.equal(ready, 2, "both asks are told: a second pick window for the window is not left spinning");
    const answer = cache.get("90d", ["/a", "/b"], () => ready++);
    assert.deepEqual([...(answer?.get("/a") ?? [])], ["objects/rules/a.yaml"]);
    assert.deepEqual(runs, ["/a 90d", "/b 90d"]);
    cache.get("30d", ["/a"], () => {});
    await sleep(5);
    assert.deepEqual(runs.at(-1), "/a 30d");
  });

  it("tells one window once, however often it asks while the run is under way", async () => {
    const cache = new UnreviewedCache({
      hasCommand: () => true,
      run: async () => ({ rules: [] }),
      log: () => {},
    });
    let ready = 0;
    const onReady = () => ready++;
    cache.get("90d", ["/a"], onReady);
    cache.get("90d", ["/a"], onReady);
    await sleep(5);
    assert.equal(ready, 1);
  });

  it("lists nothing for a folder whose run fails, or without the command", async () => {
    const logged: string[] = [];
    const failing = new UnreviewedCache({
      hasCommand: () => true,
      run: async () => {
        throw new Error("no runtime");
      },
      log: (message) => logged.push(message),
    });
    failing.get("90d", ["/a"], () => {});
    await sleep(5);
    assert.equal(failing.get("90d", ["/a"], () => {})?.get("/a")?.size, 0);
    assert.match(logged[0] ?? "", /no runtime/);
    const old = new UnreviewedCache({ hasCommand: () => false, run: async () => ({}), log: () => {} });
    assert.equal(old.get("90d", ["/a"], () => {})?.get("/a")?.size, 0);
  });

  it("drops an answer that arrives after clear()", async () => {
    let release: () => void = () => {};
    const cache = new UnreviewedCache({
      hasCommand: () => true,
      run: () => new Promise((resolve) => (release = () => resolve({ rules: [{ path: "x" }] }))),
      log: () => {},
    });
    let ready = false;
    cache.get("90d", ["/a"], () => (ready = true));
    cache.clear();
    release();
    await sleep(5);
    assert.equal(ready, false);
  });
});

describe("unreviewed: while typing", () => {
  it("runs only the window typed and left, not each prefix (1d, 18d, 180d)", () => {
    const timers: { callback: () => void; cleared: boolean }[] = [];
    let asked = 0;
    const settled = new SettledWindow(undefined, 400, () => asked++, {
      set: (callback) => timers.push({ callback, cleared: false }) - 1,
      clear: (handle) => {
        const timer = timers[handle as number];
        if (timer) timer.cleared = true;
      },
    });
    assert.equal(settled.ready("1d"), false);
    assert.equal(settled.ready("18d"), false);
    assert.equal(settled.ready("180d"), false);
    assert.equal(settled.ready("180d"), false, "the same window keeps its timer");
    assert.deepEqual(
      timers.map((t) => t.cleared),
      [true, true, false],
    );
    timers[2]?.callback();
    assert.equal(asked, 1);
    assert.equal(settled.ready("180d"), true);
    const opened = new SettledWindow("90d", 400, () => {});
    assert.equal(opened.ready("90d"), true, "the window the pick opened with runs at once");
    opened.dispose();
  });
});
