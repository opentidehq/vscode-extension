const { launch, shot } = require('./lib');
const cp = require('child_process'); const fs = require('fs');
const ps = () => { try { return cp.execSync("ps -eo pid,args | grep -E 'launcher.cjs|mcp-wasi' | grep -v grep | grep -v 'h/r4' | cut -c1-170", { encoding: 'utf8' }).trim() || '(none)'; } catch { return '(none)'; } };
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-r4', ext: '/tmp/qa/ext-r4', folders: ['/tmp/qa/empty4'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(14000); console.log('A. empty folder window:\n' + ps());
  // opentide content appears in the folder (a repo is set up inside it)
  cp.execSync('cp -r /tmp/qa/ws-pristine/. /tmp/qa/empty4/ && rm -rf /tmp/qa/empty4/.git');
  await page.waitForTimeout(10000); console.log('B. 10 s after a detection repo appears in the folder:\n' + ps());
  await page.keyboard.press('Control+Alt+b'); await page.keyboard.press('Control+p'); await page.waitForTimeout(500); await page.keyboard.type('suspicious-lsass-access.yaml', { delay: 30 }); await page.waitForTimeout(900); await page.keyboard.press('Enter'); await page.waitForTimeout(8000);
  console.log('C. after opening a rule file in it:\n' + ps());
  await shot(page, 'r4-96d-content-appeared');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
