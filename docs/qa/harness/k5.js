// Restart Kiro with the entry already in ~/.kiro/settings/mcp.json and see what runs (no UI driving).
const { launch, shot } = require('./lib');
const cp = require('child_process');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/kiro/Kiro/kiro', ud: '/tmp/qa/ud-kiro', ext: process.env.KEXT || '/tmp/qa/ext-kiro3', folders: ['/tmp/qa/ws'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1', ELASTIC_STAGING_API_KEY: 'fake-key-qa', PATH: (process.env.EXTRA_PATH ? process.env.EXTRA_PATH + ':' : '') + process.env.PATH } });
  await page.waitForTimeout(25000);
  await shot(page, process.argv[2] || 'kiro-retest-02-restart');
  console.log('PROCS (25 s after start)'); cp.execSync("ps -eo pid,ppid,args | grep -E 'mcp-wasi|launcher.cjs' | grep -v grep | cut -c1-200 || true", { stdio: 'inherit' });
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
