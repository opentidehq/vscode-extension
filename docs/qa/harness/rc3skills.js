const { launch, shot } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-rc3v', ext: '/tmp/qa/ext-rc3v', folders: ['/tmp/qa/ws-rc3'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(14000); await page.keyboard.press('Control+Alt+b');
  for (const [cmd, name] of [['MCP: List Servers', 'rc3-agents-0-mcp-list-servers'], ['Chat: Configure Tools', 'rc3-agents-0b-configure-tools'], ['Chat: Configure Skills', 'rc3-agents-a-chat-configure-skills'], ['Chat: Configure Instructions', 'rc3-agents-b-chat-configure-instructions'], ['Chat: Open Customizations', 'rc3-agents-c-chat-customizations']]) {
    await page.keyboard.press('Escape'); await page.mouse.click(85, 51); await page.keyboard.press('Control+Shift+p'); await page.waitForSelector('.quick-input-widget', { state: 'visible' });
    await page.keyboard.type(cmd, { delay: 40 }); await page.waitForTimeout(1200);
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | ')).slice(0, 4));
    console.log('PALETTE', cmd, JSON.stringify(rows));
    await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
    const items = await page.evaluate(() => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | ')));
    console.log('LIST', cmd, items.length, JSON.stringify(items.slice(0, 40)));
    await shot(page, name);
  }
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
