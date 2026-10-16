const assert = require('assert'); const load = require('./gasmock');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
function seed(g) { // simulate the owner's existing tabs
  const mk = (name, rows) => { const sh = g.SpreadsheetApp.openById().insertSheet(name); rows.forEach(r => sh.appendRow(r)); return sh; };
  mk('Clients', [['client_id', 'name', 'aliases', 'phone', 'email', 'billing_info', 'notes', 'portal_code'],
    ['cl-a', 'Maria Santos', '', '0917 123 4567', 'maria@example.com', 'secret billing', 'VIP note', ''],
    ['cl-b', 'Ben Cruz', '', '0918 555 0000', 'ben@example.com', '', '', ''],
    ['cl-c', 'Cora Lim', '', '0919 777 8888', '', '', '', '']]);
  mk('JobOrders', [['jo', 'type', 'parent_jo', 'root_jo', 'status', 'current_stage', 'item_id', 'client_id', 'description', 'metal', 'karat', 'size', 'due_date', 'rate_snapshot_id', 'product_photo_file_id', 'drive_folder_id', 'review_state'],
    ['26-001', 'new', '', '', 'active', 'bench', '', 'cl-a', 'Silver coin necklace', 'Silver', '925', '18in', '2026-11-01', 'r1', 'file-a', '', 'reviewed'],
    ['26-002', 'new', '', '', 'active', 'design', '', 'cl-b', 'Ben ring', '18k gold', '18', '9', '', '', 'file-b', '', 'reviewed'],
    ['26-003', 'new', '', '', 'cancelled', '', '', 'cl-a', 'Cancelled', '', '', '', '', '', '', '', ''],
    ['26-004', 'repair', '', '', 'active', 'intake', '', 'cl-c', 'Cora repair', '', '', '', '', '', '', '', '']]);
  mk('Quotes', [['quote_id', 'jo', 'version', 'amount', 'breakdown_json', 'status', 'gmail_draft_id'], ['q1', '26-001', 1, 6000, '{"metal_cost":2100,"labor":900}', 'accepted', ''], ['q2', '26-002', 1, 50000, '{"metal_cost":30000}', 'accepted', '']]);
  mk('Payments', [['pay_id', 'jo', 'date', 'amount', 'method', 'kind', 'payer', 'receipt_file_id', 'status'], ['p1', '26-001', '', 3500, 'gcash', 'deposit', '', '', 'confirmed'], ['p2', '26-001', '', 1000, 'gcash', '', '', '', 'pending']]);
  mk('JobStages', [['stage_id', 'jo', 'seq', 'stage_code', 'status'], ['s1', '26-001', 1, 'intake', 'done'], ['s2', '26-001', 2, 'design', 'done'], ['s3', '26-001', 3, 'bench', 'doing'], ['s4', '26-001', 4, 'qc', 'todo']]);
}
const g = load(); seed(g);
const before = JSON.stringify(['Clients', 'JobOrders', 'Quotes', 'Payments', 'JobStages'].map(t => g._.sheets[t].data));
g._.props.SEED_USERS = 'miriam:admin:3816,susan:production_manager:2507'; g.setupAuth(); g.setupCustomers();
ok(['Customers', 'CustomerSessions', 'CustomerLinks', 'ShopItems'].every(t => g._.sheets[t]), 'setupCustomers adds the 4 new tabs');
const adm = g.call({ action: 'login', username: 'miriam', code: '3816', device_id: 'a' }).session;
const pm = g.call({ action: 'login', username: 'susan', code: '2507', device_id: 'p' }).session;
const lastCode = to => { const m = g._.mail.filter(x => x.to === to).pop(); return m && m.subject.match(/(\d{6})/)[1]; };
const C = (action, d) => g.call(Object.assign({ action, device_id: d.device_id || 'phone1' }, d));

// --- sign up + verify + auto-link by email
ok(!C('custSignup', { full_name: 'Maria', email: 'maria@example.com', mobile: '09171234567', pin: '3816' }).ok, 'full name required');
ok(C('custSignup', { full_name: 'Maria Santos', email: 'maria@example.com', mobile: '09171234567', pin: '1234' }).error.includes('harder'), 'weak PIN refused');
let r = C('custSignup', { full_name: 'Maria  Santos', email: ' Maria@Example.com', mobile: '+63 917 123 4567', pin: '3816' });
ok(r.ok && g._.mail.length === 1 && g._.mail[0].to === 'maria@example.com', 'signup emails a check code');
ok(C('custLogin', { email: 'maria@example.com', pin: '3816' }).code === 'BAD_LOGIN', 'cannot sign in before email check');
ok(!C('custVerify', { email: 'maria@example.com', code: '000000' }).ok, 'wrong check code refused');
const va = C('custVerify', { email: 'maria@example.com', code: lastCode('maria@example.com') });
ok(va.ok && va.linked === 1 && va.customer.status === 'active', 'email match auto-links active JO (not cancelled one)');
ok(!C('custVerify', { email: 'maria@example.com', code: lastCode('maria@example.com') }).ok, 'check code is single-use');
const A = va.session;
const cust = g._.sheets.Customers.data; ok(!JSON.stringify(cust).includes('3816'), 'PIN stored only as salted hash');
ok(C('custSignup', { full_name: 'Someone Else', email: 'maria@example.com', mobile: '09990000000', pin: '5829' }).code === 'EXISTS', 'cannot re-register a confirmed email');

// --- customer B: mobile-only match -> pending, nothing linked
C('custSignup', { full_name: 'Ben Cruz', email: 'benny@other.com', mobile: '0918 555 0000', pin: '5829', device_id: 'phone2' });
const vb = C('custVerify', { email: 'benny@other.com', code: lastCode('benny@other.com'), device_id: 'phone2' });
ok(vb.ok && vb.linked === 0 && vb.customer.status === 'pending', 'mobile-only match stays pending (no auto-link)');
const B = vb.session;
ok(C('custJobs', { session: B }).jobs.length === 0, 'pending customer sees no JOs');

// --- isolation
const ja = C('custJobs', { session: A }); const j1 = ja.jobs[0];
ok(ja.jobs.length === 1 && j1.jo === '26-001' && j1.total === 6000 && j1.paid === 3500 && j1.balance === 2500, 'A sees own JO; balance counts confirmed payments only');
ok(j1.stage === 'Goldsmith' && j1.stages.length === 4, 'friendly stage labels');
const sa = JSON.stringify(ja); ok(!/metal_cost|breakdown|2100|rate_snapshot|r1|billing|VIP|cl-a|file-a|26-002|Ben/.test(sa), 'customer payload has no costs, ids, notes or other JOs');
ok(C('custPhoto', { session: A, jo: '26-002' }).code === 'FORBIDDEN', 'A cannot fetch B\'s JO photo');
ok(C('custPhoto', { session: A, jo: '26-001' }).src.startsWith('data:image/png'), 'A gets own photo');
ok(C('custJobs', { session: A, jo: '26-002', customer_id: vb.customer.customer_id }).jobs.every(j => j.jo === '26-001'), 'request params cannot switch customer');
for (const a of ['listUsers', 'admCustList', 'admCustLink', 'admShopList']) ok(!C(a, { session: A }).ok, 'customer session refused for ' + a);
ok(C('custJobs', { session: adm }).code === 'NO_SESSION', 'staff session is not a customer session');
for (const a of ['admCustList', 'admCustApprove', 'admCustResetPin', 'admShopSave']) ok(C(a, { session: pm }).code === 'FORBIDDEN', 'PM blocked from ' + a);

// --- admin
let L = C('admCustList', { session: adm }).customers; ok(L.length === 2 && L.find(c => c.full_name === 'Ben Cruz').match_note.includes('cl-b'), 'admin list shows pending with suggested client');
const bid = vb.customer.customer_id, aid = va.customer.customer_id;
ok(C('admCustApprove', { session: adm, customer_id: bid, client_id: 'cl-b' }).linked === 1, 'admin approves B -> links B\'s JO');
ok(C('custJobs', { session: B }).jobs.map(j => j.jo).join() === '26-002', 'B now sees only 26-002');
ok(C('custJobs', { session: A }).jobs.map(j => j.jo).join() === '26-001', 'A still sees only 26-001');
ok(!C('admCustLink', { session: adm, customer_id: aid, jo: '26-999' }).ok, 'link refuses unknown JO');
ok(C('admCustLink', { session: adm, customer_id: aid, jo: '26-004' }).ok && C('custJobs', { session: A }).jobs.length === 2, 'admin links extra JO');
ok(C('admCustUnlink', { session: adm, customer_id: aid, jo: '26-004' }).ok && C('custJobs', { session: A }).jobs.length === 1, 'admin unlinks JO');
ok(!C('admCustUpdate', { session: adm, customer_id: aid, email: 'benny@other.com' }).ok, 'edit refuses duplicate email');
ok(C('admCustUpdate', { session: adm, customer_id: aid, mobile: '0917 000 1111' }).ok, 'admin edits mobile');

// --- lockout
let x; for (let i = 0; i < 5; i++) x = C('custLogin', { email: 'benny@other.com', pin: '0000', device_id: 'phx' + i });
ok(x.code === 'USER_LOCK', '5 wrong PINs lock the account');
ok(C('custLogin', { email: 'benny@other.com', pin: '5829', device_id: 'phz' }).code === 'USER_LOCK', 'right PIN refused while locked');
ok(C('admCustList', { session: adm }).customers.find(c => c.customer_id === bid).locked, 'admin sees locked');
ok(C('admCustUnlock', { session: adm, customer_id: bid }).ok && C('custLogin', { email: 'benny@other.com', pin: '5829', device_id: 'phz' }).ok, 'admin unlock works');
for (let i = 0; i < 5; i++) x = C('custLogin', { email: 'ghost@nowhere.com', pin: '0000', device_id: 'phg' + i });
ok(x.code === 'USER_LOCK', 'unknown emails lock the same way (no account leak)');
ok(C('custLogin', { email: 'x@y.com', pin: '1111', device_id: 'q' }).error === C('custLogin', { email: 'maria@example.com', pin: '9999', device_id: 'q2' }).error, 'same error for unknown email and wrong PIN');
g._.advance(16 * 6e4);

// --- forgot PIN
const sent0 = g._.mail.length;
ok(C('custForgot', { email: 'nobody@x.com' }).message === C('custForgot', { email: 'maria@example.com' }).message, 'forgot gives same reply for unknown email');
ok(g._.mail.length === sent0 + 1, 'no email sent for unknown address');
let code1 = lastCode('maria@example.com');
ok(!C('custReset', { email: 'maria@example.com', code: code1, pin: '1111' }).ok, 'reset refuses weak PIN');
g._.advance(16 * 6e4); ok(C('custReset', { email: 'maria@example.com', code: code1, pin: '6290' }).code === 'BAD_CODE', 'reset code expires after 15 min');
C('custForgot', { email: 'maria@example.com' }); code1 = lastCode('maria@example.com');
const rs = C('custReset', { email: 'maria@example.com', code: code1, pin: '6290' });
ok(rs.ok && C('custJobs', { session: A }).code === 'NO_SESSION', 'reset works and signs out old phones');
ok(!C('custReset', { email: 'maria@example.com', code: code1, pin: '7391' }).ok, 'reset code is single-use');
ok(C('custLogin', { email: 'maria@example.com', pin: '6290' }).ok && !C('custLogin', { email: 'maria@example.com', pin: '3816', device_id: 'o' }).ok, 'new PIN works, old PIN does not');
C('custForgot', { email: 'maria@example.com' }); code1 = lastCode('maria@example.com');
for (let i = 0; i < 5; i++) C('custReset', { email: 'maria@example.com', code: '000000', pin: '7391' });
ok(!C('custReset', { email: 'maria@example.com', code: code1, pin: '7391' }).ok, 'code dies after 5 wrong guesses');
x = null; for (let i = 0; i < 5; i++) x = C('custForgot', { email: 'ben@rate.com', device_id: 'rate' + i });
C('custSignup', { full_name: 'Rate Test', email: 'rate@x.com', mobile: '09170000001', pin: '5829', device_id: 'r0' });
g._.advance(61 * 6e4); const m0 = g._.mail.length; for (let i = 0; i < 4; i++) x = C('custForgot', { email: 'benny@other.com', device_id: 'rr' + i });
ok(g._.mail.length - m0 === 3 && x.ok, 'max 3 code emails per hour per address, reply stays generic');

// --- 30-day session
const s30 = C('custLogin', { email: 'benny@other.com', pin: '5829', device_id: 'long' }).session;
g._.advance(29 * 864e5); ok(C('custMe', { session: s30 }).ok, 'remembered for 29 days');
g._.advance(2 * 864e5); ok(C('custMe', { session: s30 }).code === 'NO_SESSION', 'expires after 30 days');
const adm2 = g.call({ action: 'login', username: 'miriam', code: '3816', device_id: 'a2' }).session;
const rp = C('admCustResetPin', { session: adm2, customer_id: bid });
ok(rp.ok && /^\d{4}$/.test(rp.pin) && C('custLogin', { email: 'benny@other.com', pin: rp.pin, device_id: 'n' }).ok, 'admin PIN reset gives working PIN');
ok(C('admCustSetActive', { session: adm2, customer_id: bid, active: false }).ok && !C('custLogin', { email: 'benny@other.com', pin: rp.pin, device_id: 'n2' }).ok, 'deactivated customer cannot sign in');
ok(C('admCustAudit', { session: adm2, customer_id: bid }).log.some(l => l.action === 'cust_off'), 'audit log per customer');

// --- shop
ok(!C('admShopSave', { session: adm2, item_code: '26-001', title: 'x' }).ok, 'shop refuses a JO number as item code');
C('admShopSave', { session: adm2, item_code: 'OYP-R001', title: 'Olive Leaf Ring', category: 'Ring', metal: '18k gold', price_php: 28500, photo_file_ids: 'file-a,file-z', status: 'listed', jo: '26-001' });
C('admShopSave', { session: adm2, item_code: 'OYP-H002', title: 'Hidden one', status: 'hidden', jo: '26-002' });
const sh = C('shopList', { session: '' });
ok(sh.ok && sh.items.length === 1 && sh.items[0].price_php === 28500 && sh.items[0].photos === 2, 'shop lists only listed items, no login');
ok(!/26-00|file-|jo"|cl-|Maria|metal_cost|created_by|miriam/.test(JSON.stringify(sh)), 'shop never leaks JO, file ids, client or staff');
ok(C('shopPhoto', { item_code: 'OYP-R001', n: 1 }).src.startsWith('data:') && C('shopPhoto', { item_code: 'OYP-H002' }).src === '', 'shop photo only for listed items');
ok(C('admShopList', { session: adm2 }).items.length === 2, 'admin sees all shop items incl. JO');

ok(JSON.stringify(['Clients', 'JobOrders', 'Quotes', 'Payments', 'JobStages'].map(t => g._.sheets[t].data)) === before, 'existing tabs unchanged byte-for-byte');
ok(g._.mail.every(m => /^\S+@\S+$/.test(m.to) && /code: \d{6}$/.test(m.subject)), 'only code emails went out (mocked, none real)');
console.log('all', n, 'customer tests passed');
