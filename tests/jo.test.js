const assert = require('assert'); const fs = require('fs'); const vm = require('vm');
const gs = {}; vm.runInNewContext(fs.readFileSync(__dirname + '/../apps-script/Code.gs', 'utf8'), gs);
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8'); const fe = src.match(/function normJO\(s\) \{[\s\S]*?\n\}/)[0];
const appNorm = new Function(fe + '; return normJO;')();
const norm = { '26-005B': '26-005B', '26-005b': '26-005B', 'JO 26-005B': '26-005B', '26 005 B': '26-005B', '26-005': '26-005', 'JO# 26,001': '26-001', '26-1234': '26-1234', '26-001 JO': '26-001', '26-005BC': '26-005' };
let f = 0;
for (const [k, v] of Object.entries(norm)) for (const [n, fn] of [['app', appNorm], ['gs', gs.joFull_]]) { const g = fn(k); if (g !== v) { f++; console.log('FAIL', n, k, g); } }
const ocr = { 'JO NO. 26-005B\nDate 1-7-26': ['26-005B'], 'JO# 26-005\n': ['26-005'], 'rev 26-005B and 26-001': ['26-005B', '26-001'] };
for (const [k, v] of Object.entries(ocr)) { const g = gs.findJOs_(k); if (JSON.stringify(g) !== JSON.stringify(v)) { f++; console.log('FAIL ocr', JSON.stringify(k), g); } }
const parent = { '26-005B': '26-005', 'JO 26-287b': '26-287', '26 287 A': '26-287', '26-287': '26-287', '26-001 JO': '26-001' };
for (const [k, v] of Object.entries(parent)) if (gs.normJO_(k) !== v) { f++; console.log('FAIL parent', k, gs.normJO_(k)); }
if (gs.joVersion_('26-287B') !== 'B' || gs.joVersion_('26-287') !== '') { f++; console.log('FAIL version'); }
assert.strictEqual(f, 0); console.log('jo tests passed');
