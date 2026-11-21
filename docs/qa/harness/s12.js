const { launch, shot, run, palette } = require('./lib');
const cp = require('child_process');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: ['/tmp/qa/ws-vsc'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(12000);
  await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(300);
  await shot(page, 'vscode-05e-restricted-statusbar');
  console.log('PROCS-RESTRICTED'); cp.execSync("ps -eo pid,args | grep -E 'launcher.cjs|opentide' | grep -v grep | cut -c1-150 || true", { stdio: 'inherit' });
  await run(page, 'MCP: List Servers'); await page.waitForTimeout(2000);
  await shot(page, 'vscode-05f-restricted-mcp-list');
  await page.keyboard.press('Escape');
  await run(page, 'opentide: Validate Workspace'); await page.waitForTimeout(3000);
  await shot(page, 'vscode-05g-restricted-validate-command');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
