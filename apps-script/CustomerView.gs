/**
 * OYP CustomerView: what customers may see about a JO (oypjewelry.com "Track my order" and My orders).
 * Paste as a NEW script file named "CustomerView" in the Apps Script project "OYP System".
 *
 * Customers see ONLY: progress/stages, price shown to them (latest SENT or ACCEPTED quote), payments
 * (date, amount, method), balance, and the piece's own photos: the product photo (JobOrders.product_photo_file_id)
 * and image files in the JO's Drive "product" and "cad" folders.
 * NEVER: JO card scans (any file listed in OcrLog, the JO folder itself, its "scans" folder), Drive file ids or links,
 * costs, markup, margin, labor, workers, client ids, notes.
 * Read-only on the Sheet; it only adds one AuditLog line per order lookup.
 *
 * ONE line to add in the file "Customers", inside function handleCustomer_(req), right after the line
 *     var a = req.action;
 * add:
 *     if (typeof handleCustView_ === 'function') { var cv = handleCustView_(req); if (cv) return cv; } // CustomerView.gs
 */
var CV = { JO_FAILS: 5, DEVICE_FAILS: 10, LOCK_MIN: 15, PHOTO_FOLDERS: ['product', 'cad'] };
var CV_NOT_FOUND = 'We couldn\'t find an order with that JO number and mobile number or email.';

/** Returns a reply, or null to let Customers.gs handle the action as before. */
function handleCustView_(req) {
  var a = req.action;
  if (a === 'custTrack') return cvTrack_(req, false);
  if (a === 'custTrackPhoto') return cvTrack_(req, true);
  if (a !== 'custJobs' && a !== 'custPhoto') return null;
  custInit_();
  var cs = custSession_(req.session);
  if (!cs) return { ok: false, error: 'Please sign in again', code: 'NO_SESSION' };
  var mine = myJos_(cs.c.customer_id).map(cvKey_);
  if (a === 'custJobs') {
    var all = cvData_();
    var jobs = all.jobs.filter(function (j) { return mine.indexOf(cvKey_(j.jo)) >= 0 && j.status !== 'cancelled'; }).map(function (j) { return cvView_(j, all); });
    return { ok: true, safe_photos: true, customer: custPublic_(cs.c), jobs: jobs };
  }
  var jo = cvKey_(req.jo);
  if (mine.indexOf(jo) < 0) { audit_('cust:' + cs.c.customer_id, 'denied', 'custPhoto', req.device_id, jo); return { ok: false, error: 'Not allowed', code: 'FORBIDDEN' }; }
  return cvPhoto_(jo, req.n);
}

function cvKey_(s) {
  var m = String(s || '').toUpperCase().match(/(\d{2})\s*[-,.\/ ]?\s*(\d{3,4})(?:\s?([A-Z])(?![A-Z0-9]))?/);
  return m ? m[1] + '-' + m[2] : ''; // a letter (26-287B) is a newer version of the same JO 26-287
}
function cvData_() {
  return { jobs: readOpt_('JobOrders'), quotes: readOpt_('Quotes'), stages: readOpt_('JobStages'),
    hasPayments: !!ss_().getSheetByName('Payments'), pays: readOpt_('Payments') };
}
/** The only JO fields a customer gets. */
function cvView_(j, d) {
  var jo = cvKey_(j.jo);
  var q = d.quotes.filter(function (x) { return cvKey_(x.jo) === jo && (x.status === 'accepted' || x.status === 'sent'); })
    .sort(function (a, b) { return (a.status === 'accepted' ? 1 : 0) - (b.status === 'accepted' ? 1 : 0) || Number(a.version) - Number(b.version); }).pop();
  var pays = d.pays.filter(function (p) { return cvKey_(p.jo) === jo && p.status === 'confirmed' && Number(p.amount) > 0; })
    .map(function (p) { return { date: fmtDate_(p.date || p.confirmed_at), amount: Number(p.amount), method: String(p.method || '').slice(0, 30) }; });
  var paid = pays.reduce(function (s, p) { return s + p.amount; }, 0);
  var price = q && Number(q.amount) > 0 ? Number(q.amount) : null;
  var st = d.stages.filter(function (s) { return cvKey_(s.jo) === jo && s.status !== 'skipped'; }).sort(function (a, b) { return a.seq - b.seq; })
    .map(function (s) { return { label: STAGE_LABEL[s.stage_code] || String(s.stage_code).replace(/_/g, ' '), status: String(s.status) }; });
  return { jo: jo, description: cvS_(j.description), item_type: cvItemType_(j.item_type), specs: cvSpecs_(j),
    metal: cvS_(j.metal), karat: cvS_(j.karat), size: cvS_(j.size),
    due_date: fmtDate_(j.due_date), status: String(j.status || ''), stage: STAGE_LABEL[j.current_stage] || String(j.current_stage || '').replace(/_/g, ' '),
    stages: st, photos: cvPhotoIds_(j).length,
    price: price, total: price, paid: paid, balance: price == null ? null : Math.max(0, price - paid),
    payments: pays, payments_recorded: d.hasPayments };
}

/* ---------- specs: ALLOWLIST. Only these JobOrders columns ever reach a customer; any new column stays internal. ---------- */
var CV_SPECS = [['metal', 'Metal'], ['karat', 'Karat'], ['color', 'Color'], ['finish', 'Finish'], ['size', 'Size'],
  ['stone_type', 'Stone'], ['stone_qty', 'Stones (pcs)'], ['stone_size', 'Carat / size'], ['grade', 'Grade'], ['weight_g', 'Weight (g)']];
function cvS_(v) { return v instanceof Date ? fmtDate_(v) : String(v == null ? '' : v).trim().slice(0, 120); }
function cvSpecs_(j) { return CV_SPECS.filter(function (f) { return cvS_(j[f[0]]) !== ''; }).map(function (f) { return { label: f[1], value: cvS_(j[f[0]]) }; }); }
function cvItemType_(k) {
  k = cvS_(k); if (!k) return '';
  try { if (typeof jobItemTypes_ === 'function') { var t = jobItemTypes_().filter(function (x) { return x[0] === k; })[0]; if (t) return String(t[1]); } } catch (e) {}
  return k.replace(/_/g, ' ');
}

/* ---------- photos: piece photos only, never JO card scans ---------- */
function cvScanIds_() { var o = {}; readOpt_('OcrLog').forEach(function (r) { if (r.file_id) o[String(r.file_id)] = true; }); return o; }
function cvPhotoIds_(j) { // server-side only; ids never leave the server
  var jo = cvKey_(j.jo), c = CacheService.getScriptCache(), hit = c.get('cvph_' + jo);
  if (hit) return JSON.parse(hit);
  var scans = cvScanIds_(), out = [], scanName = new RegExp('^' + jo + '-p\\d+', 'i');
  var ok = function (f) { var id = f.getId(); return !scans[id] && !scanName.test(f.getName()) && /^image\//.test(f.getMimeType()) && out.indexOf(id) < 0; };
  try {
    if (j.product_photo_file_id) {
      var f = DriveApp.getFileById(String(j.product_photo_file_id)), ps = f.getParents(), inScans = false;
      while (ps.hasNext()) { var pn = ps.next().getName(); if (pn === 'scans' || cvKey_(pn) === jo) inScans = true; } // a file in the JO folder itself or scans/ is a card
      if (!inScans && ok(f)) out.push(f.getId());
    }
  } catch (e) {}
  try {
    var folder = j.drive_folder_id ? DriveApp.getFolderById(String(j.drive_folder_id)) : null;
    if (folder) CV.PHOTO_FOLDERS.forEach(function (name) {
      var it = folder.getFoldersByName(name);
      while (it.hasNext()) { var files = it.next().getFiles(); while (files.hasNext()) { var x = files.next(); if (!x.isTrashed() && ok(x)) out.push(x.getId()); } }
    });
  } catch (e) {}
  c.put('cvph_' + jo, JSON.stringify(out), 600);
  return out;
}
function cvPhoto_(jo, n) {
  var j = readOpt_('JobOrders').filter(function (x) { return cvKey_(x.jo) === jo && x.status !== 'cancelled'; })[0];
  var id = j ? cvPhotoIds_(j)[Number(n || 0)] : null;
  if (!id || cvScanIds_()[id]) return { ok: true, src: '' };
  try { return { ok: true, src: thumb_(id) }; } catch (e) { return { ok: true, src: '' }; }
}

/* ---------- Track my order: JO number + the mobile or email on that order (no account needed) ---------- */
function cvTrack_(req, photo) {
  custInit_();
  var jo = cvKey_(req.jo), raw = String(req.contact || '').trim(), dev = String(req.device_id || 'none').slice(0, 64), c0 = CacheService.getScriptCache();
  var email = /@/.test(raw) ? normEmail_(raw) : '', mob = email ? '' : normMobile_(raw).slice(-10);
  if (!jo) return { ok: false, error: 'Type the JO number, like 26-001' };
  if (!email && mob.length < 10) return { ok: false, error: 'Type the mobile number or email on the order' };
  if (c0.get('tdlock_' + dev) || c0.get('tjlock_' + jo)) return { ok: false, error: 'Too many tries. Please wait 15 minutes.', code: 'RATE' };
  var d = cvData_(), j = d.jobs.filter(function (x) { return cvKey_(x.jo) === jo && x.status !== 'cancelled'; })[0];
  var same = function (e, p) { return email ? !!e && normEmail_(e) === email : !!p && normMobile_(p).slice(-10) === mob; };
  var good = false;
  if (j) {
    good = readOpt_('Clients').some(function (k) { return String(j.client_id) !== '' && String(k.client_id) === String(j.client_id) && same(k.email, k.phone); });
    if (!good) { // a portal account linked to this JO also counts
      var ids = readOpt_('CustomerLinks').filter(function (l) { return cvKey_(l.jo) === jo && !l.unlinked_at; }).map(function (l) { return l.customer_id; });
      good = readOpt_('Customers').some(function (c) { return ids.indexOf(c.customer_id) >= 0 && c.status !== 'off' && same(c.email, String(c.mobile_norm).replace(/^'/, '')); });
    }
  }
  if (!good) {
    if (hit_('tdf_' + dev, CV.LOCK_MIN) >= CV.DEVICE_FAILS) { cachePut_('tdlock_' + dev, 1, CV.LOCK_MIN); c0.remove('tdf_' + dev); }
    if (hit_('tjf_' + jo, CV.LOCK_MIN) >= CV.JO_FAILS) { cachePut_('tjlock_' + jo, 1, CV.LOCK_MIN); c0.remove('tjf_' + jo); }
    audit_('public', 'track_failed', jo, dev, '');
    return { ok: false, error: CV_NOT_FOUND, code: 'NOT_FOUND' };
  }
  if (photo) return cvPhoto_(jo, req.n);
  audit_('public', 'track', jo, dev, '');
  return { ok: true, safe_photos: true, job: cvView_(j, d) };
}

/** Optional check: select cvSelfTest and click Run. Logs what a customer would get for one JO (change the JO below). */
function cvSelfTest() {
  var jo = '26-001', j = readOpt_('JobOrders').filter(function (x) { return cvKey_(x.jo) === jo; })[0];
  if (!j) return Logger.log('No JO ' + jo);
  var v = cvView_(j, cvData_()), scans = cvScanIds_(), leak = cvPhotoIds_(j).filter(function (id) { return scans[id]; });
  Logger.log(JSON.stringify(v, null, 1)); Logger.log(leak.length ? 'PROBLEM: card scan in customer photos' : 'OK: no JO card scans in customer photos');
}
