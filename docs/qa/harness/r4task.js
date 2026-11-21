const { launch, shot, run } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-r4', ext: '/tmp/qa/ext-r4', folders: ['/tmp/qa/ws'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1', PATH: '/tmp/qa/venv-native/bin:' + process.env.BASEPATH, ELASTIC_STAGING_API_KEY: 'fake-key-qa' } });
  await page.waitForTimeout(14000); await page.keyboard.press('Control+Alt+b');
  const toasts = async (tag) => console.log(tag, JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('.notification-toast')).map(e => e.innerText.replace(/\n+/g, ' | ')).filter(x => !/root user/.test(x)))));
  for (const [label, shotName] of [[process.argv[2], process.argv[3]]]) {
    await page.keyboard.press('Escape'); await page.mouse.click(85, 51); await page.keyboard.press('Control+Shift+p'); await page.waitForSelector('.quick-input-widget', { state: 'visible' });
    await page.keyboard.type('Tasks: Run Task', { delay: 40 }); await page.waitForTimeout(1200);
    await page.locator('.quick-input-list .monaco-list-row', { hasText: /^Tasks: Run Task\s*$/ }).first().click(); await page.waitForTimeout(2000);
    await page.keyboard.type(label, { delay: 30 }); await page.waitForTimeout(1200);
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | ')).slice(0, 3));
    console.log('TASK PICKER', label, JSON.stringify(rows));
    await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
    await page.keyboard.press('Enter').catch(() => {}); // "Continue without scanning"
    await page.waitForTimeout(5000); await toasts('TOASTS ' + label);
    await shot(page, shotName); const term = await page.evaluate(() => Array.from(document.querySelectorAll('.terminal-wrapper .xterm-rows > div, .part.panel .xterm-rows > div')).map(e => e.innerText).join('\n')); console.log('TERMINAL TEXT:\n' + term.slice(0, 900)); const links = await page.evaluate(() => Array.from(document.querySelectorAll('.part.panel a, .xterm-link-layer')).map(e => e.innerText || e.className).slice(0, 5)); console.log('LINKS', JSON.stringify(links));
  }
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
