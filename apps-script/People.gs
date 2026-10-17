/**
 * OYP back office: one "Customers" page = every client (Clients tab, walk-ins included) + their portal account if any (Customers tab).
 * Paste as a new SCRIPT file "People" in the same project. Needs JobSync.gs (jobRows_, jobAppend_, jobSet_, jobKey_, jobStr_, stripPricing_)
 * and Customers.gs (normMobile_, normEmail_, okEmail_, cleanName_). The portal tools themselves stay in Customers.gs (admCust* actions).
 * Hook (Auth.gs handleAction_, right after the JobSync line):
 *   if (typeof isPeopleAction_ === 'function' && isPeopleAction_(a)) return handlePeople_(req, s.user); // People.gs
 * Nothing to run once: it only reads the existing tabs and writes Clients rows (and a blank Customers.client_id) when the admin saves.
 * Data model unchanged: Clients and Customers stay separate tabs, joined by Customers.client_id. Nothing is ever overwritten blindly:
 * an edit carries the values the admin saw; if someone changed a field meanwhile, the whole save is refused (CONFLICT).
 * Admin only (the page shows phone numbers and portal tools).
 */
var PEOPLE = { ROLES: { admin: true }, FIELDS: ['name', 'aliases', 'phone', 'email', 'notes'] };
function isPeopleAction_(a) { return a === 'pplList' || a === 'pplSave'; }
function handlePeople_(req, user) {
  if (!PEOPLE.ROLES[user.role]) { audit_(user.username, 'denied', req.action, req.device_id, 'role ' + user.role); return { ok: false, error: 'Not allowed', code: 'FORBIDDEN' }; }
  if (!ss_().getSheetByName('Clients')) return { ok: false, error: 'The Sheet has no Clients tab yet (run setupJobs).', code: 'NO_TABS' };
  var res = req.action === 'pplSave' ? withLock_(function () { return pplSave_(req, user); }) : pplList_(req, user);
  return stripPricing_(res, user);
}
function pplHas_(name) { return !!ss_().getSheetByName(name); }
function pplDigits_(p) { var d = normMobile_(p); return d.length >= 7 ? d.slice(-10) : ''; }
function pplAccount_(c, links) {
  return { customer_id: String(c.customer_id), full_name: jobStr_(c.full_name), email: jobStr_(c.email), mobile: jobStr_(c.mobile), status: jobStr_(c.status),
    email_verified: String(c.email_verified) === 'true', client_id: jobStr_(c.client_id), match_note: jobStr_(c.match_note),
    locked: !!(c.locked_until && new Date(c.locked_until) > new Date()), last_login_at: jobStr_(c.last_login_at), created_at: jobStr_(c.created_at),
    jos: links.filter(function (l) { return l.customer_id === c.customer_id; }).map(function (l) { return String(l.jo); }) };
}
/** Everyone: clients (with their portal account, if linked) + portal sign-ups that match no client yet. */
function pplList_(req, user) {
  var clients = jobRows_('Clients').filter(function (c) { return jobStr_(c.client_id) || jobStr_(c.name); });
  var custs = pplHas_('Customers') ? jobRows_('Customers').filter(function (c) { return c.customer_id; }) : [];
  var links = pplHas_('CustomerLinks') ? jobRows_('CustomerLinks').filter(function (l) { return !l.unlinked_at; }) : [];
  var jobs = pplHas_('JobOrders') ? jobRows_('JobOrders') : [], byClientJobs = {};
  jobs.forEach(function (j) {
    var k = jobStr_(j.client_id); if (!k || !jobKey_(j.jo)) return;
    (byClientJobs[k] = byClientJobs[k] || []).push({ jo: jobKey_(j.jo), description: jobStr_(j.description), status: jobStr_(j.status), location: jobStr_(j.location) });
  });
  var ids = {}; clients.forEach(function (c) { ids[jobStr_(c.client_id)] = true; });
  var accByClient = {}, loose = [];
  custs.forEach(function (c) { var a = pplAccount_(c, links); if (a.client_id && ids[a.client_id]) (accByClient[a.client_id] = accByClient[a.client_id] || []).push(a); else loose.push(a); });
  var people = clients.map(function (c) {
    var id = jobStr_(c.client_id);
    return { client_id: id, name: jobStr_(c.name), aliases: jobStr_(c.aliases), phone: jobStr_(c.phone), email: jobStr_(c.email), notes: jobStr_(c.notes),
      created_at: jobStr_(c.created_at), jos: (byClientJobs[id] || []).sort(function (a, b) { return a.jo < b.jo ? 1 : -1; }), portal: accByClient[id] || [] };
  }).concat(loose.map(function (a) { // sign-ups not matched to a client yet: shown so they can be approved / matched
    return { client_id: '', name: a.full_name, aliases: '', phone: a.mobile, email: a.email, notes: '', created_at: a.created_at, jos: [], portal: [a], unmatched: true };
  }));
  var pend = function (p) { return p.portal.some(function (a) { return a.status === 'pending'; }); };
  return { ok: true, people: people, counts: { all: people.length, portal: people.filter(function (p) { return p.portal.length; }).length,
    offline: people.filter(function (p) { return !p.portal.length; }).length, needs_approval: people.filter(pend).length, unmatched: loose.length } };
}
function pplClean_(k, v) {
  v = String(v == null ? '' : v).trim();
  if (k === 'name') return cleanName_(v);
  if (k === 'email') { v = normEmail_(v); if (v && !okEmail_(v)) throw new Error('Check the email'); return v; }
  if (k === 'phone') { if (v && pplDigits_(v).length < 7) throw new Error('Check the phone number'); return v.replace(/\s+/g, ' ').slice(0, 30); }
  return v.slice(0, k === 'notes' ? 1000 : 200);
}
/**
 * New client:  { set: {name, aliases?, phone?, email?, notes?}, force?, from_customer? }  (from_customer = a sign-up to link it to)
 * Edit client: { client_id, set: {...}, seen: {field: value shown when the form opened} }
 */
function pplSave_(req, user) {
  var set = req.set || {}, want = {};
  try { PEOPLE.FIELDS.forEach(function (k) { if (k in set) want[k] = pplClean_(k, set[k]); }); } catch (e) { return { ok: false, error: e.message }; }
  var t = now_(), rows = jobRows_('Clients');
  if (!req.client_id) {
    if (!want.name || want.name.length < 2) return { ok: false, error: 'Type the client\u2019s name' };
    var d = want.phone ? pplDigits_(want.phone) : '', e = want.email || '';
    var dup = rows.filter(function (c) { return (d && pplDigits_(c.phone) === d) || (e && normEmail_(c.email) === e); });
    if (dup.length && !req.force) return { ok: false, code: 'DUPLICATE', error: 'A client with that phone or email already exists',
      matches: dup.slice(0, 5).map(function (c) { return { client_id: jobStr_(c.client_id), name: jobStr_(c.name) }; }) };
    var id = 'c-' + randHex_(8), row = { client_id: id, created_at: t, created_by: user.username, updated_at: t, updated_by: user.username };
    PEOPLE.FIELDS.forEach(function (k) { row[k] = want[k] || ''; });
    jobAppend_('Clients', row);
    var linked = '';
    if (req.from_customer && pplHas_('Customers')) {
      var cu = jobRows_('Customers').filter(function (c) { return String(c.customer_id) === String(req.from_customer); })[0];
      if (cu && !jobStr_(cu.client_id)) { jobSet_('Customers', cu._row, { client_id: id, updated_at: t, updated_by: user.username }); linked = cu.customer_id; }
    }
    audit_(user.username, 'clientAdd', id, req.device_id, 'fields ' + Object.keys(want).join(',') + (linked ? '; linked sign-up ' + linked : '') + (dup.length ? '; despite similar ' + dup.map(function (c) { return c.client_id; }).join(',') : ''));
    return { ok: true, client_id: id, linked_customer: linked || null };
  }
  var c = rows.filter(function (r) { return jobStr_(r.client_id) === String(req.client_id); })[0];
  if (!c) return { ok: false, error: 'No such client' };
  var seen = req.seen || {}, ch = {}, conf = {};
  Object.keys(want).forEach(function (k) {
    var cur = jobStr_(c[k]); if (cur === want[k]) return;
    if (cur !== '' && String(seen[k] == null ? '' : seen[k]).trim() !== cur) conf[k] = cur; else ch[k] = want[k];
  });
  if (Object.keys(conf).length) return { ok: false, code: 'CONFLICT', error: 'Someone changed this client meanwhile', conflicts: conf };
  if (ch.name !== undefined && ch.name.length < 2) return { ok: false, error: 'Name is too short' };
  if (!Object.keys(ch).length) return { ok: true, changed: [] };
  ch.updated_at = t; ch.updated_by = user.username; jobSet_('Clients', c._row, ch);
  var changed = Object.keys(ch).filter(function (k) { return k !== 'updated_at' && k !== 'updated_by'; });
  audit_(user.username, 'clientEdit', String(req.client_id), req.device_id, changed.map(function (k) { return k + (jobStr_(c[k]) ? ' changed' : ' filled'); }).join(', '));
  return { ok: true, changed: changed };
}
