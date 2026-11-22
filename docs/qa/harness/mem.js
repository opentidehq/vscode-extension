const { _electron } = require('/opt/node-tools/node_modules/playwright'); const cp = require('child_process'); const fs = require('fs');
const [ud, ext, ws, label, runsArg] = process.argv.slice(2); const sleep = ms => new Promise(r => setTimeout(r, ms));
const kb = pid => { try { return +/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]; } catch { return 0; } };
(async () => { const out = [];
 for (let i = 0; i < (+runsArg || 5); i++) {
  cp.execSync("pkill -9 -f '[/]tmp/qa/vscode/code' || true"); await sleep(1500); try { cp.execSync(`rm -rf '${ud}/Backups' '${ud}/User/workspaceStorage'`); } catch {}
  const app = await _electron.launch({ executablePath: '/tmp/qa/vscode/code', args: ['--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--user-data-dir', ud, '--extensions-dir', ext, '--new-window', ws], env: { ...process.env, VSCODE_CLI: '1' } });
  await app.firstWindow(); await sleep(25000);
  const main = app.process().pid; const ps = cp.execSync('ps -eo pid,ppid,rss,args').toString().split('\n').slice(1).map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(m => ({ pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] }));
  const kids = ps.filter(p => p.ppid === main); const eh = kids.filter(p => /NodeService|extensionHost/.test(p.args)).sort((a, b) => b.rss - a.rss);
  const r = { extHostCandidates: eh.map(p => [p.pid, Math.round(p.rss / 1024)]), ext_host_rss_mb: eh[0] ? Math.round(eh[0].rss / 1024) : null, opentide_procs: ps.filter(p => /opentide\.wasm|launcher\.cjs/.test(p.args)).map(p => [p.args.replace(/.*opentide\.wasm/, 'opentide.wasm').slice(0, 40), Math.round(p.rss / 1024)]) };
  out.push(r); console.log(JSON.stringify(r)); await Promise.race([app.close(), sleep(10000)]); }
 const med = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s[s.length >> 1]; };
 fs.writeFileSync(`/tmp/qa/bench/out/mem-${label}.json`, JSON.stringify({ label, out, median_ext_host_mb: med(out.map(o => o.ext_host_rss_mb)) }, null, 2)); console.log(label, 'median ext host', med(out.map(o => o.ext_host_rss_mb))); process.exit(0); })();
