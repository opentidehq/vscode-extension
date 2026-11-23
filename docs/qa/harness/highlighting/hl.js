// Highlighting timing driver (VS Code under Xvfb, Playwright _electron).
// usage: node hl.js <ws> <kind: kql|esql> <runs> <theme: dark|light> <sem: on|off> <label> [--shots]
// An in-page MutationObserver records every change of the query block's per-span colours with Date.now() timestamps.
const { _electron } = require('/opt/node-tools/node_modules/playwright');
const fs = require('fs'); const cp = require('child_process');
const [ws, kind, runsArg, theme, sem, label, ...flags] = process.argv.slice(2);
const SHOTS = flags.includes('--shots'); const RUNS = +runsArg || 5;
const UD = process.env.HL_UD || '/tmp/qa/ud-v030', EXT = process.env.HL_EXT || '/tmp/qa/ext-v030', EXE = '/tmp/qa/vscode/code';
const OTHER = { kql: 'esql', esql: 'kql' }; const FILE = k => process.env.HL_FILE || `${ws}/objects/rules/hl-${k}.yaml`; const LINE1 = process.env.HL_SIG === 'line1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killAll = () => { try { cp.execSync("pkill -9 -f '[/]tmp/qa/vscode/code' || true"); } catch {} };
function writeSettings() { const s = { 'files.hotExit': 'off', 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.colorTheme': theme === 'light' ? 'Default Light+' : 'Default Dark+', 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'chat.disableAIFeatures': true };
  if (sem === 'off') s['[opentide-yaml]'] = { 'editor.semanticHighlighting.enabled': false };
  fs.writeFileSync(`${UD}/User/settings.json`, JSON.stringify(s)); }
const RECORDER = () => `(() => { if (window.__hl) return; const H = window.__hl = { dict: [], idx: new Map(), series: [], last: 0, firstLine: 0 };
  const sig = () => { const root = document.querySelector('.editor-instance .monaco-editor .view-lines'); if (!root) return null; if (!H.firstLine) H.firstLine = Date.now();
    const ls = Array.from(root.querySelectorAll('.view-line')).sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map(l => ({ t: l.textContent.replace(/\\u00a0/g, ' '), el: l }));
    if (LINE1) { const l1 = ls.find(l => /^name:/.test(l.t)); if (!l1) return null; return JSON.stringify([Array.from(l1.el.querySelectorAll(':scope > span > span')).map(s => [s.textContent.replace(/\\u00a0/g, ' '), getComputedStyle(s).color])]); }
    const i = ls.findIndex(l => /^\\s*query:\\s*\\|/.test(l.t)); if (i < 0) return null; const out = [];
    for (let k = i + 1; k < ls.length; k++) { const m = /^(\\s*)\\S/.exec(ls[k].t); if (!m || m[1].length < 6) break; out.push(Array.from(ls[k].el.querySelectorAll(':scope > span > span')).map(s => [s.textContent.replace(/\\u00a0/g, ' '), getComputedStyle(s).color])); }
    return JSON.stringify(out); };
  const tick = () => { const s = sig(); if (s == null) return; let h = H.idx.get(s); if (h == null) { h = H.dict.length; H.dict.push(s); H.idx.set(s, h); } const L = H.series[H.series.length - 1]; if (!L || L[1] !== h) { H.series.push([Date.now(), h]); H.last = Date.now(); } };
  new MutationObserver(tick).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); const raf = () => { tick(); requestAnimationFrame(raf); }; raf(); })();`;
async function until(page, fn, timeout) { const end = Date.now() + timeout; while (Date.now() < end) { const v = await page.evaluate(fn).catch(() => null); if (v) return true; await sleep(20); } return false; }
async function settle(page, minMs, quietMs, maxMs) { const t0 = Date.now(); while (Date.now() - t0 < maxMs) { await sleep(200); const last = await page.evaluate(() => window.__hl && window.__hl.last).catch(() => 0); if (Date.now() - t0 >= minMs && last && Date.now() - last >= quietMs) return true; } return false; }
const slice = async (page, t0) => page.evaluate((t0) => ({ dict: window.__hl.dict, series: window.__hl.series.filter(e => e[0] >= t0).map(e => [e[0] - t0, e[1]]), before: (() => { const s = window.__hl.series.filter(e => e[0] < t0); return s.length ? s[s.length - 1][1] : null; })() }), t0);
async function oneRun(i) {
  killAll(); await sleep(1500); try { cp.execSync(`rm -rf '${UD}/Backups' '${UD}/User/workspaceStorage'`); } catch {} writeSettings();
  const res = { run: i, kind, theme, sem, ws };
  const t0 = Date.now();
  const app = await _electron.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-gpu', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--user-data-dir', UD, '--extensions-dir', EXT, '--new-window', ws, FILE(kind)], env: { ...process.env, VSCODE_CLI: '1' }, timeout: 120000 });
  const page = await app.firstWindow(); res.t_window_ms = Date.now() - t0;
  const frames = []; let cdp = null;
  if (SHOTS) { try { cdp = await page.context().newCDPSession(page); cdp.on('Page.screencastFrame', async ev => { frames.push({ ts: ev.metadata.timestamp * 1000, data: ev.data }); cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {}); }); await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }); } catch (e) { res.screencast_error = String(e).slice(0, 120); } }
  while (!(await page.evaluate(() => !!document.querySelector('.monaco-workbench')).catch(() => false))) await sleep(10);
  await page.evaluate(RECORDER().replace('LINE1', String(LINE1)));
  res.settled1 = await settle(page, 9000, 4500, 45000);
  res.launch = await slice(page, t0); res.t_first_line_abs = await page.evaluate(() => window.__hl.firstLine); res.t0 = t0;
  if (cdp) { await cdp.send('Page.stopScreencast').catch(() => {}); if (frames.length) { fs.mkdirSync(`/tmp/qa/hl/out/frames-${label}-${i}`, { recursive: true }); res.frames = frames.map((f, k) => { fs.writeFileSync(`/tmp/qa/hl/out/frames-${label}-${i}/${k}.png`, Buffer.from(f.data, 'base64')); return [k, f.ts - t0]; }); } }
  if (process.env.HL_LAUNCH_ONLY) { await Promise.race([app.close(), sleep(15000)]); await sleep(800); killAll(); return res; }
  // step 3: with the server running, open the other kind
  await page.keyboard.press('Control+p'); await sleep(600); await page.keyboard.type(`hl-${OTHER[kind]}.yaml`, { delay: 8 }); await sleep(900);
  const t3 = Date.now(); await page.keyboard.press('Enter');
  res.settled2 = await settle(page, 5000, 4000, 30000);
  res.open = await slice(page, t3);
  // step 4: keystrokes inside the query of the file now open
  await page.keyboard.press('Control+g'); await sleep(300); await page.keyboard.type('27'); await page.keyboard.press('Enter'); await sleep(400); await page.keyboard.press('End'); await sleep(1500);
  res.keys = [];
  for (let k = 0; k < 3; k++) { for (const key of ['x', 'Backspace']) { const tk = Date.now(); if (key === 'x') await page.keyboard.type('x', { delay: 0 }); else await page.keyboard.press('Backspace'); await sleep(2500); res.keys.push({ key, ...(await slice(page, tk)) }); } }
  try { const dirs = fs.readdirSync(`${UD}/logs`).sort(); const d = dirs[dirs.length - 1]; const fl = cp.execSync(`find '${UD}/logs/${d}' -path '*opentidehq.opentide*' -name '*.log' | head -3`, { encoding: 'utf8' }).split('\n').filter(Boolean); res.log = fl.map(f => fs.readFileSync(f, 'utf8')).join('\n').split('\n').slice(0, 80).map(l => l.slice(0, 200)); } catch (e) { res.log_error = String(e).slice(0, 100); }
  await Promise.race([app.close(), sleep(15000)]); await sleep(800); killAll();
  return res;
}
(async () => { const all = []; for (let i = 1; i <= RUNS; i++) { try { const r = await oneRun(i); all.push(r); console.log('run', i, 'ok', 'launch changes', r.launch.series.length, 'first-line ms', r.t_first_line_abs - r.t0); } catch (e) { console.log('run', i, 'error', String(e).slice(0, 200)); killAll(); } }
  fs.writeFileSync(`/tmp/qa/hl/out/${label}.json`, JSON.stringify({ ws, kind, theme, sem, runs: all }, null, 0)); process.exit(0); })();
