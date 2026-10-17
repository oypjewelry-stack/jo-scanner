const assert = require('assert'); const load = require('./gasmock');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const g = load();
g._.props.SEED_USERS = 'miriam:admin:3816,susan:production_manager:2507,ana:accounting:4444,thea:staff:1111'; g.setupAuth();
const S = (u, c) => g.call({ action: 'login', username: u, code: c, device_id: u }).session;
const adm = S('miriam', '3816'), pm = S('susan', '2507'), acc = S('ana', '4444'), st = S('thea', '1111');
const C = (s, action, d = {}) => g.call(Object.assign({ action, session: s, device_id: 'x' }, d));
const tab = n => { const d = g._.sheets[n] ? g._.sheets[n].data : []; const h = d[0] || []; return d.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] === undefined ? '' : r[i]]))); };
const put = (name, o) => { const h = g._.sheets[name].data[0]; g._.sheets[name].data.push(h.map(k => o[k] !== undefined ? o[k] : '')); };

ok(C(adm, 'pplList').code === 'NO_TABS', 'no Clients tab yet: clear answer');
g.setupJobs(); g.setupCustomers();
['26-001', '26-002', '26-005'].forEach(jo => g.call({ jo, page: 1, imageBase64: 'eA==' }));
put('Clients', { client_id: 'c-el', name: 'Elena Tan', aliases: 'Lenlen', phone: '0917 123 4567', email: 'elena@x.ph', notes: 'Prefers 18k' });
put('Clients', { client_id: 'c-mc', name: 'Maria Cruz', phone: '0918 111 2222' });
put('Clients', { client_id: 'c-walk', name: 'Mang Jose', phone: '0999 000 1111', notes: 'Walk-in, repairs' });
put('Customers', { customer_id: 'cu-1', full_name: 'Elena Tan', email: 'elena@x.ph', mobile: '0917 123 4567', status: 'active', email_verified: true, client_id: 'c-el' });
put('Customers', { customer_id: 'cu-2', full_name: 'Maria C.', email: 'mc@x.ph', mobile: '0918 111 2222', status: 'pending', email_verified: true, client_id: 'c-mc', match_note: 'phone' });
put('Customers', { customer_id: 'cu-9', full_name: 'New Person', email: 'np@x.ph', mobile: '0915 777 3434', status: 'pending', email_verified: true });
put('CustomerLinks', { link_id: 'l1', customer_id: 'cu-1', jo: '26-001', method: 'admin' });
C(adm, 'jobReviewSave', { jo: '26-001', set: { client_id: 'c-el', description: 'Ring' }, seen: {} });
C(adm, 'jobReviewSave', { jo: '26-005', set: { client_id: 'c-walk' }, seen: {} });
const before = JSON.stringify([g._.sheets.Clients.data, g._.sheets.Customers.data]);

// roles
['pplList', 'pplSave'].forEach(a => ok(C(pm, a).code === 'FORBIDDEN' && C(acc, a).code === 'FORBIDDEN' && C(st, a).code === 'FORBIDDEN', a + ': admin only (PM, accounting, staff refused)'));
ok(C('', 'pplList').code === 'NO_SESSION', 'signed out: refused');
ok(tab('AuditLog').some(r => r.action === 'denied' && r.target === 'pplList'), 'refusals logged');

let L = C(adm, 'pplList');
ok(L.ok && L.people.length === 4, 'one list: 3 clients + 1 unmatched sign-up');
ok(JSON.stringify([g._.sheets.Clients.data, g._.sheets.Customers.data]) === before, 'listing changes nothing');
const P = id => L.people.find(p => p.client_id === id);
ok(P('c-el').portal.length === 1 && P('c-el').portal[0].customer_id === 'cu-1' && P('c-el').portal[0].jos.join() === '26-001', 'Elena: Portal ticked, linked portal JOs');
ok(P('c-walk').portal.length === 0 && P('c-walk').jos[0].jo === '26-005', 'walk-in: offline only, JOs from JobOrders');
ok(P('c-el').jos[0].jo === '26-001' && P('c-el').aliases === 'Lenlen' && P('c-el').notes === 'Prefers 18k', 'client details: aliases, notes, JOs');
ok(P('c-mc').portal[0].status === 'pending', 'matched pending sign-up shows on its client');
const u = L.people.find(p => p.unmatched);
ok(u && u.name === 'New Person' && u.portal[0].customer_id === 'cu-9' && !u.client_id, 'sign-up with no client still listed (unmatched)');
ok(L.counts.portal === 3 && L.counts.offline === 1 && L.counts.needs_approval === 2 && L.counts.unmatched === 1, 'counts: portal 3, offline 1, needs approval 2');
ok(!JSON.stringify(L).match(/pin_hash|pin_salt|token/), 'no PIN hashes or tokens in the list');

// add offline client
let r = C(adm, 'pplSave', { set: { name: 'Lita Ramos', phone: '0905 222 3333', notes: 'Walk-in' } });
ok(r.ok && /^c-/.test(r.client_id) && tab('Clients').length === 4, 'admin adds an offline client');
ok(tab('Customers').length === 3, '...without creating any portal account');
ok(C(adm, 'pplSave', { set: { name: 'L' } }).ok === false, 'name required');
ok(C(adm, 'pplSave', { set: { name: 'Bad Mail', email: 'nope' } }).error === 'Check the email', 'bad email refused');
r = C(adm, 'pplSave', { set: { name: 'Elena T', phone: '+63 917 123 4567' } });
ok(r.code === 'DUPLICATE' && r.matches[0].client_id === 'c-el' && tab('Clients').length === 4, 'same phone (+63 form) → warns about Elena, nothing added');
ok(C(adm, 'pplSave', { set: { name: 'Elena T', phone: '0917 123 4567' }, force: true }).ok && tab('Clients').length === 5, '"add anyway" works when confirmed');
// make a client from an unmatched sign-up
r = C(adm, 'pplSave', { set: { name: 'New Person', phone: '0915 777 3434', email: 'np@x.ph' }, from_customer: 'cu-9' });
ok(r.ok && r.linked_customer === 'cu-9' && tab('Customers').find(c => c.customer_id === 'cu-9').client_id === r.client_id, 'client from sign-up: links the sign-up (blank client_id only)');
ok(C(adm, 'pplSave', { set: { name: 'Elena Again', email: 'x2@x.ph' }, from_customer: 'cu-1', force: true }).linked_customer === null && tab('Customers').find(c => c.customer_id === 'cu-1').client_id === 'c-el', 'never re-points a sign-up that already has a client');
ok(!C(adm, 'pplList').people.some(p => p.unmatched), 'sign-up now shows under its client');

// edit with never-blind-overwrite
r = C(adm, 'pplSave', { client_id: 'c-walk', set: { email: 'jose@x.ph', notes: 'Walk-in, repairs. Calls first.' }, seen: { email: '', notes: 'Walk-in, repairs' } });
ok(r.ok && r.changed.join() === 'email,notes' && tab('Clients').find(c => c.client_id === 'c-walk').email === 'jose@x.ph', 'edit fills + changes fields');
r = C(adm, 'pplSave', { client_id: 'c-walk', set: { phone: '0999 000 2222', notes: 'mine' }, seen: { phone: '0999 000 1111', notes: 'Walk-in, repairs' } });
ok(r.code === 'CONFLICT' && r.conflicts.notes === 'Walk-in, repairs. Calls first.' && tab('Clients').find(c => c.client_id === 'c-walk').phone === '0999 000 1111', 'someone changed notes meanwhile → whole save refused, phone untouched');
ok(C(adm, 'pplSave', { client_id: 'c-walk', set: { name: 'Mang Jose' }, seen: {} }).changed.length === 0, 'no change → nothing written');
ok(C(adm, 'pplSave', { client_id: 'c-nope', set: { name: 'X Y' } }).error === 'No such client', 'unknown client');
ok(tab('AuditLog').filter(r => r.action === 'clientAdd').length === 4 && tab('AuditLog').some(r => r.action === 'clientEdit' && /email filled, notes changed/.test(r.detail)), 'adds + edits logged (field names, not values)');
ok(!tab('AuditLog').some(r => /0905 222 3333|Calls first/.test(r.detail)), 'phone numbers and notes not copied into AuditLog');
// other columns untouched
put('Clients', { client_id: 'c-bill', name: 'Billing Co', billing_info: 'TIN 123', portal_code: 'PC1' });
C(adm, 'pplSave', { client_id: 'c-bill', set: { phone: '0917 000 0000' }, seen: {} });
const b = tab('Clients').find(c => c.client_id === 'c-bill');
ok(b.billing_info === 'TIN 123' && b.portal_code === 'PC1' && b.phone === '0917 000 0000', 'billing_info / portal_code columns never touched');
// prices never leak through (exec gating still applies to non-admins if EXEC_ROLES changes)
ok(!JSON.stringify(C(adm, 'pplList')).match(/"(srp|price|margin|quote_amount)"/), 'no prices in the people list');
// existing portal tools still work on the same records
ok(C(adm, 'admCustApprove', { customer_id: 'cu-2' }).ok && C(adm, 'pplList').people.find(p => p.client_id === 'c-mc').portal[0].status === 'active', 'approve via existing portal tool → shows Active');
console.log(n + ' people tests passed');
