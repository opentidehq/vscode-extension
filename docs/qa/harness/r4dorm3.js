const { launch, shot, run } = require('./lib');
const cp = require('child_process');
const ps = () => { try { return cp.execSync("ps -eo pid,args | grep -E 'mcp-wasi|mcp start' | grep -v grep | grep -v 'h/r4' | cut -c1-170", { encoding: 'utf8' }).trim() || '(none)'; } catch { return '(none)'; } };
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-r4', ext: '/tmp/qa/ext-r4', folders: ['/tmp/qa/empty5'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(14000); await page.keyboard.press('Control+Alt+b');
  await run(page, 'MCP: List Servers'); await page.waitForTimeout(1500); await shot(page, 'r4-96e-mcp-list-dormant');
  const before = await page.evaluate(() => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | '))); console.log('MCP list while dormant:', JSON.stringify(before)); await page.keyboard.press('Escape');
  cp.execSync('cp -r /tmp/qa/ws-pristine/. /tmp/qa/empty5/ && rm -rf /tmp/qa/empty5/.git'); await page.waitForTimeout(9000);
  await run(page, 'MCP: List Servers'); await page.waitForTimeout(1500); await shot(page, 'r4-96f-mcp-list-after-content');
  const after = await page.evaluate(() => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | '))); console.log('MCP list after content appeared:', JSON.stringify(after));
  await page.locator('.quick-input-list .monaco-list-row', { hasText: /^opentide/ }).first().click().catch(e => console.log('no opentide row')); await page.waitForTimeout(1200);
  await page.keyboard.type('Start Server', { delay: 40 }); await page.waitForTimeout(700); await page.keyboard.press('Enter'); await page.waitForTimeout(6000);
  console.log('PROCESSES after Start Server:\n' + ps());
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
