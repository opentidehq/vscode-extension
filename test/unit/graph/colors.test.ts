import * as assert from "node:assert/strict";
import { canvasColor } from "../../../src/features/graph/colors";

describe("graph colours", () => {
  it("turns theme hex colours into rgb with opacity", () => {
    assert.deepEqual(canvasColor("#f14c4c", "#000"), { color: "rgb(241, 76, 76)", opacity: 1 });
    assert.deepEqual(canvasColor("#fff", "#000"), { color: "rgb(255, 255, 255)", opacity: 1 });
    assert.deepEqual(canvasColor("#ea5c0055", "#000"), { color: "rgb(234, 92, 0)", opacity: 0.333 });
    assert.deepEqual(canvasColor("#0008", "#000"), { color: "rgb(0, 0, 0)", opacity: 0.533 });
  });

  it("reads rgb() and rgba(), in either syntax", () => {
    assert.deepEqual(canvasColor("rgba(10, 20, 30, 0.5)", ""), { color: "rgb(10, 20, 30)", opacity: 0.5 });
    assert.deepEqual(canvasColor("rgb(10 20 30 / 40%)", ""), { color: "rgb(10, 20, 30)", opacity: 0.4 });
  });

  it("falls back when a variable is unset, and passes other colours through", () => {
    assert.deepEqual(canvasColor("", "#010203"), { color: "rgb(1, 2, 3)", opacity: 1 });
    assert.deepEqual(canvasColor(undefined, ""), { color: "rgb(128, 128, 128)", opacity: 1 });
    assert.deepEqual(canvasColor("Canvas", "#000"), { color: "Canvas", opacity: 1 });
  });
});
