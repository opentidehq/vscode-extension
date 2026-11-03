import * as assert from "node:assert/strict";
import {
  cellText,
  filterRows,
  formatRows,
  sortKind,
  sortRows,
  toCsv,
  toJsonl,
  toMarkdown,
} from "../../../src/features/query/format";
import {
  applyProgress,
  formatMs,
  keepable,
  pendingTabs,
  progressFromEvent,
  tabSummary,
  tabsFromDocument,
} from "../../../src/features/query/results";

// A Sentinel rule on two tenants, one answering 403 (the shape of `opentide --json query`).
const DOCUMENT = {
  platform: "sentinel",
  source: "rule",
  tenants: ["prod", "dev"],
  results: [
    {
      tenant: "prod",
      status: "ok",
      columns: [
        { name: "TimeGenerated", type: "datetime" },
        { name: "DeviceName", type: "string" },
        { name: "Count", type: "long" },
      ],
      rows: [
        { TimeGenerated: "2026-11-03T09:12:44Z", DeviceName: "ws-0142", Count: 10 },
        { TimeGenerated: "2026-11-03T08:00:00Z", DeviceName: "ws, 7", Count: 2 },
        { TimeGenerated: null, DeviceName: 'say "hi"', Count: null },
      ],
      row_count: 3,
      truncated: true,
      sent: "SecurityEvent | take 3",
      vendor_query_id: "q-1",
      warnings: [],
      elapsed_ms: 1800,
    },
    {
      tenant: "dev",
      status: "failed",
      error: "HTTP 403 Forbidden",
      detail: "AuthorizationFailed",
      warnings: [],
      elapsed_ms: 40,
    },
  ],
  exit_code: 1,
};

describe("query results (#17)", () => {
  it("makes one result tab and one error tab", () => {
    const [ok, failed] = tabsFromDocument(DOCUMENT);
    assert.equal(ok?.status, "ok");
    assert.equal(ok?.rows.length, 3);
    assert.equal(ok?.truncated, true);
    assert.equal(ok?.sent, "SecurityEvent | take 3");
    assert.equal(ok?.vendorQueryId, "q-1");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, "HTTP 403 Forbidden");
    assert.equal(failed?.detail, "AuthorizationFailed");
    assert.ok(ok && failed);
    assert.equal(tabSummary(ok), "3 rows+ · 1.8 s");
    assert.equal(tabSummary(failed), "failed · 40 ms");
  });

  it("exports the first tab as CSV, as opentide query --format csv quotes it", () => {
    const [ok] = tabsFromDocument(DOCUMENT);
    assert.ok(ok);
    assert.equal(
      toCsv(ok.columns, ok.rows),
      'TimeGenerated,DeviceName,Count\r\n2026-11-03T09:12:44Z,ws-0142,10\r\n2026-11-03T08:00:00Z,"ws, 7",2\r\n,"say ""hi""",\r\n',
    );
  });

  it("takes columns from the rows when the platform names none", () => {
    const [tab] = tabsFromDocument({ results: [{ tenant: "t", status: "ok", rows: [{ a: 1 }, { b: 2 }] }] });
    assert.deepEqual(
      tab?.columns.map((c) => c.name),
      ["a", "b"],
    );
  });

  it("sorts by type, empty values last, and filters in one or every column", () => {
    const [ok] = tabsFromDocument(DOCUMENT);
    assert.ok(ok);
    const count = ok.columns[2];
    const time = ok.columns[0];
    assert.ok(count && time);
    assert.equal(sortKind(count, ok.rows), "number");
    assert.equal(sortKind(time, ok.rows), "date");
    assert.deepEqual(
      sortRows(ok.rows, "Count", "number", false).map((r) => r.Count),
      [2, 10, null],
    );
    assert.deepEqual(
      sortRows(ok.rows, "Count", "number", true).map((r) => r.Count),
      [10, 2, null],
    );
    assert.deepEqual(
      sortRows(ok.rows, "TimeGenerated", "date", false).map((r) => r.DeviceName),
      ["ws, 7", "ws-0142", 'say "hi"'],
    );
    assert.equal(filterRows(ok.rows, ok.columns, "WS-").length, 1);
    assert.equal(filterRows(ok.rows, ok.columns, "10", "DeviceName").length, 0);
    assert.equal(filterRows(ok.rows, ok.columns, "  ").length, 3);
  });

  it("writes JSONL, JSON and Markdown", () => {
    const columns = [{ name: "a" }, { name: "b|c" }];
    const rows = [{ a: { x: 1 }, "b|c": "l1\nl2" }];
    assert.equal(toJsonl(columns, rows), '{"a":{"x":1},"b|c":"l1\\nl2"}\n');
    assert.equal(toMarkdown(columns, rows), '| a | b\\|c |\n| --- | --- |\n| {"x":1} | l1<br>l2 |\n');
    assert.deepEqual(JSON.parse(formatRows("json", columns, rows)), [{ a: { x: 1 }, "b|c": "l1\nl2" }]);
    assert.equal(cellText(null), "");
    assert.equal(cellText(true), "true");
  });

  it("shows tenant progress events (opentide#756) before the rows arrive", () => {
    const event = {
      event: "tenant",
      platform: "sentinel",
      tenant: "prod",
      status: "ok",
      rows: 120,
      elapsed_ms: 1800,
    };
    const progress = progressFromEvent(event);
    assert.ok(progress);
    const tabs = applyProgress(pendingTabs(["prod", "dev"]), progress);
    const [prod, dev] = tabs;
    assert.ok(prod && dev);
    assert.equal(prod.status, "ok");
    assert.equal(prod.rowCount, 120);
    assert.equal(dev.status, "pending");
    assert.equal(tabSummary(prod), "120 rows · 1.8 s");
    // A run with no tenant list gains a tab per event.
    assert.equal(applyProgress([], progress).length, 1);
    assert.equal(progressFromEvent({ event: "progress", step: "x" }), undefined);
  });

  it("formats durations", () => {
    assert.equal(formatMs(250), "250 ms");
    assert.equal(formatMs(1800), "1.8 s");
    assert.equal(formatMs(125_000), "2 min 5 s");
  });
});

describe("query: results kept from a closed panel (opentide.query.retainResults)", () => {
  it("keeps a finished run, never one closed while running", () => {
    assert.equal(keepable({ phase: "running" }), false);
    assert.equal(keepable(undefined), false);
    for (const phase of ["done", "failed", "cancelled"]) assert.equal(keepable({ phase }), true);
  });
});
