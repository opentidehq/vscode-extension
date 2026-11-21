const { launch, shot, run, palette } = require('./lib');
const cp = require('child_process');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-br', ext: '/tmp/qa/ext-br', folders: ['/tmp/qa/ws'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(10000);
  await page.keyboard.press('Control+Alt+b'); await page.waitForTimeout(300);
  await run(page, 'MCP: List Servers'); await page.waitForTimeout(1500);
  await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  await shot(page, 'bridge-vscode-04b-mcp-server-actions');
  await page.keyboard.type('Start Server', { delay: 40 }); await page.waitForTimeout(600); await page.keyboard.press('Enter'); await page.waitForTimeout(6000);
  console.log('PROCS-MCP'); cp.execSync("ps -eo pid,ppid,args | grep -E 'mcp-wasi|launcher.cjs' | grep -v grep | cut -c1-200 || true", { stdio: 'inherit' });
  const pid = cp.execSync("pgrep -f 'dist/mcp-wasi.js' | head -1").toString().trim();
  if (pid) { console.log('ENV', cp.execSync(`tr '\\0' '\\n' < /proc/${pid}/environ | grep -E 'ELECTRON|OPENTIDE|^PWD|FETCH' ; readlink /proc/${pid}/cwd`).toString()); }
  await run(page, 'MCP: List Servers'); await page.waitForTimeout(1500);
  await shot(page, 'bridge-vscode-04c-mcp-list-running');
  await page.keyboard.press('Escape');
  await run(page, 'MCP: List Servers'); await page.waitForTimeout(1000); await page.keyboard.press('Enter'); await page.waitForTimeout(800);
  await page.keyboard.type('Show Output', { delay: 40 }); await page.waitForTimeout(600); await page.keyboard.press('Enter'); await page.waitForTimeout(3000);
  await shot(page, 'bridge-vscode-04d-mcp-server-output');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]);
  await new Promise(r => setTimeout(r, 5000));
  console.log('PROCS-AFTER-CLOSE'); cp.execSync("ps -eo pid,args | grep -E 'mcp-wasi|launcher.cjs' | grep -v grep | cut -c1-200 || true", { stdio: 'inherit' });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
