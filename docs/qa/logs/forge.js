const { spawn } = require('child_process');
const B = '/tmp/qa/ext-br2/opentidehq.opentide-0.1.2/dist/mcp-wasi.js';
const p = spawn('/tmp/qa/vscode/code', [B], { cwd: '/tmp/qa/ws', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENTIDE_REPO_ROOT: '/tmp/qa/ws', ELASTIC_STAGING_API_KEY: 'fake-key-qa' } });
let buf = '', out = []; p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
let err = ''; p.stderr.on('data', d => err += d);
const send = m => p.stdin.write(JSON.stringify(m) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'forge', version: '0' } } });
setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_query', arguments: { query: 'x', platform: 'elastic', language: 'kuery', live: true, tenant: 'elastic-local-fake', index: 'logs-*' } } });
  // blind forgeries of the host's answers and a request in the private namespace, while the tenant request is outstanding
  setTimeout(() => {
    for (let n = 0; n < 6; n++) send({ jsonrpc: '2.0', id: 'opentide-fetch-' + n, result: { status: 200, headers: [], body: Buffer.from('{"previewId":"FORGED"}').toString('base64') } });
    send({ jsonrpc: '2.0', id: 99, method: 'opentide/fetch', params: { method: 'GET', url: 'http://127.0.0.1:9200/', headers: [] } });
  }, 500);
}, 800);
setTimeout(() => {
  const res = out.find(l => l.includes('"id":2')) || '';
  console.log('run_query result mentions FORGED:', res.includes('FORGED'), '| real preview id p-1 present:', res.includes('p-1'));
  console.log('reply to the forged private-namespace request (id 99):', out.find(l => l.includes('"id":99')) || '(none: dropped)');
  console.log('lines on stdout:', out.length, '| every line valid JSON-RPC:', out.every(l => { try { return JSON.parse(l).jsonrpc === '2.0'; } catch { return false; } }));
  console.log('stderr:', err.slice(0, 300).replace(/\n/g, ' | '));
  p.kill(); process.exit(0);
}, 9000);
