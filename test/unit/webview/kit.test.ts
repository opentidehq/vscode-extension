// The panels kit's vscode-free and DOM-free pieces: component render functions (VNodes), placement and
// the panel pool, window math, column sizing, keyed updates, menus.
import * as assert from "node:assert/strict";
import {
  gridTemplate,
  initialWidths,
  keyboardResizeDelta,
  resizeColumn,
} from "../../../src/core/webview/kit/columns";
import {
  button,
  callout,
  chip,
  collapsible,
  emptyState,
  errorState,
  icon,
  nextOption,
  progressBar,
  segmented,
  skeletonRows,
  statCard,
  stepper,
  toolbar,
} from "../../../src/core/webview/kit/components";
import { fingerprint, keyedPlan } from "../../../src/core/webview/kit/keyed";
import { menuMove, placePopup } from "../../../src/core/webview/kit/menu";
import { pageRows, revealRow, rowWindow } from "../../../src/core/webview/kit/virtual";
import {
  cx,
  findByClass,
  takeFocusIntent,
  textOf,
  type UiEvent,
  type VNode,
  walk,
} from "../../../src/core/webview/kit/vnode";
import {
  fileColumnFrom,
  PanelPool,
  panelTitle,
  placement,
  shorten,
} from "../../../src/core/webview/placement";

const key = (k: string): UiEvent & { prevented: boolean } => {
  const event = {
    type: "keydown",
    key: k,
    currentTarget: undefined,
    target: undefined,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
    stopPropagation() {},
  };
  return event;
};

const byRole = (node: VNode, role: string) => walk(node).filter((n) => n.props.attrs?.role === role);

describe("panels kit: components", () => {
  it("icons are codicons, decorative unless labelled", () => {
    assert.equal(icon("globe").props.class, "codicon codicon-globe");
    assert.equal(icon("globe").props.attrs?.["aria-hidden"], "true");
    assert.deepEqual(icon("globe", "Contacts tenants").props.attrs, {
      role: "img",
      "aria-label": "Contacts tenants",
      title: "Contacts tenants",
    });
    assert.equal(cx("a", false, null, "b", undefined), "a b");
  });

  it("buttons: primary by default, icon-only ones named by their label, toggles pressed", () => {
    const primary = button({ label: "Re-run", icon: "globe" });
    assert.equal(primary.props.class, "ot-btn");
    assert.equal(textOf(primary).trim(), "Re-run");
    const lock = button({ label: "Lock", variant: "icon", icon: "lock", pressed: true });
    assert.equal(lock.props.attrs?.["aria-label"], "Lock");
    assert.equal(lock.props.attrs?.["aria-pressed"], "true");
    assert.equal(lock.props.title, "Lock", "an icon button's tooltip is its name");
    assert.equal(textOf(lock), "", "no visible text");
    assert.equal(button({ label: "x", disabled: true }).props.attrs?.disabled, true);
  });

  it("the toolbar puts the object and its context on the left and the actions on the right", () => {
    const bar = toolbar({
      title: "LSASS handle opened by unsigned process",
      context: [chip({ text: "Sentinel" })],
      actions: [button({ label: "Re-run" })],
      label: "Query",
    });
    assert.equal(bar.tag, "header");
    const [start, end] = bar.children as VNode[];
    assert.equal(start?.props.class, "ot-toolbar-start");
    assert.equal(findByClass(start, "ot-title")?.tag, "h1");
    assert.equal(end?.props.attrs?.role, "toolbar");
    assert.equal(end?.props.attrs?.["aria-label"], "Query");
    assert.equal(toolbar({ title: "x" }).children[1], null, "no actions, no end region");
  });

  it("the segmented control is a radio group with one tab stop, moved by the arrow keys", () => {
    const changes: string[] = [];
    const options = [
      { value: "changed", label: "Changed" },
      { value: "all", label: "All" },
      { value: "selected", label: "Only this rule", disabled: true },
    ];
    const control = segmented({
      name: "scope",
      label: "Scope",
      value: "changed",
      options,
      onChange: (v) => changes.push(v),
    });
    assert.equal(control.props.attrs?.role, "radiogroup");
    const radios = byRole(control, "radio");
    assert.deepEqual(
      radios.map((r) => [r.props.attrs?.["aria-checked"], r.props.attrs?.tabindex, r.props.attrs?.disabled]),
      [
        ["true", 0, false],
        ["false", -1, false],
        ["false", -1, true],
      ],
    );
    const down = key("ArrowRight");
    radios[0]?.props.on?.keydown?.(down);
    assert.equal(down.prevented, true);
    assert.deepEqual(changes, ["all"]);
    assert.equal(takeFocusIntent(), "scope:all", "the re-render gives the focus to the new choice");
    assert.equal(takeFocusIntent(), undefined, "taken once");
    // Wraps, skipping the disabled option; Home and End.
    assert.equal(nextOption(options, "all", "ArrowRight")?.value, "changed");
    assert.equal(nextOption(options, "changed", "ArrowLeft")?.value, "all");
    assert.equal(nextOption(options, "all", "Home")?.value, "changed");
    assert.equal(nextOption(options, "changed", "End")?.value, "all");
    assert.equal(nextOption(options, "changed", "a"), undefined);
    // A click on the checked one changes nothing.
    radios[0]?.props.on?.click?.(key("x"));
    assert.deepEqual(changes, ["all"]);
  });

  it("the progress bar is always in the page (no layout shift) and hidden from readers when idle", () => {
    const idle = progressBar({ active: false, label: "Planning" });
    assert.equal(idle.props.class, "ot-progress");
    assert.equal(idle.props.attrs?.["aria-hidden"], "true");
    const busy = progressBar({ active: true, label: "Planning" });
    assert.equal(busy.props.class, "ot-progress active");
    assert.equal(busy.props.attrs?.["aria-hidden"], undefined);
    const half = progressBar({ active: true, label: "Applying", value: 0.5 });
    assert.equal(half.props.attrs?.["aria-valuenow"], 50);
    assert.deepEqual((half.children[0] as VNode).props.style, { width: "50%" });
  });

  it("skeleton rows take the shape of the data that is coming", () => {
    const rows = skeletonRows({ rows: 12, columns: 5 });
    assert.equal(rows.children.length, 12);
    assert.equal((rows.children[0] as VNode).children.length, 5);
    assert.equal(rows.props.attrs?.["aria-busy"], "true");
  });

  it("empty and error states: one primary action, Show output for the log", () => {
    const ran: string[] = [];
    const empty = emptyState({ title: "No rows", body: "Nothing matched in last 24h." });
    assert.equal(empty.props.attrs?.role, "status");
    assert.equal(findByClass(empty, "ot-state-actions"), undefined, "no actions, no button row");
    const error = errorState({
      title: "prod refused the credentials",
      code: "AuthorizationFailed",
      action: { label: "Set Credential…", run: () => ran.push("set") },
      secondary: [{ label: "Tenants and window…", run: () => ran.push("edit") }],
      onShowOutput: () => ran.push("output"),
    });
    assert.equal(error.props.attrs?.role, "alert");
    const buttons = walk(error).filter((n) => n.tag === "button");
    assert.deepEqual(
      buttons.map((b) => [textOf(b).trim(), b.props.class]),
      [
        ["Set Credential…", "ot-btn"],
        ["Tenants and window…", "ot-btn secondary"],
        ["Show output", "ot-btn secondary"],
      ],
    );
    for (const b of buttons) b.props.on?.click?.(key("x"));
    assert.deepEqual(ran, ["set", "edit", "output"]);
    assert.equal(findByClass(error, "ot-state-code")?.props.text, "AuthorizationFailed");
  });

  it("callouts carry their tone and role", () => {
    assert.equal(callout({ tone: "error", body: "No rule matches" }).props.attrs?.role, "alert");
    const note = callout({
      tone: "warning",
      title: "No tenant configured.",
      body: "x",
      actions: [{ label: "Open configuration", run: () => undefined }],
    });
    assert.equal(note.props.class, "ot-callout warning");
    assert.equal(note.props.attrs?.role, "note");
    assert.match(textOf(note), /No tenant configured\. x/);
    assert.equal(findByClass(note, "link")?.tag, "button");
  });

  it("collapsible sections: open state, count, and a toggle handler", () => {
    const toggles: boolean[] = [];
    const section = collapsible({
      id: "platform:sentinel",
      title: "Microsoft Sentinel",
      count: 81,
      countLabel: "changes",
      open: true,
      onToggle: (open) => toggles.push(open),
      children: ["…"],
    });
    assert.equal(section.tag, "details");
    assert.equal(section.props.attrs?.open, true);
    assert.equal(findByClass(section, "ot-badge")?.props.attrs?.["aria-label"], "81 changes");
    section.props.on?.toggle?.({ ...key("x"), type: "toggle", currentTarget: { open: false } });
    assert.deepEqual(toggles, [false]);
  });

  it("stat cards name their value and label together", () => {
    const card = statCard({ label: "create", value: 12, icon: "diff-added", tone: "create" });
    assert.equal(card.props.attrs?.["aria-label"], "12 create");
    assert.equal(statCard({ label: "delete", value: 0, dim: true }).props.class, "ot-card dim");
  });

  it("the stepper marks done, current, invalid and to-do steps and moves with the arrow keys", () => {
    const selected: string[] = [];
    const view = stepper({
      label: "Setup steps",
      steps: [
        { id: "0", label: "Repository", state: "invalid", number: 1 },
        { id: "1", label: "Platforms", state: "current", number: 2 },
        { id: "2", label: "CI", state: "todo", number: 3 },
      ],
      onSelect: (id) => selected.push(id),
    });
    const tabs = byRole(view, "tab");
    assert.deepEqual(
      tabs.map((t) => [t.props.class, t.props.attrs?.["aria-selected"], t.props.attrs?.tabindex]),
      [
        ["ot-step invalid", "false", -1],
        ["ot-step current", "true", 0],
        ["ot-step todo", "false", -1],
      ],
    );
    assert.equal(tabs[0]?.props.attrs?.["aria-label"], "Step 1: Repository, needs attention");
    tabs[1]?.props.on?.keydown?.(key("ArrowRight"));
    tabs[1]?.props.on?.keydown?.(key("Home"));
    assert.deepEqual(selected, ["2", "0"]);
    assert.equal(takeFocusIntent(), "step:0");
  });
});

describe("panels kit: placement and the panel pool", () => {
  interface Entry {
    target: string;
    locked: boolean;
  }

  it("reveals the panel that shows the object, else retargets the most recent unlocked one", () => {
    const pool = new PanelPool<string, Entry>((a, b) => a === b);
    assert.deepEqual(pool.choose("a"), { kind: "create" });
    const first: Entry = { target: "a", locked: false };
    pool.add(first);
    assert.deepEqual(pool.choose("a"), { kind: "reveal", entry: first });
    assert.deepEqual(pool.choose("b"), { kind: "retarget", entry: first });
    first.locked = true;
    assert.deepEqual(pool.choose("b"), { kind: "create" }, "a locked panel keeps its object");
    assert.deepEqual(pool.choose("a"), { kind: "reveal", entry: first }, "and is still found for it");
    const second: Entry = { target: "b", locked: false };
    const third: Entry = { target: "c", locked: false };
    pool.add(second);
    pool.add(third);
    assert.equal((pool.choose("d") as { entry: Entry }).entry, third, "the most recently used");
    pool.touch(second);
    assert.equal((pool.choose("d") as { entry: Entry }).entry, second, "after it became active");
    pool.remove(second);
    assert.equal(pool.size, 2);
    assert.equal((pool.choose("d") as { entry: Entry }).entry, third);
  });

  it("titles say the object, shortened at a word", () => {
    assert.equal(
      panelTitle("Query", "LSASS handle opened by unsigned process", "Sentinel"),
      "Query · LSASS handle opened by… · Sentinel",
    );
    assert.equal(panelTitle("Deploy Plan", null), "Deploy Plan");
    assert.equal(shorten("short"), "short");
    assert.equal(shorten("a".repeat(40)), `${"a".repeat(27)}…`, "no word boundary: cut");
    assert.equal(shorten("  spaced   out  "), "spaced out");
  });

  it("opens beside an editor without taking its focus; files from a panel open next to it", () => {
    assert.deepEqual(placement(true), { beside: true, preserveFocus: true });
    assert.deepEqual(placement(false), { beside: false, preserveFocus: false });
    assert.equal(fileColumnFrom(2), 1, "a panel beside the editor opens files in the editor's group");
    assert.equal(fileColumnFrom(1), undefined, "a panel in the first group: beside it");
    assert.equal(fileColumnFrom(undefined), undefined);
  });
});

describe("panels kit: virtual window, columns, keyed updates, menus", () => {
  it("draws only the rows in view, plus the overscan", () => {
    assert.deepEqual(
      rowWindow({ scrollTop: 0, viewportHeight: 240, rowHeight: 24, count: 10_000, overscan: 5 }),
      { first: 0, last: 15, offset: 0, total: 240_000 },
    );
    const middle = rowWindow({
      scrollTop: 24_000,
      viewportHeight: 240,
      rowHeight: 24,
      count: 10_000,
      overscan: 5,
      headerHeight: 24,
    });
    assert.equal(middle.first, 994);
    assert.equal(middle.last, 1014);
    assert.equal(middle.offset, 994 * 24);
    assert.deepEqual(rowWindow({ scrollTop: 0, viewportHeight: 0, rowHeight: 24, count: 3 }), {
      first: 0,
      last: 3,
      offset: 0,
      total: 72,
    });
    assert.deepEqual(rowWindow({ scrollTop: 500, viewportHeight: 100, rowHeight: 24, count: 0 }), {
      first: 0,
      last: 0,
      offset: 0,
      total: 0,
    });
    assert.equal(pageRows(240, 24), 9);
  });

  it("scrolls a focused row into view below a sticky header, and leaves it when it is in view", () => {
    assert.equal(
      revealRow({ row: 5, rowHeight: 24, scrollTop: 0, viewportHeight: 240, headerHeight: 24 }),
      undefined,
    );
    assert.equal(revealRow({ row: 2, rowHeight: 24, scrollTop: 120, viewportHeight: 240 }), 48);
    assert.equal(
      revealRow({ row: 20, rowHeight: 24, scrollTop: 0, viewportHeight: 240, headerHeight: 24 }),
      288,
    );
  });

  it("sizes columns from the header and a sample, and resizes within bounds", () => {
    const lengths = [
      [3, 4],
      [40, 2],
    ];
    const widths = initialWidths(["Time", "Device"], (c, r) => lengths[r]?.[c] ?? 0, 2);
    assert.equal(widths.length, 2);
    assert.ok((widths[0] ?? 0) > (widths[1] ?? 0), "the longer column is wider");
    assert.equal(initialWidths(["x"], () => 10_000, 1)[0], 420, "capped");
    assert.equal(initialWidths(["x"], () => 0, 0)[0], 80, "a floor");
    let samples = 0;
    initialWidths(
      ["a"],
      () => {
        samples++;
        return 1;
      },
      10_000,
    );
    assert.equal(samples, 200, "a sample, not every row");
    assert.deepEqual(resizeColumn([100, 200], 1, 50), [100, 250]);
    assert.deepEqual(resizeColumn([100, 200], 0, -500), [48, 200]);
    assert.deepEqual(resizeColumn([100], 0, 5000), [1200]);
    assert.equal(keyboardResizeDelta("ArrowRight", false), 16);
    assert.equal(keyboardResizeDelta("ArrowLeft", true), -64);
    assert.equal(keyboardResizeDelta("Enter", false), 0);
    assert.equal(gridTemplate([80, 120]), "80px 120px");
  });

  it("plans keyed updates: what leaves, arrives and stays, and whether order changes", () => {
    assert.deepEqual(keyedPlan(["a", "b", "c"], ["a", "c", "d"]), {
      remove: ["b"],
      add: ["d"],
      keep: ["a", "c"],
      reorder: false,
    });
    assert.equal(keyedPlan(["a", "b"], ["b", "a"]).reorder, true);
    assert.equal(keyedPlan(["a", "b"], ["x", "a", "b"]).reorder, true, "a new key first moves the rest");
    assert.deepEqual(keyedPlan([], []), { remove: [], add: [], keep: [], reorder: false });
    assert.equal(fingerprint({ a: 1 }), fingerprint({ a: 1 }));
    assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  });

  it("moves through a menu's enabled items and places popups inside the viewport", () => {
    const enabled = [true, false, true];
    assert.equal(menuMove("ArrowDown", -1, enabled), 0);
    assert.equal(menuMove("ArrowDown", 0, enabled), 2, "skips the disabled item");
    assert.equal(menuMove("ArrowDown", 2, enabled), 0, "wraps");
    assert.equal(menuMove("ArrowUp", 0, enabled), 2);
    assert.equal(menuMove("End", 0, enabled), 2);
    assert.equal(menuMove("Home", 2, enabled), 0);
    assert.equal(menuMove("x", 0, enabled), undefined);
    assert.equal(menuMove("ArrowDown", 0, [false]), undefined);
    const viewport = { width: 800, height: 600 };
    assert.deepEqual(
      placePopup({
        anchor: { left: 700, right: 780, top: 10, bottom: 30 },
        size: { width: 200, height: 100 },
        viewport,
        align: "end",
      }),
      { left: 580, top: 34 },
    );
    assert.deepEqual(
      placePopup({
        anchor: { left: 10, right: 50, top: 560, bottom: 580 },
        size: { width: 200, height: 100 },
        viewport,
      }),
      { left: 10, top: 456 },
      "flipped above when there is no room below",
    );
  });
});
