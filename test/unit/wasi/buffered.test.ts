import * as assert from "node:assert/strict";

import { Buffered } from "../../../src/core/wasi/buffered";

describe("Buffered (a stream's replay buffer)", () => {
  it("holds what arrives before anyone listens and replays it to the first listener", () => {
    const out = new Buffered<string>();
    out.push("a");
    out.push("b");
    const heard: string[] = [];
    out.listen((value) => heard.push(value));
    out.push("c");
    assert.deepEqual(heard, ["a", "b", "c"]);
  });

  it("gives every listener what comes after it subscribes: a second subscriber misses nothing from then on", () => {
    const out = new Buffered<string>();
    out.push("early");
    const first: string[] = [];
    const second: string[] = [];
    out.listen((value) => first.push(value));
    out.push("x");
    out.listen((value) => second.push(value));
    out.push("y");
    assert.deepEqual(first, ["early", "x", "y"], "the first listener still hears everything");
    assert.deepEqual(
      second,
      ["y"],
      "the second hears what comes after it subscribed, and replay is not repeated",
    );
  });

  it("does not drop the first listener when a second subscribes (it replaced it before)", () => {
    const out = new Buffered<number>();
    const first: number[] = [];
    out.listen((value) => first.push(value));
    out.listen(() => undefined);
    out.push(1);
    assert.deepEqual(first, [1]);
  });

  it("latches a fact: an exit that came before the listener, or that a second listener asks for, is still heard", () => {
    const close = new Buffered<[number | null, string | null]>(true);
    close.push([0, null]);
    const first: unknown[] = [];
    const late: unknown[] = [];
    close.listen((value) => first.push(value));
    close.listen((value) => late.push(value));
    assert.deepEqual(first, [[0, null]]);
    assert.deepEqual(late, [[0, null]]);
    const after = new Buffered<number>(true);
    const heard: number[] = [];
    after.listen((value) => heard.push(value));
    after.push(7);
    after.listen((value) => heard.push(value + 100));
    assert.deepEqual(heard, [7, 107]);
  });
});
