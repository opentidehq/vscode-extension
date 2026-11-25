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
