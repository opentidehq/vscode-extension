// #87: same rule, same cursor; (1) palette command, (2) the CodeLens. Marks each phase in the log with a timestamped console line.
const { launch, shot } = require('./lib');
const fs = require('fs');
const stamp = (s) => { const t = new Date().toISOString(); console.log(t, s); fs.appendFileSync('/tmp/qa/trace-phases-r4.txt', t + ' ' + s + '\n'); };
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-r4', ext: '/tmp/qa/ext-r4', folders: ['/tmp/qa/ws'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1', ELASTIC_STAGING_API_KEY: 'fake-key-qa' } });
  stamp('window launched'); await page.waitForTimeout(14000); await page.keyboard.press('Control+Alt+b');
  await page.keyboard.press('Control+p'); await page.waitForTimeout(500); await page.keyboard.type('encoded-powershell.yaml', { delay: 30 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(5000);
  await page.keyboard.press('Control+g'); await page.waitForTimeout(500); await page.keyboard.type('61', { delay: 40 }); await page.keyboard.press('Enter'); await page.keyboard.press('End'); await page.waitForTimeout(1500);
  // visible opentide output channel
  await page.keyboard.press('Control+Shift+p'); await page.waitForTimeout(700); await page.keyboard.type('opentide: Show Output', { delay: 40 }); await page.waitForTimeout(1200); await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  await page.keyboard.press('Control+1'); await page.waitForTimeout(500); // back to the editor, cursor stays on line 61
  await shot(page, 'r4-87-before-palette');
  stamp('PHASE A: palette command "opentide: Validate Query on Tenants" (cursor at end of line 61)');
  await page.keyboard.press('Control+Shift+p'); await page.waitForTimeout(700); await page.keyboard.type('opentide: Validate Query on Tenants', { delay: 40 }); await page.waitForTimeout(1500); await page.keyboard.press('Enter');
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(700); const t = await page.evaluate(() => Array.from(document.querySelectorAll('.notification-toast')).map(e => e.innerText.replace(/\n+/g, ' | ')).filter(x => !/root user/.test(x))); if (t.length) { stamp('TOAST (palette): ' + t.join(' || ')); await shot(page, 'r4-87-palette-result'); break; } }
  await page.waitForTimeout(3000);
  stamp('PHASE B: CodeLens "Validate live on elastic-local-fake" (same file, same cursor)');
  await page.locator('a:has-text("Validate live")').first().click({ timeout: 8000 }).catch(e => stamp('lens click failed ' + e.message.split('\n')[0]));
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(700); const t = await page.evaluate(() => Array.from(document.querySelectorAll('.notification-toast')).map(e => e.innerText.replace(/\n+/g, ' | ')).filter(x => !/root user/.test(x))); if (t.length) { stamp('TOAST (lens): ' + t.join(' || ')); await shot(page, 'r4-87-lens-result'); if (t.some(x => /valid/.test(x))) break; } }
  stamp('done');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
