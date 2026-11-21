const { launch } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: ['/tmp/qa/ws'], env: { ELASTIC_STAGING_API_KEY: 'fake-key-qa', VSCODE_CLI: '1' } });
  await page.waitForTimeout(30000);
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})();
