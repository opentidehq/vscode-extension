const { launch, shot, run, palette } = require('./lib');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: ['/tmp/qa/ws'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(12000);
  await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(300);
  await run(page, 'Developer: Show Running Extensions'); await page.waitForTimeout(4000);
  await shot(page, 'vscode-01f-running-extensions-activation-time');
  console.log('PIDS-BEFORE-CLOSE');
  require('child_process').execSync("ps -eo pid,args | grep -E 'launcher.cjs' | grep -v grep | cut -c1-170", { stdio: 'inherit' });
  await app.close().catch(() => {});
  console.log('closed');
  await new Promise(r => setTimeout(r, 6000));
  console.log('PIDS-6s-AFTER-CLOSE');
  require('child_process').execSync("ps -eo pid,ppid,etime,args | grep -E 'launcher.cjs|vscode/code' | grep -v grep | cut -c1-170 || true", { stdio: 'inherit' });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
