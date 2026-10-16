/**
 * OYP customer portal + public shop + admin Customers screen.
 * Paste as a new script file "Customers" in the same Apps Script project as Code.gs and Auth.gs.
 * Adds ONLY new tabs: Customers, CustomerSessions, CustomerLinks, ShopItems. Existing tabs
 * (Clients, JobOrders, Payments, Quotes, Items) are only READ, never created or written.
 * Emails (sign-up check code, Forgot PIN code) go out with MailApp only when the customer asks.
 */
var CUST = { SESSION_DAYS: 30, FAILS: 5, LOCK_MIN: 15, DEVICE_FAILS: 10, CODE_MIN: 15, CODE_TRIES: 5,
  MAIL_PER_HOUR_EMAIL: 3, MAIL_PER_HOUR_DEVICE: 6, MAIL_PER_DAY: 80 };
var CUST_TABS = {
  Customers: ['customer_id', 'full_name', 'email', 'mobile', 'mobile_norm', 'pin_salt', 'pin_hash', 'email_verified', 'status',
    'client_id', 'match_note', 'failed_count', 'locked_until', 'last_login_at', 'created_at', 'updated_at', 'updated_by'],
  CustomerSessions: ['token_hash', 'customer_id', 'device_id', 'created_at', 'expires_at', 'last_seen_at', 'revoked_at', 'revoked_reason'],
  CustomerLinks: ['link_id', 'customer_id', 'jo', 'method', 'linked_by', 'linked_at', 'unlinked_at', 'unlinked_by'],
  ShopItems: ['item_code', 'title', 'category', 'description', 'metal', 'karat', 'weight_g', 'size', 'price_php', 'photo_file_ids',
    'status', 'jo', 'sort', 'created_at', 'created_by', 'updated_at', 'updated_by']
};
var SHOP_PUBLIC = ['item_code', 'title', 'category', 'description', 'metal', 'karat', 'weight_g', 'size', 'price_php'];
var STAGE_LABEL = { intake: 'Received', quote_deposit: 'Quote & deposit', design: 'Design', approval: 'Your approval', stone_sourcing: 'Sourcing stones',
  model: 'Model', casting: 'Casting', bench: 'Goldsmith', pre_polish: 'Polishing', stone_setting: 'Stone setting', engraving: 'Engraving',
  final_polish: 'Final polish', plating: 'Plating', qc: 'Quality check', photo: 'Final photos', final_costing: 'Almost ready',
  notify: 'Ready for pickup', pickup: 'Picked up', repair_intake: 'Received', assess: 'Checking', repair: 'Repair' };
var CUST_ERR = 'Email or PIN is wrong';

function custInit_() { Object.keys(CUST_TABS).forEach(function (k) { TABS[k] = CUST_TABS[k]; }); }
function isCustAction_(a) { return /^(cust|shop)/.test(String(a || '')) || /^adm(Cust|Shop)/.test(String(a || '')); }

/** Called from handleAction_ in Auth.gs. */
function handleCustomer_(req) {
  custInit_();
  var a = req.action;
  var pub = { custSignup: custSignup_, custVerify: custVerify_, custLogin: custLogin_, custForgot: custForgot_, custReset: custReset_,
    shopList: shopList_, shopPhoto: shopPhoto_ };
  if (pub[a]) return pub[a](req);
  if (/^cust/.test(a)) {
    var cs = custSession_(req.session);
    if (!cs) return { ok: false, error: 'Please sign in again', code: 'NO_SESSION' };
    if (a === 'custMe') return { ok: true, customer: custPublic_(cs.c) };
    if (a === 'custLogout') { custRevoke_(req.session, 'logout'); audit_('cust:' + cs.c.customer_id, 'cust_logout', '', req.device_id, ''); return { ok: true }; }
    if (a === 'custJobs') return custJobs_(cs.c);
    if (a === 'custPhoto') return custPhoto_(cs.c, req);
    return { ok: false, error: 'Unknown action' };
  }
  // admin back office (staff session, admin role only)
  var s = sessionFrom_(req.session);
  if (!s) return { ok: false, error: 'Not signed in', code: 'NO_SESSION' };
  if (s.user.role !== 'admin') { audit_(s.user.username, 'denied', a, req.device_id, 'role ' + s.user.role); return { ok: false, error: 'Not allowed', code: 'FORBIDDEN' }; }
  var adm = { admCustList: admCustList_, admCustUpdate: admCustUpdate_, admCustLink: admCustLink_, admCustUnlink: admCustUnlink_,
    admCustApprove: admCustApprove_, admCustResetPin: admCustResetPin_, admCustUnlock: admCustUnlock_, admCustSetActive: admCustSetActive_,
    admCustAudit: admCustAudit_, admShopList: admShopList_, admShopSave: admShopSave_ };
  if (!adm[a]) return { ok: false, error: 'Unknown action' };
  return withLock_(function () { return adm[a](req, s.user); });
}

/* ---------- helpers ---------- */
function readOpt_(name) { // read an existing tab WITHOUT creating it
  var sh = ss_().getSheetByName(name); if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues(), h = v[0].map(function (x) { return String(x).trim(); }), out = [];
  for (var i = 1; i < v.length; i++) { var o = {}; for (var j = 0; j < h.length; j++) o[h[j]] = v[i][j]; out.push(o); }
  return out;
}
function normEmail_(e) { return String(e || '').trim().toLowerCase(); }
function okEmail_(e) { return /^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,}$/.test(e) && e.length <= 120; }
function normMobile_(m) { var d = String(m || '').replace(/\D/g, ''); if (/^63\d{10}$/.test(d)) d = '0' + d.slice(2); if (/^9\d{9}$/.test(d)) d = '0' + d; return d; }
function okMobile_(d) { return /^\d{10,13}$/.test(d); }
function cleanName_(n) { return String(n || '').trim().replace(/\s+/g, ' ').slice(0, 80); }
function custByEmail_(e) { return rows_('Customers').filter(function (r) { return normEmail_(r.email) === e; })[0]; }
function custById_(id) { return rows_('Customers').filter(function (r) { return r.customer_id === id; })[0]; }
function custPublic_(c) { return { customer_id: c.customer_id, full_name: c.full_name, email: c.email, mobile: c.mobile, status: c.status }; }
function sixDigits_() { return ('00000' + (parseInt(randHex_(8), 16) % 1000000)).slice(-6); }
function hit_(k, min) { var n = cacheNum_(k) + 1; cachePut_(k, n, min); return n; }
function sendCode_(email, purpose, dev) { // rate-limited one-time code by email; returns null or error obj
  var e = sha_(email);
  if (cacheNum_('mh_' + e) >= CUST.MAIL_PER_HOUR_EMAIL || cacheNum_('md_' + dev) >= CUST.MAIL_PER_HOUR_DEVICE || cacheNum_('mday') >= CUST.MAIL_PER_DAY)
    return { ok: false, error: 'Too many codes asked for. Please wait an hour and try again.', code: 'RATE' };
  hit_('mh_' + e, 60); hit_('md_' + dev, 60); hit_('mday', 24 * 60);
  var code = sixDigits_(), salt = randHex_(16);
  CacheService.getScriptCache().put('oc_' + purpose + '_' + e, JSON.stringify({ s: salt, h: codeHash_(salt, code), t: 0 }), CUST.CODE_MIN * 60);
  var what = purpose === 'verify' ? 'finish creating your account' : 'set a new PIN';
  MailApp.sendEmail({ to: email, name: 'OYP Jewelry', subject: 'Your OYP Jewelry code: ' + code,
    body: 'Your code is ' + code + '\n\nType it on the OYP Jewelry page to ' + what + '. It works once and expires in ' + CUST.CODE_MIN +
      ' minutes.\n\nIf you did not ask for this, you can ignore this email.' });
  return null;
}
function checkCode_(email, purpose, code) { // single use, expiring, max tries
  var c = CacheService.getScriptCache(), k = 'oc_' + purpose + '_' + sha_(email), raw = c.get(k);
  if (!raw) return false;
  var o = JSON.parse(raw);
  if (/^\d{6}$/.test(String(code)) && codeHash_(o.s, String(code)) === o.h) { c.remove(k); return true; }
  o.t++; if (o.t >= CUST.CODE_TRIES) c.remove(k); else c.put(k, JSON.stringify(o), CUST.CODE_MIN * 60);
  return false;
}
function setPin_(c, pin, by) { var salt = randHex_(32); update_('Customers', c._row, { pin_salt: salt, pin_hash: codeHash_(salt, pin), failed_count: 0, locked_until: '', updated_at: now_(), updated_by: by }); }

/* ---------- sign up / verify ---------- */
function custSignup_(req) {
  var name = cleanName_(req.full_name), email = normEmail_(req.email), mob = normMobile_(req.mobile), pin = String(req.pin || ''), dev = String(req.device_id || 'none').slice(0, 64);
  if (name.length < 3 || name.indexOf(' ') < 0) return { ok: false, error: 'Type your full name (first and last)' };
  if (!okEmail_(email)) return { ok: false, error: 'Check your email address' };
  if (!okMobile_(mob)) return { ok: false, error: 'Check your mobile number' };
  if (isWeakCode_(pin)) return { ok: false, error: 'Pick a harder PIN (not 1234, 1111, a year…)' };
  return withLock_(function () {
    var c = custByEmail_(email);
    if (c && String(c.email_verified) === 'true') return { ok: false, error: 'This email already has an account. Sign in, or tap Forgot PIN.', code: 'EXISTS' };
    var err = sendCode_(email, 'verify', dev); if (err) return err;
    var salt = randHex_(32), fields = { full_name: name, email: email, mobile: mob.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3'), mobile_norm: "'" + mob,
      pin_salt: salt, pin_hash: codeHash_(salt, pin), email_verified: false, status: 'unverified', updated_at: now_(), updated_by: 'self' };
    if (c) update_('Customers', c._row, fields); // unverified re-try: whoever controls the inbox wins
    else { fields.customer_id = 'c-' + randHex_(8); fields.failed_count = 0; fields.created_at = now_(); append_('Customers', fields); }
    audit_('cust:' + email, 'cust_signup', '', dev, '');
    return { ok: true, sent: true };
  });
}
function custVerify_(req) {
  var email = normEmail_(req.email), dev = String(req.device_id || 'none').slice(0, 64);
  return withLock_(function () {
    var c = custByEmail_(email);
    if (!c || String(c.email_verified) === 'true' || !checkCode_(email, 'verify', req.code)) return { ok: false, error: 'That code is wrong or expired', code: 'BAD_CODE' };
    var m = autoMatch_(email, String(c.mobile_norm).replace(/^'/, ''));
    update_('Customers', c._row, { email_verified: true, status: m.status, client_id: m.client_id || '', match_note: m.note, updated_at: now_(), updated_by: 'self' });
    (m.jos || []).forEach(function (jo) { link_(c.customer_id, jo, 'auto_email', 'system'); });
    audit_('cust:' + c.customer_id, 'cust_verified', '', dev, m.note);
    return newCustSession_(custById_(c.customer_id), dev, { linked: (m.jos || []).length });
  });
}
/** Email (verified) matching exactly one Clients row -> active + JOs linked. Mobile-only match -> pending with a suggestion. */
function autoMatch_(email, mob) {
  var clients = readOpt_('Clients');
  var byEmail = clients.filter(function (k) { return k.email && normEmail_(k.email) === email; });
  var byMob = clients.filter(function (k) { return k.phone && mob && normMobile_(k.phone).slice(-10) === mob.slice(-10); });
  if (byEmail.length === 1) {
    var id = String(byEmail[0].client_id);
    var jos = readOpt_('JobOrders').filter(function (j) { return String(j.client_id) === id && j.status !== 'cancelled'; }).map(function (j) { return String(j.jo); });
    return { status: 'active', client_id: id, jos: jos, note: 'auto: email matched ' + id };
  }
  if (byEmail.length > 1) return { status: 'pending', note: 'email matches ' + byEmail.length + ' clients' };
  if (byMob.length === 1) return { status: 'pending', client_id: '', note: 'suggest ' + byMob[0].client_id + ' (mobile matched, needs approval)' };
  return { status: 'pending', note: byMob.length ? 'mobile matches ' + byMob.length + ' clients' : 'no match' };
}
function link_(cid, jo, method, by) {
  var exists = rows_('CustomerLinks').some(function (l) { return l.customer_id === cid && String(l.jo) === jo && !l.unlinked_at; });
  if (!exists) append_('CustomerLinks', { link_id: 'l-' + randHex_(8), customer_id: cid, jo: jo, method: method, linked_by: by, linked_at: now_() });
}

/* ---------- sign in ---------- */
function custLogin_(req) {
  var email = normEmail_(req.email), pin = String(req.pin || ''), dev = String(req.device_id || 'none').slice(0, 64), ek = sha_(email), c0 = CacheService.getScriptCache();
  if (c0.get('glock')) return { ok: false, error: 'Sign-in is paused for a few minutes. Please try again later.', code: 'GLOBAL_LOCK' };
  if (c0.get('cdlock_' + dev)) return { ok: false, error: 'Too many tries on this phone. Wait 15 minutes.', code: 'DEVICE_LOCK' };
  if (c0.get('celock_' + ek)) return { ok: false, error: 'Too many tries. Wait 15 minutes or tap Forgot PIN.', code: 'USER_LOCK' };
  return withLock_(function () {
    var c = custByEmail_(email);
    var good = c && String(c.email_verified) === 'true' && c.status !== 'off' && c.pin_hash && /^\d{4}$/.test(pin) &&
      codeHash_(c.pin_salt, pin) === c.pin_hash && !(c.locked_until && new Date(c.locked_until) > new Date());
    if (!good) {
      var n = hit_('cef_' + ek, CUST.LOCK_MIN), d = hit_('cdf_' + dev, CUST.LOCK_MIN), g = hit_('gf', AUTH.GLOBAL_WINDOW_MIN);
      var locked = n >= CUST.FAILS;
      if (locked) { cachePut_('celock_' + ek, 1, CUST.LOCK_MIN); c0.remove('cef_' + ek); }
      if (c) update_('Customers', c._row, locked ? { failed_count: n, locked_until: new Date(Date.now() + CUST.LOCK_MIN * 6e4).toISOString() } : { failed_count: n });
      if (d >= CUST.DEVICE_FAILS) { cachePut_('cdlock_' + dev, 1, CUST.LOCK_MIN); c0.remove('cdf_' + dev); }
      if (g >= AUTH.GLOBAL_FAILS) { cachePut_('glock', 1, AUTH.GLOBAL_LOCK_MIN); c0.remove('gf'); }
      audit_(c ? 'cust:' + c.customer_id : 'cust:(unknown)', 'cust_login_failed', '', dev, locked ? 'locked' : 'try ' + n);
      if (locked) return { ok: false, error: 'Too many tries. Wait 15 minutes or tap Forgot PIN.', code: 'USER_LOCK' };
      return { ok: false, error: CUST_ERR, code: 'BAD_LOGIN' };
    }
    c0.remove('cef_' + ek);
    update_('Customers', c._row, { failed_count: 0, locked_until: '', last_login_at: now_() });
    audit_('cust:' + c.customer_id, 'cust_login', '', dev, '');
    return newCustSession_(c, dev);
  });
}
function newCustSession_(c, dev, extra) {
  var token = randHex_(48), exp = new Date(Date.now() + CUST.SESSION_DAYS * 864e5).toISOString();
  append_('CustomerSessions', { token_hash: sha_(token), customer_id: c.customer_id, device_id: dev, created_at: now_(), expires_at: exp, last_seen_at: now_() });
  var r = { ok: true, session: token, expires_at: exp, customer: custPublic_(c) };
  Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
  return r;
}
function custSession_(token) {
  if (!token || String(token).length < 20) return null;
  var th = sha_(String(token)), s = rows_('CustomerSessions').filter(function (r) { return r.token_hash === th; })[0];
  if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) return null;
  var c = custById_(s.customer_id);
  if (!c || c.status === 'off' || String(c.email_verified) !== 'true') return null;
  if (Date.now() - new Date(s.last_seen_at).getTime() > 36e5) update_('CustomerSessions', s._row, { last_seen_at: now_() });
  return { s: s, c: c };
}
function custRevoke_(token, why) { var th = sha_(String(token)); rows_('CustomerSessions').forEach(function (r) { if (r.token_hash === th && !r.revoked_at) update_('CustomerSessions', r._row, { revoked_at: now_(), revoked_reason: why }); }); }
function custRevokeAll_(cid, why) { rows_('CustomerSessions').forEach(function (r) { if (r.customer_id === cid && !r.revoked_at) update_('CustomerSessions', r._row, { revoked_at: now_(), revoked_reason: why }); }); }

/* ---------- forgot PIN ---------- */
var FORGOT_MSG = 'If that email has an account, we sent it a 6-digit code. Check your inbox (and spam).';
function custForgot_(req) {
  var email = normEmail_(req.email), dev = String(req.device_id || 'none').slice(0, 64);
  if (!okEmail_(email)) return { ok: false, error: 'Check your email address' };
  return withLock_(function () {
    var c = custByEmail_(email);
    if (c && String(c.email_verified) === 'true' && c.status !== 'off') sendCode_(email, 'reset', dev); // rate-limited silently: same reply either way
    audit_(c ? 'cust:' + c.customer_id : 'cust:(unknown)', 'cust_forgot', '', dev, '');
    return { ok: true, message: FORGOT_MSG };
  });
}
function custReset_(req) {
  var email = normEmail_(req.email), pin = String(req.pin || ''), dev = String(req.device_id || 'none').slice(0, 64);
  if (isWeakCode_(pin)) return { ok: false, error: 'Pick a harder PIN (not 1234, 1111, a year…)' };
  return withLock_(function () {
    var c = custByEmail_(email);
    if (!c || !checkCode_(email, 'reset', req.code)) return { ok: false, error: 'That code is wrong or expired', code: 'BAD_CODE' };
    setPin_(c, pin, 'self'); custRevokeAll_(c.customer_id, 'pin_reset');
    CacheService.getScriptCache().remove('celock_' + sha_(email));
    audit_('cust:' + c.customer_id, 'cust_pin_reset', '', dev, 'by email code');
    return newCustSession_(custById_(c.customer_id), dev);
  });
}

/* ---------- customer data (only their own JOs) ---------- */
function myJos_(cid) { return rows_('CustomerLinks').filter(function (l) { return l.customer_id === cid && !l.unlinked_at; }).map(function (l) { return String(l.jo); }); }
function custJobs_(c) {
  var mine = myJos_(c.customer_id), jobs = readOpt_('JobOrders').filter(function (j) { return mine.indexOf(String(j.jo)) >= 0 && j.status !== 'cancelled'; });
  var quotes = readOpt_('Quotes'), pays = readOpt_('Payments'), stages = readOpt_('JobStages');
  return { ok: true, customer: custPublic_(c), jobs: jobs.map(function (j) {
    var jo = String(j.jo);
    var q = quotes.filter(function (x) { return String(x.jo) === jo && (x.status === 'accepted' || x.status === 'sent'); })
      .sort(function (a, b) { return (a.status === 'accepted' ? 1 : 0) - (b.status === 'accepted' ? 1 : 0) || Number(a.version) - Number(b.version); }).pop();
    var paid = pays.filter(function (p) { return String(p.jo) === jo && p.status === 'confirmed'; }).reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);
    var st = stages.filter(function (s) { return String(s.jo) === jo && s.status !== 'skipped'; }).sort(function (a, b) { return a.seq - b.seq; })
      .map(function (s) { return { label: STAGE_LABEL[s.stage_code] || String(s.stage_code).replace(/_/g, ' '), status: s.status }; });
    var total = q ? Number(q.amount || 0) : null;
    return { jo: jo, description: j.description || '', metal: j.metal || '', karat: j.karat || '', size: j.size || '', due_date: fmtDate_(j.due_date),
      status: j.status, stage: STAGE_LABEL[j.current_stage] || String(j.current_stage || '').replace(/_/g, ' '), stages: st,
      photos: j.product_photo_file_id ? 1 : 0, total: total, paid: paid, balance: total == null ? null : Math.max(0, total - paid) };
  }) };
}
function fmtDate_(d) { if (!d) return ''; var x = new Date(d); return isNaN(x) ? String(d) : Utilities.formatDate(x, 'Asia/Manila', 'MMM d, yyyy'); }
function thumb_(id) { var b = DriveApp.getFileById(id).getThumbnail() || DriveApp.getFileById(id).getBlob(); return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()); }
function custPhoto_(c, req) {
  var jo = String(req.jo || '');
  if (myJos_(c.customer_id).indexOf(jo) < 0) { audit_('cust:' + c.customer_id, 'denied', 'custPhoto', req.device_id, jo); return { ok: false, error: 'Not allowed', code: 'FORBIDDEN' }; }
  var j = readOpt_('JobOrders').filter(function (x) { return String(x.jo) === jo; })[0];
  if (!j || !j.product_photo_file_id) return { ok: true, src: '' };
  try { return { ok: true, src: thumb_(String(j.product_photo_file_id)) }; } catch (e) { return { ok: true, src: '' }; }
}

/* ---------- public shop (sanitised) ---------- */
function shopRows_() { return rows_('ShopItems').filter(function (r) { return r.status === 'listed' && r.item_code; }); }
function shopList_() {
  return { ok: true, items: shopRows_().sort(function (a, b) { return Number(a.sort || 0) - Number(b.sort || 0); }).map(function (r) {
    var o = {}; SHOP_PUBLIC.forEach(function (k) { o[k] = r[k] === '' ? '' : String(r[k]); });
    o.price_php = Number(r.price_php) || null; o.photos = String(r.photo_file_ids || '').split(',').filter(String).length; return o;
  }) };
}
function shopPhoto_(req) {
  var r = shopRows_().filter(function (x) { return String(x.item_code) === String(req.item_code); })[0];
  var ids = r ? String(r.photo_file_ids || '').split(',').map(function (s) { return s.trim(); }).filter(String) : [], id = ids[Number(req.n || 0)];
  if (!id) return { ok: true, src: '' };
  try { return { ok: true, src: thumb_(id) }; } catch (e) { return { ok: true, src: '' }; }
}

/* ---------- admin: Customers screen ---------- */
function admCustList_() {
  var links = rows_('CustomerLinks').filter(function (l) { return !l.unlinked_at; });
  return { ok: true, customers: rows_('Customers').map(function (c) {
    return { customer_id: c.customer_id, full_name: c.full_name, email: c.email, mobile: c.mobile, status: c.status, email_verified: String(c.email_verified) === 'true',
      client_id: c.client_id, match_note: c.match_note, locked: !!(c.locked_until && new Date(c.locked_until) > new Date()), last_login_at: c.last_login_at,
      created_at: c.created_at, jos: links.filter(function (l) { return l.customer_id === c.customer_id; }).map(function (l) { return String(l.jo); }) };
  }) };
}
function needCust_(req) { var c = custById_(String(req.customer_id || '')); if (!c) throw new Error('Customer not found'); return c; }
function admWrap_(fn) { try { return fn(); } catch (e) { return { ok: false, error: String(e.message || e) }; } }
function admCustUpdate_(req, u) { return admWrap_(function () {
  var c = needCust_(req), f = {};
  if (req.full_name !== undefined) { var n = cleanName_(req.full_name); if (n.length < 2) throw new Error('Name is too short'); f.full_name = n; }
  if (req.email !== undefined) { var e = normEmail_(req.email); if (!okEmail_(e)) throw new Error('Check the email'); var o = custByEmail_(e); if (o && o.customer_id !== c.customer_id) throw new Error('Another customer has that email'); f.email = e; }
  if (req.mobile !== undefined) { var m = normMobile_(req.mobile); if (!okMobile_(m)) throw new Error('Check the mobile number'); f.mobile = m.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3'); f.mobile_norm = "'" + m; }
  if (req.client_id !== undefined) f.client_id = String(req.client_id).trim();
  f.updated_at = now_(); f.updated_by = u.username; update_('Customers', c._row, f);
  audit_(u.username, 'cust_edit', c.customer_id, req.device_id, Object.keys(f).filter(function (k) { return k !== 'updated_at' && k !== 'updated_by' && k !== 'mobile_norm'; }).join(','));
  return { ok: true };
}); }
function admCustLink_(req, u) { return admWrap_(function () {
  var c = needCust_(req), jo = normJO_(req.jo);
  if (!readOpt_('JobOrders').some(function (j) { return String(j.jo) === jo; })) throw new Error('No JO ' + jo + ' in JobOrders');
  link_(c.customer_id, jo, 'admin', u.username); audit_(u.username, 'cust_link', c.customer_id, req.device_id, jo); return { ok: true };
}); }
function admCustUnlink_(req, u) { return admWrap_(function () {
  var c = needCust_(req), jo = String(req.jo || '');
  rows_('CustomerLinks').forEach(function (l) { if (l.customer_id === c.customer_id && String(l.jo) === jo && !l.unlinked_at) update_('CustomerLinks', l._row, { unlinked_at: now_(), unlinked_by: u.username }); });
  audit_(u.username, 'cust_unlink', c.customer_id, req.device_id, jo); return { ok: true };
}); }
function admCustApprove_(req, u) { return admWrap_(function () {
  var c = needCust_(req), cid = String(req.client_id || c.client_id || '').trim(), n = 0;
  if (String(c.email_verified) !== 'true') throw new Error('They have not confirmed their email yet');
  if (cid) readOpt_('JobOrders').forEach(function (j) { if (String(j.client_id) === cid && j.status !== 'cancelled') { link_(c.customer_id, String(j.jo), 'admin', u.username); n++; } });
  update_('Customers', c._row, { status: 'active', client_id: cid, updated_at: now_(), updated_by: u.username });
  audit_(u.username, 'cust_approve', c.customer_id, req.device_id, cid ? 'client ' + cid + ', ' + n + ' JOs' : 'no client'); return { ok: true, linked: n };
}); }
function admCustResetPin_(req, u) { return admWrap_(function () {
  var c = needCust_(req), pin = newCode_(); setPin_(c, pin, u.username); custRevokeAll_(c.customer_id, 'admin_reset');
  CacheService.getScriptCache().remove('celock_' + sha_(normEmail_(c.email)));
  audit_(u.username, 'cust_pin_reset', c.customer_id, req.device_id, 'by admin'); return { ok: true, pin: pin };
}); }
function admCustUnlock_(req, u) { return admWrap_(function () {
  var c = needCust_(req); update_('Customers', c._row, { failed_count: 0, locked_until: '' });
  var k = CacheService.getScriptCache(); k.remove('celock_' + sha_(normEmail_(c.email))); k.remove('cef_' + sha_(normEmail_(c.email)));
  audit_(u.username, 'cust_unlock', c.customer_id, req.device_id, ''); return { ok: true };
}); }
function admCustSetActive_(req, u) { return admWrap_(function () {
  var c = needCust_(req), on = !!req.active;
  update_('Customers', c._row, { status: on ? (c.client_id || myJos_(c.customer_id).length ? 'active' : 'pending') : 'off', updated_at: now_(), updated_by: u.username });
  if (!on) custRevokeAll_(c.customer_id, 'deactivated');
  audit_(u.username, on ? 'cust_on' : 'cust_off', c.customer_id, req.device_id, ''); return { ok: true };
}); }
function admCustAudit_(req) {
  var id = String(req.customer_id || '');
  return { ok: true, log: rows_('AuditLog').filter(function (r) { return r.actor === 'cust:' + id || r.target === id; }).slice(-100).reverse()
    .map(function (r) { return { at: r.at, actor: r.actor, action: r.action, detail: r.detail }; }) };
}
function admShopList_() { return { ok: true, items: rows_('ShopItems').map(function (r) { var o = {}; CUST_TABS.ShopItems.forEach(function (k) { o[k] = r[k]; }); return o; }) }; }
function admShopSave_(req, u) { return admWrap_(function () {
  var code = String(req.item_code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) throw new Error('Item code: letters, numbers and - only');
  if (/^\d{2}-\d{3,4}[A-Z]?$/.test(code)) throw new Error('Item code must not be a JO number');
  var f = { title: cleanName_(req.title), category: cleanName_(req.category), description: String(req.description || '').slice(0, 600), metal: cleanName_(req.metal),
    karat: cleanName_(req.karat), weight_g: req.weight_g || '', size: cleanName_(req.size), price_php: Number(req.price_php) || '', photo_file_ids: String(req.photo_file_ids || ''),
    status: ['listed', 'hidden', 'sold'].indexOf(req.status) >= 0 ? req.status : 'hidden', jo: req.jo ? normJO_(req.jo) : '', sort: Number(req.sort) || 0, updated_at: now_(), updated_by: u.username };
  var ex = rows_('ShopItems').filter(function (r) { return String(r.item_code) === code; })[0];
  if (ex) update_('ShopItems', ex._row, f); else { f.item_code = code; f.created_at = now_(); f.created_by = u.username; append_('ShopItems', f); }
  audit_(u.username, 'shop_save', code, req.device_id, f.status); return { ok: true };
}); }

/** Run once from the editor after pasting: adds the 4 new tabs (nothing else is touched). */
function setupCustomers() { custInit_(); Object.keys(CUST_TABS).forEach(tab_); audit_('setup', 'setupCustomers', '', '', ''); Logger.log('Customer tabs ready in ' + ss_().getUrl()); }
