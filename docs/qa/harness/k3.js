const { launch, shot, run, palette } = require('./lib');
const cp = require('child_process');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/kiro/Kiro/kiro', ud: '/tmp/qa/ud-kiro', ext: '/tmp/qa/ext-kiro-br', folders: ['/tmp/qa/ws-kiro'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(15000);
  await shot(page, 'kiro-bridge-00-launch');
  const notes = await page.locator('.notifications-toasts, .notification-toast, .monaco-workbench .notification-list-item').allInnerTexts().catch(() => []);
  console.log('NOTIFICATION TEXT:', JSON.stringify(notes).slice(0, 800));
  const body = await page.evaluate(() => Array.from(document.querySelectorAll('.notification-toast-container, .notifications-toasts')).map(e => e.innerText).join('|')).catch(() => '');
  console.log('BODY', body.slice(0, 600));
  console.log('PROCS'); cp.execSync("ps -eo pid,args | grep -E 'launcher.cjs|mcp-wasi' | grep -v grep | cut -c1-200 || true", { stdio: 'inherit' });
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
