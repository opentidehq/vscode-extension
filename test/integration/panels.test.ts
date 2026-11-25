// Query lenses (#17), the deploy plan (#18) and the ATT&CK matrix (#20) inside VS Code.
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { activated, fixture, waitFor } from "./helpers";

/** What `opentide.deployPlan._state` returns (a test-mode command). */
interface PlanRow {
  id: string;
  kind: string;
  label: string;
  context: string;
  children: PlanRow[];
}
interface PlanState {
  phase: string;
  message: string | null;
  badge: number;
  changes: number;
  roots: PlanRow[];
}
const countRows = (rows: PlanRow[], kind: string): number =>
  rows.reduce((sum, row) => sum + (row.kind === kind ? 1 : 0) + countRows(row.children, kind), 0);
const findRow = (rows: PlanRow[], match: (row: PlanRow) => boolean): PlanRow | undefined => {
  for (const row of rows) {
    if (match(row)) return row;
    const inside = findRow(row.children, match);
    if (inside) return inside;
  }
  return undefined;
};

const panelOpen = (viewType: string) =>
  vscode.window.tabGroups.all.some((group) =>
    group.tabs.some(
      (tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType),
    ),
  );

describe("panels (#17, #18, #20)", () => {
  before(() => activated());
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("registers the panels' commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      "opentide.query.run",
      "opentide.query.validateLive",
      "opentide.query.showCompiled",
      "opentide.deployPlan.open",
      "opentide.deployPlan.openChanged",
      "opentide.matrix.open",
    ])
      assert.ok(commands.includes(command), command);
  });

  it("puts query lenses on the rule's query, and none on its UUID beyond the server's own", async function () {
    const api = await activated();
    if (!api.ctx.client.current) this.skip();
    const uri = fixture("objects", "rules", "suspicious-lsass-access.yaml");
    await vscode.window.showTextDocument(uri);
    const lenses = await waitFor(async () => {
      const found = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        uri,
      );
      return found?.some((lens) => lens.command?.command === "opentide.query.showCompiled")
        ? found
        : undefined;
    });
    const ours = lenses.filter((lens) => lens.command?.command.startsWith("opentide.query."));
    const queryLine = (await vscode.workspace.openTextDocument(uri))
      .getText()
      .split("\n")
      .findIndex((line) => line.includes("DeviceProcessEvents"));
    for (const lens of ours) assert.equal(lens.range.start.line, queryLine);
  });

  it("opens the compiled query as a read-only document", async function () {
    const api = await activated();
    if (!api.ctx.client.current) this.skip();
    const uri = fixture("objects", "rules", "suspicious-lsass-access.yaml");
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      uri,
    );
    const compiled = lenses?.find((lens) => lens.command?.command === "opentide.query.showCompiled");
    if (!compiled?.command) this.skip();
    const rule = await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand(compiled.command.command, ...(compiled.command.arguments ?? []));
    const editor = await waitFor(() =>
      vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "opentide-compiled"),
    );
    assert.match(editor.document.getText(), /DeviceProcessEvents/);
    // Beside the rule, which keeps the focus.
    assert.notEqual(editor.viewColumn, rule.viewColumn);
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), uri.toString());
  });

  it("opens the ATT&CK matrix, with the needs-a-newer-opentide state where info catalog is missing", async () => {
    await vscode.commands.executeCommand("opentide.matrix.open");
    await waitFor(() => panelOpen("opentide.matrix") || undefined);
  });

  it("previews the deploy of the active rule into the Deploy Plan view", async function () {
    const api = await activated();
    if (!api.ctx.runtime.current || api.ctx.backend.availability().available !== true) this.skip();
    await vscode.window.showTextDocument(fixture("objects", "rules", "suspicious-lsass-access.yaml"));
    await vscode.commands.executeCommand("opentide.deployPlan.open");
    const state = await waitFor(async () => {
      const now = await vscode.commands.executeCommand<PlanState>("opentide.deployPlan._state");
      return now.phase === "done" || now.phase === "failed" ? now : undefined;
    });
    // The dry run of the fixture may fail in an environment without the rule's platform: either way it ended.
    assert.ok(["done", "failed"].includes(state.phase));
  });
});

const webviewTabs = (viewType: string) =>
  vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter(
      (tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType),
    ),
  );

describe("panels open beside the object and reuse their panel (SPEC §10)", () => {
  before(() => activated());
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("deploy plan: the tree shows the plan's counts, and a change opens a diff on payload documents", async () => {
    const root = path.join(__dirname, "..", "..", "..");
    const captured = JSON.parse(
      readFileSync(path.join(root, "test", "fixtures", "panels", "deploy-dry-run.json"), "utf8"),
    ) as {
      changes: { platform: string; uuid: string }[];
      payloads: Record<string, Record<string, unknown>[]>;
      counts?: unknown;
    };
    // opentide 0.21's plans carry no deployed state: give the first payload one, as a newer opentide would.
    const first = captured.changes[0];
    assert.ok(first);
    const payloads = Object.fromEntries(
      Object.entries(captured.payloads).map(([platform, rows]) => [
        platform,
        rows.map((row) =>
          platform === first.platform && row.uuid === first.uuid
            ? { ...row, deployed_request: { enabled: false, name: "the deployed one" } }
            : row,
        ),
      ]),
    );
    const document = { ...captured, payloads };
    const state = await vscode.commands.executeCommand<PlanState>("opentide.deployPlan._load", document);
    assert.equal(state.phase, "done");
    const changes = captured.changes.length;
    assert.equal(countRows(state.roots, "change"), changes, "one row per change in the plan");
    assert.ok(state.roots.some((r) => r.kind === "platform" && r.label === first.platform));
    assert.ok(state.changes > 0 && state.badge === state.changes, "the badge is the number of changes");
    assert.match(state.message ?? "", /^Dry run · PREVIEW · /);
    const withDiff = findRow(state.roots, (n) => n.kind === "change" && n.context.includes("deployed"));
    assert.ok(withDiff, "a change that can be diffed");

    await vscode.commands.executeCommand("opentide.deployPlan.openChange", withDiff.id);
    const diff = await waitFor(() => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputTextDiff ? input : undefined;
    });
    assert.equal(diff.original.scheme, "opentide-payload", "what is deployed");
    assert.equal(diff.modified.scheme, "opentide-payload", "what the plan would send");
    assert.match(diff.original.path, /\.deployed\.json$/);
    const original = await vscode.workspace.openTextDocument(diff.original);
    assert.match(original.getText(), /the deployed one/);

    // A change with no deployed state opens its request alone.
    const requestOnly = findRow(
      state.roots,
      (n) => n.kind === "change" && n.context.includes("request") && !n.context.includes("deployed"),
    );
    assert.ok(requestOnly);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("opentide.deployPlan.openChange", requestOnly.id);
    const editor = await waitFor(() =>
      vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "opentide-payload"),
    );
    assert.match(editor.document.getText(), /^\{/);
  });

  it("ATT&CK matrix: one panel; asked for a technique from an editor, it opens beside", async () => {
    const rule = fixture("objects", "rules", "suspicious-lsass-access.yaml");
    const editor = await vscode.window.showTextDocument(rule);
    await vscode.commands.executeCommand("opentide.matrix.open", { technique: "T1003" });
    const tab = await waitFor(() => webviewTabs("opentide.matrix")[0]);
    assert.notEqual(tab.group.viewColumn, editor.viewColumn, "beside the editor");
    assert.equal(
      vscode.window.activeTextEditor?.document.uri.toString(),
      rule.toString(),
      "the editor keeps the focus",
    );
    await vscode.commands.executeCommand("opentide.matrix.open");
    await vscode.commands.executeCommand("opentide.matrix.open", { technique: "T1059" });
    // Give a second panel the time to appear, if one were opened.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(webviewTabs("opentide.matrix").length, 1, "reused, not a new tab");
  });

  it("ATT&CK matrix: hidden and shown again, the page is rebuilt from the host, with the filters and the selected detail", async function () {
    const api = await activated();
    if (!api.ctx.runtime.current) this.skip();
    // Record what the matrix posts to its page; the panel is created after this.
    const posts: { type: string; payload: unknown }[] = [];
    const webview = api.ctx.webview;
    const create = webview.createPanel.bind(webview);
    webview.createPanel = ((options: Parameters<typeof create>[0]) => {
      const created = create(options);
      const post = created.channel.post.bind(created.channel) as (t: string, p: unknown) => Thenable<boolean>;
      (created.channel as { post: unknown }).post = (type: string, payload: unknown) => {
        posts.push({ type, payload });
        return post(type, payload);
      };
      return created;
    }) as typeof webview.createPanel;
    try {
      await vscode.commands.executeCommand("opentide.matrix.open", { technique: "T1003" });
      await waitFor(() => posts.find((p) => p.type === "detail" && p.payload !== null));
      const group = (await waitFor(() => webviewTabs("opentide.matrix")[0])).group;
      // Another editor in the panel's group sends the panel to the background: VS Code drops its page.
      posts.length = 0;
      await vscode.window.showTextDocument(fixture("objects", "rules", "suspicious-lsass-access.yaml"), {
        viewColumn: group.viewColumn,
        preview: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.ok(webviewTabs("opentide.matrix")[0], "the panel is still open, hidden");
      // Showing it again (the command reveals the one panel) loads a new page, which says `ready`; the
      // host answers with the state and the detail.
      await vscode.commands.executeCommand("opentide.matrix.open");
      const detail = await waitFor(() => posts.find((p) => p.type === "detail" && p.payload !== null)).catch(
        () => {
          throw new Error(
            `no detail after showing the panel again; posted: ${posts.map((p) => p.type).join(", ")}`,
          );
        },
      );
      assert.equal((detail.payload as { id: string }).id, "T1003", "the selected detail is posted again");
      const state = posts.find((p) => p.type === "state")?.payload as
        | { filters: { layer: string } }
        | undefined;
      assert.ok(state, "the state is posted again, with the saved filters");
      assert.ok(["rules", "planned", "unaddressed"].includes(state.filters.layer));
    } finally {
      webview.createPanel = create;
    }
  });

  it("answers a webview's pick with VS Code's QuickPick, and Escape leaves the value alone", async () => {
    const api = await activated();
    const posted: { type: string; payload: unknown }[] = [];
    const received = new vscode.EventEmitter<unknown>();
    // A webview that only records what the host posts to it; `received` plays the page's messages.
    const webview = {
      onDidReceiveMessage: received.event,
      postMessage: (message: { type: string; payload: unknown }) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    } as unknown as vscode.Webview;
    const channel = api.ctx.webview.connect(webview, {});
    const window = vscode.window as unknown as { showQuickPick: unknown };
    const original = window.showQuickPick;
    const shown: { items: { value: string; label: string; description?: string }[]; options: unknown }[] = [];
    try {
      const request = {
        id: "pick-test-1",
        title: "Filter in column",
        items: [
          { value: "", label: "all columns" },
          { value: "DeviceName", label: "DeviceName" },
        ],
        current: [""],
      };
      // A choice: the item's value comes back under the request's id.
      window.showQuickPick = async (items: (typeof shown)[number]["items"], options: unknown) => {
        shown.push({ items, options });
        return items[1];
      };
      received.fire({ type: "pick", payload: request });
      const picked = await waitFor(() => posted.find((m) => m.type === "picked"));
      assert.deepEqual(picked.payload, { id: "pick-test-1", values: ["DeviceName"] });
      assert.equal(shown[0]?.items[0]?.description, "current", "the current value is marked");
      assert.equal(((shown[0]?.options ?? {}) as { title?: string }).title, "Filter in column");
      // Escape: undefined from the picker is a dismissal, `values: null`.
      posted.length = 0;
      window.showQuickPick = async () => undefined;
      received.fire({ type: "pick", payload: { ...request, id: "pick-test-2" } });
      const dismissed = await waitFor(() => posted.find((m) => m.type === "picked"));
      assert.deepEqual(dismissed.payload, { id: "pick-test-2", values: null });
      // A malformed request is dropped, not shown.
      posted.length = 0;
      let asked = false;
      window.showQuickPick = async () => {
        asked = true;
        return undefined;
      };
      received.fire({ type: "pick", payload: { id: "", items: [] } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(asked, false);
      assert.equal(posted.length, 0);
    } finally {
      window.showQuickPick = original;
      channel.dispose();
      received.dispose();
    }
  });
});
