import * as assert from "node:assert/strict";
import { EngineSync, planDelta } from "../../../src/engine/sync";

const delta = (uri: string, visibility?: string | null) => ({
  documents: [{ uri, text: "x" }],
  removed: [],
  ...(visibility !== undefined ? { visibility } : {}),
});
const none = new Set<string>();

describe("engine sync across starts (src/engine/sync.ts)", () => {
  it("keeps a change that arrives while the engine starts, and restarts 0.10.0 once it answers", () => {
    const sync = new EngineSync();
    sync.given();
    assert.equal(sync.changed(delta("file:///w/objects/a.yaml"), none), undefined, "nothing answers yet");
    assert.equal(sync.changed(delta("file:///w/objects/b.yaml"), none), undefined);
    assert.deepEqual(sync.ready(false), [{ kind: "restart" }]);
    assert.deepEqual(sync.ready(false), [], "replayed once");
  });

  it("sends what changed during the start, in order, to an engine that takes updates", () => {
    const sync = new EngineSync();
    sync.given();
    const a = delta("file:///w/objects/a.yaml");
    const b = delta("file:///w/objects/b.yaml");
    sync.changed(a, none);
    sync.changed(b, none);
    assert.deepEqual(sync.ready(true), [
      { kind: "notify", delta: a },
      { kind: "notify", delta: b },
    ]);
  });

  it("drops what the next initialize carries: a change before it is in the workspace it is given", () => {
    const sync = new EngineSync();
    sync.down();
    sync.changed(delta("file:///w/objects/a.yaml"), none);
    sync.given();
    assert.deepEqual(sync.ready(false), []);
  });

  it("queues again after the server stops on its own, until the client's restart answers", () => {
    const sync = new EngineSync();
    sync.given();
    sync.ready(true);
    assert.equal(sync.changed(delta("file:///w/objects/a.yaml"), none)?.kind, "notify");
    sync.down();
    assert.equal(sync.changed(delta("file:///w/objects/b.yaml"), none), undefined);
    sync.given();
    assert.deepEqual(sync.ready(true), []);
  });

  it("plans a change for a running engine", () => {
    const a = delta("file:///w/objects/a.yaml");
    assert.deepEqual(planDelta(a, true, none), { kind: "notify", delta: a });
    assert.deepEqual(planDelta(a, false, none), { kind: "restart" });
    assert.deepEqual(planDelta(a, false, new Set(["file:///w/objects/a.yaml"])), {
      kind: "after-close",
      uris: ["file:///w/objects/a.yaml"],
    });
    assert.deepEqual(
      planDelta(delta("file:///w/objects/a.yaml", "x"), false, new Set(["file:///w/objects/a.yaml"])),
      {
        kind: "restart",
      },
    );
  });
});
