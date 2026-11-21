const { launch, shot, run, palette } = require('./lib');
const W = '/tmp/qa/ws';
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: [W], env: { ELASTIC_STAGING_API_KEY: 'fake-key-qa', VSCODE_CLI: '1' } });
  await page.waitForTimeout(10000);
  await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(300);
  await page.keyboard.press('Control+p'); await page.waitForTimeout(500);
  await page.keyboard.type('encoded-powershell.yaml', { delay: 30 }); await page.waitForTimeout(900);
  await page.keyboard.press('Enter'); await page.waitForTimeout(4000);
  await page.keyboard.press('Control+g'); await page.waitForTimeout(500);
  await page.keyboard.type('61', { delay: 40 }); await page.keyboard.press('Enter'); await page.keyboard.press('End'); await page.waitForTimeout(1000);
  await shot(page, 'vscode-03c-cursor-in-query-codelens');
  await run(page, 'opentide: Validate Query on Tenants'); await page.waitForTimeout(4000);
  await shot(page, 'vscode-03d-validate-live-picker');
  await page.keyboard.press('Enter'); await page.waitForTimeout(9000);
  await shot(page, 'vscode-03e-validate-live-result');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
