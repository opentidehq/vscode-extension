const { launch, shot, run } = require('./lib');
const cp = require('child_process');
(async () => {
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: '/tmp/qa/ud-r4', ext: '/tmp/qa/ext-r4', folders: ['/tmp/qa/ws'], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1', PATH: '/tmp/qa/venv-native/bin:' + process.env.BASEPATH } });
  await page.waitForTimeout(14000); await page.keyboard.press('Control+Alt+b');
  await run(page, 'opentide: Switch Runtime'); await page.waitForTimeout(1500);
  await shot(page, 'r4-04a-switch-runtime-picker');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(400);
  const items = await page.evaluate(() => Array.from(document.querySelectorAll('.quick-input-list .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | ')));
  console.log('PICKER', JSON.stringify(items, null, 1));
  await page.keyboard.press('Escape');
  await run(page, 'opentide: Switch Runtime'); await page.waitForTimeout(1200);
  // pick the item containing "installed"
  await page.locator('.quick-input-list .monaco-list-row', { hasText: /installed/i }).first().click().catch(e => console.log('click fail'));
  await page.waitForTimeout(6000);
  const toasts = await page.evaluate(() => Array.from(document.querySelectorAll('.notification-toast')).map(e => e.innerText.replace(/\n+/g, ' | ')).filter(x => !/root user/.test(x)));
  console.log('TOASTS after switch to installed', JSON.stringify(toasts));
  await shot(page, 'r4-04b-after-switch-to-installed');
  cp.execSync("ps -eo args | grep -E 'launcher.cjs|venv-native' | grep -v grep | cut -c1-140 || true", { stdio: 'inherit' });
  await run(page, 'opentide: Switch Runtime'); await page.waitForTimeout(1200);
  await page.locator('.quick-input-list .monaco-list-row', { hasText: /bundled/i }).first().click().catch(e => console.log('click fail'));
  await page.waitForTimeout(6000);
  const t2 = await page.evaluate(() => Array.from(document.querySelectorAll('.notification-toast')).map(e => e.innerText.replace(/\n+/g, ' | ')).filter(x => !/root user/.test(x)));
  console.log('TOASTS after switch back to bundled', JSON.stringify(t2));
  await shot(page, 'r4-04c-after-switch-back-to-bundled');
  cp.execSync("ps -eo args | grep -E 'launcher.cjs|venv-native' | grep -v grep | cut -c1-140 || true", { stdio: 'inherit' });
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
