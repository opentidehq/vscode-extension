const { launch, shot, run, palette } = require('./lib');
const W = '/tmp/qa/ws';
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: [W] });
  await page.waitForTimeout(10000);
  await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(300);
  await page.keyboard.press('Control+j'); await page.waitForTimeout(300);  // hide panel
  // sidebar: click opentide activity icon
  await page.mouse.click(26, 277); await page.waitForTimeout(3000);
  await shot(page, 'vscode-02f-sidebar-views');
  await palette(page, 'opentide: Show Status Menu'); await shot(page, 'vscode-01d-status-menu-palette');
  await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  await shot(page, 'vscode-01e-status-menu');
  await page.keyboard.press('Escape');
  await run(page, 'opentide: Show Graph'); await page.waitForTimeout(6000);
  await shot(page, 'vscode-02h-graph');
  await run(page, 'opentide: Preview Deploy'); await page.waitForTimeout(7000);
  await shot(page, 'vscode-02i-deploy-preview');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
})().catch(e => { console.error(e); process.exit(1); });
