const { launch, shot } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-r3', ext: '/tmp/qa/ext-r3', folders: ['/tmp/qa/ws'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(14000); await page.keyboard.press('Control+Alt+b');
  await page.keyboard.press('Escape'); await page.mouse.click(85, 51); await page.keyboard.press('Control+Shift+p'); await page.waitForSelector('.quick-input-widget', { state: 'visible' });
  await page.keyboard.type('Chat: Configure Skills', { delay: 40 }); await page.waitForTimeout(1200); await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
  const items = await page.evaluate(() => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | ').slice(0, 90)));
  const dup = items.filter(x => /^active-directory/.test(x)).length; const full = await page.evaluate(() => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | ')).filter(x => /^active-directory/.test(x)).map(x => x.slice(-60))); console.log('active-directory rows:', dup, JSON.stringify(full));
  await shot(page, 'r3-08e-skills-no-plugin');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
