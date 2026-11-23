// Direct LSP client for the extension's own server process (the WASI module through the launcher): where does the semantic-token time go?
// usage: node lspbench.js <ext dir> <ws> <file rel> <runs> <label>
const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path');
const [extDir, ws, rel, runsArg, label] = process.argv.slice(2); const RUNS = +runsArg || 5;
const L = path.join(extDir, 'dist/wasi/launcher.cjs'), M = path.join(extDir, 'dist/wasi/opentide.wasm');
const med = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
function once() { return new Promise((resolve) => {
  const t0 = Date.now(); const p = spawn('/tmp/qa/vscode/code', [L, M, 'lsp', 'start'], { cwd: ws, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }); p.stderr.resume();
  let buf = Buffer.alloc(0); const pend = new Map(); let id = 0; const events = []; const T = () => Date.now() - t0;
  const send = m => { const b = Buffer.from(JSON.stringify(m)); p.stdin.write(`Content-Length: ${b.length}\r\n\r\n`); p.stdin.write(b); };
  const req = (method, params) => new Promise(res => { const i = ++id; pend.set(i, res); send({ jsonrpc: '2.0', id: i, method, params }); });
  p.stdout.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { const h = buf.indexOf('\r\n\r\n'); if (h < 0) return; const n = +/Content-Length: (\d+)/i.exec(buf.slice(0, h).toString())[1]; if (buf.length < h + 4 + n) return; const m = JSON.parse(buf.slice(h + 4, h + 4 + n).toString()); buf = buf.slice(h + 4 + n);
    if (m.id !== undefined && m.method) { events.push([T(), 'srv-req', m.method]); send({ jsonrpc: '2.0', id: m.id, result: m.method === 'workspace/configuration' ? (m.params.items || []).map(() => null) : null }); }
    else if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) events.push([T(), 'notif', m.method]); } });
  (async () => { const r = {}; const root = 'file://' + ws;
    const init = await req('initialize', { processId: process.pid, rootUri: root, workspaceFolders: [{ uri: root, name: 'ws' }], capabilities: { workspace: { configuration: true, semanticTokens: { refreshSupport: true }, workspaceFolders: true }, textDocument: { semanticTokens: { requests: { full: true, range: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'] }, publishDiagnostics: {} } } }); r.initialize_ms = T();
    r.legend = !!(init.result && init.result.capabilities && init.result.capabilities.semanticTokensProvider);
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    const uri = 'file://' + path.join(ws, rel); const text = fs.readFileSync(path.join(ws, rel), 'utf8');
    const tOpen = T(); send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'opentide-yaml', version: 1, text } } });
    const reqs = []; for (let k = 0; k < 6; k++) { const t = T(); const m = await req('textDocument/semanticTokens/full', { textDocument: { uri } }); reqs.push([t - tOpen, T() - t, m.result && m.result.data ? m.result.data.length / 5 : (m.error ? 'err' : 0)]); if (k < 3) await new Promise(r => setTimeout(r, 300)); }
    r.sem_requests = reqs; r.first_sem_total_ms = reqs[0][0] + reqs[0][1]; r.first_sem_server_ms = reqs[0][1]; r.warm_sem_ms = med(reqs.slice(2).map(x => x[1])); r.tokens = reqs[reqs.length - 1][2];
    // after an edit
    const t1 = T(); send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: text.replace('4688', '4688x') .replace('| LIMIT 100', '| LIMIT 1001') }] } });
    const m2 = await req('textDocument/semanticTokens/full', { textDocument: { uri } }); r.after_change_sem_ms = T() - t1; r.events = events.filter(e => e[0] < 6000).slice(0, 30);
    p.stdin.end(); setTimeout(() => { p.kill(); resolve(r); }, 200); })(); }); }
(async () => { const all = []; for (let i = 0; i < RUNS; i++) all.push(await once());
  const med_ = {}; for (const k of ['initialize_ms', 'first_sem_total_ms', 'first_sem_server_ms', 'warm_sem_ms', 'after_change_sem_ms', 'tokens']) med_[k] = med(all.map(r => r[k]));
  fs.writeFileSync(`/tmp/qa/hl/out/lsp-${label}.json`, JSON.stringify({ label, ws, rel, median: med_, runs: all }, null, 1)); console.log(label, JSON.stringify(med_), 'legend', all[0].legend, 'server->client:', JSON.stringify(all[0].events.map(e => e[2]).filter((v, i, a) => a.indexOf(v) === i))); process.exit(0); })();
