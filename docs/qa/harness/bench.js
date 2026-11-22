// opentide VS Code / Kiro benchmark driver (Playwright _electron under Xvfb + openbox).
// usage: node bench.js <editor: vscode|kiro> <ud> <ext> <workspace> <runs> <label> [--trust]
// Output: JSON lines on stdout (one per run) and a summary (medians) at the end; writes /tmp/qa/bench/out/<label>.json
const { _electron } = require('/opt/node-tools/node_modules/playwright');
const fs = require('fs'); const cp = require('child_process');
const [editor, ud, ext, ws, runsArg, label] = process.argv.slice(2);
const RUNS = +runsArg || 5;
const EXE = editor === 'kiro' ? '/tmp/qa/kiro/Kiro/kiro' : '/tmp/qa/vscode/code';
const killAll = () => { try { cp.execSync("pkill -9 -f '[" + EXE[0] + "]" + EXE.slice(1) + "' || true"); } catch {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const median = (a) => { const s = [...a].filter(x => x != null && !Number.isNaN(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const rssKb = (pid) => { try { return +/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]; } catch { return 0; } };
const ppid = (pid) => { try { return +/PPid:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]; } catch { return 0; } };
const pgrep = (pat) => { try { return cp.execSync(`pgrep -f -- '${pat}'`, { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; } };
// poll until fn() truthy in the page; returns ms since t0 or null on timeout
async function until(page, t0, fn, arg, timeout = 30000, step = 25) { const end = Date.now() + timeout; while (Date.now() < end) { const v = await page.evaluate(fn, arg).catch(() => false); if (v) return Date.now() - t0; await sleep(step); } return null; }
const PROBLEMS = () => { const el = document.querySelector('#status\\.problems, [id="status.problems"]'); if (!el) return 0; const n = (el.innerText.match(/\d+/g) || []).map(Number); return n.reduce((a, b) => a + b, 0); };
const SQUIGGLE = () => document.querySelectorAll('.monaco-editor .squiggly-error, .monaco-editor .squiggly-warning, .monaco-editor .squiggly-info').length;
const SQUIGGLE_ERR = () => document.querySelectorAll('.monaco-editor .squiggly-error').length;
const SUGGEST = () => { const w = document.querySelector('.suggest-widget.visible'); return !!(w && w.querySelectorAll('.monaco-list-row').length); };
const HOVER = () => { const h = document.querySelector('.monaco-hover:not(.hidden)'); return !!(h && h.innerText.trim().length > 0); };
async function palette(page, text) { await page.keyboard.press('Escape'); await page.keyboard.press('Control+Shift+p'); await page.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 8000 }); await page.keyboard.type(text, { delay: 20 }); await sleep(900); }

const ROWS = () => { const w = document.querySelector('.suggest-widget.visible'); return w ? Array.from(w.querySelectorAll('.monaco-list-row')).map(r => r.getAttribute('aria-label') || r.innerText).join('|') : ''; };
const HOVERTXT = () => { const h = document.querySelector('.monaco-hover:not(.hidden)'); return h ? h.innerText : ''; };
const hostOf = () => {
  try { const logs = cp.execSync(`find '${ud}/logs' -path '*opentidehq.opentide*' -name '*.log' -newermt '-3 minutes' 2>/dev/null | head -5`, { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const f of logs) { const t = fs.readFileSync(f, 'utf8'); const all = t.match(/WASI: running under[^\n]*|the module runs through[^\n]*/g); if (all) return all[all.length - 1].slice(0, 110); } } catch {} return null; };
const childRss = (pid) => { try { return cp.execSync(`ps -o rss= --ppid ${pid}`, { encoding: 'utf8' }).split('\n').filter(Boolean).reduce((a, b) => a + +b, 0) / 1024; } catch { return 0; } };
const SUMMARIZE = () => /Keyword/.test(Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')).map(r => r.getAttribute('aria-label') || r.innerText).join('|'));
const HOVER_EVENTID = () => { const h = document.querySelector('.monaco-hover:not(.hidden)'); return !!(h && /EventID/.test(h.innerText)); };
const NO_ERR = () => document.querySelectorAll('.monaco-editor .squiggly-error').length === 0;
async function goLine(page, n) { await page.keyboard.press('Control+g'); await sleep(250); await page.keyboard.type(String(n)); await page.keyboard.press('Enter'); await sleep(250); }
async function openFile(page, name) { await page.keyboard.press('Control+p'); await sleep(500); await page.keyboard.type(name, { delay: 10 }); await sleep(800); const t = Date.now(); await page.keyboard.press('Enter'); return t; }
async function oneRun(i) {
  const res = { run: i };
  const env = { ...process.env, VSCODE_CLI: '1' };
  try { cp.execSync(`rm -rf '${ud}/Backups' '${ud}/User/workspaceStorage'`); } catch {}
  const tLaunch = Date.now();
  const app = await _electron.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-gpu', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--user-data-dir', ud, '--extensions-dir', ext, '--new-window', ws], env, timeout: 120000 });
  const page = await app.firstWindow();
  res.launch_to_first_diagnostics_ms = await until(page, tLaunch, PROBLEMS, null, 60000);
  await sleep(5000);
  const lsp0 = pgrep('lsp start'); let ehPid = lsp0.length ? ppid(lsp0[0]) : 0;
  if (!ehPid) { const c = cp.execSync("ps -eo pid,args | grep -E 'extensionHost' | grep -v grep || true", { encoding: 'utf8' }).split('\n').filter(l => l.includes(ud)); if (c[0]) ehPid = +c[0].trim().split(/\s+/)[0]; }
  if (process.env.BENCH_PROBE) console.log('PS', cp.execSync("ps -eo pid,ppid,rss,args | grep -E 'extensionHost|lsp start|wasm' | grep -v grep | cut -c1-230", { encoding: 'utf8' })); res.exthost_rss_mb = ehPid ? Math.round(rssKb(ehPid) / 1024) : null; res.children_rss_mb = ehPid ? Math.round(childRss(ehPid)) : null;
  res.server_procs = pgrep('lsp start').length; res.host = hostOf();
  const vis = (sel) => page.evaluate((q) => { const e = document.querySelector(q); return !!(e && e.offsetHeight > 0 && e.offsetWidth > 0); }, sel);
  if (await vis('.part.panel')) { await page.keyboard.press('Control+j'); await sleep(400); }
  if (await vis('.part.auxiliarybar')) { await page.keyboard.press('Control+Alt+b'); await sleep(400); }
  res.editor_lines_visible = await page.evaluate(() => Math.round((document.querySelector('.monaco-editor') || { clientHeight: 0 }).clientHeight / 19));
  const tOpen = await openFile(page, 'bench-broken-kql.yaml');
  res.open_to_diagnostics_ms = await until(page, tOpen, SQUIGGLE_ERR, null, 30000, 5);
  await sleep(1500);
  // restart: sample the squiggle every ~5 ms for 4 s; gap = first absent, back = present again afterwards
  const restartOnce = async () => { await palette(page, 'opentide: Restart Server'); const t0 = Date.now(); await page.keyboard.press('Enter');
    let gone = null, back = null, last = null; while (Date.now() - t0 < 4000) { const n = await page.evaluate(SQUIGGLE_ERR).catch(() => -1); last = n; if (gone == null && n === 0) gone = Date.now() - t0; if (gone != null && back == null && n > 0) back = Date.now() - t0; await sleep(3); }
    return { gone, back, present_after_4s: last > 0 }; };
  const r = await restartOnce(); res.restart_to_diagnostics_ms = r.gone == null ? null : r.back; res.restart_cleared_first = r.gone != null; res.restart_first_present = r.present_after_4s;
  await sleep(3000);
  await openFile(page, 'bench-clean-kql.yaml'); await sleep(2500);
  res.clean_has_error = (await page.evaluate(SQUIGGLE_ERR)) > 0;
  await goLine(page, 26); await page.keyboard.press('Home'); for (let k = 0; k < 14; k++) await page.keyboard.press('ArrowRight');
  const hov = [];
  for (let k = 0; k < 4; k++) { await sleep(700); await page.keyboard.press('Escape'); await sleep(200); const t = Date.now(); await page.keyboard.press('Control+k'); await page.keyboard.press('Control+i'); hov.push(await until(page, t, HOVER_EVENTID, null, 8000, 5)); if (k === 0 && process.env.BENCH_PROBE) console.log('HOVER', (await page.evaluate(HOVERTXT)).slice(0, 120)); }
  await page.keyboard.press('Escape'); res.hover_ms = median(hov.slice(1)); res.hover_first_ms = hov[0];
  await goLine(page, 28); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await sleep(300);
  const idle = [], after = []; let sawTop = '';
  for (let k = 0; k < 4; k++) { await page.keyboard.type('| ', { delay: 0 }); await sleep(1500); const t = Date.now(); await page.keyboard.press('Control+Space'); idle.push(await until(page, t, SUMMARIZE, null, 8000, 5)); if (k === 0) sawTop = (await page.evaluate(ROWS)).slice(0, 160); await page.keyboard.press('Escape'); await sleep(250); await page.keyboard.press('Shift+Home'); await page.keyboard.press('Backspace'); await sleep(400); }
  for (let k = 0; k < 4; k++) { await page.keyboard.type('| ', { delay: 0 }); await sleep(1500); await page.keyboard.type('s', { delay: 0 }); const t = Date.now(); await page.keyboard.press('Control+Space'); after.push(await until(page, t, SUMMARIZE, null, 8000, 5)); await page.keyboard.press('Escape'); await sleep(250); await page.keyboard.press('Shift+Home'); await page.keyboard.press('Backspace'); await sleep(400); }
  res.completion_idle_ms = median(idle.slice(1)); res.completion_first_ms = idle[0]; res.completion_after_keystroke_ms = median(after); res.completion_rows = sawTop;
  await page.keyboard.press('Backspace'); await sleep(500);
  await goLine(page, 26); await page.keyboard.press('Home'); for (let k = 0; k < 7; k++) await page.keyboard.press('ArrowRight'); await sleep(1200);
  const ks = [], kc = [];
  for (let k = 0; k < 4; k++) { if ((await page.evaluate(SQUIGGLE_ERR)) > 0) res.stale_error = true; const t = Date.now(); await page.keyboard.press('Backspace'); ks.push(await until(page, t, SQUIGGLE_ERR, null, 15000, 5)); await sleep(800); const t2 = Date.now(); await page.keyboard.type('e', { delay: 0 }); kc.push(await until(page, t2, NO_ERR, null, 15000, 5)); await sleep(800); }
  res.keystroke_to_error_ms = median(ks); res.keystroke_to_clear_ms = median(kc);
  await openFile(page, 'bench-broken-kql.yaml'); await sleep(2000);
  const rs = [res.restart_to_diagnostics_ms]; const pres = [r.present_after_4s]; let gaps = r.gone != null ? 1 : 0; for (let k = 0; k < 3; k++) { const q = await restartOnce(); rs.push(q.gone == null ? null : q.back); pres.push(q.present_after_4s); if (q.gone != null) gaps++; await sleep(2500); }
  res.restart_all_ms = rs; res.restart_with_visible_gap = gaps; res.restart_back_every_time = pres.every(Boolean);
  await sleep(500);
  await Promise.race([app.close(), sleep(15000)]);
  await sleep(1500);
  killAll();
  return res;
}
(async () => {
  const all = [];
  for (let i = 1; i <= RUNS; i++) { try { const r = await oneRun(i); all.push(r); console.log(JSON.stringify(r)); } catch (e) { console.log(JSON.stringify({ run: i, error: String(e).slice(0, 200) })); killAll(); } }
  const keys = Object.keys(all[0] || {}).filter(k => typeof all[0][k] === 'number' && k !== 'run');
  const summary = {}; for (const k of keys) summary[k] = median(all.map(r => r[k])); summary.restart_gap_runs = all.map(r => r.restart_with_visible_gap).join('/'); summary.hosts = [...new Set(all.map(r => r.host))]; summary.restart_back_every_time = all.every(r => r.restart_back_every_time);
  fs.mkdirSync('/tmp/qa/bench/out', { recursive: true });
  fs.writeFileSync(`/tmp/qa/bench/out/${label}.json`, JSON.stringify({ editor, ws, runs: all, median: summary }, null, 2));
  console.log('MEDIAN ' + JSON.stringify(summary)); process.exit(0);
})();
