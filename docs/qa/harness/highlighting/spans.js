// Dump every visible span (text, colour) of the open rule after settling, to diff semantic on/off.
const { _electron } = require('/opt/node-tools/node_modules/playwright'); const fs = require('fs'); const cp = require('child_process');
const [ws, kind, theme, sem, label] = process.argv.slice(2); const UD = '/tmp/qa/ud-v030', EXT = '/tmp/qa/ext-v030'; const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  cp.execSync("pkill -9 -f '[/]tmp/qa/vscode/code' || true"); await sleep(1500); cp.execSync(`rm -rf '${UD}/Backups' '${UD}/User/workspaceStorage'`);
  const s = { 'files.hotExit': 'off', 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'chat.disableAIFeatures': true, 'workbench.colorTheme': theme === 'light' ? 'Default Light+' : 'Default Dark+' }; if (sem === 'off') s['[opentide-yaml]'] = { 'editor.semanticHighlighting.enabled': false };
  fs.writeFileSync(`${UD}/User/settings.json`, JSON.stringify(s));
  const app = await _electron.launch({ executablePath: '/tmp/qa/vscode/code', args: ['--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--user-data-dir', UD, '--extensions-dir', EXT, '--new-window', ws, `${ws}/objects/rules/hl-${kind}.yaml`], env: { ...process.env, VSCODE_CLI: '1' } });
  const page = await app.firstWindow(); await sleep(14000);
  const lines = await page.evaluate(() => Array.from(document.querySelectorAll('.editor-instance .monaco-editor .view-lines .view-line')).sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map(l => Array.from(l.querySelectorAll(':scope > span > span')).map(s => [s.textContent.replace(/ /g, ' '), getComputedStyle(s).color])));
  fs.writeFileSync(`/tmp/qa/hl/out/spans-${label}.json`, JSON.stringify(lines)); console.log(label, lines.length, 'lines');
  await Promise.race([app.close(), sleep(10000)]); cp.execSync("pkill -9 -f '[/]tmp/qa/vscode/code' || true"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
