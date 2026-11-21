const { launch, shot } = require('./lib');
const cp = require('child_process');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/kiro/Kiro/kiro', ud: '/tmp/qa/ud-kiro', ext: '/tmp/qa/ext-kiro3', folders: ['/tmp/qa/ws'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1', ELASTIC_STAGING_API_KEY: 'fake-key-qa' } });
  await page.waitForTimeout(16000);
  await shot(page, process.argv[2] || 'kiro-retest-01-launch');
  const toasts = await page.evaluate(() => Array.from(document.querySelectorAll('.notification-toast, .notifications-toasts .notification-list-item')).map(e => ({ text: e.innerText.replace(/\n+/g, ' | '), buttons: Array.from(e.querySelectorAll('a.monaco-button, .monaco-button')).map(b => b.innerText) })));
  console.log('TOASTS', JSON.stringify(toasts, null, 1));
  if (process.argv[3] === 'consent') {
    const clicked = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.notification-toast .monaco-button, .notification-toast a.monaco-button')).find(x => x.innerText.trim() === 'Add'); if (b) { b.click(); return true; } return false; });
    console.log('clicked Add via DOM:', clicked); await page.waitForTimeout(4000);
  }
  console.log('PROCS'); cp.execSync("ps -eo pid,ppid,args | grep -E 'mcp-wasi|launcher.cjs' | grep -v grep | cut -c1-210 || true", { stdio: 'inherit' });
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
