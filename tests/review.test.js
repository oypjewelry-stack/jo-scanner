const assert = require('assert'); const load = require('./gasmock');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const g = load();
g._.props.SEED_USERS = 'miriam:admin:3816,susan:production_manager:2507,ana:accounting:4444,thea:staff:1111'; g.setupAuth();
const S = (u, c) => g.call({ action: 'login', username: u, code: c, device_id: u }).session;
const adm = S('miriam', '3816'), pm = S('susan', '2507'), acc = S('ana', '4444'), st = S('thea', '1111');
const C = (s, action, d = {}) => g.call(Object.assign({ action, session: s, device_id: 'x' }, d));
const img = Buffer.from('jpeg').toString('base64');
const scan = (jo, page, extra = {}) => g.call(Object.assign({ jo, page, imageBase64: img }, extra));
const tab = n => { const d = g._.sheets[n] ? g._.sheets[n].data : []; const h = d[0] || []; return d.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))); };

ok(C(adm, 'jobReviewList').code === 'NO_TABS', 'before setupJobs: clear "run setupJobs" answer');
// cards scanned before JobSync existed -> import
scan('26-001', 1); scan('26-001', 2); scan('26-002', 1);
g.setupJobs();
ok(tab('JobOrders').length === 0, 'setupJobs adds tabs only, no rows');
let im = g.importExistingScans();
ok(im.done && im.added === 3 && tab('JobOrders').length === 2 && tab('OcrLog').length === 3, 'importExistingScans brings in old scans (2 JOs, 3 pages)');
ok(g.importExistingScans().added === 0 && tab('JobOrders').length === 2, 'import is safe to run again (no duplicates)');
scan('26-003', 1); scan('26-005B', 1); scan('26-006', 1); scan('26-007', 1);
g._.sheets.Clients.data.push(['c-el', 'Elena Tan', 'Lenlen', '0917 123 4567', 'elena@x.ph']);

// roles
ok(C(st, 'jobReviewList').code === 'FORBIDDEN' && C(acc, 'jobReviewList').code === 'FORBIDDEN', 'staff + accounting: no access');
ok(C(st, 'jobReviewSave', { jo: '26-001', set: { location: 'vault' } }).code === 'FORBIDDEN' && tab('JobOrders')[0].location === '', 'staff cannot save');
ok(C('', 'jobReviewList').code === 'NO_SESSION', 'signed out: no access');
let L = C(adm, 'jobReviewList');
ok(L.ok && L.jobs.map(j => j.jo).join() === '26-001,26-002,26-003,26-005,26-006,26-007', 'admin list: all drafts, JO order');
const j1 = L.jobs[0];
ok(j1.pages.length === 2 && j1.missing.join() === 'location,item_type,client,due_date,type,description', 'pages + common missing fields flagged (no metal/karat until the kind is known)');
ok(L.locations.length === 8 && L.locations[3][1] === 'Being worked on' && L.locations[7][1] === 'Archived', '8 locations offered (Archived last)');
ok(C(pm, 'jobReviewList').ok, 'PM can open the list');

// photos: role-checked, only files tied to that JO
const f1 = j1.pages[0].file_id, f3 = L.jobs[2].pages[0].file_id;
let ph = C(adm, 'jobPhoto', { jo: '26-001', file_id: f1 });
ok(ph.ok && ph.src.startsWith('data:image/png;base64,'), 'thumbnail served as data URL');
ok(C(adm, 'jobPhoto', { jo: '26-001', file_id: f1, size: 'full' }).src.startsWith('data:image/jpeg'), 'full-size on request');
ok(C(adm, 'jobPhoto', { jo: '26-001', file_id: f3 }).code === 'FORBIDDEN', "another JO's file refused");
ok(C(adm, 'jobPhoto', { jo: '26-001', file_id: 'any-drive-id' }).code === 'FORBIDDEN', 'random Drive id refused');
ok(C(st, 'jobPhoto', { jo: '26-001', file_id: f1 }).code === 'FORBIDDEN', 'staff cannot load photos');

// client search: PM sees names only
ok(C(adm, 'jobClientSearch', { q: 'elen' }).clients[0].phone === '0917 123 4567', 'admin client search shows phone');
let pc = C(pm, 'jobClientSearch', { q: 'lenlen' }).clients[0]; ok(pc.name === 'Elena Tan' && !('phone' in pc), 'PM search by alias, no phone');
ok(C(pm, 'jobClientSearch', { q: '0917' }).clients.length === 0, 'PM cannot search by phone');

// save: fill blanks, derive status, mark reviewed
let r = C(adm, 'jobReviewSave', { jo: '26-001', set: { location: 'working', type: 'new', due_date: '2026-01-17', metal: 'Silver', karat: '925', description: 'Coin necklace', client_id: 'c-el' }, seen: {}, mark_reviewed: true });
let row = tab('JobOrders').find(j => j.jo === '26-001');
ok(r.ok && row.location === 'working' && row.status === 'active' && row.review_state === 'reviewed' && row.client_id === 'c-el' && row.due_date === '2026-01-17', 'save fills fields, Being worked on -> active, reviewed');
ok(row.updated_by === 'miriam' && tab('AuditLog').some(a => a.action === 'jobReview' && a.target === '26-001' && a.detail.includes('location: — -> working')), 'AuditLog has old -> new');
ok(tab('OcrLog').filter(o => o.jo === '26-001').every(o => o.review_state === 'saved' && o.reviewed_by === 'miriam'), 'its scans marked saved by the reviewer');
ok(!C(adm, 'jobReviewList').jobs.some(j => j.jo === '26-001'), 'reviewed JO leaves the To review list');
// never blind overwrite
r = C(pm, 'jobReviewSave', { jo: '26-001', set: { description: 'Charm necklace' }, seen: { description: 'Old text' } });
ok(r.code === 'CONFLICT' && r.conflicts[0].now === 'Coin necklace' && tab('JobOrders').find(j => j.jo === '26-001').description === 'Coin necklace', 'stale form -> CONFLICT, nothing saved');
r = C(pm, 'jobReviewSave', { jo: '26-001', set: { description: 'Charm necklace', metal: 'Gold' }, seen: { description: 'Coin necklace', metal: 'Brass' } });
ok(r.code === 'CONFLICT' && tab('JobOrders').find(j => j.jo === '26-001').description === 'Coin necklace', 'one conflict -> the whole save is refused');
r = C(pm, 'jobReviewSave', { jo: '26-001', set: { description: 'Charm necklace' }, seen: { description: 'Coin necklace' } });
ok(r.ok && tab('JobOrders').find(j => j.jo === '26-001').description === 'Charm necklace', 'up-to-date form may change a filled field');
ok(C(adm, 'jobReviewSave', { jo: '26-002', set: {}, mark_reviewed: true }).error.includes('location'), 'cannot mark reviewed without a location');
ok(C(adm, 'jobReviewSave', { jo: '26-002', set: { location: 'attic' } }).error === 'Unknown location', 'bad location refused');
ok(C(adm, 'jobReviewSave', { jo: '26-002', set: { due_date: 'Jan 17' } }).error.includes('2026-01-17'), 'bad date refused');
// new client from the form (PM may add name + phone)
r = C(pm, 'jobReviewSave', { jo: '26-002', set: { location: 'showroom' }, new_client: { name: 'Maria Cruz', phone: '0918 111 2222' }, seen: {} });
row = tab('JobOrders').find(j => j.jo === '26-002'); const mc = tab('Clients').find(c => c.name === 'Maria Cruz');
ok(r.ok && mc && row.client_id === mc.client_id && row.status === 'done' && row.review_state === 'draft', 'new client added + linked; Showroom -> done; still in review until marked');
ok(!('phone' in r.job.client), 'PM response hides the phone it just saved');
r = C(adm, 'jobReviewSave', { jo: '26-003', set: {}, new_client: { name: 'M. Cruz', phone: '+63 918 111 2222' }, seen: {} });
ok(r.ok && tab('JobOrders').find(j => j.jo === '26-003').client_id === mc.client_id && tab('Clients').length === 2, 'same phone -> existing client, no duplicate');

// bulk location
r = C(adm, 'jobBulkLocation', { jos: ['26-003', '26-005B', '26-006', '26-002', '26-099'], location: 'vault' });
ok(r.ok && r.set.join() === '26-003,26-005,26-006' && r.kept[0].jo === '26-002' && r.kept[0].location === 'showroom' && r.missing[0] === '26-099', 'bulk: blanks set, Showroom kept, unknown reported');
ok(tab('JobOrders').find(j => j.jo === '26-006').status === 'done', 'bulk vault -> status done');
r = C(adm, 'jobBulkLocation', { jos: ['26-002'], location: 'vault', overwrite: true }); ok(r.set[0] === '26-002' && tab('JobOrders').find(j => j.jo === '26-002').location === 'vault', 'overwrite:true changes it');
ok(tab('AuditLog').some(a => a.action === 'jobBulkLocation' && a.detail.includes('(overwrite)')), 'bulk logged, overwrite marked');
ok(C(st, 'jobBulkLocation', { jos: ['26-007'], location: 'sold' }).code === 'FORBIDDEN', 'staff cannot bulk');
ok(C(adm, 'jobBulkLocation', { jos: ['26-007'], location: 'garage' }).error === 'Unknown location', 'bulk bad location refused');
C(adm, 'jobBulkLocation', { jos: ['26-007'], location: 'consigned' });

// dashboard
const d = C(adm, 'dashboard');
ok(d.board.reduce((s, c) => s + c.count, 0) === 1 && d.board.find(c => c.key === 'intake').cards[0].jo === '26-001', 'only Being worked on JOs on the board');
const loc = k => d.locations.find(l => l.key === k).count;
ok(loc('vault') === 4 && loc('working') === 1 && loc('consigned') === 1 && loc('unset') === 0, 'location counts row (vault 4, working 1, consigned 1)');
ok(d.counts.consigned_out === 1 && d.counts.consigned_jos === 1, 'Consigned JOs feed the consigned count');
ok(d.counts.active_jobs === 1 && d.counts.pending_breakdown.reviews === 5, 'active = being worked on; reviews = drafts still unchecked');
const dp = C(pm, 'dashboard'); ok(dp.locations && dp.locations.length === 9, 'PM sees location counts');
ok(!('locations' in C(acc, 'dashboard')) && !('locations' in C(st, 'dashboard')), 'accounting + staff: no location counts');
// scans keep working, re-scan never touches the reviewed JO
scan('26-001', 3); row = tab('JobOrders').find(j => j.jo === '26-001');
ok(row.location === 'working' && row.review_state === 'reviewed' && row.description === 'Charm necklace', 're-scan leaves reviewed JO alone');

// item type: flags follow the kind of piece
const M = jo => C(adm, 'jobReviewList').jobs.find(j => j.jo === jo);
ok(C(adm, 'jobReviewList').item_types.map(t => t[1]).join() === 'Jewelry,Loose stone,Pearl,Raw material,Other', '5 item types offered');
scan('26-060', 1); scan('26-061', 1); scan('26-062', 1); scan('26-063', 1);
C(adm, 'jobReviewSave', { jo: '26-060', set: { item_type: 'jewelry' }, seen: {} });
let m = M('26-060').missing; ok(m.includes('metal') && m.includes('karat') && !m.includes('stone_type') && !m.includes('item_type'), 'Jewelry -> metal + karat flagged');
C(adm, 'jobReviewSave', { jo: '26-061', set: { item_type: 'pearl', stone_type: 'South Sea', stone_size: '11 mm' }, seen: {} });
m = M('26-061').missing; ok(m.includes('grade') && !m.includes('stone_type') && !m.includes('stone_size') && !m.includes('metal') && !m.includes('karat'), 'Pearl -> stone type/size/grade, never metal/karat');
C(adm, 'jobReviewSave', { jo: '26-062', set: { item_type: 'raw_material', material: 'Gold scrap', weight_g: '12.5 g' }, seen: {} });
let rw = tab('JobOrders').find(j => j.jo === '26-062'); m = M('26-062').missing;
ok(rw.weight_g === '12.5' && rw.material === 'Gold scrap' && !m.includes('material') && !m.includes('weight_g') && !m.includes('metal'), 'Raw material -> material + weight (grams kept as number)');
ok(C(adm, 'jobReviewSave', { jo: '26-062', set: { weight_g: 'heavy' }, seen: { weight_g: '12.5' } }).error.includes('grams'), 'bad weight refused');
C(adm, 'jobReviewSave', { jo: '26-063', set: { item_type: 'other' }, seen: {} });
m = M('26-063').missing; ok(!['metal', 'karat', 'stone_type', 'grade', 'material', 'weight_g'].some(k => m.includes(k)) && m.includes('description'), 'Other -> description only');
ok(C(adm, 'jobReviewSave', { jo: '26-063', set: { item_type: 'spaceship' }, seen: {} }).error === 'Unknown item type', 'unknown item type refused');
// changing kind never wipes what was typed before; changing a filled kind still needs an up-to-date form
C(adm, 'jobReviewSave', { jo: '26-060', set: { metal: 'Gold', karat: '18k' }, seen: {} });
ok(C(pm, 'jobReviewSave', { jo: '26-060', set: { item_type: 'pearl' }, seen: { item_type: '' } }).code === 'CONFLICT', 'stale form cannot change the kind');
C(pm, 'jobReviewSave', { jo: '26-060', set: { item_type: 'pearl' }, seen: { item_type: 'jewelry' } });
rw = tab('JobOrders').find(j => j.jo === '26-060'); ok(rw.item_type === 'pearl' && rw.metal === 'Gold' && rw.karat === '18k', 'switching to Pearl keeps the old metal/karat (nothing deleted)');
// owner adds more kinds in Settings
g._.sheets.Settings = null; delete g._.sheets.Settings;
g._.sheets.Settings = { data: [['key', 'value'], ['item_types_extra', 'Watch, Coin, Watch']], getLastRow() { return this.data.length; },
  getDataRange() { const d = this.data; return { getValues: () => d.map(r => r.slice()) }; } };
const its = C(adm, 'jobReviewList').item_types.map(t => t[0]).join();
ok(its === 'jewelry,loose_stone,pearl,raw_material,watch,coin,other', 'Settings item_types_extra adds Watch + Coin (once each, before Other)');
ok(C(adm, 'jobReviewSave', { jo: '26-063', set: { item_type: 'watch' }, seen: { item_type: 'other' } }).ok, 'an added kind can be saved');
ok(C(pm, 'jobReviewSave', { jo: '26-063', set: { srp: '5000' }, seen: {} }).code === 'FORBIDDEN', 'PM cannot send a price field');
ok(tab('AuditLog').some(a => a.action === 'denied' && a.detail.includes('pricing field')), 'refused price write logged');
ok(C(adm, 'jobReviewSave', { jo: '26-063', set: { srp: '5000' }, seen: {} }).ok, 'admin request with a price field is accepted (field not stored yet)');
console.log(n + ' review tests passed');
