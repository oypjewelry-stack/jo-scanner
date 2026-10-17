const assert = require('assert'); const load = require('./gasmock'); const seedDash = require('./dashseed');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const g = load(); seedDash(g);
g._.props.SEED_USERS = 'miriam:admin:3816,susan:production_manager:2507'; g.setupAuth();
const before = JSON.stringify(Object.keys(g._.sheets).filter(k => !['Sessions', 'AuditLog', 'Users'].includes(k)).map(k => [k, g._.sheets[k].data]));
const tabsBefore = Object.keys(g._.sheets).sort().join();
const S = (u, c) => g.call({ action: 'login', username: u, code: c, device_id: u }).session;
const adm = S('miriam', '3816'), pm = S('susan', '2507');
g.call({ action: 'createUser', session: adm, username: 'Ana', role: 'accounting' }).code;
const anaCode = g._.sheets.Users && g.call({ action: 'resetCode', session: adm, username: 'ana' }).code;
const thea = g.call({ action: 'createUser', session: adm, username: 'Thea', role: 'staff' }).code;
const acc = S('ana', anaCode), st = S('thea', thea);
const D = s => g.call({ action: 'dashboard', session: s, device_id: 'x' });

ok(D('').code === 'NO_SESSION', 'no session -> NO_SESSION');
const a = D(adm);
ok(a.ok, 'admin dashboard ok');
ok(a.counts.active_jobs === 9, 'active jobs = status active only (9)');
ok(a.board.reduce((s, c) => s + c.count, 0) === 11, 'board holds draft+active+done (11), not picked_up/cancelled');
ok(a.board.map(c => c.key).join() === 'intake,design,casting,setting,polishing,qc,pickup', '7 columns in agreed order');
const col = k => a.board.find(c => c.key === k).cards.map(c => c.jo);
ok(col('casting').includes('26-001') && col('casting').includes('26-006') && col('casting').includes('26-008'), 'bench/repair/casting -> Casting');
ok(col('setting').includes('26-003') && col('polishing').includes('26-005') && col('qc').includes('26-002'), 'setting/polishing/qc mapped');
ok(col('pickup').includes('26-009') && col('design').join() === '26-010,26-004', 'done -> Pickup; design+approval -> Design');
ok(col('intake').includes('26-005B') && col('intake').includes('26-007'), 'revision letter kept; draft in intake');
const late = a.board.find(c => c.key === 'polishing').cards[0]; ok(late.late && late.client === 'Elena Tan', 'past-due card flagged, client name shown to admin');
ok(!a.board.find(c => c.key === 'pickup').cards[0].late, 'done job waiting for pickup is not "late"');
ok(a.counts.pending_breakdown.reviews === 1 && a.counts.pending_breakdown.past_due === 1 && a.counts.pending_breakdown.payments === 1 && a.counts.pending_work === 3, 'pending work = review + past due + pending payment');
ok(a.counts.consigned_out === 4 && a.counts.overdue_consignments === 3, '4 items out, 3 over 30 days');
ok(a.consignments[0].days_out === 47 && a.consignments[0].consignee === 'Tita Lorna' && a.consignments[0].value === 68000, 'oldest consignment first with days, consignee, value');
const mon = a.today.slice(0, 7), exp = g._.sheets.Payments.data.slice(1).filter(r => r[8] === 'confirmed' && String(r[2]).slice(0, 7) === mon).reduce((t, r) => t + r[3], 0);
ok(exp > 0 && a.counts.month_sales === exp, 'month sales = confirmed payments this month only (' + exp + ')');
ok(a.sales.months.length === 6 && a.sales.months[5].month === a.today.slice(0, 7), 'sales chart: last 6 months, current last');
ok(a.payments.length === 10 && !a.payments.some(p => p.status === 'rejected') && a.payments[0].date >= a.payments[1].date, 'recent payments: newest first, rejected hidden, max 10');
ok(a.inquiries === null, 'email inquiries placeholder present (null) for admin');
ok(a.missing.join() === 'Settings', 'missing tabs reported (Settings)');

const p = D(pm);
ok(p.ok && p.consignments && p.counts.overdue_consignments === 3, 'PM sees consignment');
ok(p.sales === undefined && p.counts.month_sales === undefined && p.payments === undefined, 'PM: no sales, no payments');
ok(p.counts.pending_breakdown.payments === null && p.counts.pending_work === 2, 'PM pending work excludes payments');
const c = D(acc);
ok(c.ok && c.payments && c.sales === undefined && c.counts.month_sales === undefined, 'accounting: payments yes, sales no');
ok(c.consignments === undefined && c.counts.consigned_out === undefined, 'accounting: no consignment');
const s = D(st);
ok(s.ok && !JSON.stringify(s).includes('Elena') && !JSON.stringify(s).includes('Maria'), 'staff: no client names anywhere');
ok(s.payments === undefined && s.sales === undefined && s.consignments === undefined && s.inquiries === undefined, 'staff: board + counts only');
ok(!JSON.stringify([a, p, c, s]).includes('0917'), 'no client phone numbers leak');

// settings override + read-only guarantees
g.SpreadsheetApp.openById().insertSheet('Settings').appendRow(['key', 'value', 'updated_by', 'updated_at']);
g._.sheets.Settings.appendRow(['consign_overdue_days', 40, 'miriam', '']);
const a2 = D(adm); ok(a2.overdue_days === 40 && a2.counts.overdue_consignments === 1, 'Settings consign_overdue_days changes threshold');
const after = JSON.stringify(Object.keys(g._.sheets).filter(k => !['Sessions', 'AuditLog', 'Users', 'Settings'].includes(k)).map(k => [k, g._.sheets[k].data]));
ok(before === after, 'dashboard never writes to business tabs');

// empty spreadsheet (no business tabs yet)
const g2 = load(); g2._.props.SEED_USERS = 'miriam:admin:3816'; g2.setupAuth();
const e = g2.call({ action: 'dashboard', session: g2.call({ action: 'login', username: 'miriam', code: '3816', device_id: 'z' }).session });
ok(e.ok && e.counts.active_jobs === 0 && e.counts.consigned_out === 0 && e.counts.month_sales === 0, 'works with no tabs (all zero)');
ok(e.missing.includes('JobOrders') && e.missing.includes('ConsignmentItems') && e.missing.includes('Payments'), 'reports missing tabs');
ok(!g2._.sheets.JobOrders && !g2._.sheets.Payments, 'does NOT create missing tabs');
console.log(n + ' dashboard tests passed');
