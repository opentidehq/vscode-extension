import * as assert from "node:assert/strict";
import { UnreviewedCache } from "../../../src/features/search/unreviewed";
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
    assert.equal(ready, 1);
    const answer = cache.get("90d", ["/a", "/b"], () => ready++);
    assert.deepEqual([...(answer?.get("/a") ?? [])], ["objects/rules/a.yaml"]);
    assert.deepEqual(runs, ["/a 90d", "/b 90d"]);
    cache.get("30d", ["/a"], () => {});
    await sleep(5);
    assert.deepEqual(runs.at(-1), "/a 30d");
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
