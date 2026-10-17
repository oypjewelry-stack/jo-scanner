/**
 * OYP one-link app: sign-in (first name + 4-digit code), sessions, roles, staff logins.
 * Lives in the same Apps Script project as Code.gs; doPost/doGet route here when req.action is set.
 * Sheet tabs are only ever ADDED (Users, Sessions, AuditLog); existing tabs and rows are never touched.
 * Script Properties used: SHEET_ID (optional; otherwise a new "OYP JO System" spreadsheet is created),
 * PEPPER (auto-created), SEED_USERS (one-time, removed after setupAuth runs).
 */
var AUTH = { SESSION_DAYS: 30, USER_FAILS: 5, USER_LOCK_MIN: 15, DEVICE_FAILS: 10, DEVICE_LOCK_MIN: 15,
  GLOBAL_FAILS: 30, GLOBAL_WINDOW_MIN: 10, GLOBAL_LOCK_MIN: 15 };
var ROLES = ['admin', 'production_manager', 'accounting', 'staff'];
var TABS = {
  Users: ['user_id', 'username', 'display_name', 'role', 'code_salt', 'code_hash', 'active', 'failed_count', 'locked_until',
    'created_at', 'created_by', 'updated_at', 'updated_by'],
  Sessions: ['token_hash', 'user_id', 'username', 'role', 'device_id', 'created_at', 'expires_at', 'last_seen_at', 'revoked_at', 'revoked_reason'],
  AuditLog: ['at', 'actor', 'action', 'target', 'device_id', 'detail']
};
var GENERIC_ERR = 'Name or code is wrong';

/* ---------- routing ---------- */
function handleAction_(req) {
  var a = req.action;
  if (typeof handleCustomer_ === 'function' && isCustAction_(a)) return handleCustomer_(req); // Customers.gs
  if (a === 'login') return login_(req);
  if (a === 'ping') return { ok: true, service: 'OYP' };
  var s = sessionFrom_(req.session);
  if (!s) return { ok: false, error: 'Not signed in', code: 'NO_SESSION' };
  if (a === 'me') return { ok: true, user: publicUser_(s.user) };
  if (a === 'logout') { revokeToken_(req.session, 'logout'); audit_(s.user.username, 'logout', '', req.device_id, ''); return { ok: true }; }
  if (a === 'dashboard' && typeof dashboard_ === 'function') return dashboard_(req, s.user); // Dashboard.gs
  var adminOnly = { listUsers: listUsers_, createUser: createUser_, resetCode: resetCode_, unlockUser: unlockUser_, setActive: setActive_ };
  if (adminOnly[a]) {
    if (s.user.role !== 'admin') { audit_(s.user.username, 'denied', a, req.device_id, 'role ' + s.user.role); return { ok: false, error: 'Not allowed', code: 'FORBIDDEN' }; }
    return withLock_(function () { return adminOnly[a](req, s.user); });
  }
  return { ok: false, error: 'Unknown action' };
}

/* ---------- sheet helpers ---------- */
function ss_() {
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var s = SpreadsheetApp.create('OYP JO System'); p.setProperty('SHEET_ID', s.getId()); return s;
}
function tab_(name) {
  var ss = ss_(), sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]); sh.setFrozenRows(1); }
  else if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]);
  return sh;
}
function rows_(name) { // [{_row, ...}]
  var sh = tab_(name), v = sh.getDataRange().getValues(), h = v[0], out = [];
  for (var i = 1; i < v.length; i++) { var o = { _row: i + 1 }; for (var j = 0; j < h.length; j++) o[h[j]] = v[i][j]; out.push(o); }
  return out;
}
function append_(name, obj) { var sh = tab_(name); sh.appendRow(TABS[name].map(function (k) { return obj[k] === undefined ? '' : obj[k]; })); }
function update_(name, row, obj) { // only the given columns of one row this app created
  var sh = tab_(name), h = TABS[name];
  Object.keys(obj).forEach(function (k) { var c = h.indexOf(k); if (c >= 0) sh.getRange(row, c + 1).setValue(obj[k]); });
}
function withLock_(fn) { var l = LockService.getScriptLock(); l.waitLock(20000); try { return fn(); } finally { l.releaseLock(); } }
function now_() { return new Date().toISOString(); }
function audit_(actor, action, target, device, detail) {
  try { append_('AuditLog', { at: now_(), actor: actor || '', action: action, target: target || '', device_id: String(device || '').slice(0, 40), detail: detail || '' }); } catch (e) {}
}

/* ---------- crypto ---------- */
function sha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ((b + 256) % 256).toString(16).replace(/^(.)$/, '0$1'); }).join('');
}
function pepper_() {
  var p = PropertiesService.getScriptProperties(), v = p.getProperty('PEPPER');
  if (!v) { v = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('PEPPER', v); }
  return v;
}
function codeHash_(salt, code) { return sha_(salt + String(code) + pepper_()); }
function randHex_(n) { var s = ''; while (s.length < n) s += Utilities.getUuid().replace(/-/g, ''); return s.slice(0, n); }
function isWeakCode_(c) {
  if (!/^\d{4}$/.test(c)) return true;
  if (/^(\d)\1{3}$/.test(c)) return true;                       // 0000, 7777
  if ('0123456789'.indexOf(c) >= 0 || '9876543210'.indexOf(c) >= 0) return true; // 1234, 4321
  if (/^(\d\d)\1$/.test(c) || /^(\d)\1(\d)\2$/.test(c)) return true; // 1212, 1122
  if (/^(19|20)\d\d$/.test(c)) return true;                       // years
  return false;
}
function newCode_() { // random, not obvious
  for (;;) { var n = parseInt(randHex_(8), 16) % 10000, c = ('000' + n).slice(-4); if (!isWeakCode_(c)) return c; }
}
function normUser_(u) { return String(u || '').trim().toLowerCase().replace(/\s+/g, ' '); }

/* ---------- login ---------- */
function cacheNum_(k) { return Number(CacheService.getScriptCache().get(k) || 0); }
function cachePut_(k, v, min) { CacheService.getScriptCache().put(k, String(v), Math.round(min * 60)); }
function login_(req) {
  var uname = normUser_(req.username), code = String(req.code || ''), dev = String(req.device_id || 'none').slice(0, 64);
  var c = CacheService.getScriptCache();
  if (c.get('glock')) return { ok: false, error: 'Sign-in is paused for a few minutes. Please try again later.', code: 'GLOBAL_LOCK' };
  if (c.get('dlock_' + dev)) return { ok: false, error: 'Too many tries on this phone. Wait 15 minutes.', code: 'DEVICE_LOCK' };
  // per-name lock works the same for unknown names, so it doesn't reveal which names exist
  if (c.get('ulock_' + sha_(uname))) return { ok: false, error: 'Too many tries for this name. Wait 15 minutes.', code: 'USER_LOCK' };
  return withLock_(function () {
    var u = rows_('Users').filter(function (r) { return r.username === uname; })[0];
    var good = u && String(u.active) !== 'false' && u.code_hash && /^\d{4}$/.test(code) &&
      codeHash_(u.code_salt, code) === u.code_hash && !(u.locked_until && new Date(u.locked_until) > new Date());
    if (!good) return fail_(uname, u, dev);
    c.remove('uf_' + sha_(uname));
    if (Number(u.failed_count) || u.locked_until) update_('Users', u._row, { failed_count: 0, locked_until: '' });
    var token = randHex_(48), exp = new Date(Date.now() + AUTH.SESSION_DAYS * 864e5).toISOString();
    append_('Sessions', { token_hash: sha_(token), user_id: u.user_id, username: u.username, role: u.role, device_id: dev,
      created_at: now_(), expires_at: exp, last_seen_at: now_() });
    audit_(u.username, 'login', '', dev, '');
    return { ok: true, session: token, expires_at: exp, user: publicUser_(u) };
  });
}
function fail_(uname, u, dev) {
  var c = CacheService.getScriptCache(), uk = 'uf_' + sha_(uname), dk = 'df_' + dev;
  var uf = cacheNum_(uk) + 1, df = cacheNum_(dk) + 1, gf = cacheNum_('gf') + 1;
  cachePut_(uk, uf, AUTH.USER_LOCK_MIN); cachePut_(dk, df, AUTH.DEVICE_LOCK_MIN); cachePut_('gf', gf, AUTH.GLOBAL_WINDOW_MIN);
  var locked = '';
  if (uf >= AUTH.USER_FAILS) {
    cachePut_('ulock_' + sha_(uname), 1, AUTH.USER_LOCK_MIN); c.remove(uk); locked = 'user';
    if (u) update_('Users', u._row, { failed_count: uf, locked_until: new Date(Date.now() + AUTH.USER_LOCK_MIN * 6e4).toISOString() });
  } else if (u) update_('Users', u._row, { failed_count: uf });
  if (df >= AUTH.DEVICE_FAILS) { cachePut_('dlock_' + dev, 1, AUTH.DEVICE_LOCK_MIN); c.remove(dk); locked = locked || 'device'; }
  if (gf >= AUTH.GLOBAL_FAILS) { cachePut_('glock', 1, AUTH.GLOBAL_LOCK_MIN); c.remove('gf'); locked = locked || 'global'; }
  audit_(u ? u.username : '(unknown)', 'login_failed', '', dev, locked ? 'locked:' + locked : 'try ' + uf);
  if (locked === 'user') return { ok: false, error: 'Too many tries for this name. Wait 15 minutes.', code: 'USER_LOCK' };
  return { ok: false, error: GENERIC_ERR, code: 'BAD_LOGIN' };
}
function sessionFrom_(token) {
  if (!token || String(token).length < 20) return null;
  var th = sha_(String(token)), s = rows_('Sessions').filter(function (r) { return r.token_hash === th; })[0];
  if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) return null;
  var u = rows_('Users').filter(function (r) { return r.user_id === s.user_id; })[0];
  if (!u || String(u.active) === 'false') return null;
  if (Date.now() - new Date(s.last_seen_at).getTime() > 36e5) update_('Sessions', s._row, { last_seen_at: now_() });
  return { session: s, user: u };
}
function revokeToken_(token, why) {
  var th = sha_(String(token)); rows_('Sessions').forEach(function (r) { if (r.token_hash === th && !r.revoked_at) update_('Sessions', r._row, { revoked_at: now_(), revoked_reason: why }); });
}
function revokeUser_(userId, why) {
  rows_('Sessions').forEach(function (r) { if (r.user_id === userId && !r.revoked_at) update_('Sessions', r._row, { revoked_at: now_(), revoked_reason: why }); });
}
function publicUser_(u) { return { username: u.username, display_name: u.display_name, role: u.role }; }

/* ---------- admin: staff logins ---------- */
function listUsers_() {
  return { ok: true, users: rows_('Users').map(function (u) {
    return { username: u.username, display_name: u.display_name, role: u.role, active: String(u.active) !== 'false',
      has_code: !!u.code_hash, locked: !!(u.locked_until && new Date(u.locked_until) > new Date()) };
  }) };
}
function createUser_(req, actor) {
  var name = String(req.display_name || req.username || '').trim(), uname = normUser_(req.username || name), role = String(req.role || 'staff');
  if (!/^[a-z][a-z0-9 .'-]{0,23}$/.test(uname)) return { ok: false, error: 'Use a first name (letters, up to 24)' };
  if (ROLES.indexOf(role) < 0) return { ok: false, error: 'Unknown role' };
  if (rows_('Users').some(function (r) { return r.username === uname; })) return { ok: false, error: 'That name is taken. Try e.g. ' + uname + '2' };
  var code = newCode_(), salt = randHex_(32);
  append_('Users', { user_id: 'u-' + randHex_(8), username: uname, display_name: name.charAt(0).toUpperCase() + name.slice(1), role: role,
    code_salt: salt, code_hash: codeHash_(salt, code), active: true, failed_count: 0, created_at: now_(), created_by: actor.username, updated_at: now_(), updated_by: actor.username });
  audit_(actor.username, 'createUser', uname, '', 'role ' + role);
  return { ok: true, username: uname, code: code }; // shown once
}
function findUser_(req) { var un = normUser_(req.username); return rows_('Users').filter(function (r) { return r.username === un; })[0]; }
function resetCode_(req, actor) {
  var u = findUser_(req); if (!u) return { ok: false, error: 'No such user' };
  var code = newCode_(), salt = randHex_(32);
  update_('Users', u._row, { code_salt: salt, code_hash: codeHash_(salt, code), failed_count: 0, locked_until: '', updated_at: now_(), updated_by: actor.username });
  CacheService.getScriptCache().remove('ulock_' + sha_(u.username));
  revokeUser_(u.user_id, 'code reset');
  audit_(actor.username, 'resetCode', u.username, '', 'sessions ended');
  return { ok: true, username: u.username, code: code };
}
function unlockUser_(req, actor) {
  var u = findUser_(req); if (!u) return { ok: false, error: 'No such user' };
  update_('Users', u._row, { failed_count: 0, locked_until: '', updated_at: now_(), updated_by: actor.username });
  CacheService.getScriptCache().remove('ulock_' + sha_(u.username)); CacheService.getScriptCache().remove('uf_' + sha_(u.username));
  audit_(actor.username, 'unlockUser', u.username, '', ''); return { ok: true };
}
function setActive_(req, actor) {
  var u = findUser_(req); if (!u) return { ok: false, error: 'No such user' };
  if (u.username === actor.username && !req.active) return { ok: false, error: "You can't deactivate yourself" };
  update_('Users', u._row, { active: !!req.active, updated_at: now_(), updated_by: actor.username });
  if (!req.active) revokeUser_(u.user_id, 'deactivated');
  audit_(actor.username, req.active ? 'activateUser' : 'deactivateUser', u.username, '', ''); return { ok: true };
}

/**
 * ONE-TIME SETUP: run from the Apps Script editor (select setupAuth, click Run).
 * Adds the Users/Sessions/AuditLog tabs and seeds users from the SEED_USERS script property:
 *   miriam:admin:1234,rosanna:admin:5678,...   (name:role:code)
 * Existing users are skipped, never overwritten. SEED_USERS is deleted afterwards so no plain code is kept.
 */
function setupAuth() {
  pepper_(); Object.keys(TABS).forEach(tab_);
  var p = PropertiesService.getScriptProperties(), seed = p.getProperty('SEED_USERS') || '', added = [];
  var existing = rows_('Users').map(function (r) { return r.username; });
  seed.split(',').map(function (s) { return s.trim(); }).filter(String).forEach(function (s) {
    var a = s.split(':'), un = normUser_(a[0]), role = a[1], code = a[2];
    if (!un || ROLES.indexOf(role) < 0 || !/^\d{4}$/.test(code || '')) throw new Error('Bad SEED_USERS entry: ' + a[0]);
    if (existing.indexOf(un) >= 0) return;
    var salt = randHex_(32);
    append_('Users', { user_id: 'u-' + randHex_(8), username: un, display_name: un.charAt(0).toUpperCase() + un.slice(1), role: role,
      code_salt: salt, code_hash: codeHash_(salt, code), active: true, failed_count: 0, created_at: now_(), created_by: 'setup', updated_at: now_(), updated_by: 'setup' });
    existing.push(un); added.push(un + ' (' + role + ')');
  });
  p.deleteProperty('SEED_USERS');
  audit_('setup', 'setupAuth', '', '', 'added ' + added.join(', '));
  Logger.log('Sheet: ' + ss_().getUrl() + '\nAdded users: ' + (added.join(', ') || 'none'));
}
