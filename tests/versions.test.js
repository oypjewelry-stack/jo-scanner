// JO version letters: 26-287A / 26-287B are newer versions of the SAME JO 26-287 (B = latest).
const assert = require('assert'); const fs = require('fs'); const vm = require('vm'); const load = require('./gasmock');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const g = load(); g._.advance(Date.parse('2026-10-17T04:00:00Z') - new g.Date().getTime());
g._.props.SEED_USERS = 'miriam:admin:3816,susan:production_manager:2507'; g.setupAuth(); g.setupJobs(); g.setupCustomers();
const adm = g.call({ action: 'login', username: 'miriam', code: '3816', device_id: 'm' }).session;
const C = (action, d = {}) => g.call(Object.assign({ action, session: adm, device_id: 'x' }, d));
const img = Buffer.from('jpeg').toString('base64');
const cards = () => { const rt = g.DriveApp.getRootFolder(); return rt.subs['Job Order Cards'] || rt.createFolder('Job Order Cards'); };
const sub = n => cards().subs[n];
const tab = t => { const d = g._.sheets[t].data, h = d[0]; return d.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))); };

// --- names
ok(g.normJO_('26-287B') === '26-287' && g.joFull_('jo 26-287b') === '26-287B' && g.joVersion_('26-287B') === 'B' && g.jobKey_('26-287A') === '26-287' && g.jobVersion_('26-287A') === 'A', 'JO = number only, letter = version');

// --- the owner's live data before this update: rows 26-287A + 26-287B (old "revision" rule), scans in their own folders
const jo = g._.sheets.JobOrders; const H = jo.data[0];
const row = o => jo.appendRow(H.map(k => o[k] === undefined ? '' : o[k]));
row({ jo: '26-287A', type: 'revision', parent_jo: '26-287', root_jo: '26-287', status: 'draft', review_state: 'draft', description: 'Ring, first redesign', created_at: '2026-10-01' });
row({ jo: '26-287B', type: 'revision', parent_jo: '26-287', root_jo: '26-287', status: 'draft', review_state: 'draft', location: 'working', created_at: '2026-10-10' });
const fa = cards().createFolder('26-287A'); fa.createFile({ name: '26-287A-p1.jpg' }); fa.createFile({ name: '26-287A-p2.jpg' });
const fb = cards().createFolder('26-287B'); fb.createFile({ name: '26-287B-p1.jpg' });
ok(g.importExistingScans().added === 3, 'old version folders import fine');
ok(tab('OcrLog').every(o => o.jo === '26-287') && tab('OcrLog').map(o => o.jo_version).join() === 'A,A,B', 'OcrLog: JO 26-287, version kept');
ok(tab('JobOrders').length === 2, 'no JobOrders row added or changed by the import');

// --- scanner uploads go to the JO folder, file names keep the letter
let r = g.call({ jo: '26-287B', page: 1, scan: 's1', filename: '26-287B-p1-101726.jpg', imageBase64: img });
ok(r.ok && r.filename === '26-287B-p1-101726.jpg' && sub('26-287').files.some(f => f.name === r.filename), '26-287B uploads into Job Order Cards/26-287 as 26-287B-p1-101726.jpg');
const ra = g.call({ jo: '26-287A', page: 1, scan: 's2', filename: '26-287A-p1-101826.jpg', imageBase64: img }); // A scanned LATER than B
const r0 = g.call({ jo: '26-287', page: 1, scan: 's3', filename: '26-287-p1-101926.jpg', imageBase64: img }); // and the base even later
ok(ra.filename === '26-287A-p1-101826.jpg' && r0.filename === '26-287-p1-101926.jpg' && Object.keys(cards().subs).filter(k => k.startsWith('26-287')).sort().join() === '26-287,26-287A,26-287B', 'all versions share the 26-287 folder; old folders untouched');
const r2 = g.call({ jo: '26-287B', page: 1, scan: 's4', filename: '26-287B-p1-101726.jpg', imageBase64: img });
ok(r2.filename === '26-287B-p1-101726b.jpg', 'second B session same day: letter b after the date as before');
ok(tab('JobOrders').length === 2, 'scans of 26-287 / A / B never add a JobOrders row (it is one JO)');
ok(g.call({ jo: '26-287B', page: 1, scan: 's9', filename: '26-287B-p1-101726.jpg', imageBase64: img }).match === false, 'no card text: not verified (as before)');
g._.ocrQueue.push('JO NO. 26-287B'); ok(g.call({ jo: '26-287', page: 2, scan: 's3', filename: '26-287-p2-101926.jpg', imageBase64: img }).match === true, 'card reads 26-287B, typed 26-287: same JO, verified');

// --- back office: one JO, latest version first
let L = C('jobReviewList'); const js = L.jobs.filter(j => j.jo.startsWith('26-287'));
ok(js.length === 1 && js[0].jo === '26-287', 'To review: one JO 26-287');
const j = js[0];
ok(j.version === 'B' && j.versions.join() === 'B,A' && j.location === 'working' && j.description === 'Ring, first redesign', 'merged view: B row first, blanks filled from A');
ok(j.parent_jo === '' && j.type === '', 'no "revision of itself"');
ok(j.pages_version === 'B' && j.pages_set === '101726c' && j.pages.length === 1, 'LATEST = highest letter (B), newest B scan (even though A and the base were scanned later)');
const order = [j.pages_version + ':' + j.pages_set].concat(j.history.map(h => h.version + ':' + h.set));
ok(order.join(' > ') === 'B:101726c > B:101726b > B:101726 > B: > A:101826 > A: > :101926', 'history: B older (old untagged B last), then A, then the base: ' + order.join(' > '));
const fA = tab('OcrLog').find(o => o.jo_version === 'A').file_id;
ok(C('jobPhoto', { jo: '26-287', file_id: fA }).ok && C('jobPhoto', { jo: '26-287B', file_id: fA }).ok, 'old version photos open on the JO card (26-287 or 26-287B)');
let S = C('jobSearch', { q: '26-287A' }); ok(S.jobs.length === 1 && S.jobs[0].jo === '26-287', 'search 26-287A -> JO 26-287');
S = C('jobSearch', { q: '26-287' }); ok(S.jobs.length === 1, 'search 26-287 -> one result');
r = C('jobReviewSave', { jo: '26-287A', set: { item_type: 'jewelry' }, seen: {} });
ok(r.ok && tab('JobOrders').find(x => x.jo === '26-287B').item_type === 'jewelry' && tab('JobOrders').find(x => x.jo === '26-287A').item_type === '', 'saving 26-287 (typed 26-287A) writes the latest version row (B) only');

// --- swipe-delete across version folders
r = g.call({ op: 'deletePage', jo: '26-287B', file_id: fA }); ok(r.ok && r.deleted === 1 && g._.fileReg[fA].trashed, 'delete: a page in the old 26-287A folder is allowed for JO 26-287');
const other = cards().createFolder('26-288A').createFile({ name: '26-288A-p1.jpg' });
ok(g.call({ op: 'deletePage', jo: '26-287', file_id: other.id }).code === 'FORBIDDEN' && !other.trashed, "another JO's version folder is refused");
const outside = g.DriveApp.getRootFolder().createFolder('26-287A').createFile({ name: '26-287A-p9.jpg' });
ok(g.call({ op: 'deletePage', jo: '26-287', file_id: outside.id }).code === 'FORBIDDEN' && !outside.trashed, 'a "26-287A" folder outside Job Order Cards is refused');
r = g.call({ op: 'deletePage', jo: '26-287A', page: 1, scan: 's2' }); ok(r.deleted === 1 && sub('26-287').files.find(f => f.name === '26-287A-p1-101826.jpg').trashed && !sub('26-287').files.find(f => f.name === '26-287B-p1-101726.jpg').trashed, 'delete by session keeps to that version');

// --- optional folder merge (dry run first)
const before = JSON.stringify(Object.values(cards().subs).map(f => [f.name, f.files.map(x => x.id)]));
let m = g.mergeSuffixFolders(); ok(!m.apply && m.moves.length === 3 && JSON.stringify(Object.values(cards().subs).map(f => [f.name, f.files.map(x => x.id)])) === before, 'mergeSuffixFolders(): dry run lists 3 moves, changes nothing: ' + m.moves[0]);
const fakeMove = x => { x.moveTo = to => { for (const f of Object.values(cards().subs)) f.files = f.files.filter(y => y !== x); to.files.push(x); }; };
Object.values(cards().subs).forEach(f => f.files.forEach(fakeMove));
m = g.mergeSuffixFoldersApply(); const p = sub('26-287');
ok(m.apply && m.moves.length === 3 && p.files.some(x => x.name === '26-287A-p2.jpg') && sub('26-287A').files.every(x => x.trashed) && sub('26-287B').files.length === 0, 'Apply: files moved into 26-287 with the same names; emptied folder left in place');
ok(sub('26-288').files.some(x => x.name === '26-288A-p1.jpg'), 'Apply: creates the JO folder when missing');
L = C('jobReviewList'); ok(L.jobs.find(x => x.jo === '26-287').history.length === 5, 'back office unchanged after the move (same file ids)');

// --- other parts: Dashboard, Costing, Customers, CustomerView
const d = C('dashboard'); const cardsOn = d.board.flatMap(c => c.cards.map(x => x.jo)).filter(x => x.startsWith('26-287'));
ok(cardsOn.join() === '26-287', 'dashboard: one card 26-287 (not 26-287A + 26-287B)');
ok(C('costSave', { jo: '26-287A', lines: [], total: 0 }).error !== 'No JO 26-287A in the Sheet', 'cost estimator: 26-287A is a known JO');
g._.sheets.CustomerLinks.appendRow(g._.sheets.CustomerLinks.data[0].map(k => ({ link_id: 'l1', customer_id: 'cu1', jo: '26-287A', method: 'admin' })[k] || ''));
const cj = g.custJobs_({ customer_id: 'cu1', full_name: 'Elena', email: 'e@x.ph' });
ok(cj.jobs.length === 1 && cj.jobs[0].jo === '26-287', 'customer portal: a link to 26-287A shows JO 26-287 once');
const cv = {}; vm.runInNewContext(fs.readFileSync(__dirname + '/../apps-script/CustomerView.gs', 'utf8'), cv);
ok(cv.cvKey_('26-287B') === '26-287' && cv.cvKey_('JO 26-001') === '26-001', 'Track my order: 26-287B looks up JO 26-287');
console.log('versions tests passed:', n);
