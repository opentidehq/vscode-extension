// One traced launch: opentide.trace.server=verbose, copy the LSP trace channel text out via the clipboard.
const { _electron } = require('/opt/node-tools/node_modules/playwright'); const fs = require('fs'); const cp = require('child_process');
const [ws, kind, label] = process.argv.slice(2); const UD = '/tmp/qa/ud-v030', EXT = '/tmp/qa/ext-v030'; const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  cp.execSync("pkill -9 -f '[/]tmp/qa/vscode/code' || true"); await sleep(1500); cp.execSync(`rm -rf '${UD}/Backups' '${UD}/User/workspaceStorage'`);
  fs.writeFileSync(`${UD}/User/settings.json`, JSON.stringify({ 'files.hotExit': 'off', 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'chat.disableAIFeatures': true, 'opentide.trace.server': 'verbose' }));
  const t0 = Date.now();
  const app = await _electron.launch({ executablePath: '/tmp/qa/vscode/code', args: ['--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--user-data-dir', UD, '--extensions-dir', EXT, '--new-window', ws, `${ws}/objects/rules/hl-${kind}.yaml`], env: { ...process.env, VSCODE_CLI: '1' } });
  const page = await app.firstWindow(); await sleep(16000);
  await page.keyboard.press('Control+Shift+p'); await page.waitForSelector('.quick-input-widget', { state: 'visible' }); await page.keyboard.type('Output: Show Output Channels', { delay: 15 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(900);
  await page.keyboard.type('Language Server Trace', { delay: 15 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(1500);
  await page.keyboard.press('Control+a'); await page.keyboard.press('Control+c'); await sleep(500);
  const txt = await app.evaluate(({ clipboard }) => clipboard.readText());
  fs.writeFileSync(`/tmp/qa/hl/out/trace-${label}.txt`, txt); console.log(label, 'trace chars', txt.length, 'lines', txt.split('\n').length);
  await Promise.race([app.close(), sleep(10000)]); cp.execSync("pkill -9 -f '[/]tmp/qa/vscode/code' || true"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
