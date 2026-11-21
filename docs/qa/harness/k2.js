const { launch, shot, run, palette } = require('./lib');
const cp = require('child_process');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/kiro/Kiro/kiro', ud: '/tmp/qa/ud-kiro', ext: '/tmp/qa/ext-kiro', folders: ['/tmp/qa/ws-kiro'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(14000);
  await page.keyboard.press('Control+Shift+p'); await page.waitForTimeout(1500);
  await shot(page, 'kiro-01-palette-over-signin');
  await page.keyboard.type('MCP', { delay: 60 }); await page.waitForTimeout(2000);
  await shot(page, 'kiro-02-palette-mcp-commands');
  await page.keyboard.press('Escape');
  console.log('PROCS'); cp.execSync("ps -eo pid,args | grep -E 'launcher.cjs|mcp-wasi' | grep -v grep | cut -c1-200 || true", { stdio: 'inherit' });
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
