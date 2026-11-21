const { launch, shot, run } = require('./lib');
const cp = require('child_process');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-r4', ext: '/tmp/qa/ext-r4', folders: ['/tmp/qa/empty5'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(14000); await page.keyboard.press('Control+Alt+b');
  await run(page, 'MCP: List Servers'); await page.waitForTimeout(1500);
  await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  const acts = await page.evaluate(() => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | '))); console.log('ACTIONS', JSON.stringify(acts));
  await page.locator('.quick-input-list .monaco-list-row', { hasText: /Start Server/ }).first().click().catch(() => console.log('no start row')); await page.waitForTimeout(6000);
  console.log('PROCESSES:\n' + cp.execSync("ps -eo pid,args | grep -E 'mcp-wasi|mcp start' | grep -v grep | grep -v 'h/r4' | cut -c1-170 || true", { encoding: 'utf8' }));
  await run(page, 'MCP: List Servers'); await page.waitForTimeout(1500); await shot(page, 'r4-96g-mcp-running');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
