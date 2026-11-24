// The webview core's hook for restoring panels after a window reload (src/core/webview/panel.ts).
import * as assert from "node:assert/strict";

import * as vscode from "vscode";

import { createWebviewHelpers, type OpentidePanel } from "../../../src/core/webview/panel";
import type { Protocol } from "../../../src/core/webview/protocol";
import { panelSerializers, webviewPanels } from "../../stubs/vscode";

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
  const viewState: (() => void)[] = [];
  const panel = {
    title: "opentide graph",
    webview,
    visible: false,
    active: false,
    viewColumn: 2 as number | undefined,
    iconPath: undefined as unknown,
    onDidChangeViewState: (listener: () => void) => {
      viewState.push(listener);
      return { dispose: () => void viewState.splice(viewState.indexOf(listener), 1) };
    },
    onDidDispose: (listener: () => void) => {
      disposed.push(listener);
      return { dispose: () => void (disposed = disposed.filter((d) => d !== listener)) };
    },
    dispose: () => {
      for (const listener of disposed) listener();
    },
  };
  /** VS Code shows or hides the panel. */
  const setVisible = (visible: boolean) => {
    panel.visible = visible;
    for (const listener of [...viewState]) listener();
  };
  return { panel, webview, messages, setVisible, isDisposed: () => disposed.length === 0 };
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
    assert.equal(
      got.opened.panel.webview,
      revived.webview as unknown,
      "the feature's panel is the revived one",
    );
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
    assert.equal(opened.panel.webview, revived.webview as unknown);
    assert.equal(opened.panel.title, "opentide graph");
    opened.panel.title = "renamed";
    assert.equal(revived.panel.title, "renamed", "the feature's panel sets VS Code's");
    opened.dispose();
    assert.ok(revived.isDisposed());
  });

  it("replaces the panel of a visible page that said nothing, once, in its place (the watchdog)", async () => {
    const made: { viewType: string; title: string; show: unknown; fake: ReturnType<typeof revivedPanel> }[] =
      [];
    webviewPanels.create = (viewType, title, show) => {
      const fake = revivedPanel();
      fake.panel.title = title;
      fake.panel.visible = true;
      made.push({ viewType, title, show, fake });
      return fake.panel;
    };
    try {
      const quick = createWebviewHelpers(vscode.Uri.file("/ext"), (message) => logs.push(message), 20);
      const ready: unknown[] = [];
      let opened: OpentidePanel<TestProtocol> | undefined;
      quick.registerPanelSerializer<TestProtocol>(options, (wired) => {
        opened = wired;
        wired.channel.on("ready", (payload) => void ready.push(payload));
      });
      const silent = revivedPanel();
      silent.panel.visible = true;
      silent.panel.title = "opentide graph · detections";
      await panelSerializers.get("opentide.test")?.deserializeWebviewPanel(silent.panel, undefined);
      assert.ok(opened);
      const closes: string[] = [];
      opened.panel.onDidDispose(() => void closes.push("closed"));
      const first = quick.pages.get(silent.panel as unknown as vscode.WebviewPanel)?.id;
      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.equal(made.length, 1, "one new panel");
      const [replacement] = made;
      assert.ok(replacement);
      assert.equal(replacement.viewType, "opentide.test");
      assert.equal(replacement.title, "opentide graph · detections", "with the silent panel's title");
      assert.deepEqual(replacement.show, { viewColumn: 2, preserveFocus: true }, "in its column");
      assert.ok(silent.isDisposed(), "the silent panel is closed");
      assert.deepEqual(closes, [], "the feature's panel is not closed: it is replaced");
      assert.ok(
        logs.includes(
          "webview: the page of opentide.test sent nothing in 0 s: opening it again in a new panel",
        ),
        logs.join(" | "),
      );
      const second = quick.pages.get(replacement.fake.panel as unknown as vscode.WebviewPanel)?.id;
      assert.ok(second !== undefined && second !== first, "the new page is wired");
      assert.deepEqual(
        quick.lifecycle.filter((event) => event.id === first).map((event) => [event.event, event.detail]),
        [
          ["wired", undefined],
          ["replaced", `by #${second}`],
        ],
      );
      assert.match(replacement.fake.webview.html, /\/ext\/dist\/webview\/graph\.js/, "showing the page");

      // The feature's panel and channel are the new panel's: its handlers hear the new page.
      assert.equal(opened.panel.webview, replacement.fake.webview as unknown);
      for (const listener of replacement.fake.messages) listener({ type: "ready" });
      assert.deepEqual(ready, [undefined], "the feature's `ready` handler heard the new page");
      assert.equal(quick.pages.get(replacement.fake.panel as unknown as vscode.WebviewPanel)?.ready, true);

      // It speaks: left alone, never replaced again.
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(made.length, 1);

      // Closing it is the feature's panel closing.
      replacement.fake.panel.dispose();
      assert.deepEqual(closes, ["closed"]);
      assert.equal(quick.pages.size, 0, "both pages are forgotten");
    } finally {
      delete webviewPanels.create;
    }
  });

  it("replaces a silent panel at most once: a silent replacement is only a warning", async () => {
    const made: ReturnType<typeof revivedPanel>[] = [];
    webviewPanels.create = () => {
      const fake = revivedPanel();
      fake.panel.visible = true;
      made.push(fake);
      return fake.panel;
    };
    try {
      const quick = createWebviewHelpers(vscode.Uri.file("/ext"), (message) => logs.push(message), 20);
      const silent = revivedPanel();
      silent.panel.visible = true;
      const opened = quick.adoptPanel<TestProtocol>(silent.panel as unknown as vscode.WebviewPanel, options);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(made.length, 1, "replaced once, never again");
      assert.ok(
        logs.includes(
          "webview: the page of opentide.test still sent nothing 0 s after its panel was replaced",
        ),
        logs.join(" | "),
      );
      assert.ok(!made[0]?.isDisposed(), "the replacement stays open");
      opened.dispose();
      assert.ok(made[0]?.isDisposed(), "disposing the feature's panel closes the replacement");
    } finally {
      delete webviewPanels.create;
    }
  });

  it("keeps a silent panel, and says why, when no new panel can be opened", async () => {
    webviewPanels.create = () => {
      throw new Error("the window is closing");
    };
    try {
      const quick = createWebviewHelpers(vscode.Uri.file("/ext"), (message) => logs.push(message), 20);
      const silent = revivedPanel();
      silent.panel.visible = true;
      const opened = quick.adoptPanel<TestProtocol>(silent.panel as unknown as vscode.WebviewPanel, options);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.ok(!silent.isDisposed(), "the silent panel stays");
      assert.ok(
        logs.includes("webview: could not open opentide.test again: Error: the window is closing"),
        logs.join(" | "),
      );
      assert.equal(opened.panel.webview, silent.webview as unknown);
      opened.dispose();
    } finally {
      delete webviewPanels.create;
    }
  });

  it("does not replace a hidden panel's page, which may only load when shown", async () => {
    webviewPanels.create = () => {
      throw new Error("no panel should be made");
    };
    try {
      const quick = createWebviewHelpers(vscode.Uri.file("/ext"), (message) => logs.push(message), 20);
      const hidden = revivedPanel();
      const opened = quick.adoptPanel<TestProtocol>(hidden.panel as unknown as vscode.WebviewPanel, options);
      const states: boolean[] = [];
      opened.panel.onDidChangeViewState((event) => void states.push(event.webviewPanel.visible));
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.ok(!hidden.isDisposed());
      hidden.setVisible(true);
      assert.deepEqual(states, [true], "the feature hears the view state, about its own panel");
      for (const listener of hidden.messages) listener({ type: "log", payload: "script started" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.ok(!hidden.isDisposed(), "a page that spoke once shown is left alone");
      opened.dispose();
    } finally {
      delete webviewPanels.create;
    }
  });
});
