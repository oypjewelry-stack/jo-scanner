const assert = require('assert'); const load = require('./gasmock');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const g = load();
g._.props.SEED_USERS = 'miriam:admin:3816,thea:staff:1111'; g.setupAuth();
const img = Buffer.from('jpeg').toString('base64');
const scan = (jo, page, extra = {}, ocr = '') => { g._.ocrQueue.push(ocr); return g.call(Object.assign({ jo, page, imageBase64: img }, extra)); };
const tab = n => { const d = g._.sheets[n] ? g._.sheets[n].data : []; const h = d[0] || []; return d.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))); };

// before setup: upload still works, nothing written to job tabs, no tab created
let r = scan('26-001', 1);
ok(r.ok && r.fileUrl, 'upload works before setupJobs');
ok(!g._.sheets.JobOrders && !g._.sheets.OcrLog, 'no job tabs created by an upload');

// setup adds only missing tabs, leaves an existing one alone
g._.sheets.Clients = { name: 'Clients', data: [['client_id', 'name', 'phone', 'email', 'aliases'], ['c-old1', 'Elena Tan', '0917 123 4567', 'elena@x.ph', 'Lenlen']],
  getLastRow() { return this.data.length; }, appendRow(a) { this.data.push(a.slice()); }, setFrozenRows() {},
  getDataRange() { const d = this.data, w = Math.max(...d.map(x => x.length)); return { getValues: () => d.map(x => Array.from({ length: w }, (_, i) => x[i] === undefined ? '' : x[i])) }; },
  getRange(rw, c) { const sh = this; return { setValue(v) { sh.data[rw - 1][c - 1] = v; } }; } };
const before = JSON.stringify(g._.sheets.Clients.data);
const s = g.setupJobs();
ok(s.added.join() === 'JobOrders,JobStages,OcrLog' && s.kept[0] === 'Clients', 'setupJobs adds JobOrders/JobStages/OcrLog, keeps existing Clients');
ok(JSON.stringify(g._.sheets.Clients.data) === before, 'existing Clients tab untouched by setup');
ok(g.setupJobs().added.length === 0, 'setupJobs is safe to run twice');

// first scan creates the JO, OcrLog row, first stage
r = scan('JO 26-001', 1, {}, 'JOB ORDER\nDATE DUE: Jan 17 \'26\nJO# 26-001\nKARAT GOLD AG');
ok(r.ok && r.match, 'scan still returns ok + match');
let jo = tab('JobOrders');
ok(jo.length === 1 && jo[0].jo === '26-001' && jo[0].status === 'draft' && jo[0].review_state === 'draft' && jo[0].current_stage === 'intake' && jo[0].type === 'new', 'first scan -> one draft JobOrders row at intake');
ok(String(jo[0].drive_folder_id).startsWith('fld-'), 'drive folder id stored');
let st = tab('JobStages'); ok(st.length === 1 && st[0].stage_code === 'intake' && st[0].status === 'doing' && st[0].started_at, 'first JobStage intake/doing added');
let ol = tab('OcrLog'); ok(ol.length === 1 && ol[0].ocr_text.includes('DATE DUE') && ol[0].review_state === 'draft' && ol[0].page === 1, 'OcrLog keeps the OCR text');
const pj = JSON.parse(ol[0].parsed_json); ok(pj.due_text && pj.due_text.startsWith('JAN 17') && pj.karat_text === 'AG', 'due date / karat hints parsed into OcrLog only');
ok(jo[0].due_date === '' && jo[0].karat === '', 'hints NOT written to JobOrders');

// re-scan and page 2: no duplicates
scan('26-001', 1); scan('26 001', 2, {}, 'METALS');
jo = tab('JobOrders'); ok(jo.length === 1, 're-scans never add a second JobOrders row');
ok(tab('JobStages').length === 1, 'no second first-stage');
ol = tab('OcrLog'); ok(ol.length === 3 && ol[0].review_state === 'replaced' && ol[1].review_state === 'draft' && ol[2].page === 2, 'old draft of a re-shot page marked replaced; page 2 logged');

// human edits are never overwritten
const sh = g._.sheets.JobOrders, H = sh.data[0];
const setCell = (k, v) => { sh.data[1][H.indexOf(k)] = v; };
setCell('description', 'Coin necklace'); setCell('status', 'active'); setCell('current_stage', 'bench'); setCell('review_state', 'reviewed'); setCell('drive_folder_id', 'fld-manual'); setCell('type', 'repair');
r = scan('26-001', 3, { type: 'new' });
jo = tab('JobOrders')[0];
ok(jo.description === 'Coin necklace' && jo.status === 'active' && jo.current_stage === 'bench' && jo.review_state === 'reviewed', 'workflow + human fields untouched by re-scan');
ok(jo.drive_folder_id === 'fld-manual' && jo.type === 'repair', 'filled scan fields not overwritten without flag');
// with the flag
r = scan('26-001', 3, { type: 'new', overwrite: true });
jo = tab('JobOrders')[0]; ok(jo.type === 'new' && String(jo.drive_folder_id).startsWith('fld-root'), 'overwrite:true replaces scan fields');
ok(jo.description === 'Coin necklace' && jo.status === 'active', 'overwrite never touches non-scan fields');
ok(tab('AuditLog').some(a => a.action === 'jobOverwriteFromScan' && a.detail.includes('fld-manual')), 'overwrite logged with old value');

// revision + repair
scan('26-005b', 1); jo = tab('JobOrders').find(j => j.jo === '26-005B');
ok(jo && jo.type === 'revision' && jo.parent_jo === '26-005' && jo.root_jo === '26-005', 'revision letter kept, parent/root set');
ok(!tab('JobOrders').some(j => j.jo === '26-005'), 'parent JO not invented');
scan('26-020', 1, { type: 'repair' }); jo = tab('JobOrders').find(j => j.jo === '26-020');
ok(jo.type === 'repair' && jo.current_stage === 'receive_inspect' && tab('JobStages').find(s => s.jo === '26-020').stage_code === 'receive_inspect', 'repair starts at receive_inspect');

// clients: match existing by phone, by alias, add new, ambiguous not linked
scan('26-030', 1, { client_name: 'E. Tan', client_phone: '+63 917 123 4567' });
ok(tab('JobOrders').find(j => j.jo === '26-030').client_id === 'c-old1', 'client matched by phone');
scan('26-031', 1, { client_name: 'lenlen' }); ok(tab('JobOrders').find(j => j.jo === '26-031').client_id === 'c-old1', 'client matched by alias');
scan('26-032', 1, { client_name: 'Maria Cruz', client_phone: '09181112222' });
const cl = tab('Clients'); const mc = cl.find(c => c.name === 'Maria Cruz');
ok(mc && mc.client_id.startsWith('c-') && tab('JobOrders').find(j => j.jo === '26-032').client_id === mc.client_id, 'new client added and linked');
scan('26-033', 1, { client_name: 'Maria Cruz' }); ok(tab('Clients').length === 2, 'same name again -> no duplicate client');
g._.sheets.Clients.data.push(['c-x', 'Ana Reyes', '', '', '']); g._.sheets.Clients.data.push(['c-y', 'Ana Reyes', '', '', '']);
r = scan('26-034', 1, { client_name: 'Ana Reyes' }); ok(tab('JobOrders').find(j => j.jo === '26-034').client_id === '', 'two matching clients -> not linked');
scan('26-032', 2, { client_name: 'Elena Tan' }); ok(tab('JobOrders').find(j => j.jo === '26-032').client_id === mc.client_id, 'existing client link kept on re-scan');

// a sheet failure never fails the upload
const realRows = g.jobRows_; g.jobRows_ = () => { throw new Error('boom'); };
r = scan('26-040', 1); ok(r.ok && r.fileUrl, 'Sheet error -> upload still ok');
g.jobRows_ = realRows; ok(tab('AuditLog').some(a => a.action === 'jobSyncError'), 'Sheet error logged');

// the dashboard and customer portal see the scans
const adm = g.call({ action: 'login', username: 'miriam', code: '3816', device_id: 'd' }).session;
const d = g.call({ action: 'dashboard', session: adm });
ok(d.ok && !d.missing.includes('JobOrders') && !d.missing.includes('JobStages'), 'dashboard no longer reports JobOrders/JobStages missing');
ok(d.counts.pending_breakdown.reviews === 7 && d.counts.active_jobs === 1 && d.board.find(c => c.key === 'intake').cards.some(c => c.jo === '26-005B'), 'scanned drafts show on the board as reviews');
ok(d.board.find(c => c.key === 'casting').cards.some(c => c.jo === '26-001' && c.client === undefined), 'human-moved JO shows in its real column');
const tok = g.call({ action: 'login', username: 'thea', code: '1111', device_id: 'e' }).session;
const sd = g.call({ action: 'dashboard', session: tok }); ok(sd.ok && sd.board.every(c => c.cards.every(x => !x.client)), 'staff board has no client names');
// scanner token still enforced
g._.props.TOKEN = 'sekret'; r = scan('26-050', 1); ok(!r.ok && r.error === 'Bad token' && !tab('JobOrders').some(j => j.jo === '26-050'), 'bad token -> nothing written');
console.log(n + ' jobsync tests passed');
