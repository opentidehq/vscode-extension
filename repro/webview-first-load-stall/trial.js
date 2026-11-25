// One window's trial, run by @vscode/test-electron as the extension tests of a fresh VS Code window (run.mjs).
//
// Arms (REPRO_ARM):
// - `cut`: open a webview panel whose page loads a ~1.2 MB script, close it ~100 ms later (before its page has
//   posted anything), then open a second panel of the same view type and wait 30 s for its page's first message.
// - `control`: only the second panel.
// - `cut-inline`: as `cut`, with an inline script that posts `inline` before the big script loads: a page whose
//   document was written but whose script never arrived is told apart from one whose document never was.
// - `cut-delay`: as `cut`, waiting REPRO_DELAY_MS (1 s) between closing the first panel and opening the second.
// - `cut-recreate`: as `cut`; if the second page says nothing for 10 s, it is disposed and a third panel of the same
//   view type opens in its column (what opentide's watchdog does), which gets 30 s. `cut-recreate-3s` and
//   `cut-recreate-5s` do the same after 3 s and 5 s.
//
// The page's first statement posts `started`, its last `ready`: a page that sends nothing never ran. When a page
// has said nothing for 10 s, the trial writes `<REPRO_OUT>.silent` and waits (up to 15 s) for the runner to probe the
// webview frames over the DevTools protocol and write `<REPRO_OUT>.probed`.
// No dependencies besides the vscode API; the result is written as JSON to REPRO_OUT.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const vscode = require("vscode");

const VIEW_TYPE = "repro.view";
const SETTLE_MS = Number(process.env.REPRO_SETTLE_MS ?? 1500);
const CUT_AFTER_MS = Number(process.env.REPRO_CUT_AFTER_MS ?? 100);
const DELAY_MS = Number(process.env.REPRO_DELAY_MS ?? 1000);
const SILENT_MS = Number(process.env.REPRO_SILENT_MS ?? 10000);
const WAIT_MS = Number(process.env.REPRO_WAIT_MS ?? 30000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The page: a strict CSP, one nonce'd stylesheet and the nonce'd big script, as a real extension's panel. With
 * `inline`, a nonce'd inline script posts `inline` first (and hands the API to the big script).
 */
function html(webview, media, inline) {
  const nonce = crypto.randomBytes(18).toString("base64").replace(/[+/=]/g, "");
  const asset = (name) => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const ping = inline
    ? `<script nonce="${nonce}">globalThis.reproApi = acquireVsCodeApi(); reproApi.postMessage({ type: "inline" });</script>\n`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset("style.css")}" nonce="${nonce}">
<title>repro</title>
</head>
<body>
<div id="root"></div>
${ping}<script nonce="${nonce}" src="${asset("big.js")}"></script>
</body>
</html>`;
}

/** Open a panel of VIEW_TYPE showing the page, and record its page's messages from the moment it was created. */
function open(title, media, { inline = false, viewColumn = vscode.ViewColumn.Active } = {}) {
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    title,
    { viewColumn, preserveFocus: false },
    { enableScripts: true, enableFindWidget: true, localResourceRoots: [media] },
  );
  const created = Date.now();
  const messages = [];
  panel.webview.onDidReceiveMessage((message) =>
    messages.push({ type: String(message?.type), afterMs: Date.now() - created }),
  );
  panel.webview.html = html(panel.webview, media, inline);
  return { panel, created, messages };
}

async function waitFor(check, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

const started = (opened) => opened.messages.some((m) => m.type === "started");

/** Ask the runner to probe the webview frames now (it answers within a few seconds, or not at all). */
async function probe(out, what) {
  if (!out) return;
  const probed = `${out}.probed`;
  fs.writeFileSync(`${out}.silent`, what);
  await waitFor(() => fs.existsSync(probed), 15000);
  try {
    fs.rmSync(probed);
  } catch {
    // never probed
  }
}

async function trial(arm, out) {
  const media = vscode.Uri.file(path.join(__dirname, "media"));
  const inline = arm === "cut-inline";
  const result = {
    arm,
    vscode: vscode.version,
    platform: process.platform,
    arch: process.arch,
    settleMs: SETTLE_MS,
    cutAfterMs: CUT_AFTER_MS,
  };
  // A window that has just opened, as a user's (or a test's) a moment after the extension activates.
  await sleep(SETTLE_MS);
  if (arm.startsWith("cut")) {
    const first = open("first", media, { inline });
    await sleep(CUT_AFTER_MS);
    // Closed the way a user closes it (and the opentide probe does): the editor closes, the panel is disposed.
    const disposed = new Promise((resolve) => first.panel.onDidDispose(resolve));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await disposed;
    result.firstClosedAfterMs = Date.now() - first.created;
    result.firstMessagesAtClose = first.messages.map((m) => m.type);
    if (arm === "cut-delay") {
      await sleep(DELAY_MS);
      result.delayMs = DELAY_MS;
    }
  }
  const second = open("second", media, { inline });
  const recreateAfter = /^cut-recreate(?:-(\d+)s)?$/.exec(arm);
  const silentMs = recreateAfter?.[1] ? Number(recreateAfter[1]) * 1000 : SILENT_MS;
  let ok = await waitFor(() => started(second), silentMs);
  result.secondVisible = second.panel.visible;
  if (!ok) {
    await probe(out, "second");
    if (recreateAfter) {
      // opentide's watchdog: a new panel of the same view type in the silent one's column, then the silent one closes.
      const column = second.panel.viewColumn;
      const third = open("third", media, { viewColumn: column ?? vscode.ViewColumn.Active });
      second.panel.dispose();
      result.recreated = true;
      result.recreatedAfterMs = silentMs;
      ok = await waitFor(() => started(third), WAIT_MS);
      if (!ok) await probe(out, "third");
      result.thirdMessages = third.messages;
      third.panel.dispose();
    } else {
      ok = await waitFor(() => started(second), WAIT_MS - silentMs);
    }
  }
  if (ok && !result.recreated) await waitFor(() => second.messages.some((m) => m.type === "ready"), 5000);
  // A healthy page probed too, in each arm's first windows: what the probe sees when nothing is wrong.
  if (ok && !result.recreated && Number(process.env.REPRO_WINDOW ?? 99) < 2) await probe(out, "healthy");
  result.stalled = !ok;
  result.secondMessages = second.messages;
  if (!result.recreated) second.panel.dispose();
  return result;
}

exports.run = async function run() {
  const arm = process.env.REPRO_ARM ?? "cut";
  const out = process.env.REPRO_OUT;
  let result;
  try {
    result = await trial(arm, out);
  } catch (error) {
    result = {
      arm,
      vscode: vscode.version,
      platform: process.platform,
      error: String(error?.stack ?? error),
    };
  }
  if (out) fs.writeFileSync(out, JSON.stringify(result));
};
