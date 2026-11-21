// Drive the server the way Kiro's agent does ("modern" era, protocol 2026-07-28, per-request _meta) and print what comes back.
const { spawn } = require('child_process');
const [,, cmd, cwd, ...args] = process.argv;
const p = spawn(cmd, args, { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELASTIC_STAGING_API_KEY: 'fake-key-qa' } });
let buf = ''; const waiting = new Map(); let err = '';
p.stderr.on('data', d => err += d);
p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch { console.log('NON-JSON:', l.slice(0, 120)); } } });
let n = 0; const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const req = (method, params = {}) => new Promise(res => { const id = ++n; waiting.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }) + '\n'); setTimeout(() => res({ timeout: method }), 20000); });
(async () => {
  const d = await req('server/discover'); console.log('server/discover  resultType =', d.result && d.result.resultType, '| keys:', Object.keys(d.result || d.error || {}).join(','));
  const t = await req('tools/list'); console.log('tools/list       resultType =', t.result && t.result.resultType, '| tools:', (t.result && t.result.tools || []).length, '| result keys:', Object.keys(t.result || t.error || {}).join(','));
  const c = await req('tools/call', { name: process.env.QA_CALL || 'coverage', arguments: JSON.parse(process.env.QA_ARGS || '{}') }); console.log('tools/call       resultType =', c.result && c.result.resultType, '| isError =', c.result && c.result.isError, '|', JSON.stringify(c).slice(0, 220));
  console.log('stderr first line:', err.split('\n')[0]);
  p.stdin.end(); setTimeout(() => { p.kill(); process.exit(0); }, 1000);
})();
