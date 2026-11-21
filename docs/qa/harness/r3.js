// Generic Rerun-3 driver. usage: node r3.js <ud> <ext> <folder> <shotName|-> [flags...]; env EXTRA_PATH to prepend to PATH, TRUST=1 for --disable-workspace-trust,
// CMDS="cmd1;cmd2" palette commands (each followed by Enter), WAIT ms.
const { launch, shot, run } = require('./lib');
const cp = require('child_process');
(async () => {
  const [ud, ext, folder, name] = process.argv.slice(2);
  const env = { VSCODE_CLI: '1', ELASTIC_STAGING_API_KEY: 'fake-key-qa' };
  if (process.env.EXTRA_PATH !== undefined) env.PATH = process.env.EXTRA_PATH + (process.env.EXTRA_PATH ? ':' : '') + process.env.BASEPATH;
  const exe = process.env.EDITOR_EXE || '/tmp/qa/vscode/code';
  const t0 = Date.now();
  const { app, page } = await launch({ exe, ud, ext, folders: [folder], extra: process.env.TRUST === '1' ? ['--disable-workspace-trust'] : [], env });
  const seen = new Set(); const wait = +(process.env.WAIT || 14000); const tEnd = Date.now() + wait;
  while (Date.now() < tEnd) { await page.waitForTimeout(700); if (process.env.CLICK_ADD) { const c = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('.notification-toast .monaco-button')).find(x => x.innerText.trim() === 'Add'); if (b) { b.click(); return true; } return false; }); if (c) console.log('clicked Add (DOM of the extension\'s own notification)'); } const t = await page.evaluate(() => Array.from(document.querySelectorAll('.notification-toast')).map(e => e.innerText.replace(/\n+/g, ' | '))).catch(() => []); for (const x of t) { if (!seen.has(x) && !/root user/.test(x) && name !== '-') { await shot(page, name + '-toast-' + seen.size); } seen.add(x); } }
  console.log('TOASTS-SEEN', JSON.stringify([...seen].filter(x => !/root user/.test(x)), null, 1));
  await page.keyboard.press('Control+Alt+b').catch(() => {});
  for (const c of (process.env.CMDS || '').split(';').filter(Boolean)) {
    await run(page, c); await page.waitForTimeout(+(process.env.CMDWAIT || 2500));
    if (process.env.SHOT_EACH) await shot(page, name + '-' + c.replace(/[^a-z0-9]+/gi, '-').slice(0, 30));
  }
  if (name !== '-') await shot(page, name);
  if (process.env.PS) { console.log('PS'); cp.execSync(process.env.PS, { stdio: 'inherit' }); }
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 15000))]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
