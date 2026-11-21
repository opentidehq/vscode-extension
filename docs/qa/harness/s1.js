const { launch, shot, run } = require('./lib');
(async () => {
  const t0 = Date.now();
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: ['/tmp/qa/ws'] });
  await page.waitForTimeout(8000);
  await shot(page, 'vscode-00-launch');
  console.log('title', await page.title());
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
})().catch(e => { console.error(e); process.exit(1); });
