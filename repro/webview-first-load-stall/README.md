# Repro: a webview page that never runs after the window's first one was closed mid-load

A minimal extension, with no opentide code, for a VS Code behaviour that opentide's CI caught. When a window's
first webview panel is closed while its page is still loading, the next panel of the same view type can stay
blank: its page never runs, and it sends no message at all.

## What a trial does

Each trial runs in a fresh VS Code window, with its own empty user data and extensions folders. The code is in
`trial.js`.

- **Arm `cut`:**
  1. Open a panel whose page loads a ~1.2 MB script whose first statement posts `started`.
  2. About 100 ms later, before the page has posted, close it with `workbench.action.closeAllEditors`.
  3. Open a second panel of the same view type.
  4. Wait 30 s for its first message.
- **Arm `control`:** open only the second panel, the same way.
- **Arm `cut-inline`:** as `cut`, with a nonce'd inline script that posts `inline` before the big script loads. It
  shows whether a silent page's document was written at all.
- **Arm `cut-delay`:** as `cut`, waiting 1 s between closing the first panel and opening the second.
- **Arm `cut-recreate`:** as `cut`. If the second page has said nothing after 10 s, its panel is disposed and a third
  panel of the same view type opens in its column, as opentide's watchdog does. That panel gets 30 s.
  `cut-recreate-5s` and `cut-recreate-3s` do the same after 5 s and 3 s.

**The probe.** A page that has said nothing for 10 s is probed over the DevTools protocol: VS Code runs with
`--remote-debugging-port`, and the code is in `cdp.mjs`. The probe reads each `vscode-webview://` frame:
- whether a service worker controls it;
- its registration's workers;
- VS Code's own performance marks (`content/started`, `content/workerReady`, …);
- its child frames and loaded resources.

It also reads the webview service worker's state and its clients. Each arm's first two healthy windows are probed
too, as a baseline. The probes are in the log as `probe {…}` lines and in the results JSON.

A window whose second page sends nothing in 30 s **stalled**. A `cut` window whose first page had already posted
when it was closed did not cut a load short, so it is counted apart.

## Run it

From the repository root, after `npm ci`, which provides `@vscode/test-electron`:

```bash
cd repro/webview-first-load-stall
node run.mjs --version stable --windows 40   # on Linux: xvfb-run -a node run.mjs …
node summary.mjs results
```

In CI, `.github/workflows/repro-webview-stall.yml` runs it on Ubuntu, macOS and Windows, with VS Code stable and
Insiders. It runs on a pull request that changes the repro, or by hand ("Run workflow", with the number of
windows). Its summary job prints the stall rate per OS, VS Code version and arm.

The summary job also prints how long healthy pages take to send their first message, per OS. That sets how low
opentide's watchdog threshold can go: a page slower than the threshold would be recreated for nothing.

## The upstream issue (draft, in microsoft/vscode's bug report template)

This is the text to file at https://github.com/microsoft/vscode/issues/new. It is not filed from here.

---

**Title:** Webview panel never loads (blank, no messages) when the previous panel of its view type was closed while the
origin's service worker was first installing

<!-- ⚠️⚠️ Do Not Delete This! bug_report_template ⚠️⚠️ -->

Does this issue occur when all extensions are disabled?: Yes. The repro runs with `--disable-extensions`; the only
extension is the repro under development.

- VS Code Version: 1.147.0 (stable) and 1.148.0-insider; seen in CI on 1.91.0 too
- OS Version: Ubuntu (GitHub `ubuntu-latest`, under Xvfb), macOS (`macos-latest`), Windows (`windows-latest`)

**Steps to Reproduce:**

1. In a fresh profile, create a webview panel. Use `enableScripts: true`, and a page whose nonce'd script (about
   1.2 MB) posts a message as its first statement.
2. About 100 ms later, before the page has posted anything, close it (`workbench.action.closeAllEditors`, or
   `panel.dispose()`).
3. Immediately create a second panel of the **same view type**, with the same HTML (a fresh nonce).
4. Wait for the second page's first message.

**Expected:** the second page loads and posts its message, as it does when no panel was closed first.

**Actual:** in about 3% of fresh windows, the second panel shows a blank page that never loads.
`onDidReceiveMessage` gets nothing in 30 s; a page that never posts anything has never run. Later panels in the same
window load normally.

**Minimal repro.** The extension code, which has no dependencies:

```js
const vscode = require("vscode");
const crypto = require("crypto");
const path = require("path");

function open(media, title) {
  const panel = vscode.window.createWebviewPanel("repro.view", title, vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [media],
  });
  const nonce = crypto.randomBytes(18).toString("base64").replace(/[+/=]/g, "");
  const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "big.js"));
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'">
</head><body><script nonce="${nonce}" src="${script}"></script></body></html>`;
  const messages = [];
  panel.webview.onDidReceiveMessage((m) => messages.push(m));
  return { panel, messages };
}

exports.activate = (context) => {
  context.subscriptions.push(
    vscode.commands.registerCommand("repro.run", async () => {
      const media = vscode.Uri.file(path.join(context.extensionPath, "media"));
      open(media, "first");
      await new Promise((r) => setTimeout(r, 100));
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      const second = open(media, "second");
      await new Promise((r) => setTimeout(r, 30000));
      vscode.window.showInformationMessage(second.messages.length ? "loaded" : "STALLED: the page never ran");
    }),
  );
};
```

`media/big.js` begins with `acquireVsCodeApi().postMessage({ type: "started" });`, followed by about 1.2 MB of
code. The stall needs a fresh profile, or at least a view type whose origin has never had a service worker: run it
with an empty `--user-data-dir` each time.

The automated harness, with N fresh windows per arm and the CDP probe below, is
https://github.com/opentidehq/vscode-extension/tree/main/repro/webview-first-load-stall.

**Measured.** Each window is a fresh `--user-data-dir`, on GitHub-hosted runners, over three runs:

| OS | VS Code | closed mid-load, then reopened: stalled | control (no first panel): stalled |
|---|---|---:|---:|
| Linux | 1.147.0 | 3 / 120 | 0 / 120 |
| Linux | 1.148.0-insider | 1 / 120 | 0 / 120 |
| macOS | 1.147.0 | 2 / 120 | 0 / 120 |
| macOS | 1.148.0-insider | 6 / 120 | 0 / 120 |
| Windows | 1.147.0 | 10 / 118 | 0 / 120 |
| Windows | 1.148.0-insider | 2 / 120 | 0 / 120 |
| **all** | | **24 / 718 (3.3%)** | **0 / 720** |

- **Inline script:** with a nonce'd inline script that posts before the external one, 14 windows stalled. The inline
  script ran in none of them, so the document is never written.
- **Waiting first:** waiting 1 s between the close and the second panel cut stalls to 1 / ~476, but did not remove
  them.
- **A new panel recovers it:** disposing the silent panel and creating a new one of the same view type recovered
  every stuck page. That was 16 / 16 after 10 s over three runs, and 7 / 7 each after 5 s and after 3 s.

**What the stalled frame looks like.** Observed over the DevTools protocol (`--remote-debugging-port`) 10 s into a
stall. Every one of 13 stalls probed, on all three OSes and both versions, looked like this:

```
outer frame /index.html?id=…   readyState=complete
  navigator.serviceWorker.controller = null            (controlled=false)
  registration: installing=null waiting=null active=activated
  performance marks: webview/index.html/content/started   (no content/workerReady)
  child frames: 0
service worker: active=activated; clients: [index.html?id=… (not controlled)]
```

A healthy load, probed the same way:

```
  controlled=true (activated); marks content/started → content/workerReady → innerFrameLoaded → wroteInnerContent;
  child frames: 1; the worker's clients: index.html and fake.html, both controlled
```

**Root cause.**

*Observed.* The stalled outer frame never gets past `await workerReady` in
`src/vs/workbench/contrib/webview/browser/pre/index.html`, in its `content` handler. `content/started` is marked and
`content/workerReady` is not, so the page's HTML is never written into a frame.

At that point:
- the registration's worker is `activated`;
- there is no installing or waiting worker;
- the frame is not controlled;
- the worker lists the frame as an uncontrolled client.

`workerReady` resolves only after `controllerchange` when `!navigator.serviceWorker.controller`:

```js
if (registration.installing || registration.waiting || !navigator.serviceWorker.controller) {
  await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
}
```

The active worker has already run its `activate` handler, which is the only place `service-worker.js` calls
`clients.claim()`. So nothing will ever make this frame controlled, and the wait has no timeout.

*Inferred.* We did not observe the ordering directly. Panels of one view type share one origin:
`ExtensionKeyedWebviewOriginStore` persists one origin per view type and extension. So the first panel's outer frame
is the first client of that origin in the profile, and it registers the service worker. We believe the second
panel's outer frame navigates while that first install is still installing or activating. Its navigation is not
intercepted, because there is no active worker yet. The document then commits just after the worker's
`clients.claim()` has run, so it stays uncontrolled.

This fits the evidence:
- It never happens without the first panel (0 / 720).
- It happens only on the origin's first install. Later panels in the same window load, because the worker is active
  when they navigate.
- A 1 s gap mostly avoids it.
- A brand-new panel created later recovers.

Closing the first panel probably only matters because it lets the second panel open while the install is in flight.

**Suggested fix.** `workerReady` should never wait unbounded for `controllerchange`. Any of these would do:
- When `registration.active` exists but `navigator.serviceWorker.controller` is null, ask the worker to claim again.
  For example, post `{ channel: 'claim' }` to `registration.active`, and have `service-worker.js` answer it with
  `clients.claim()`. A newly committed uncontrolled client then becomes controlled, and `controllerchange` fires.
- Or wait for `controllerchange` with a timeout. On timeout, reload the outer frame, which a now-active worker will
  control.

**Workaround in extensions.** If the page has sent nothing after a few seconds while visible, dispose the panel and
create a new one of the same view type in the same column. opentide's watchdog does this (opentidehq/vscode-extension
#150).
