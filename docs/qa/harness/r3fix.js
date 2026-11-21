const { launch, shot, run } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-r3', ext: '/tmp/qa/ext-r3', folders: ['/tmp/qa/ws'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1', ELASTIC_STAGING_API_KEY: 'fake-key-qa' } });
  await page.waitForTimeout(12000); await page.keyboard.press('Control+Alt+b');
  await page.keyboard.press('Control+p'); await page.waitForTimeout(500); await page.keyboard.type('encoded-powershell.yaml', { delay: 30 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(4000);
  await page.keyboard.press('Control+g'); await page.waitForTimeout(500); await page.keyboard.type('61', { delay: 40 }); await page.keyboard.press('Enter'); await page.keyboard.press('End'); await page.waitForTimeout(800);
  await page.keyboard.press('Control+Shift+p'); await page.waitForTimeout(700); await page.keyboard.type('opentide: Validate Query on Tenants', { delay: 40 }); await page.waitForTimeout(1500);
  await page.keyboard.press('Enter');
  const seen = new Set(); const t1 = Date.now();
  while (Date.now() - t1 < 9000) { await page.waitForTimeout(500);
    const picker = await page.evaluate(() => document.querySelector('.quick-input-widget:not([style*="display: none"]) .quick-input-list') ? Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).map(e => 'PICKER: ' + e.innerText.replace(/\n+/g, ' | ')) : []);
    const t = await page.evaluate(() => Array.from(document.querySelectorAll('.notification-toast')).map(e => e.innerText.replace(/\n+/g, ' | ')).filter(x => !/root user/.test(x)));
    for (const x of [...t, ...picker]) { if (!seen.has(x)) { seen.add(x); await shot(page, 'r3-10-fix-palette-validate-' + seen.size); } } }
  for (const wait of [6000, 6000]) {
    await page.waitForTimeout(wait); await page.keyboard.press('Escape'); await page.keyboard.press('Control+Shift+p'); await page.waitForTimeout(700); await page.keyboard.type('opentide: Validate Query on Tenants', { delay: 40 }); await page.waitForTimeout(1500); await page.keyboard.press('Enter');
    const t2 = Date.now(); while (Date.now() - t2 < 4000) { await page.waitForTimeout(500); const t = await page.evaluate(() => Array.from(document.querySelectorAll('.notification-toast')).map(e => e.innerText.replace(/\n+/g, ' | ')).filter(x => !/root user/.test(x))); t.forEach(x => seen.add('retry: ' + x)); }
  }
  console.log('PALETTE Validate Query on Tenants (cursor in query):', JSON.stringify([...seen], null, 1));
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
