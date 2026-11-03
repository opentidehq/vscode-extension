import * as assert from "node:assert/strict";
import {
  cellText,
  clampFocus,
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
  exportable,
  formatMs,
  keepable,
  pendingTabs,
  progressFromEvent,
  queryViewState,
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

describe("query: what Copy and Export act on", () => {
  const [pending] = pendingTabs(["B"]);
  const tab = (overrides: object) => ({ ...(pending as NonNullable<typeof pending>), ...overrides });
  it("only a finished tab of its own rows: never a failed or empty one, whose table holds another's", () => {
    const ok = tab({ status: "ok", rows: [{ a: 1 }], columns: [{ name: "a" }] });
    assert.equal(exportable(ok, "done"), true);
    assert.equal(exportable(ok, "running"), false);
    assert.equal(exportable(tab({ status: "failed" }), "done"), false);
    assert.equal(exportable(tab({ status: "ok", rows: [] }), "done"), false);
    assert.equal(exportable(pending, "done"), false);
    assert.equal(exportable(undefined, "done"), false);
  });
});

describe("query: the table's focus and view across tabs", () => {
  it("moves a focused cell into a tab with fewer columns or rows", () => {
    assert.deepEqual(clampFocus({ row: 4, column: 8 }, 10, 3), { row: 4, column: 2 });
    assert.deepEqual(clampFocus({ row: 40, column: 1 }, 10, 3), { row: 9, column: 1 });
    assert.deepEqual(clampFocus({ row: 3, column: 3 }, 0, 0), { row: 0, column: 0 });
  });

  it("keeps the selected tab, filter and sort, and nothing it cannot read", () => {
    const state = {
      selected: "prod",
      table: { filter: "lsass", filterColumn: "User", sort: { column: "Time", descending: true } },
    };
    assert.deepEqual(queryViewState(JSON.parse(JSON.stringify(state))), state);
    assert.deepEqual(queryViewState({ selected: 3, table: { filter: 1 } }), {});
    assert.deepEqual(queryViewState(undefined), {});
    assert.deepEqual(queryViewState({ table: { filter: "", filterColumn: "", sort: { column: 1 } } }), {
      table: { filter: "", filterColumn: "" },
    });
  });
});
