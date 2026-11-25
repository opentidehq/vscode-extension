// One window's trial, run by @vscode/test-electron as the extension tests of a fresh VS Code window (run.mjs).
//
// Arm `cut`: open a webview panel whose page loads a ~1.2 MB script, close it ~100 ms later (before its page has
// posted anything), then open a second panel of the same view type and wait 30 s for its page's first message.
// Arm `control`: only the second panel, in a fresh window too.
//
// The page's first statement posts `started`, its last `ready`: a page that sends nothing never ran.
// No dependencies besides the vscode API; the result is written as JSON to REPRO_OUT.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const vscode = require("vscode");

const VIEW_TYPE = "repro.view";
const SETTLE_MS = Number(process.env.REPRO_SETTLE_MS ?? 1500);
const CUT_AFTER_MS = Number(process.env.REPRO_CUT_AFTER_MS ?? 100);
const WAIT_MS = Number(process.env.REPRO_WAIT_MS ?? 30000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page: a strict CSP, one nonce'd stylesheet and the nonce'd big script, as a real extension's panel. */
function html(webview, media) {
  const nonce = crypto.randomBytes(18).toString("base64").replace(/[+/=]/g, "");
  const asset = (name) => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
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
<script nonce="${nonce}" src="${asset("big.js")}"></script>
</body>
</html>`;
}

/** Open a panel of VIEW_TYPE showing the page, and record its page's messages from the moment it was created. */
function open(title, media) {
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    title,
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, enableFindWidget: true, localResourceRoots: [media] },
  );
  const created = Date.now();
  const messages = [];
  panel.webview.onDidReceiveMessage((message) =>
    messages.push({ type: String(message?.type), afterMs: Date.now() - created }),
  );
  panel.webview.html = html(panel.webview, media);
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

async function trial(arm) {
  const media = vscode.Uri.file(path.join(__dirname, "media"));
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
  if (arm === "cut") {
    const first = open("first", media);
    await sleep(CUT_AFTER_MS);
    // Closed the way a user closes it (and the opentide probe does): the editor closes, the panel is disposed.
    result.firstMessagesBeforeClose = first.messages.map((m) => m.type);
    const disposed = new Promise((resolve) => first.panel.onDidDispose(resolve));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await disposed;
    result.firstClosedAfterMs = Date.now() - first.created;
    result.firstMessagesAtClose = first.messages.map((m) => m.type);
  }
  const second = open("second", media);
  const started = await waitFor(() => second.messages.some((m) => m.type === "started"), WAIT_MS);
  if (started) await waitFor(() => second.messages.some((m) => m.type === "ready"), 5000);
  result.stalled = !started;
  result.secondMessages = second.messages;
  result.secondVisible = second.panel.visible;
  result.secondActive = second.panel.active;
  second.panel.dispose();
  return result;
}

exports.run = async function run() {
  const arm = process.env.REPRO_ARM ?? "cut";
  const out = process.env.REPRO_OUT;
  let result;
  try {
    result = await trial(arm);
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
