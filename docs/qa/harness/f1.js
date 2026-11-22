// Functional run, VS Code. env: UD EXT WS PFX (screenshot prefix) RESTARTS
const { launch, shot, run } = require('./lib');
const fs = require('fs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const PFX = process.env.PFX; const out = { };
  const { app, page } = await launch({ exe: '/tmp/qa/vscode/code', ud: process.env.UD, ext: process.env.EXT, folders: [process.env.WS], extra: ['--disable-workspace-trust'], env: { VSCODE_CLI: '1' } });
  const t0 = Date.now();
  await sleep(14000); await page.keyboard.press('Control+Alt+b');
  await shot(page, PFX + '-01-activated');
  await page.mouse.move(350, 986); await sleep(2200); await shot(page, PFX + '-01b-status-tooltip'); await page.mouse.move(800, 400);
  await page.keyboard.press('Control+Shift+p'); await page.waitForSelector('.quick-input-widget', { state: 'visible' }); await page.keyboard.type('opentide: Show Output', { delay: 40 }); await sleep(1200); await page.keyboard.press('Enter'); await sleep(1500);
  await shot(page, PFX + '-02-output-channel');
  const outText = await page.evaluate(() => Array.from(document.querySelectorAll('.part.panel .view-lines .view-line')).map(e => e.innerText).join('\n')); fs.writeFileSync(`/tmp/qa/${PFX}-output.txt`, outText);
  await page.keyboard.press('Control+Shift+m'); await sleep(2500);
  await shot(page, PFX + '-03-problems-shard-and-queries');
  const probs = await page.evaluate(() => Array.from(document.querySelectorAll('.markers-panel .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' | ')));
  fs.writeFileSync(`/tmp/qa/${PFX}-problems.txt`, probs.join('\n')); console.log('PROBLEMS', probs.length, JSON.stringify(probs.slice(0, 12)));
  const open = async (name) => { await page.keyboard.press('Control+p'); await sleep(400); await page.keyboard.type(name, { delay: 20 }); await sleep(900); await page.keyboard.press('Enter'); await sleep(3500); };
  await open('lsass-access-kql.yaml'); await shot(page, PFX + '-04-kql-rule');
  await open('lsass-access-spl.yaml'); await shot(page, PFX + '-05-spl-rule');
  // Tide field completion: new line at top level, type "sta", Ctrl+Space
  await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('sta', { delay: 20 }); await page.keyboard.press('Control+Space'); await sleep(2000);
  const tide = await page.evaluate(() => Array.from(document.querySelectorAll('.suggest-widget .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' ').slice(0, 60)));
  console.log('TIDE FIELD COMPLETION', JSON.stringify(tide.slice(0, 8))); await shot(page, PFX + '-06-completion-tide-field'); await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Home'); await page.keyboard.press('Backspace');
  // ATT&CK completion under techniques:
  await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+f'); await page.keyboard.press('Control+a'); await page.keyboard.type('#techniques:', { delay: 10 }); await page.keyboard.press('Enter'); await page.keyboard.press('Escape'); await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await page.keyboard.type('techniques:', { delay: 15 }); await page.keyboard.press('Enter'); await page.keyboard.press('Shift+Home'); await page.keyboard.type('  - T10', { delay: 20 }); await page.keyboard.press('Control+Space'); await sleep(2000);
  const att = await page.evaluate(() => Array.from(document.querySelectorAll('.suggest-widget .monaco-list-row')).map(e => e.innerText.replace(/\n+/g, ' ').slice(0, 70)));
  console.log('ATTACK COMPLETION', JSON.stringify(att.slice(0, 8))); await shot(page, PFX + '-07-completion-attack'); await page.keyboard.press('Escape');
  // undo all edits of the SPL buffer
  for (let i = 0; i < 12; i++) await page.keyboard.press('Control+z');
  // hover on a Tide key and on a KQL column
  await open('lsass-access-kql.yaml'); await page.keyboard.press('Control+f'); await page.keyboard.type('EventID', { delay: 10 }); await page.keyboard.press('Enter'); await page.keyboard.press('Escape'); await page.keyboard.press('ArrowLeft'); await sleep(500);
  await page.keyboard.press('Control+k'); await page.keyboard.press('Control+i'); await sleep(2500); await shot(page, PFX + '-08-hover-kql-column'); await page.keyboard.press('Escape');
  const hov = await page.evaluate(() => Array.from(document.querySelectorAll('.monaco-hover')).map(e => e.innerText).join(' | ')); console.log('HOVER', JSON.stringify((hov || '').slice(0, 160)));
  await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+f'); await page.keyboard.type('schema:', { delay: 10 }); await page.keyboard.press('Enter'); await page.keyboard.press('Escape'); await page.keyboard.press('ArrowLeft'); await sleep(400);
  await page.keyboard.press('Control+k'); await page.keyboard.press('Control+i'); await sleep(2500); await shot(page, PFX + '-09-hover-tide-field'); await page.keyboard.press('Escape');
  // restarts with an erroring file open
  await open('zz-broken-kql.yaml'); await page.keyboard.press('Control+g'); await sleep(300); await page.keyboard.type('63', { delay: 30 }); await page.keyboard.press('Enter'); await sleep(2000); await shot(page, PFX + '-10-broken-rule-errors');
  const results = [];
  for (let i = 1; i <= (+process.env.RESTARTS || 5); i++) {
    const before = await page.evaluate(() => document.querySelectorAll('.monaco-editor .squiggly-error').length);
    await page.keyboard.press('Control+Shift+p'); await page.waitForSelector('.quick-input-widget', { state: 'visible' }); await page.keyboard.type('opentide: Restart Server', { delay: 25 }); await sleep(900);
    const t = Date.now(); await page.keyboard.press('Enter');
    let cleared = null, back = null; const end = Date.now() + 30000;
    while (Date.now() < end) { await sleep(20); const n = await page.evaluate(() => document.querySelectorAll('.monaco-editor .squiggly-error').length); if (cleared == null && n === 0) cleared = Date.now() - t; if (n > 0 && (cleared != null || Date.now() - t > 2500)) { back = Date.now() - t; break; } }
    await sleep(1500); const after = await page.evaluate(() => document.querySelectorAll('.monaco-editor .squiggly-error').length);
    results.push({ restart: i, errors_before: before, cleared_ms: cleared, back_ms: back, errors_after_2s: after }); console.log('RESTART', JSON.stringify(results[i - 1]));
    if (i === 1) await shot(page, PFX + '-11-after-restart-1');
  }
  fs.writeFileSync(`/tmp/qa/${PFX}-restarts.json`, JSON.stringify(results, null, 2));
  await shot(page, PFX + '-12-after-restarts');
  await Promise.race([app.close(), sleep(15000)]); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
