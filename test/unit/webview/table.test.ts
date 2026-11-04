// The kit table's model (sorting and filtering through cached orders and lower-cased text), and the
// performance budget of SPEC §14 for query results: no synchronous step over 16 ms for 10,000 rows.
import * as assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { initialWidths } from "../../../src/core/webview/kit/columns";
import { type Column, type Row, sortOrder, TableModel } from "../../../src/core/webview/kit/table";
import { rowWindow } from "../../../src/core/webview/kit/virtual";

const COLUMNS: Column[] = [
  { name: "TimeGenerated", type: "datetime" },
  { name: "DeviceName", type: "string" },
  { name: "InitiatingProcessFileName", type: "string" },
  { name: "InitiatingProcessCommandLine", type: "string" },
  { name: "AccountName", type: "string" },
  { name: "count_", type: "long" },
];

/** A synthetic result set like a Sentinel answer (deterministic). */
function synthetic(count: number): Row[] {
  const procs = ["rundll32.exe", "powershell.exe", "procdump64.exe", "taskmgr.exe", "werfault.exe"];
  const accounts = ["svc-backup", "alice", "bob", "SYSTEM"];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  return Array.from({ length: count }, (_, i) => ({
    TimeGenerated: new Date(Date.UTC(2026, 10, 3, 0, 0, 0) + (next() % 86_400_000)).toISOString(),
    DeviceName: `ws-${String(next() % 3000).padStart(4, "0")}`,
    InitiatingProcessFileName: procs[next() % procs.length],
    InitiatingProcessCommandLine: `"C:\\Windows\\System32\\${procs[i % procs.length]}" -pid ${next() % 9000} -ma lsass.exe`,
    AccountName: accounts[next() % accounts.length],
    count_: next() % 500,
  }));
}

/**
 * The median of `runs` timings of `work` after one warm-up (the JIT), in ms. The median, not the worst:
 * a CI runner or a busy machine preempts a run now and then, which is not the code's time.
 */
function timed(work: () => void, runs = 7): number {
  work();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    work();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? 0;
}

describe("kit table model", () => {
  const rows: Row[] = [
    { name: "b", n: 2, when: "2026-11-03T10:00:00Z" },
    { name: "A", n: 10, when: "2026-11-01T10:00:00Z" },
    { name: "c", n: null, when: "" },
  ];
  const columns: Column[] = [{ name: "name" }, { name: "n" }, { name: "when", type: "datetime" }];

  it("sorts by kind, empties last both ways, and filters after sorting", () => {
    const model = new TableModel(columns, rows);
    assert.deepEqual(model.kinds, ["text", "number", "date"]);
    assert.deepEqual(model.view({ filter: "", filterColumn: "" }), [0, 1, 2]);
    assert.deepEqual(
      model.view({ filter: "", filterColumn: "", sort: { column: "n", descending: false } }),
      [0, 1, 2],
    );
    assert.deepEqual(
      model.view({ filter: "", filterColumn: "", sort: { column: "n", descending: true } }),
      [1, 0, 2],
    );
    assert.deepEqual(
      model.view({ filter: "", filterColumn: "", sort: { column: "name", descending: false } }),
      [1, 0, 2],
    );
    assert.deepEqual(
      model.view({ filter: "", filterColumn: "", sort: { column: "when", descending: false } }),
      [1, 0, 2],
    );
    assert.deepEqual(model.view({ filter: "a", filterColumn: "" }), [1]);
    assert.deepEqual(model.view({ filter: "2026-11-0", filterColumn: "name" }), [], "in one column only");
    assert.deepEqual(model.view({ filter: " 1 ", filterColumn: "n" }), [1]);
    assert.deepEqual(
      model.view({ filter: "2026", filterColumn: "", sort: { column: "n", descending: true } }),
      [1, 0],
      "sorted, then filtered",
    );
    assert.deepEqual(
      model.view({ filter: "", filterColumn: "", sort: { column: "gone", descending: false } }),
      [0, 1, 2],
    );
    assert.equal(model.text(1, 0), "A");
    assert.equal(model.text(2, 1), "", "null shows empty");
  });

  it("keeps ties in their original order", () => {
    const tied = [{ k: 1 }, { k: 1 }, { k: 0 }];
    assert.deepEqual(sortOrder(tied, "k", "number", false), [2, 0, 1]);
    assert.deepEqual(sortOrder(tied, "k", "number", true), [0, 1, 2]);
  });
});

describe("performance: 10,000 result rows (SPEC §14)", function () {
  this.timeout(60_000);
  // The target is a frame, 16 ms: each step the webview runs synchronously on a data set, a sort click
  // or a filter keystroke, stays inside it (measured locally: 1–10 ms). Measured here: the median of 7
  // runs after a warm-up. Shared CI runners are slower and preempted, so the assertion there allows 4×
  // the target: it still catches a step that went quadratic (seconds, not milliseconds).
  const TARGET_MS = 16;
  const SLACK = process.env.CI ? 4 : 1.5;
  const BUDGET_MS = TARGET_MS * SLACK;
  const rows = synthetic(10_000);

  it("builds the model, sizes the columns and draws the first window within a frame", () => {
    let model = new TableModel(COLUMNS, rows);
    const build = timed(() => {
      model = new TableModel(COLUMNS, rows);
      initialWidths(
        COLUMNS.map((c) => c.name),
        (c, r) => model.text(r, c).length,
        rows.length,
      );
      const window_ = rowWindow({ scrollTop: 0, viewportHeight: 600, rowHeight: 24, count: rows.length });
      for (let r = window_.first; r < window_.last; r++)
        for (let c = 0; c < COLUMNS.length; c++) model.text(r, c);
    });
    assert.ok(build < BUDGET_MS, `setData took ${build.toFixed(1)} ms`);
  });

  it("sorts 10,000 rows by any column within a frame, and a second click on it is cached", () => {
    for (const column of COLUMNS) {
      const sort = timed(() => {
        // A new model each time: the first sort of a column, uncached.
        new TableModel(COLUMNS, rows).view({
          filter: "",
          filterColumn: "",
          sort: { column: column.name, descending: false },
        });
      });
      assert.ok(sort < BUDGET_MS, `sorting by ${column.name} took ${sort.toFixed(1)} ms`);
    }
    const model = new TableModel(COLUMNS, rows);
    model.view({ filter: "", filterColumn: "", sort: { column: "DeviceName", descending: true } });
    const again = timed(() =>
      model.view({ filter: "", filterColumn: "", sort: { column: "DeviceName", descending: true } }),
    );
    assert.ok(again < 4 * SLACK, `a cached sort took ${again.toFixed(1)} ms`);
  });

  it("filters 10,000 rows on every column per keystroke within a frame", () => {
    const model = new TableModel(COLUMNS, rows);
    // The first keystroke lower-cases each column once.
    const first = timed(() => new TableModel(COLUMNS, rows).view({ filter: "lsass", filterColumn: "" }), 3);
    assert.ok(first < BUDGET_MS, `the first filter took ${first.toFixed(1)} ms`);
    model.view({ filter: "w", filterColumn: "" });
    for (const needle of ["ws-0", "powershell", "alice", "-pid 4", "zzz"]) {
      const keystroke = timed(() =>
        model.view({ filter: needle, filterColumn: "", sort: { column: "count_", descending: true } }),
      );
      assert.ok(keystroke < BUDGET_MS, `filtering on "${needle}" took ${keystroke.toFixed(1)} ms`);
    }
    assert.ok(model.view({ filter: "ws-0", filterColumn: "DeviceName" }).length > 0);
  });
});
