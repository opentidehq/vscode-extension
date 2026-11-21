const { launch, shot, run } = require('./lib');
const cp = require('child_process');
const ps = () => { try { return cp.execSync("ps -eo pid,args | grep -E 'launcher.cjs|mcp-wasi|opentide' | grep -v grep | grep -v 'h/r3' | cut -c1-170", { encoding: 'utf8' }).trim() || '(none)'; } catch { return '(none)'; } };
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-r4', ext: '/tmp/qa/ext-r4', folders: ['/tmp/qa/empty3'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  await page.waitForTimeout(14000); await page.keyboard.press('Control+Alt+b');
  console.log('PROCESSES, empty window:\n' + ps());
  await shot(page, 'r4-96a-dormant-window');
  await run(page, 'Developer: Show Running Extensions'); await page.waitForTimeout(4000);
  await shot(page, 'r4-96b-dormant-running-extensions');
  const act = await page.evaluate(() => Array.from(document.querySelectorAll('.monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | ')).filter(x => /^opentide\b|opentide/i.test(x)).slice(0, 2));
  console.log('RUNNING EXTENSIONS row:', JSON.stringify(act));
  await page.keyboard.press('Escape');
  cp.execSync(`/tmp/qa/vscode/bin/code --no-sandbox --user-data-dir /tmp/qa/ud-r4 --extensions-dir /tmp/qa/ext-r4 -r /tmp/qa/other/objects/rules/suspicious-lsass-access.yaml`, { stdio: 'ignore', env: { ...process.env, VSCODE_CLI: '1' } });
  await page.waitForTimeout(12000);
  console.log('PROCESSES, after opening a rule file:\n' + ps()); await page.waitForTimeout(8000); console.log('PROCESSES, 8 s later:\n' + ps());
  await shot(page, 'r4-96c-rule-file-opened');
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
