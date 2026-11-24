// Panels come back after a window reload (src/core/webview/panel.ts `registerPanelSerializer`). A reload cannot be
// driven from a test, so VS Code's part is played here: a panel of the view type with nothing wired to it (as a revived
// one arrives) is given to the serializer the feature registered. Needs a VS Code download (CI).
import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import type { ExtensionApi } from "../../src/extension";
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
    // A webview loads its page once its panel is shown: reveal it (a disposed panel throws, and says so below).
    panel.reveal(undefined, false);
    await waitFor(() => (received.includes("ready") ? true : undefined), 30_000);
  } catch {
    throw new Error(
      `the page of ${panel.viewType} sent no "ready" in ${Math.round((Date.now() - began) / 1000)} s: ` +
        `${panelState(panel)}; messages ${JSON.stringify(received)}; tabs ${tabsOf(panel.viewType).length}`,
    );
  }
  process.stdout.write(`PANEL-RESTORE ${panel.viewType} page ready after ${Date.now() - began} ms\n`);
}

/** Where a panel is, or that it is gone: what a timeout says, so a page that never loads is diagnosable. */
function panelState(panel: vscode.WebviewPanel): string {
  try {
    return `visible=${panel.visible} active=${panel.active} viewColumn=${String(panel.viewColumn)}`;
  } catch (error) {
    return `the panel is disposed (${String(error)})`;
  }
}

/**
 * Until the page of the panel a command opened (the feature's own, not a revived one) has said it is ready: the
 * graph "as it was before the reload" is a loaded one. Closing it while its page still loads is another case (below).
 */
async function openedPageReady(api: Required<ExtensionApi>, viewType: string, what: string): Promise<void> {
  const began = Date.now();
  const pages = () => [...api.ctx.webview.pages].filter(([, page]) => page.viewType === viewType);
  try {
    await waitFor(() => (pages().some(([, page]) => page.ready) ? true : undefined), 30_000);
  } catch {
    const states = pages().map(([panel, page]) => `${panelState(panel)} ready=${page.ready}`);
    throw new Error(
      `the page of ${what} sent no "ready" in ${Math.round((Date.now() - began) / 1000)} s: ` +
        `${states.join("; ") || "no such panel"}; tabs ${tabsOf(viewType).length}`,
    );
  }
  process.stdout.write(`PANEL-RESTORE ${what} page ready after ${Date.now() - began} ms\n`);
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

  // A graph closed while its page (1.2 MB) still loads, then opened again: the new page loads. Panels of one view type
  // share their webview origin, so a load cut short could hold up the next one's; each page now asks for its own copy
  // of its script (panel.ts `html`). Ten cycles in one run, so a single CI job says whether it still happens.
  it("a graph closed before its page loaded does not keep the next one from loading (10 cycles)", async () => {
    const api = await activated();
    const cycles: number[] = [];
    for (let cycle = 1; cycle <= 10; cycle += 1) {
      await vscode.commands.executeCommand("opentide.graph.open");
      await waitFor(() => tabsOf(GRAPH)[0]);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await waitFor(() => (tabsOf(GRAPH).length === 0 ? true : undefined));
      const began = Date.now();
      await vscode.commands.executeCommand("opentide.graph.open");
      await openedPageReady(api, GRAPH, `the graph opened after one closed while loading (cycle ${cycle})`);
      cycles.push(Date.now() - began);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await waitFor(() => (tabsOf(GRAPH).length === 0 ? true : undefined));
    }
    process.stdout.write(`PANEL-RESTORE close-mid-load cycles ready after ${cycles.join(", ")} ms\n`);
    assert.equal(api.ctx.webview.pages.size, 0, "the closed panels are forgotten");
  });

  it("the graph: a revived panel is wired, shows the graph page and is the one panel", async () => {
    const api = await activated();
    // The graph as it was before the reload (loaded), then gone with the host: its panel closed.
    await vscode.commands.executeCommand("opentide.graph.open");
    await waitFor(() => tabsOf(GRAPH)[0]);
    await openedPageReady(api, GRAPH, "the graph Show Graph opened");
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
    await openedPageReady(api, MATRIX, "the matrix the command opened");
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
    await openedPageReady(api, GRAPH, "the graph already open");
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
