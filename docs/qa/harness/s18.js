const { launch, shot } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: ['/tmp/qa/ws'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(10000);
  const item = page.locator('[id*="opentidehq.opentide"]').first();
  console.log('status items', await page.locator('footer [id*="opentidehq.opentide"]').count());
  await page.mouse.move(350, 986); await page.waitForTimeout(2500);
  await shot(page, 'vscode-01g-statusbar-tooltip');
  await page.mouse.click(350, 986); await page.waitForTimeout(2000);
  await shot(page, 'vscode-01h-statusbar-click');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
