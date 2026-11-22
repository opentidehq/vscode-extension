// MCP round-trip benchmark: spawn the definition, time initialize (cold, from spawn) and warm tools/call round trips.
// usage: node mcpbench.js <label> <cmd> <cwd> <spawns> <args...>   (env QA_EXTRA_ENV adds env; ELECTRON_RUN_AS_NODE=1 is set)
const { spawn } = require('child_process'); const fs = require('fs'); const cp = require('child_process');
const [,, label, cmd, cwd, spawnsArg, ...args] = process.argv; const SPAWNS = +spawnsArg || 5;
const median = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const UUID = '4280fd71-92b7-47a0-bfe6-5271b61ee396';
function once() { return new Promise((resolve) => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(process.env.QA_EXTRA_ENV ? JSON.parse(process.env.QA_EXTRA_ENV) : {}) };
  const t0 = Date.now(); const p = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); p.stderr.resume();
  let buf = ''; const pending = new Map(); let n = 0;
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; try { const m = JSON.parse(l); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} } });
  const req = (method, params) => new Promise(res => { const id = ++n; pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  (async () => {
    const r = {}; const first = await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa', version: '0' } }); r.spawn_to_initialize_ms = Date.now() - t0;
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    let t = Date.now(); await req('tools/list', {}); r.tools_list_ms = Date.now() - t;
    const calls = { validate_rule: { uuid: UUID }, explain: { code: 'deployment_state_uuid_mismatch' }, coverage: {} };
    for (const [name, a] of Object.entries(calls)) { const ts = []; for (let k = 0; k < 6; k++) { t = Date.now(); const m = await req('tools/call', { name, arguments: a }); ts.push(Date.now() - t); if (m.result && m.result.isError) r[name + '_isError'] = true; } r[name + '_first_ms'] = ts[0]; r[name + '_warm_ms'] = median(ts.slice(1)); }
    // RSS of the bridge process tree
    try { const kids = cp.execSync(`ps -o rss= --ppid ${p.pid}`, { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); const self = +/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p.pid}/status`, 'utf8'))[1]; r.rss_mb = Math.round((self + kids.reduce((a, b) => a + b, 0)) / 1024); } catch {}
    p.stdin.end(); setTimeout(() => { p.kill(); resolve(r); }, 300);
  })(); }); }
(async () => { const all = []; for (let i = 0; i < SPAWNS; i++) { all.push(await once()); }
  const keys = Object.keys(all[0]).filter(k => typeof all[0][k] === 'number'); const med = {}; for (const k of keys) med[k] = median(all.map(r => r[k]));
  fs.mkdirSync('/tmp/qa/bench/out', { recursive: true }); fs.writeFileSync(`/tmp/qa/bench/out/mcp-${label}.json`, JSON.stringify({ label, runs: all, median: med }, null, 2)); console.log(label, JSON.stringify(med)); process.exit(0); })();
