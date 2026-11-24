// Panels come back after a window reload (src/core/webview/panel.ts `registerPanelSerializer`). A reload cannot be
// driven from a test, so VS Code's part is played here: a panel of the view type with nothing wired to it (as a revived
// one arrives) is given to the serializer the feature registered. Needs a VS Code download (CI).
import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { activated, waitFor } from "./helpers";

const GRAPH = "opentide.graph";
const MATRIX = "opentide.matrix";

/** The tabs of a webview view type, in every editor group (VS Code prefixes the type of an extension's panels). */
function tabsOf(viewType: string): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType));
}

/**
 * What a reload leaves of a panel: VS Code's own panel, with the page's title, and no extension code behind it. The
 * page's messages are collected, to see that it loads and talks to the host.
 */
function revived(viewType: string, title: string) {
  const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active, {
    enableScripts: true,
  });
  const received: string[] = [];
  panel.webview.onDidReceiveMessage((message: { type?: string }) => {
    if (typeof message?.type === "string") received.push(message.type);
  });
  return { panel, received };
}

/**
 * Until the page of a panel has loaded and said it is ready. A page that does not says what it can see of the panel, so
 * a failure names where it stopped (a hidden panel, a closed one) rather than only that it timed out.
 */
async function pageReady(panel: vscode.WebviewPanel, received: readonly string[]): Promise<void> {
  const began = Date.now();
  try {
    await waitFor(() => (received.includes("ready") ? true : undefined), 30_000);
  } catch {
    let state: string;
    try {
      state = `visible=${panel.visible} active=${panel.active} viewColumn=${String(panel.viewColumn)}`;
    } catch (error) {
      state = `the panel is disposed (${String(error)})`;
    }
    throw new Error(
      `the page of ${panel.viewType} sent no "ready" in 30 s: ${state}; ` +
        `messages ${JSON.stringify(received)}; tabs ${tabsOf(panel.viewType).length}`,
    );
  }
  process.stdout.write(`PANEL-RESTORE ${panel.viewType} page ready after ${Date.now() - began} ms\n`);
}

describe("panels restored after a window reload", () => {
  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("registers a restorer for the graph and for the matrix", async () => {
    const api = await activated();
    assert.ok(api.ctx.webview.restorers.has(GRAPH), "graph");
    assert.ok(api.ctx.webview.restorers.has(MATRIX), "matrix");
  });

  it("the graph: a revived panel is wired, shows the graph page and is the one panel", async () => {
    const api = await activated();
    // The graph as it was before the reload, then gone with the host: its panel closed.
    await vscode.commands.executeCommand("opentide.graph.open");
    await waitFor(() => tabsOf(GRAPH)[0]);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(() => (tabsOf(GRAPH).length === 0 ? true : undefined));

    const { panel, received } = revived(GRAPH, "opentide graph");
    const restore = api.ctx.webview.restorers.get(GRAPH);
    assert.ok(restore, "the graph registered a restorer");
    // `saved` is what the page's own setState left: its mode and filters, which the page reads itself on load.
    await restore(panel, { mode: "focus" });

    assert.match(panel.webview.html, /graph\.js/, "the graph page was set");
    assert.equal(panel.webview.options.enableScripts, true);
    await pageReady(panel, received);
    const status = await vscode.commands.executeCommand<{ open: boolean }>("opentide.graph.reveal");
    assert.equal(status?.open, true, "the feature owns the revived panel");
    assert.equal(tabsOf(GRAPH).length, 1, "one graph panel, not a second beside it");
    // Show Graph reuses it.
    await vscode.commands.executeCommand("opentide.graph.open");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(tabsOf(GRAPH).length, 1, "Show Graph reused the revived panel");
  });

  it("the coverage matrix: a revived panel is wired, titled, and is the one panel", async () => {
    const api = await activated();
    await vscode.commands.executeCommand("opentide.matrix.open");
    await waitFor(() => tabsOf(MATRIX)[0]);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(() => (tabsOf(MATRIX).length === 0 ? true : undefined));

    const { panel, received } = revived(MATRIX, "stale title");
    const restore = api.ctx.webview.restorers.get(MATRIX);
    assert.ok(restore, "the matrix registered a restorer");
    await restore(panel, { focused: undefined });

    assert.match(panel.webview.html, /matrix\.js/, "the matrix page was set");
    assert.notEqual(panel.title, "stale title", "the title is the matrix's own again");
    assert.match(panel.title, /ATT&CK Coverage/);
    await pageReady(panel, received);
    assert.equal(tabsOf(MATRIX).length, 1);
    // The command finds the revived panel: it reveals it, it opens no second one.
    await vscode.commands.executeCommand("opentide.matrix.open");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(tabsOf(MATRIX).length, 1, "the matrix command reused the revived panel");
  });

  it("a revived panel replaces a graph that is already open: one graph per window, the revived one", async () => {
    const api = await activated();
    await vscode.commands.executeCommand("opentide.graph.open");
    await waitFor(() => tabsOf(GRAPH)[0]);
    const { panel, received } = revived(GRAPH, "opentide graph");
    await api.ctx.webview.restorers.get(GRAPH)?.(panel, undefined);
    // The one that was open is closed, and the revived one stays and loads its page.
    await waitFor(() => (tabsOf(GRAPH).length === 1 ? true : undefined));
    await pageReady(panel, received);
    assert.doesNotThrow(() => panel.viewColumn, "the revived panel was not disposed");
    assert.equal(tabsOf(GRAPH).length, 1);
    const status = await vscode.commands.executeCommand<{ open: boolean }>("opentide.graph.reveal");
    assert.equal(status?.open, true, "the feature owns the revived panel, not the one it replaced");
  });
});
