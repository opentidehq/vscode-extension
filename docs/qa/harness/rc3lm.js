const { launch, shot } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-rc3v', ext: '/tmp/qa/ext-rc3v', folders: ['/tmp/qa/ws-rc3'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(12000);
  await page.keyboard.press('Control+Alt+i'); await page.waitForTimeout(1500);
  await page.keyboard.type('#opentide', { delay: 60 }); await page.waitForTimeout(2000);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.suggest-widget .monaco-list-row, .chat-input-widget .monaco-list-row')).map(e => (e.getAttribute('aria-label') || e.innerText).replace(/\n+/g, ' | ')));
  console.log('ROWS', JSON.stringify(rows));
  await shot(page, 'rc3-agents-d-lm-tools-hash-completion');
  await page.keyboard.press('Escape');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
