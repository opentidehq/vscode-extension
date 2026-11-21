// Minimal MCP stdio client: spawns the exact definition, checks that every stdout line is valid JSON-RPC.
const { spawn } = require('child_process');
const [,, cmd, cwd, ...args] = process.argv;
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(process.env.QA_EXTRA_ENV ? JSON.parse(process.env.QA_EXTRA_ENV) : {}) };
const p = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', bad = [], lines = 0; const pending = new Map(); let stderr = '';
p.stderr.on('data', d => stderr += d);
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; lines++;
  let m; try { m = JSON.parse(l); if (m.jsonrpc !== '2.0') throw new Error('not jsonrpc'); } catch (e) { bad.push(l.slice(0, 200)); continue; }
  if (m.method === 'opentide/fetch') bad.push('LEAKED opentide/fetch: ' + l.slice(0, 200));
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
let n = 0; const req = (method, params, ms = 20000) => new Promise((res) => { const id = ++n; pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ timeout: true, method }); } }, ms); });
const show = (label, m) => console.log(`\n## ${label}\n` + JSON.stringify(m).slice(0, 700));
(async () => {
  const t0 = Date.now();
  show('server/discover', await req('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } }));
  show('initialize (legacy)', await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa', version: '0' } }));
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tl = await req('tools/list', {});
  const names = (tl.result?.tools || []).map(t => t.name);
  console.log('\n## tools/list\n', names.length, 'tools:', names.join(', '));
  global.tools = tl.result?.tools || [];
  const call = process.env.QA_CALL;
  if (call) { const [name, a] = [call, JSON.parse(process.env.QA_ARGS || '{}')]; show(`tools/call ${name}`, await req('tools/call', { name, arguments: a }, 60000)); }
  console.log(`\nstdout lines: ${lines}, invalid/leaked: ${bad.length}`); bad.forEach(b => console.log('  BAD:', b));
  console.log('stderr (first 400):', stderr.slice(0, 400).replace(/\n/g, ' | '));
  console.log('elapsed ms', Date.now() - t0);
  p.stdin.end(); setTimeout(() => { p.kill(); process.exit(0); }, 1500);
})();
