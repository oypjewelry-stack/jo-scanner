const assert = require('assert'); const load = require('./gasmock');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const g = load();
g._.props.SEED_USERS = 'miriam:admin:3816,susan:production_manager:2507,ana:accounting:4444,thea:staff:1111'; g.setupAuth();
const S = (u, c) => g.call({ action: 'login', username: u, code: c, device_id: u }).session;
const adm = S('miriam', '3816'), pm = S('susan', '2507'), acc = S('ana', '4444'), st = S('thea', '1111');
const C = (s, action, d = {}) => g.call(Object.assign({ action, session: s, device_id: 'x' }, d));
const tab = n => { const d = g._.sheets[n] ? g._.sheets[n].data : []; const h = d[0] || []; return d.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))); };
const scan = jo => g.call({ jo, page: 1, imageBase64: 'eA==' });
g.setupJobs();
['24-310', '24-311', '24-312', '26-001', '26-002', '26-003', '26-004'].forEach(scan);
g._.sheets.Clients.data.push(['c-el', 'Elena Tan', 'Lenlen', '0917 123 4567', '']);

const L = C(adm, 'jobReviewList');
ok(L.locations.some(l => l[0] === 'archived' && l[1] === 'Archived'), 'Archived is in the location picker list');
// single save + bulk
let s = C(pm, 'jobReviewSave', { jo: '24-310', set: { location: 'archived', description: 'Old JO, piece melted down', client_id: 'c-el' }, seen: {} });
ok(s.ok, 'PM can set Archived on one card');
let row = tab('JobOrders').find(j => j.jo === '24-310');
ok(row.location === 'archived' && row.status === 'done', 'archived JO: location archived, status done (not active)');
ok(C(adm, 'jobBulkLocation', { jos: ['24-311', '24-312'], location: 'archived' }).ok, 'bulk Set location → Archived');
ok(C(st, 'jobBulkLocation', { jos: ['26-001'], location: 'archived' }).code === 'FORBIDDEN', 'staff cannot archive');
C(adm, 'jobBulkLocation', { jos: ['26-001'], location: 'working' }); C(adm, 'jobBulkLocation', { jos: ['26-002'], location: 'vault' });
C(adm, 'jobBulkLocation', { jos: ['26-003'], location: 'sold' });
ok(tab('AuditLog').some(r => /archived/.test(r.detail || '') || /archived/.test(r.target || '')), 'archiving is logged');

// review list: still listed, with the archived flag
const a = C(adm, 'jobReviewList').jobs.find(j => j.jo === '24-310');
ok(a && a.archived === true && a.on_hand === false, 'review view: archived flag, not on hand');
ok(C(adm, 'jobReviewList').jobs.find(j => j.jo === '26-002').on_hand === true, 'vault piece is on hand');

// search
let q = C(adm, 'jobSearch', { q: '24-31' });
ok(q.ok && q.jobs.map(j => j.jo).join() === '24-310,24-311,24-312' && q.jobs.every(j => j.archived), 'search by JO finds archived JOs, flagged');
ok(C(pm, 'jobSearch', { q: 'melted' }).jobs[0].jo === '24-310', 'search by description');
ok(C(adm, 'jobSearch', { q: 'lenlen' }).jobs[0].jo === '24-310', 'search by client alias');
C(adm, 'jobReviewSave', { jo: '24-310', set: {}, seen: {}, mark_reviewed: true });
ok(!C(adm, 'jobReviewList').jobs.some(j => j.jo === '24-310') && C(adm, 'jobSearch', { q: '24-310' }).jobs[0].archived, 'reviewed + archived: leaves To review, still found by search');
ok(C(adm, 'jobSearch', { q: '2' }).jobs.length === 0, 'one-character search returns nothing');
ok(C(st, 'jobSearch', { q: '24' }).code === 'FORBIDDEN' && C(acc, 'jobSearch', { q: '24' }).code === 'FORBIDDEN', 'staff + accounting cannot search');
ok(!('phone' in (C(pm, 'jobSearch', { q: 'elena' }).jobs[0].client || {})), 'search never returns client phone');

// dashboard
const d = C(adm, 'dashboard'), loc = k => d.locations.find(l => l.key === k).count;
ok(loc('archived') === 3, 'dashboard Location row has its own Archived count (3)');
ok(d.counts.on_hand === 2, 'pieces on hand exclude archived + sold (working 1 + vault 1)');
ok(d.board.reduce((t, c) => t + c.count, 0) === 1 && !d.board.some(c => c.cards.some(k => k.jo.startsWith('24-'))), 'archived JOs never on the job board');
ok(d.counts.active_jobs === 1, 'archived not counted as active');
g._.sheets.JobOrders.data.forEach((r, i) => { if (i && String(r[0]).startsWith('24-')) { const h = g._.sheets.JobOrders.data[0]; r[h.indexOf('due_date')] = '2020-01-01'; } });
ok(C(adm, 'dashboard').counts.pending_breakdown.past_due === 0, 'archived JOs with an old due date are not past due');
ok(d.counts.consigned_out === 0, 'archived does not feed consigned');
ok(C(pm, 'dashboard').locations.find(l => l.key === 'archived').count === 3, 'PM sees the Archived count');
console.log(n + ' archived tests passed');
