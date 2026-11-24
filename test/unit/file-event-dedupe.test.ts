import * as assert from "node:assert/strict";

import { RecentFileEvents } from "../../src/core/services/fileEventDedupe";

describe("a file event two watchers report (E3)", () => {
  it("drops the second of the same URI and type within the window, and lets it through after", () => {
    let now = 1000;
    const recent = new RecentFileEvents(500, () => now);
    assert.equal(recent.isDuplicate("file:///ws/objects/a.yaml", 2), false);
    now += 20;
    assert.equal(recent.isDuplicate("file:///ws/objects/a.yaml", 2), true, "the other watcher's copy");
    now += 600;
    assert.equal(recent.isDuplicate("file:///ws/objects/a.yaml", 2), false, "a later change is a new event");
  });

  it("keeps different files and different kinds of event apart", () => {
    const recent = new RecentFileEvents(500, () => 1000);
    assert.equal(recent.isDuplicate("file:///ws/objects/a.yaml", 2), false);
    assert.equal(recent.isDuplicate("file:///ws/objects/b.yaml", 2), false);
    assert.equal(recent.isDuplicate("file:///ws/objects/a.yaml", 1), false, "created, not changed");
    assert.equal(recent.isDuplicate("file:///ws/objects/a.yaml", 3), false, "deleted");
  });

  it("forgets old events, so the memory stays bounded", () => {
    let now = 0;
    const recent = new RecentFileEvents(500, () => now);
    for (let i = 0; i < 2500; i += 1) {
      recent.isDuplicate(`file:///ws/objects/${i}.yaml`, 2);
      now += 1;
    }
    now += 1000;
    assert.equal(recent.isDuplicate("file:///ws/objects/0.yaml", 2), false);
  });
});
