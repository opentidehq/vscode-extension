const { launch, shot, run, palette } = require('./lib');
const W = '/tmp/qa/ws';
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: [W], env: { ELASTIC_STAGING_API_KEY: 'fake-key-qa', VSCODE_CLI: '1' } });
  await page.waitForTimeout(10000);
  await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(300);
  await page.keyboard.press('Control+p'); await page.waitForTimeout(500);
  await page.keyboard.type('encoded-powershell.yaml', { delay: 30 }); await page.waitForTimeout(900);
  await page.keyboard.press('Enter'); await page.waitForTimeout(4000);
  await run(page, 'opentide: Preview Deploy'); await page.waitForTimeout(8000);
  await shot(page, 'vscode-03b-deploy-preview-dry-run');
  await page.getByText('Validate live on', { exact: false }).first().click({ timeout: 8000 }).catch(e => console.log('codelens miss', e.message.split('\n')[0]));
  await page.waitForTimeout(8000);
  await shot(page, 'vscode-03c-validate-live-via-codelens');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
