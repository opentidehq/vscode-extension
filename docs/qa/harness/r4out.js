const { launch, shot } = require('./lib');
const fs = require('fs');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-r4', ext: '/tmp/qa/ext-r4', folders: ['/tmp/qa/ws'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1', ELASTIC_STAGING_API_KEY: 'fake-key-qa' } });
  await page.waitForTimeout(14000); await page.keyboard.press('Control+Alt+b');
  await page.keyboard.press('Control+p'); await page.waitForTimeout(500); await page.keyboard.type('encoded-powershell.yaml', { delay: 30 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(5000);
  await page.keyboard.press('Control+g'); await page.waitForTimeout(500); await page.keyboard.type('61', { delay: 40 }); await page.keyboard.press('Enter'); await page.keyboard.press('End'); await page.waitForTimeout(1500);
  await page.keyboard.press('Control+Shift+p'); await page.waitForTimeout(700); await page.keyboard.type('opentide: Validate Query on Tenants', { delay: 40 }); await page.waitForTimeout(1500); await page.keyboard.press('Enter'); await page.waitForTimeout(5000);
  await page.keyboard.press('Control+Shift+p'); await page.waitForTimeout(700); await page.keyboard.type('Output: Show Output Channels', { delay: 40 }); await page.waitForTimeout(1200); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | ')));
  console.log('CHANNELS', JSON.stringify(rows));
  await page.keyboard.type('opentide Language Server Trace', { delay: 30 }); await page.waitForTimeout(1000); await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
  await shot(page, 'r4-trace-channel');
  await page.keyboard.press('Control+Shift+p'); await page.waitForTimeout(500); await page.keyboard.type('View: Toggle Maximized Panel', { delay: 30 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(1200);
  await page.locator('.part.panel .view-lines').first().click({ position: { x: 300, y: 100 } }).catch(() => {});
  await page.keyboard.press('Control+End'); await page.waitForTimeout(500);
  const pages = [];
  for (let i = 0; i < 40; i++) { const t = await page.evaluate(() => Array.from(document.querySelectorAll('.part.panel .view-lines .view-line')).sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map(e => e.innerText.replace(/\u00a0/g, ' ')).join('\n')); pages.unshift(t); await page.keyboard.press('PageUp'); await page.waitForTimeout(120); }
  fs.writeFileSync('/tmp/qa/r4-trace-pages.txt', pages.join('\n=====page=====\n'));
  await shot(page, 'r4-trace-channel-maximized');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
