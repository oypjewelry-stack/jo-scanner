const assert = require('assert'); const load = require('./gasmock');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const g = load();
g._.props.SEED_USERS = 'miriam:admin:3816,susan:production_manager:2507,ana:accounting:4444,thea:staff:1111'; g.setupAuth();
const S = (u, c) => g.call({ action: 'login', username: u, code: c, device_id: u }).session;
const adm = S('miriam', '3816'), pm = S('susan', '2507'), acc = S('ana', '4444'), st = S('thea', '1111');
const C = (s, action, d = {}) => g.call(Object.assign({ action, session: s, device_id: 'x' }, d));
const tab = n => { const d = g._.sheets[n] ? g._.sheets[n].data : []; const h = d[0] || []; return d.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))); };
const deep = (o, k) => JSON.stringify(o).includes('"' + k + '"');
const EXEC_KEYS = ['markup', 'markups', 'srp', 'your_price', 'margin', 'quote_amount', 'srp_total'];
// the owner's example: 14k gold necklace, 1 ct look (10 DC 0.50 ct), stock order
const EX = { kind: 'stock', materials: [{ code: 'alloy_14k', grams: 5 }], labor: [{ code: 'stonesetter', hours: 1.5 }, { code: 'polisher', hours: 1.5 }],
  stones: [{ label: 'Diamond VVS', pcs: 10, carats: 0.5 }] };

ok(C(adm, 'costRates').code === 'NO_TABS', 'before setupCosting: clear "run setupCosting" answer');
g.setupJobs(); g.call({ jo: '26-001', page: 1, imageBase64: Buffer.from('j').toString('base64') });
let su = g.setupCosting();
ok(su.added.join() === 'Rates,Quotes' && tab('Rates').length === 16, 'setupCosting adds Rates + Quotes and fills Rates from the costing sheet');
g._.sheets.Rates.data[1][5] = 8100; // owner edits a rate by hand
ok(g.setupCosting().added.length === 0 && tab('Rates').length === 16 && tab('Rates')[0].rate === 8100, 'running setup again changes nothing (hand edits kept)');
g._.sheets.Rates.data[1][5] = 8000;

// roles
ok(C(st, 'costRates').code === 'FORBIDDEN' && C(acc, 'costCalc', { estimate: EX }).code === 'FORBIDDEN', 'staff + accounting: no estimator');
ok(C('', 'costRates').code === 'NO_SESSION', 'signed out: no access');
const ra = C(adm, 'costRates'), rp = C(pm, 'costRates');
ok(ra.exec && ra.markups.length === 4 && ra.rates.every(r => r.category !== 'markup'), 'admin gets rates + the 4 markups');
ok(rp.ok && !rp.exec && !deep(rp, 'markups') && !deep(rp, 'markup') && rp.rates.length === 12, 'PM gets material/labor/stone/FX rates, no markups');
ok(rp.rates.find(r => r.code === 'gold_14k').rate === 5209.17 && rp.rates.find(r => r.code === 'goldsmith').rate === 174.25, 'PM sees material + labor rates');

// the owner's numbers
let a = C(adm, 'costCalc', { estimate: Object.assign({ your_price: 120000 }, EX) }).result;
ok(a.cost.total === 61003.75, 'cost = 61,003.75 (40,000 metal + 528.75 labor + 20,475 stones)');
ok(a.srp.total === 129121.75, 'SRP = 129,121.75 (×2.5, ×2.8, ×1.35)');
ok(a.margin.at_srp === 68118, 'margin at SRP = 68,118');
ok(a.your_price === 120000 && a.margin.at_your_price === 58996.25, 'margin at Your price 120,000 = 58,996.25');
const rep = C(adm, 'costCalc', { estimate: Object.assign({}, EX, { kind: 'repair' }) }).result;
ok(rep.markup.labor === 3 && rep.srp.labor === 1586.25, 'repairs use labor ×3');
let p = C(pm, 'costCalc', { estimate: EX }).result;
ok(p.cost.total === 61003.75 && p.cost.labor === 528.75 && p.labor[0].rate === 220, 'PM gets the same raw costs + line rates');
ok(EXEC_KEYS.every(k => !deep(p, k)), 'PM result has no markup, SRP, price or margin');
ok(C(pm, 'costCalc', { estimate: Object.assign({ your_price: 1 }, EX) }).code === 'FORBIDDEN', 'PM sending a price is refused');
ok(tab('AuditLog').some(r => r.action === 'denied' && /pricing input/.test(r.detail)), '...and logged');
ok(C(pm, 'costCalc', { estimate: { materials: [{ code: 'silver', grams: 3 }] } }).result.missing_rates.join() === 'silver', 'a metal with no rate yet is flagged');
ok(C(pm, 'costCalc', { estimate: { materials: [{ code: 'silver', grams: 3, rate: 60 }] } }).result.cost.total === 180, 'a rate typed on the line is used');
const R = { material: { alloy_14k: 8000 }, labor: { stonesetter: 220, polisher: 132.5 }, stone: { diamond_usd_ct: 650 }, fx: { usd_php: 63 }, markup: { materials: 2.5, labor_stock: 2.8, labor_repair: 3, stones: 1.35 } };
const web = require('/workspace/oyp/estimate.js').calc;
let same = true; for (let i = 0; i < 300; i++) {
  const e = { kind: i % 3 ? 'stock' : 'repair', your_price: i % 2 ? Math.round(Math.random() * 2e5) : '', materials: [{ code: 'alloy_14k', grams: +(Math.random() * 30).toFixed(2) }],
    labor: [{ code: 'polisher', hours: +(Math.random() * 9).toFixed(2) }, { code: 'stonesetter', hours: +(Math.random() * 4).toFixed(1), rate: i % 5 ? '' : 250 }],
    stones: [{ carats: +(Math.random() * 3).toFixed(3), usd_per_ct: i % 4 ? '' : 900, fx: i % 7 ? '' : 58.5 }] };
  if (JSON.stringify(g.costCalc_(e, R, true)) !== JSON.stringify(web(e, R, true))) { same = false; console.log(e); break; }
}
ok(same, 'staff-app formula = server formula (300 random estimates)');

// save as a quote on a JO
ok(C(adm, 'costSave', { jo: '26-999', estimate: EX }).error === 'No JO 26-999 in the Sheet', 'unknown JO refused');
ok(C(adm, 'costSave', { jo: '26-001', estimate: { materials: [] } }).ok === false, 'empty estimate refused');
let s1 = C(adm, 'costSave', { jo: '26-001', estimate: Object.assign({ your_price: 120000 }, EX) });
ok(s1.ok && s1.version === 1 && tab('Quotes')[0].amount === 120000 && tab('Quotes')[0].status === 'draft' && tab('Quotes')[0].cost_total === 61003.75, 'admin saves v1: amount = Your price, status draft');
const b = JSON.parse(tab('Quotes')[0].breakdown_json);
ok(b.result.srp.total === 129121.75 && b.rates_used.material.alloy_14k === 8000, 'quote keeps server numbers + the rates used that day');
let s2 = C(pm, 'costSave', { jo: '26-001', estimate: EX });
ok(s2.ok && s2.version === 2 && tab('Quotes')[1].amount === '' && tab('Quotes')[1].srp_total === '', 'PM saves v2 with costs only (no price)');
ok(EXEC_KEYS.every(k => !deep(s2, k)), 'PM save answer has no prices');
g.call({ jo: '26-002', page: 1, imageBase64: 'aa' });
ok(C(adm, 'costSave', { jo: '26-002', estimate: { materials: [{ code: 'gold_18k', grams: 2 }] } }).version === 1, 'versions count per JO');
let qa = C(adm, 'costQuotes', { jo: '26-001' }), qp = C(pm, 'costQuotes', { jo: '26-001' });
ok(qa.quotes.length === 2 && qa.quotes[1].quote_amount === 120000 && qa.quotes[1].inputs.your_price === 120000, 'admin sees saved quotes with prices');
ok(qp.quotes.length === 2 && qp.quotes[1].cost_total === 61003.75 && EXEC_KEYS.every(k => !deep(qp, k)), 'PM sees saved versions + raw cost only');
ok(tab('AuditLog').filter(r => r.action === 'quoteSave').length === 3, 'every save logged');

// rate changes
const r14 = ra.rates.find(r => r.code === 'alloy_14k');
ok(C(pm, 'costRateSave', { rate: { rate_id: r14.rate_id, value: 1 } }).code === 'FORBIDDEN', 'PM cannot change rates');
ok(C(adm, 'costRateSave', { rate: { rate_id: r14.rate_id, value: 8200, seen: 7000 } }).code === 'CONFLICT', 'rate changed meanwhile: refused');
ok(C(adm, 'costRateSave', { rate: { rate_id: r14.rate_id, value: 8200, seen: 8000 } }).ok && tab('Rates')[0].rate === 8200, 'admin updates a rate');
ok(tab('AuditLog').some(r => r.action === 'rateChange' && /8000 -> 8200/.test(r.detail)), 'old value kept in AuditLog');
ok(C(adm, 'costSave', { jo: '26-001', estimate: EX }).ok && tab('Quotes')[0].amount === 120000, 'saved quotes keep their price after a rate change');

// executive list is configurable
g._.props.EXEC_ROLES = 'admin,production_manager';
ok(C(pm, 'costRates').markups.length === 4 && C(pm, 'costCalc', { estimate: EX }).result.srp, 'EXEC_ROLES can grant prices to PM');
delete g._.props.EXEC_ROLES;
ok(C(adm, 'costNope').error === 'Unknown action', 'unknown cost action');
ok(C(adm, 'jobReviewList').ok && C(adm, 'dashboard').ok, 'JobSync + dashboard still work alongside');
console.log(n + ' passed');
