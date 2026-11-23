const fs = require('fs'); const D = '/tmp/qa/hl/out/';
const med = a => { const s = a.filter(x => x != null && !Number.isNaN(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const rng = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? `${s[0]}–${s[s.length - 1]}` : '–'; };
const load = l => { try { return JSON.parse(fs.readFileSync(D + l + '.json', 'utf8')); } catch { return null; } };
const ncol = s => new Set(JSON.parse(s).flat().map(x => x[1])).size;
const chars = s => { const out = []; for (const line of JSON.parse(s)) { for (const [t, c] of line) for (const ch of t) out.push([ch, c]); out.push(['\n', null]); } return out; };
function phase(p) { // p = {dict, series, before}; returns times
  const ser = p.series.map(([dt, h]) => [dt, p.dict[h]]); if (!ser.length) return {};
  const S = ser[ser.length - 1][1]; const r = { first: ser[0][0], n: ser.length };
  const g = ser.find(e => ncol(e[1]) >= 2); r.grammar = g ? g[0] : null;
  const s = ser.find(e => e[1] === S); r.sem = s ? s[0] : null; r.final = S;
  r.last = ser[ser.length - 1][0]; return r; }
function table() {
  const rows = [];
  for (const ws of ['small', 'big']) for (const kind of ['kql', 'esql']) for (const sem of ['on', 'off']) {
    const f = load(`${ws}-${kind}-dark-${sem}`); if (!f) continue; const runs = f.runs;
    const L = runs.map(r => ({ r, ...phase(r.launch), line: r.t_first_line_abs - r.t0 }));
    const O = runs.map(r => phase(r.open));
    // controls: G of the file kind opened second = control final of the other kind
    const row = { ws, kind, sem, n: runs.length, window: med(runs.map(r => r.t_window_ms)), line: med(L.map(x => x.line)), lineR: rng(L.map(x => x.line)),
      gram: med(L.map(x => x.grammar)), gramR: rng(L.map(x => x.grammar)), sem_: sem === 'on' ? med(L.map(x => x.sem)) : null, semR: rng(L.map(x => x.sem)), states: med(L.map(x => x.n)),
      gap: med(L.map(x => x.sem != null && x.grammar != null ? x.sem - x.grammar : null)), gapR: rng(L.map(x => x.sem != null && x.grammar != null ? x.sem - x.grammar : null)),
      o_first: med(O.map(x => x.first)), o_gram: med(O.map(x => x.grammar)), o_sem: med(O.map(x => x.sem)), o_semR: rng(O.map(x => x.sem)), o_states: med(O.map(x => x.n)) };
    // keystrokes
    const K = runs.flatMap(r => r.keys.map(k => { const p = phase(k); return p; }));
    row.k_first = med(K.map(x => x.first)); row.k_last = med(K.map(x => x.last)); row.k_lastMax = Math.max(...K.map(x => x.last || 0)); row.k_states = med(K.map(x => x.n));
    rows.push(row);
  }
  return rows; }
if (require.main === module) { for (const r of table()) console.log(JSON.stringify(r)); }
module.exports = { table, phase, chars, load, med, rng };
