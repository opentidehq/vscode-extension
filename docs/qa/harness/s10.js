const { launch, shot, run, palette } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: ['/tmp/qa/ws'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(10000);
  await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(300);
  await run(page, 'MCP: List Servers'); await page.waitForTimeout(2000);
  await shot(page, 'vscode-04a-mcp-list-servers');
  await page.keyboard.press('Enter'); await page.waitForTimeout(2000);
  await shot(page, 'vscode-04b-mcp-server-actions');
  await page.keyboard.type('Show Output', { delay: 40 }); await page.waitForTimeout(800);
  await page.keyboard.press('Enter'); await page.waitForTimeout(4000);
  await shot(page, 'vscode-04c-mcp-server-output');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
