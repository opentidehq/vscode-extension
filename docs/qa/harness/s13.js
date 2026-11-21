const { launch, shot, run, palette } = require('./lib');
const cp = require('child_process');
(async () => {
  const t0 = Date.now();
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: ['/tmp/qa/multi.code-workspace'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  console.log('window up ms', Date.now() - t0);
  await page.waitForTimeout(20000);
  await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(300);
  await page.keyboard.press('Control+Shift+m'); await page.waitForTimeout(2500);
  await shot(page, 'vscode-06a-multiroot-large-problems');
  await run(page, 'opentide: Validate Workspace'); await page.waitForTimeout(8000);
  await shot(page, 'vscode-06b-multiroot-validate-workspace');
  await page.mouse.click(26, 277); await page.waitForTimeout(3000);
  await shot(page, 'vscode-06c-multiroot-sidebar');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
