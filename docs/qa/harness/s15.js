const { launch, shot, run, palette } = require('./lib');
const cp = require('child_process');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-br', ext: '/tmp/qa/ext-br', folders: ['/tmp/qa/ws'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(6000);
  await page.click('text=Manage', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Trust', exact: true }).first().click({ timeout: 5000 }).catch(e => console.log('trust click fail'));
  await page.waitForTimeout(12000);
  await page.keyboard.press('Control+w'); await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(500);
  await shot(page, 'bridge-vscode-01-activated');
  await run(page, 'MCP: List Servers'); await page.waitForTimeout(2000);
  await shot(page, 'bridge-vscode-04a-mcp-list-servers');
  console.log('PROCS'); cp.execSync("ps -eo pid,args | grep -E 'mcp-wasi|launcher.cjs' | grep -v grep | cut -c1-230 || true", { stdio: 'inherit' });
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
  await new Promise(r => setTimeout(r, 5000));
  console.log('PROCS-AFTER-CLOSE'); cp.execSync("ps -eo pid,args | grep -E 'mcp-wasi|launcher.cjs' | grep -v grep | cut -c1-230 || true", { stdio: 'inherit' });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
