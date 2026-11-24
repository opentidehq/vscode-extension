// The pick-from-a-list messages (a QuickPick in place of a native <select>): validation, the mapping to
// QuickPick items, and the answer.
import * as assert from "node:assert/strict";

import {
  CURRENT_MARK,
  isPickRequest,
  isPickResult,
  MAX_PICK_ITEMS,
  type PickRequest,
  pickLabel,
  pickResult,
  pickToHost,
  pickToWebview,
  quickPickEntries,
} from "../../../src/core/webview/pick";
import { acceptMessage } from "../../../src/core/webview/protocol";

const request: PickRequest = {
  id: "pick-1",
  title: "Filter in column",
  items: [
    { value: "", label: "all columns" },
    { value: "DeviceName", label: "DeviceName", description: "string" },
    { value: "count_", label: "count_", detail: "long" },
  ],
  current: ["DeviceName"],
};

describe("pick protocol", () => {
  it("accepts a request and rejects what is malformed", () => {
    assert.equal(isPickRequest(request), true);
    assert.equal(isPickRequest({ ...request, canPickMany: true }), true);
    assert.equal(isPickRequest({ ...request, id: "" }), false, "an id is needed");
    assert.equal(isPickRequest({ ...request, id: "x".repeat(65) }), false);
    assert.equal(isPickRequest({ ...request, items: "no" }), false);
    assert.equal(isPickRequest({ ...request, items: [{ value: 1, label: "a" }] }), false);
    assert.equal(
      isPickRequest({ ...request, items: [{ value: "a", label: "" }] }),
      false,
      "a label is needed",
    );
    assert.equal(isPickRequest({ ...request, current: [1] }), false);
    assert.equal(isPickRequest({ ...request, canPickMany: "yes" }), false);
    assert.equal(isPickRequest({ ...request, title: 3 }), false);
    assert.equal(isPickRequest(null), false);
    assert.equal(
      isPickRequest({ ...request, items: [request.items[0], request.items[0]] }),
      false,
      "two items with one value cannot be told apart in the answer",
    );
  });

  it("bounds what a webview can ask the host to show", () => {
    const many = Array.from({ length: MAX_PICK_ITEMS + 1 }, (_, i) => ({ value: `v${i}`, label: `v${i}` }));
    assert.equal(isPickRequest({ ...request, items: many.slice(0, MAX_PICK_ITEMS) }), true);
    assert.equal(isPickRequest({ ...request, items: many }), false);
    assert.equal(isPickRequest({ ...request, items: [{ value: "a", label: "x".repeat(501) }] }), false);
  });

  it("accepts the answer, dismissed or chosen", () => {
    assert.equal(isPickResult({ id: "pick-1", values: ["a"] }), true);
    assert.equal(isPickResult({ id: "pick-1", values: [] }), true);
    assert.equal(isPickResult({ id: "pick-1", values: null }), true);
    assert.equal(isPickResult({ id: "pick-1" }), false);
    assert.equal(isPickResult({ id: "pick-1", values: [1] }), false);
    assert.equal(isPickResult({ values: null }), false);
  });

  it("travels as `pick` to the host and `picked` to the webview, through the message validators", () => {
    assert.equal(acceptMessage({ type: "pick", payload: request }, pickToHost)?.type, "pick");
    assert.equal(acceptMessage({ type: "pick", payload: { id: "" } }, pickToHost), undefined);
    assert.equal(acceptMessage({ type: "other", payload: request }, pickToHost), undefined);
    assert.equal(
      acceptMessage({ type: "picked", payload: { id: "a", values: null } }, pickToWebview)?.type,
      "picked",
    );
    assert.equal(acceptMessage({ type: "picked", payload: 3 }, pickToWebview), undefined);
  });
});

describe("pick items and answers", () => {
  it("marks the current choice of a single pick, keeping its own description", () => {
    const entries = quickPickEntries(request);
    assert.deepEqual(
      entries.map((e) => e.label),
      ["all columns", "DeviceName", "count_"],
      "in the order given",
    );
    assert.equal(entries[0]?.description, undefined);
    assert.equal(entries[1]?.description, `string · ${CURRENT_MARK}`);
    assert.equal(entries[2]?.detail, "long");
    assert.equal(quickPickEntries({ ...request, current: [""] })[0]?.description, CURRENT_MARK);
    assert.ok(
      entries.every((e) => e.picked === undefined),
      "`picked` is for a multi-pick",
    );
  });

  it("starts a multi-pick with the current values picked, and does not mark them", () => {
    const entries = quickPickEntries({ ...request, canPickMany: true, current: ["DeviceName", "count_"] });
    assert.deepEqual(
      entries.map((e) => e.picked),
      [false, true, true],
    );
    assert.equal(entries[1]?.description, "string", "no `current` mark: the check box says it");
  });

  it("answers with the values chosen, or null when the picker was dismissed", () => {
    const entries = quickPickEntries(request);
    assert.deepEqual(pickResult(request, entries[2]), { id: "pick-1", values: ["count_"] });
    assert.deepEqual(
      pickResult(
        request,
        [entries[1], entries[2]].flatMap((e) => (e ? [e] : [])),
      ),
      {
        id: "pick-1",
        values: ["DeviceName", "count_"],
      },
    );
    assert.deepEqual(pickResult(request, []), { id: "pick-1", values: [] }, "a multi-pick may choose none");
    assert.deepEqual(pickResult(request, undefined), { id: "pick-1", values: null }, "Escape");
  });

  it("labels the button with the current item, else the first", () => {
    assert.equal(pickLabel(request.items, ["DeviceName"]), "DeviceName");
    assert.equal(pickLabel(request.items, ["gone"]), "all columns");
    assert.equal(pickLabel(request.items, ["DeviceName", "count_"]), "DeviceName, count_");
    assert.equal(pickLabel([], [""]), "");
  });
});
