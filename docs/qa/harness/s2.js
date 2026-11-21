const { launch, shot, run, palette } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: ['/tmp/qa/ws'] });
  await page.waitForTimeout(6000);
  await page.click('text=Manage', { timeout: 5000 }).catch(e => console.log('no manage', e.message));
  await page.waitForTimeout(2000);
  await shot(page, 'vscode-05b-trust-editor');
  const btn = page.getByRole('button', { name: 'Trust', exact: true }).first();
  console.log('btn count', await btn.count());
  await btn.click({ timeout: 5000 }).catch(e => console.log('click fail', e.message));
  await page.waitForTimeout(12000);
  await shot(page, 'vscode-01a-after-trust');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
})().catch(e => { console.error(e); process.exit(1); });
