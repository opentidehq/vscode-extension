const { launch } = require('./lib');
const cp = require('child_process');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-vsc', ext: '/tmp/qa/ext-vsc', folders: ['/tmp/qa/ws'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(12000);
  const main = app.process().pid;
  console.log('main pid', main);
  cp.execSync("ps -eo pid,ppid,args | grep -E 'launcher.cjs' | grep -v grep | cut -c1-120", { stdio: 'inherit' });
  process.kill(main, 'SIGKILL');
  await new Promise(r => setTimeout(r, 8000));
  console.log('AFTER SIGKILL of main, 8s later:');
  cp.execSync("ps -eo pid,ppid,etime,args | grep -E 'launcher.cjs' | grep -v grep | cut -c1-140 || true", { stdio: 'inherit' });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
