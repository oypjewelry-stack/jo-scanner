const assert = require('assert'); const load = require('./gasmock');
const g = load(); let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
g._.props.SEED_USERS = 'miriam:admin:3816,rosanna:admin:6042,carlos:admin:8159,susan:production_manager:2507';
g.setupAuth();
ok(!g._.props.SEED_USERS && g._.props.PEPPER, 'seed property removed, pepper set');
const users = g._.sheets.Users.data; ok(users.length === 5 && !JSON.stringify(users).includes('3816'), 'only hashes stored');
g.setupAuth(); ok(g._.sheets.Users.data.length === 5, 're-running setup adds nothing / overwrites nothing');
const L = (u, c, d = 'dev1') => g.call({ action: 'login', username: u, code: c, device_id: d });
for (const [u, c, role] of [['Miriam', '3816', 'admin'], ['ROSANNA ', '6042', 'admin'], ['carlos', '8159', 'admin'], ['Susan', '2507', 'production_manager']]) {
  const r = L(u, c); ok(r.ok && r.user.role === role && r.session.length === 48, u.trim() + ' logs in as ' + role); }
const bad1 = L('susan', '0000', 'devA'), bad2 = L('nobody', '1111', 'devB');
ok(!bad1.ok && bad1.error === bad2.error && bad1.error === 'Name or code is wrong', 'wrong code and unknown name give same error');
const adm = L('miriam', '3816').session;
const cu = g.call({ action: 'createUser', session: adm, username: 'Thea', role: 'staff' });
ok(cu.ok && /^\d{4}$/.test(cu.code) && !g.isWeakCode_(cu.code), 'admin creates staff user, gets one-time code ' + cu.code);
const st = L('thea', cu.code); ok(st.ok && st.user.role === 'staff', 'staff logs in');
for (const a of ['listUsers', 'createUser', 'resetCode', 'unlockUser', 'setActive']) {
  const r = g.call({ action: a, session: st.session, username: 'miriam', role: 'admin', active: false }); ok(!r.ok && r.code === 'FORBIDDEN', 'staff blocked from ' + a); }
const pm = L('susan', '2507', 'devC').session; ok(g.call({ action: 'listUsers', session: pm }).code === 'FORBIDDEN', 'PM blocked from staff logins');
ok(g.call({ action: 'listUsers', session: adm }).users.length === 5, 'admin lists users');
ok(g.call({ action: 'me', session: st.session }).user.username === 'thea', 'remembered session works (me)');
g._.advance(29 * 864e5); ok(g.call({ action: 'me', session: st.session }).ok, 'still signed in after 29 days');
g._.advance(2 * 864e5); ok(g.call({ action: 'me', session: st.session }).code === 'NO_SESSION', 'session expires after 30 days');
const s2 = L('thea', cu.code, 'devD').session; ok(g.call({ action: 'logout', session: s2 }).ok && g.call({ action: 'me', session: s2 }).code === 'NO_SESSION', 'logout ends session');
// lockout after 5
let r; for (let i = 1; i <= 5; i++) r = L('carlos', '0001', 'devL' + i); ok(r.code === 'USER_LOCK', '5th wrong code locks the name');
ok(L('carlos', '8159', 'devE').code === 'USER_LOCK', 'correct code refused while locked');
for (let i = 1; i <= 5; i++) r = L('ghost', '0001', 'devG' + i); ok(r.code === 'USER_LOCK', 'unknown names lock the same way (no name leak)');
g._.advance(16 * 6e4); ok(L('carlos', '8159', 'devE').ok, 'unlocks after 15 min');
for (let i = 1; i <= 10; i++) r = L('x' + i, '0001', 'devZ'); ok(r.code === 'DEVICE_LOCK' || L('miriam', '3816', 'devZ').code === 'DEVICE_LOCK', 'device locked after 10 fails');
ok(L('miriam', '3816', 'devZ').code === 'DEVICE_LOCK', 'locked device refused even with right code');
// reset code ends sessions
const adm2 = L('miriam', '3816', 'devM').session;
const s3 = L('thea', cu.code, 'devF').session; const rc = g.call({ action: 'resetCode', session: adm2, username: 'thea' });
ok(rc.ok && g.call({ action: 'me', session: s3 }).code === 'NO_SESSION' && !L('thea', cu.code, 'devH').ok && L('thea', rc.code, 'devH').ok, 'reset code: old code + sessions dead, new code works');
ok(g.call({ action: 'setActive', session: adm2, username: 'thea', active: false }).ok && !L('thea', rc.code, 'devI').ok, 'deactivated user cannot sign in');
ok(g.isWeakCode_('1234') && g.isWeakCode_('7777') && g.isWeakCode_('1212') && g.isWeakCode_('2026') && !g.isWeakCode_('3816'), 'obvious codes blocked');
ok(!JSON.stringify(g._.sheets.AuditLog.data).match(/3816|2507|6042|8159/), 'no plain codes in AuditLog');
console.log('all', n, 'auth tests passed');
