// Rescans keep every version: <JO>-p<N>-<MMDDYY>[b|c…].jpg; same session replaces, other sessions never do; newest set shown first.
const assert = require('assert'); const fs = require('fs'); const load = require('./gasmock'); const Q = require('../queue.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const g = load(); g._.advance(Date.parse('2026-10-17T04:00:00Z') - new g.Date().getTime()); // fixed clock: Oct 17 2026, 12:00 PHT
g._.props.SEED_USERS = 'miriam:admin:3816,susan:production_manager:2507'; g.setupAuth();
const adm = g.call({ action: 'login', username: 'miriam', code: '3816', device_id: 'm' }).session;
const pm = g.call({ action: 'login', username: 'susan', code: '2507', device_id: 's' }).session;
const C = (s, action, d = {}) => g.call(Object.assign({ action, session: s, device_id: 'x' }, d));
const img = Buffer.from('jpeg').toString('base64');
const up = (jo, page, scan, filename) => g.call({ jo, page, scan, filename: filename || `${jo}-p${page}-101726.jpg`, imageBase64: img });
const folder = jo => g.DriveApp.getRootFolder().getFoldersByName('Job Order Cards').next().getFoldersByName(jo).next();
const live = jo => folder(jo).files.filter(f => !f.trashed).map(f => f.name).sort();
const tab = t => { const d = g._.sheets[t].data, h = d[0]; return d.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))); };

// --- app.js naming (Manila date, MMDDYY) ---
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const fn = new Function(src.match(/function dateTag\(d\) \{[\s\S]*?\n\}/)[0] + '\n' + src.match(/function pageName\([^)]*\) \{[^\n]*\}/)[0] + '; return { dateTag, pageName };')();
ok(fn.pageName('26-001', 1, new Date('2026-10-17T03:00:00Z')) === '26-001-p1-101726.jpg', 'scanner names pages <JO>-p<N>-MMDDYY.jpg');
ok(fn.dateTag(new Date('2026-10-17T17:30:00Z')) === '101826', 'date tag is Manila time (01:30 Oct 18 PHT -> 101826)');
ok(fn.dateTag(new Date('2026-12-31T15:59:00Z')) === '123126' && fn.dateTag(new Date('2026-12-31T16:00:00Z')) === '010127', 'year boundary in Manila time');
ok(/scan: it\.scan/.test(src) && /filename: pageName\(state\.jo, state\.page\)/.test(src), 'upload sends the session id; new pages use pageName');
ok(Q.keyOf('26-001', '26-001-p1-101726.jpg', 'A') !== Q.keyOf('26-001', '26-001-p1-101726.jpg', 'B') && Q.keyOf('26-001', 'x', 'A') === Q.keyOf('26-001', 'x', 'A'), 'phone queue: same page from two sessions never overwrite each other, re-crop still does');

// --- backend naming ---
g.setupJobs();
let r = up('26-001', 1, '26-001@a'); ok(r.ok && r.filename === '26-001-p1-101726.jpg', 'first scan of the day: no letter');
up('26-001', 2, '26-001@a');
r = up('26-001', 1, '26-001@a'); ok(r.filename === '26-001-p1-101726.jpg' && live('26-001').join() === '26-001-p1-101726.jpg,26-001-p2-101726.jpg', 'same session re-crop/retake replaces its page (no extra file)');
ok(folder('26-001').files.filter(f => f.trashed).length === 1, 'only the replaced re-crop went to Trash');
r = up('26-001', 1, '26-001@b'); ok(r.filename === '26-001-p1-101726b.jpg', 'second session same day: -101726b, nothing replaced');
r = up('26-001', 2, '26-001@b'); ok(r.filename === '26-001-p2-101726b.jpg', 'whole second set shares the letter b');
r = up('26-001', 1, '26-001@b'); ok(r.filename === '26-001-p1-101726b.jpg' && live('26-001').length === 4, 're-crop inside session b replaces only b');
r = up('26-001', 1, '26-001@c'); ok(r.filename === '26-001-p1-101726c.jpg' && live('26-001').length === 5, 'third session same day: c');
r = up('26-001', 1, '26-001@a'); ok(r.filename === '26-001-p1-101726.jpg' && live('26-001').length === 5, 'a late re-crop from the first session still lands in its own set');
r = up('26-001', 1, '26-001@d', '26-001-p1-102026.jpg'); ok(r.filename === '26-001-p1-102026.jpg' && live('26-001').length === 6, 'another day: new date tag, all older kept');
r = up('26-001', 1, '26-001@e', '26-001-p1.jpg'); // an old phone build (no date in the name): server adds today's Manila date
const todayTag = g.Utilities.formatDate(new g.Date(), 'Asia/Manila', 'MMddyy');
ok(todayTag === '101726' && r.filename === '26-001-p1-101726d.jpg', 'old phone build without a date: server adds the Manila date');
r = g.call({ jo: '26-002', page: 1, filename: '26-002-p1.jpg', imageBase64: img }); const r2 = g.call({ jo: '26-002', page: 1, filename: '26-002-p1.jpg', imageBase64: img });
ok(r.filename === r2.filename && live('26-002').length === 1, 'old build with no session id: same-day re-upload replaces (as before)');
ok(g.scanName_(folder('26-001'), '26-001', { page: 3, scan: '26-001@b', filename: '26-001-p3-101726.jpg' }) === '26-001-p3-101726b.jpg', 'session b page 3 joins set b');

// --- legacy files + import ---
const lf = folder('26-001'); lf.createFile({ name: '26-001-p1.jpg' }); lf.createFile({ name: '26-001-p2.jpg' });
const fx = g.DriveApp.getRootFolder().getFoldersByName('Job Order Cards').next().createFolder('26-003'); fx.createFile({ name: '26-003-p1-101526.jpg' }); fx.createFile({ name: '26-003-p1.jpg' });
let im = g.importExistingScans(); ok(im.done && im.added === 4, 'import picks up legacy + date-tagged files');
ok(tab('OcrLog').filter(o => o.jo === '26-003').map(o => o.page + ':' + o.scan_set).sort().join() === '1:,1:101526', 'import reads page + set from both name styles');
ok(g.importExistingScans().added === 0, 'import still safe to run twice');

// --- OcrLog rows + back office view ---
const rows = tab('OcrLog').filter(o => o.jo === '26-001');
ok(rows.filter(o => o.review_state === 'replaced').length === 3 && rows.every(o => o.review_state !== 'replaced' || o.scan_set === '101726' || o.scan_set === '101726b'), 'only same-set re-crops marked replaced');
ok(rows.some(o => o.file_name === '26-001-p1-101726b.jpg' && o.scan_set === '101726b'), 'OcrLog keeps file_name + scan_set');
let L = C(adm, 'jobReviewList'), j = L.jobs.find(x => x.jo === '26-001');
ok(j.pages_set === '102026' && j.pages_date === '2026-10-20', 'latest set first: ' + j.pages_set);
const order = [j.pages_set].concat(j.history.map(h => h.set));
const sortKey = s => s ? s.slice(4, 6) + s.slice(0, 4) + (s.slice(6) || ' ') : '';
ok(order.slice(0, -1).every((s, i) => sortKey(s) > sortKey(order[i + 1])) && order[order.length - 1] === '', 'history newest first, untagged legacy set last: ' + order.join(' > '));
const h = Object.fromEntries(j.history.map(x => [x.set, x]));
ok(h['101726b'].pages.map(p => p.page).join() === '1,2' && h['101726'].pages.map(p => p.page).join() === '1,2' && h['101726c'].n === 1, 'each older set keeps its own pages');
ok(h['101726'].date === '2026-10-17' && h[''].pages.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(h[''].date), 'set dates (legacy = first import date)');
ok(j.pages.length === 1 && j.pages[0].file_id === rows.filter(o => o.scan_set === j.pages_set && o.review_state !== 'replaced').pop().file_id, 'JO card pages = the newest scan only');
const hist = h['101726'].pages[0].file_id;
ok(C(adm, 'jobPhoto', { jo: '26-001', file_id: hist }).ok && C(pm, 'jobPhoto', { jo: '26-001', file_id: hist }).ok, 'history photos open (admin + PM)');
ok(C(adm, 'jobPhoto', { jo: '26-002', file_id: hist }).code === 'FORBIDDEN', "a history photo is still refused for another JO");
const j3 = L.jobs.find(x => x.jo === '26-003');
ok(j3.pages_set === '101526' && j3.history.length === 1 && j3.history[0].set === '', 'legacy-only + tagged: tagged first, legacy under history');
const j2 = L.jobs.find(x => x.jo === '26-002'); ok(j2.history.length === 0, 'single set: no history');
// the JO card opened from the dashboard uses the same jobView_/jobPages_ (DashboardDrill.gs): newest first there too
const v = g.jobView_({ jo: '26-001' }, g.jobPages_()['26-001'], {}, { role: 'admin' });
ok(v.pages_set === j.pages_set && v.history.length === j.history.length && JSON.parse(JSON.stringify(v)).history.length === j.history.length, 'dashboard JO card: same newest-first + history');

// --- old OcrLog tab gets the new columns from setupJobs (header only) ---
const g2 = load(); g2._.props.SEED_USERS = 'miriam:admin:3816'; g2.setupAuth();
const sh = g2.SpreadsheetApp.openById().insertSheet('OcrLog'); sh.appendRow(['scan_id', 'jo', 'page', 'file_id', 'ocr_text', 'jo_found', 'match', 'ocr_error', 'parsed_json', 'review_state', 'reviewed_by', 'reviewed_at', 'created_at', 'created_by']);
sh.appendRow(['scan-old', '26-009', 1, 'file-old', '', '', '', '', '{}', 'draft', '', '', '2026-09-01', 'scanner']);
g2.setupJobs(); ok(g2._.sheets.OcrLog.data[0].slice(-2).join() === 'file_name,scan_set' && g2._.sheets.OcrLog.data[1][0] === 'scan-old', 'setupJobs adds file_name + scan_set to an old OcrLog (rows untouched)');
// before setupJobs (no scan_set column): old behaviour, nothing breaks
const g3 = load(); g3._.props.SEED_USERS = 'miriam:admin:3816'; g3.setupAuth(); g3.setupJobs();
g3._.sheets.OcrLog.data[0] = g3._.sheets.OcrLog.data[0].slice(0, 14);
g3.call({ jo: '26-011', page: 1, scan: 'a', filename: '26-011-p1-101726.jpg', imageBase64: img }); g3.call({ jo: '26-011', page: 1, scan: 'b', filename: '26-011-p1-101726.jpg', imageBase64: img });
const o3 = g3._.sheets.OcrLog.data.slice(1);
ok(o3.length === 2 && o3[0][9] === 'replaced', 'without the new columns: old rule (latest page wins), Drive still keeps both files');
console.log('rescan tests passed:', n);
