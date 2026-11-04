import * as assert from "node:assert/strict";
import { arrowDirection, nodeInDirection } from "../../../src/features/graph/navigate";

describe("graph keyboard navigation", () => {
  const from = { x: 0, y: 0 };
  const neighbours = [
    ["right", { x: 200, y: 10 }],
    ["far-right", { x: 400, y: 0 }],
    ["left", { x: -200, y: 0 }],
    ["below", { x: 10, y: 60 }],
  ] as const;

  it("reads the arrow keys", () => {
    assert.equal(arrowDirection("ArrowLeft"), "left");
    assert.equal(arrowDirection("ArrowDown"), "down");
    assert.equal(arrowDirection("Enter"), undefined);
  });

  it("moves to the closest neighbour that way", () => {
    assert.equal(nodeInDirection(from, "right", neighbours), "right");
    assert.equal(nodeInDirection(from, "left", neighbours), "left");
    assert.equal(nodeInDirection(from, "down", neighbours), "below");
    assert.equal(nodeInDirection(from, "up", neighbours), undefined);
  });

  it("falls back to any node that way when no neighbour lies there", () => {
    const everyone = [...neighbours, ["above", { x: -30, y: -80 }]] as const;
    assert.equal(nodeInDirection(from, "up", neighbours, everyone), "above");
  });

  it("ignores what lies more than 60 degrees off the arrow", () => {
    assert.equal(nodeInDirection(from, "right", [["steep", { x: 10, y: 100 }]]), undefined);
  });
});
