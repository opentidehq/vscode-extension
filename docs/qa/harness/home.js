const { spawn } = require('child_process');
const p = spawn('/tmp/qa/kiro/Kiro/kiro', [process.argv[2]], { cwd: '/root', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
let buf = ''; p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id === 2) { console.log('isError =', m.result.isError, '| content parts =', m.result.content.length); m.result.content.forEach((c, k) => console.log(`  part ${k}:`, c.text.slice(0, 400))); p.kill(); process.exit(); } } });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'q', version: '0' } } }) + '\n');
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'coverage', arguments: {} } }) + '\n');
