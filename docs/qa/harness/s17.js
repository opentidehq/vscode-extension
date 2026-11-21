const { launch, shot } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: ['/tmp/qa/ws'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(10000);
  await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(300);
  await page.keyboard.press('Control+p'); await page.waitForTimeout(500);
  await page.keyboard.type('encoded-powershell.yaml', { delay: 30 }); await page.waitForTimeout(900);
  await page.keyboard.press('Enter'); await page.waitForTimeout(4000);
  await page.keyboard.press('Control+g'); await page.waitForTimeout(500);
  await page.keyboard.type('61', { delay: 40 }); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  await page.keyboard.press('End'); await page.waitForTimeout(500);
  await page.keyboard.press('Control+Shift+p'); await page.waitForTimeout(700);
  await page.keyboard.type('opentide: Validate Query on Tenants', { delay: 40 }); await page.waitForTimeout(1500);
  await shot(page, 'vscode-03f-validate-query-palette-cursor-in-query');
  await page.keyboard.press('Enter'); await page.waitForTimeout(4000);
  await shot(page, 'vscode-03g-validate-query-palette-result');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
