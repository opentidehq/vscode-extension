const fs = require('fs');
const NAME = { // Dark+ / Light+ palette names for the colours that show up
  '156,220,254': '#9CDCFE variable', '206,145,120': '#CE9178 string', '78,201,176': '#4EC9B0 type', '197,134,192': '#C586C0 keyword (control)', '220,220,170': '#DCDCAA function', '181,206,168': '#B5CEA8 number', '212,212,212': '#D4D4D4 default text', '86,156,214': '#569CD6 keyword', '255,215,0': '#FFD700 bracket', '106,153,85': '#6A9955 comment', '204,204,204': '#CCCCCC', '187,187,187': '#BBBBBB (editor fg, before tokenizing)',
  '0,0,255': '#0000FF keyword', '163,21,21': '#A31515 string', '175,0,219': '#AF00DB keyword (control)', '38,127,153': '#267F99 type', '121,94,38': '#795E26 function', '9,134,88': '#098658 number', '0,16,128': '#001080 variable', '0,0,0': '#000000 default text', '4,81,165': '#0451A5', '0,128,0': '#008000 comment', '59,59,59': '#3B3B3B (editor fg)', '4,49,194': '#0431C2' };
const nm = c => { const k = (/(\d+), (\d+), (\d+)/.exec(c) || []).slice(1).join(','); return NAME[k] || ('rgb(' + k + ')'); };
const chars = lines => lines.map(l => { const o = []; for (const [t, c] of l) for (const ch of t) o.push([ch, c]); return o; });
const out = {};
for (const kind of ['kql', 'esql']) for (const theme of ['dark', 'light']) {
  const off = chars(JSON.parse(fs.readFileSync(`out/spans-${kind}-${theme}-off.json`))), on = chars(JSON.parse(fs.readFileSync(`out/spans-${kind}-${theme}-on.json`)));
  const qi = off.findIndex(l => /^\s*query:/.test(l.map(x => x[0]).join(''))); // first query line
  let changedChars = 0, total = 0, inQuery = 0, outQuery = 0; const groups = new Map(); let qEnd = qi + 1; while (qEnd < off.length && /^ {6}/.test(off[qEnd].map(x => x[0]).join(''))) qEnd++;
  for (let i = 0; i < Math.min(off.length, on.length); i++) { let j = 0; const a = off[i], b = on[i]; const txt = a.map(x => x[0]).join(''); if (txt !== b.map(x => x[0]).join('')) { groups.set('LINE TEXT DIFFERS ' + i, 1); continue; }
    // group runs of changed colour
    while (j < a.length) { total++; if (a[j][1] !== b[j][1]) { let k = j; while (k < a.length && a[k][1] === a[j][1] && b[k][1] === b[j][1]) k++; const tok = txt.slice(j, k).trim(); if (tok) { const where = (i > qi && i < qEnd) ? 'query' : 'yaml'; const key = `${where} | ${nm(a[j][1])} -> ${nm(b[j][1])}`; const g = groups.get(key) || { n: 0, ex: [] }; g.n++; if (g.ex.length < 8 && !g.ex.includes(tok)) g.ex.push(tok); groups.set(key, g); changedChars += k - j; if (where === 'query') inQuery += k - j; else outQuery += k - j; } j = k; } else j++; } }
  out[`${kind}-${theme}`] = { lines: off.length, queryLines: [qi + 1, qEnd], changedChars, inQuery, outQuery, groups: [...groups.entries()].map(([k, v]) => [k, v.n, v.ex]) };
}
fs.writeFileSync('out/spandiff.json', JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) { console.log('\n==', k, 'lines', v.lines, 'query', v.queryLines.join('-'), 'changed chars', v.changedChars, '(query', v.inQuery, 'rest of yaml', v.outQuery + ')'); for (const [g, n, ex] of v.groups.sort((a, b) => b[1] - a[1])) console.log('  ', n, g, JSON.stringify(ex)); }
