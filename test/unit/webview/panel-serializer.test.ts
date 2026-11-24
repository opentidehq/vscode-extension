// The webview core's hook for restoring panels after a window reload (src/core/webview/panel.ts).
import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { createWebviewHelpers, type OpentidePanel } from "../../../src/core/webview/panel";
import type { Protocol } from "../../../src/core/webview/protocol";
import { panelSerializers } from "../../stubs/vscode";

interface TestProtocol extends Protocol {
  toHost: { ready: undefined };
  toWebview: { hello: string };
}

const validators = { ready: (value: unknown): value is undefined => value === undefined };

/** A revived panel as VS Code hands it over: a title, a webview with default options, and a way to dispose it. */
function revivedPanel() {
  const messages: ((raw: unknown) => void)[] = [];
  let disposed: (() => void)[] = [];
  const webview = {
    options: {} as unknown,
    html: "",
    cspSource: "vscode-resource:",
    asWebviewUri: (uri: { path: string }) => ({ toString: () => `vscode-resource:${uri.path}` }),
    onDidReceiveMessage: (listener: (raw: unknown) => void) => {
      messages.push(listener);
      return { dispose: () => void messages.splice(messages.indexOf(listener), 1) };
    },
    postMessage: async () => true,
  };
  const panel = {
    title: "opentide graph",
    webview,
    onDidDispose: (listener: () => void) => {
      disposed.push(listener);
      return { dispose: () => void (disposed = disposed.filter((d) => d !== listener)) };
    },
    dispose: () => {
      for (const listener of disposed) listener();
    },
  };
  return { panel, webview, messages, isDisposed: () => disposed.length === 0 };
}

describe("registerPanelSerializer", () => {
  const logs: string[] = [];
  const helpers = createWebviewHelpers(vscode.Uri.file("/ext"), (message) => logs.push(message));
  const options = {
    viewType: "opentide.test",
    title: "opentide test",
    entry: "graph",
    validators,
  };
  afterEach(() => {
    panelSerializers.clear();
    logs.length = 0;
  });

  it("registers a serializer for the view type", () => {
    const registered = helpers.registerPanelSerializer<TestProtocol>(options, () => undefined);
    assert.ok(panelSerializers.has("opentide.test"));
    assert.ok(helpers.restorers.has("opentide.test"), "tests can reach what VS Code would call");
    registered.dispose();
    assert.ok(!panelSerializers.has("opentide.test"), "disposing it unregisters the view type");
    assert.ok(!helpers.restorers.has("opentide.test"));
  });

  it("knows each wired panel's page until it closes, and when the page said it is ready (for the tests)", async () => {
    let opened: OpentidePanel<TestProtocol> | undefined;
    helpers.registerPanelSerializer<TestProtocol>(options, (wired) => {
      opened = wired;
    });
    const revived = revivedPanel();
    await panelSerializers.get("opentide.test")?.deserializeWebviewPanel(revived.panel, undefined);
    const page = () => helpers.pages.get(revived.panel as unknown as vscode.WebviewPanel);
    const id = page()?.id ?? 0;
    assert.deepEqual(
      page(),
      { viewType: "opentide.test", ready: false, id, messages: 0 },
      "wired, its page not loaded yet",
    );
    for (const listener of revived.messages) listener({ type: "log", payload: "script started" });
    for (const listener of revived.messages) listener({ type: "nonsense", payload: 1 });
    assert.equal(page()?.ready, false, "only a valid `ready` counts");
    assert.equal(page()?.messages, 2, "every message counts, valid or not");
    assert.equal(page()?.firstType, "log");
    for (const listener of revived.messages) listener({ type: "ready" });
    assert.equal(page()?.ready, true);
    revived.panel.dispose();
    assert.equal(page(), undefined, "a closed panel is forgotten");
    assert.deepEqual(
      helpers.lifecycle.filter((event) => event.id === id).map((event) => [event.event, event.detail]),
      [
        ["wired", undefined],
        ["first message", "log: script started"],
        ["ready", undefined],
        ["disposed", undefined],
      ],
    );
    assert.ok(opened);

    // Disposed from our side too.
    const other = revivedPanel();
    await panelSerializers.get("opentide.test")?.deserializeWebviewPanel(other.panel, undefined);
    assert.ok(helpers.pages.has(other.panel as unknown as vscode.WebviewPanel));
    opened?.dispose();
    assert.ok(!helpers.pages.has(other.panel as unknown as vscode.WebviewPanel));
  });

  it("hands a revived panel to `restore` wired like a new one, with the state the page saved", async () => {
    let got: { opened: OpentidePanel<TestProtocol>; saved: unknown } | undefined;
    helpers.registerPanelSerializer<TestProtocol>(options, (opened, saved) => {
      got = { opened, saved };
    });
    const revived = revivedPanel();
    const saved = { mode: "catalogue", filters: ["x"] };
    await panelSerializers.get("opentide.test")?.deserializeWebviewPanel(revived.panel, saved);
    assert.ok(got, "restore ran");
    assert.deepEqual(got.saved, saved);
    assert.equal(got.opened.panel, revived.panel as unknown);
    assert.deepEqual(revived.webview.options, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file("/ext/dist/webview")],
    });
    assert.match(revived.webview.html, /Content-Security-Policy/);
    assert.match(revived.webview.html, /\/ext\/dist\/webview\/graph\.js/);
    assert.equal(revived.messages.length, 1, "the validated channel listens to the page");
  });

  it("passes undefined when the page had saved nothing", async () => {
    let saved: unknown = "unset";
    helpers.registerPanelSerializer<TestProtocol>(options, (_opened, state) => {
      saved = state;
    });
    await panelSerializers.get("opentide.test")?.deserializeWebviewPanel(revivedPanel().panel, undefined);
    assert.equal(saved, undefined);
  });

  it("routes the page's messages to the handlers `restore` sets, and drops invalid ones", async () => {
    const ready: unknown[] = [];
    helpers.registerPanelSerializer<TestProtocol>(options, (opened) => {
      opened.channel.on("ready", (payload) => void ready.push(payload));
    });
    const revived = revivedPanel();
    await panelSerializers.get("opentide.test")?.deserializeWebviewPanel(revived.panel, undefined);
    const [listener] = revived.messages;
    listener?.({ type: "ready", payload: undefined });
    listener?.({ type: "nonsense", payload: 1 });
    assert.deepEqual(ready, [undefined]);
    assert.match(logs.join("\n"), /dropped an invalid message/);
  });

  it("closes a panel whose `restore` fails, and says why, rather than leave a blank page", async () => {
    helpers.registerPanelSerializer<TestProtocol>(options, async () => {
      throw new Error("no folder to show");
    });
    const revived = revivedPanel();
    await panelSerializers.get("opentide.test")?.deserializeWebviewPanel(revived.panel, undefined);
    assert.ok(revived.isDisposed(), "the panel was disposed");
    assert.match(logs.join("\n"), /could not restore opentide\.test: Error: no folder to show/);
  });

  it("adoptPanel wires a panel without a serializer, for a feature that revives its own", () => {
    const revived = revivedPanel();
    const opened = helpers.adoptPanel<TestProtocol>(revived.panel as unknown as vscode.WebviewPanel, options);
    assert.equal(opened.panel, revived.panel as unknown);
    opened.dispose();
    assert.ok(revived.isDisposed());
  });
});
