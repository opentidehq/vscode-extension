const { launch, shot, run } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/kiro/Kiro/kiro', ud: '/tmp/qa/ud-kiro', ext: '/tmp/qa/ext-kiro', folders: ['/tmp/qa/ws-kiro'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(15000);
  console.log('title', await page.title());
  const wins = app.windows(); console.log('windows', wins.length);
  await shot(page, 'kiro-00-launch');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
