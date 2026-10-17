/**
 * OYP scan -> Sheet sync. Every card page the scanner uploads also lands in the Sheet the dashboard and
 * customer portal read (the SHEET_ID spreadsheet from Auth.gs), so paper JOs show up online.
 * Paste as a new SCRIPT file "JobSync" in the same Apps Script project as Code.gs + Auth.gs.
 *
 * Hook (Code.gs doPost, on its own line right after `var found = findJOs_(ocrText);`):
 *   var job = typeof recordScan_ === 'function' ? recordScan_(req, jo, file, folder, ocrText, found, ocrError) : null; // JobSync.gs
 *
 * Per scanned page:
 *   - OcrLog: one new row (the OCR text is kept, review_state=draft). An earlier DRAFT row for the same JO+page IN THE SAME SCAN SET
 *     (same session: same date tag + letter in the file name, e.g. 26-001-p1-101726b.jpg) is marked "replaced". Other sets are kept as history.
 *   - JobOrders: first scan of a JO adds a row (status=draft, review_state=draft, stage intake). A re-scan never adds a second row
 *     and never changes a filled-in cell; it only fills blanks. Changing a filled cell needs overwrite:true in the request.
 *     status, current_stage, review_state, due_date, description etc. are never touched by a re-scan.
 *   - JobStages: the first stage (intake, or receive_inspect for repairs) is added once, only if the JO has no stages yet.
 *   - Clients: only when the request carries client_name / client_phone (the scanner doesn't send them yet).
 *     Matches an existing client by phone, then by name/alias; adds one only if nothing matches; never links when 2+ match.
 * Never deletes, never edits rows it didn't create apart from filling blanks, never throws: a Sheet problem can't fail an upload.
 * One-time: run setupJobs() to ADD the tabs JobOrders, JobStages, Clients, OcrLog (existing tabs are left as they are;
 *   the only exception: a JobOrders tab made by an older version gets the newer header cells (location, item_type, …) added at the far right).
 * Optional: run importExistingScans() (repeat until it says done) to bring cards scanned BEFORE this update into the Sheet.
 *
 * Back office "To review" (staff app #/review), admin + production_manager only. Hook (Auth.gs handleAction_, after the dashboard line):
 *   if (typeof isJobAction_ === 'function' && isJobAction_(a)) return handleJob_(req, s.user); // JobSync.gs
 */
var JOB_TABS = {
  JobOrders: ['jo', 'type', 'parent_jo', 'root_jo', 'status', 'location', 'current_stage', 'item_id', 'client_id', 'description', 'metal', 'karat',
    'size', 'item_type', 'stone_type', 'stone_size', 'grade', 'material', 'weight_g', 'due_date', 'rate_snapshot_id', 'product_photo_file_id', 'drive_folder_id', 'review_state',
    'created_at', 'created_by', 'updated_at', 'updated_by'],
  JobStages: ['stage_id', 'jo', 'seq', 'stage_code', 'status', 'started_at', 'ended_at', 'assignee', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  Clients: ['client_id', 'name', 'aliases', 'phone', 'email', 'billing_info', 'notes', 'portal_code', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  OcrLog: ['scan_id', 'jo', 'page', 'file_id', 'ocr_text', 'jo_found', 'match', 'ocr_error', 'parsed_json', 'review_state',
    'reviewed_by', 'reviewed_at', 'created_at', 'created_by', 'file_name', 'scan_set', 'jo_version']
};
var JOB_SCAN_FIELDS = ['type', 'parent_jo', 'root_jo', 'client_id', 'drive_folder_id']; // the only JobOrders cells a scan may fill
var JOB_ADD_COLS = { JobOrders: ['location', 'item_type', 'stone_type', 'stone_size', 'grade', 'material', 'weight_g'], OcrLog: ['file_name', 'scan_set', 'jo_version'] }; // new columns setupJobs may add (header only) to a tab made before this version
var JOB_OCR_MAX = 45000; // a Sheet cell holds 50,000 characters

/** ONE-TIME SETUP: select setupJobs and click Run. Adds missing tabs only; never changes a tab that exists. */
function setupJobs() {
  var ss = ss_(), added = [], kept = [];
  Object.keys(JOB_TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) {
      var h = jobHeader_(sh), extra = JOB_ADD_COLS[name] ? JOB_ADD_COLS[name].filter(function (k) { return h.indexOf(k) < 0; }) : [];
      if (h.length && extra.length) { sh.getRange(1, h.length + 1, 1, extra.length).setValues([extra]); } // header cells only, at the far right
      var miss = jobMissingCols_(sh, name);
      kept.push(name + (extra.length ? ' (added column: ' + extra.join(', ') + ')' : '') + (miss.length ? ' (no column: ' + miss.join(', ') + ')' : '')); return;
    }
    sh = ss.insertSheet(name); sh.getRange(1, 1, 1, JOB_TABS[name].length).setValues([JOB_TABS[name]]); sh.setFrozenRows(1); added.push(name);
  });
  audit_('setup', 'setupJobs', '', '', 'added ' + (added.join(', ') || 'none') + '; kept ' + (kept.join(', ') || 'none'));
  Logger.log('Sheet: ' + ss.getUrl() + '\nAdded tabs: ' + (added.join(', ') || 'none') + '\nAlready there (left as is): ' + (kept.join(', ') || 'none'));
  return { added: added, kept: kept };
}

/** Called from Code.gs doPost after the page is saved + OCR'd. Returns a small summary; never throws. */
function recordScan_(req, jo, file, folder, ocrText, found, ocrError) {
  try {
    return withLock_(function () {
      var key = jobKey_(req.jo) || jobKey_(jo), ver = jobVersion_(req.jo), by = 'scanner', t = now_(), out = { ok: true, jo: key, created: false, filled: [], kept: [] };
      if (!key) return { ok: false, error: 'no JO number' };
      if (!jobTabsReady_()) return { ok: false, error: 'run setupJobs first' };
      var page = Number(req.page) || 1, fileId = file && file.getId ? file.getId() : '', folderId = folder && folder.getId ? folder.getId() : '';
      var parsed = jobParse_(ocrText), fileName = String((file && file.getName ? file.getName() : '') || req.filename || ''), set = jobScanSet_(fileName);
      var hasSet = jobHeader_(ss_().getSheetByName('OcrLog')).indexOf('scan_set') >= 0; // after setupJobs adds the column (else: the old rule)
      ver = jobVersion_(fileName.replace(/-p\d+.*$/, '')) || ver; // 26-287B-p1-101726.jpg -> B

      // 1. OcrLog (always a new row; older drafts of the same page IN THE SAME SET become "replaced"; earlier sets stay as history)
      jobRows_('OcrLog').forEach(function (r) {
        if (jobKey_(r.jo) === key && Number(r.page) === page && r.review_state === 'draft' && (!hasSet || (String(r.scan_set || '') === set && jobRowVersion_(r) === ver))) jobSet_('OcrLog', r._row, { review_state: 'replaced' });
      });
      out.scan_id = 'scan-' + randHex_(8);
      jobAppend_('OcrLog', { scan_id: out.scan_id, jo: key, jo_version: ver, page: page, file_id: fileId, ocr_text: String(ocrText || '').slice(0, JOB_OCR_MAX),
        jo_found: (found || []).join(', '), match: (found || []).indexOf(key) >= 0, ocr_error: ocrError || '', parsed_json: JSON.stringify(parsed),
        review_state: 'draft', created_at: t, created_by: by, file_name: fileName, scan_set: set });

      // 2. Client (only if the scanner sent one)
      var client = jobClient_(req, by, t); if (client.note) out.client_note = client.note;

      // 3. JobOrders: add once, then fill blanks only
      // a letter (26-287B) is a newer version of the SAME JO: one JobOrders row per JO number, never a separate "revision" JO
      var type = req.type === 'repair' || req.type === 'new' ? req.type : '';
      var want = { type: type, parent_jo: '', root_jo: '', client_id: client.id || '', drive_folder_id: folderId };
      var row = jobRows_('JobOrders').filter(function (r) { return jobKey_(r.jo) === key; });
      if (row.length > 1) out.warning = row.length + ' JobOrders rows for ' + key + '; only the first is used';
      if (!row.length) {
        jobAppend_('JobOrders', { jo: key, type: type, parent_jo: want.parent_jo, root_jo: want.root_jo, status: 'draft', location: '',
          current_stage: type === 'repair' ? 'receive_inspect' : 'intake', client_id: want.client_id, drive_folder_id: want.drive_folder_id,
          review_state: 'draft', created_at: t, created_by: by, updated_at: t, updated_by: by });
        out.created = true;
        audit_(by, 'jobFromScan', key, req.device_id, 'new draft JO from scan p' + page);
      } else {
        var r0 = row[0], set = {}, changes = [];
        JOB_SCAN_FIELDS.forEach(function (k) {
          var have = String(r0[k] === undefined ? '' : r0[k]).trim(), nv = String(want[k] || '').trim();
          if (!nv || have === nv || r0[k] === undefined) return;
          if (!have) { set[k] = nv; out.filled.push(k); }
          else if (req.overwrite === true) { set[k] = nv; changes.push(k + ': ' + have + ' -> ' + nv); }
          else out.kept.push(k);
        });
        if (Object.keys(set).length) {
          set.updated_at = t; set.updated_by = by; jobSet_('JobOrders', r0._row, set);
          audit_(by, changes.length ? 'jobOverwriteFromScan' : 'jobFillFromScan', key, req.device_id, changes.length ? changes.join('; ') : 'filled ' + out.filled.join(', '));
          if (changes.length) out.overwritten = changes;
        }
      }

      // 4. First stage, once
      if (!jobRows_('JobStages').some(function (s) { return jobKey_(s.jo) === key; })) {
        var cur = row.length ? String(row[0].current_stage || '') : '';
        jobAppend_('JobStages', { stage_id: 'st-' + randHex_(8), jo: key, seq: 1, stage_code: cur || (type === 'repair' ? 'receive_inspect' : 'intake'),
          status: 'doing', started_at: t, created_at: t, created_by: by, updated_at: t, updated_by: by });
        out.stage_added = true;
      }
      return out;
    });
  } catch (e) {
    try { audit_('scanner', 'jobSyncError', String(jo || ''), '', String(e).slice(0, 300)); } catch (e2) {}
    return { ok: false, error: String(e) };
  }
}

/* ---------- helpers (header-based, so a tab with columns in another order still works) ---------- */
/* JO numbers. A letter after the number is a newer VERSION of the same JO (26-287A, then 26-287B; B is the latest):
 * jobKey_ gives the JO itself ('26-287B' -> '26-287'), jobVersion_ the letter ('B'; '' for the original). */
function jobKey_(s) { // same rules as the scanner: '26-001', 'JO 26-005b' -> '26-005'
  var m = String(s || '').toUpperCase().match(/(\d{2})\s*[-,.\/ ]?\s*(\d{3,4})(?:\s?([A-Z])(?![A-Z0-9]))?/);
  return m ? m[1] + '-' + m[2] : '';
}
function jobVersion_(s) { var m = String(s || '').toUpperCase().match(/(\d{2})\s*[-,.\/ ]?\s*(\d{3,4})(?:\s?([A-Z])(?![A-Z0-9]))?/); return m && m[3] ? m[3] : ''; }
function jobRowVersion_(r) { return String(r.jo_version || '').toUpperCase() || jobVersion_(r.jo) || jobVersion_(String(r.file_name || '').replace(/-p\d+.*$/, '')); }
/** JobOrders rows of one JO (26-287, 26-287A, 26-287B) shown as ONE row, read-only: the latest version's row (highest letter)
 *  with blanks filled from the others; jo = the JO number, version = latest letter, versions = all of them. Writes go to that row (_row). */
function jobMergeVersions_(rows) {
  var groups = {}, order = [], out = [];
  rows.forEach(function (r) { var k = jobKey_(r.jo); if (!k) { out.push({ r: r }); return; } if (!groups[k]) { groups[k] = []; order.push(k); out.push({ k: k }); } groups[k].push(r); });
  return out.map(function (x) {
    if (!x.k) return x.r;
    var g = groups[x.k].slice().sort(function (a, b) { return jobVersion_(b.jo) < jobVersion_(a.jo) ? -1 : jobVersion_(b.jo) > jobVersion_(a.jo) ? 1 : 0; });
    if (g.length === 1 && !jobVersion_(g[0].jo)) return g[0];
    var m = {}; Object.keys(g[0]).forEach(function (k) { m[k] = g[0][k]; });
    g.slice(1).forEach(function (r) { Object.keys(r).forEach(function (k) { if (k !== '_row' && (m[k] === '' || m[k] == null) && r[k] !== '' && r[k] != null) m[k] = r[k]; }); });
    m.jo = x.k; m.version = jobVersion_(g[0].jo); m.versions = g.map(function (r) { return jobVersion_(r.jo); }); m._rows = g.map(function (r) { return r._row; });
    if (jobKey_(m.parent_jo) === x.k) { m.parent_jo = ''; if (m.type === 'revision') m.type = ''; } // "revision of itself" from the old rule
    if (jobKey_(m.root_jo) === x.k) m.root_jo = '';
    return m;
  });
}
function jobTabsReady_() { var ss = ss_(); return ['JobOrders', 'JobStages', 'OcrLog'].every(function (n) { return !!ss.getSheetByName(n); }); }
function jobHeader_(sh) { return sh.getLastRow() ? sh.getDataRange().getValues()[0].map(function (x) { return String(x).trim(); }) : []; }
function jobMissingCols_(sh, name) { var h = jobHeader_(sh); return JOB_TABS[name].filter(function (k) { return h.indexOf(k) < 0 && /^(jo|client_id|status|stage_code|scan_id|name)$/.test(k); }); }
function jobRows_(name) {
  var sh = ss_().getSheetByName(name); if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues(), h = v[0].map(function (x) { return String(x).trim(); }), out = [];
  for (var i = 1; i < v.length; i++) { var o = { _row: i + 1 }; for (var j = 0; j < h.length; j++) if (h[j]) o[h[j]] = v[i][j]; out.push(o); }
  return name === 'JobOrders' ? jobMergeVersions_(out) : out;
}
function jobAppend_(name, obj) {
  var sh = ss_().getSheetByName(name), h = jobHeader_(sh);
  sh.appendRow(h.map(function (k) { return obj[k] === undefined ? '' : obj[k]; }));
}
function jobSet_(name, row, obj) { // only the named cells of one row
  var sh = ss_().getSheetByName(name), h = jobHeader_(sh);
  Object.keys(obj).forEach(function (k) { var c = h.indexOf(k); if (c >= 0) sh.getRange(row, c + 1).setValue(obj[k]); });
}
function jobPhone_(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
function jobName_(n) { return String(n || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function jobClient_(req, by, t) {
  var name = String(req.client_name || '').trim().replace(/\s+/g, ' ').slice(0, 80), phone = String(req.client_phone || '').trim().slice(0, 30);
  if (!name && !phone) return {};
  if (!ss_().getSheetByName('Clients')) return { note: 'no Clients tab' };
  var all = jobRows_('Clients'), ph = jobPhone_(phone), nm = jobName_(name);
  var hit = ph.length >= 7 ? all.filter(function (c) { return jobPhone_(c.phone) === ph; }) : [];
  if (!hit.length && nm) hit = all.filter(function (c) {
    return jobName_(c.name) === nm || String(c.aliases || '').split(',').some(function (a) { return jobName_(a) === nm; });
  });
  if (hit.length === 1) return { id: String(hit[0].client_id) };
  if (hit.length > 1) return { note: hit.length + ' clients match; not linked' };
  if (!name) return { note: 'phone only, no match; not added' };
  var id = 'c-' + randHex_(8);
  jobAppend_('Clients', { client_id: id, name: name, phone: phone, notes: 'added from card scan', created_at: t, created_by: by, updated_at: t, updated_by: by });
  return { id: id, added: true };
}
/** Best-effort hints from OCR (printed labels only; handwriting is unreliable). Stored in OcrLog.parsed_json, never in JobOrders. */
function jobParse_(text) {
  var t = String(text || ''), u = t.toUpperCase(), p = {};
  var due = u.match(/DATE\s*DUE\s*[:\-]?\s*([^\n]{1,24})/); if (due) p.due_text = due[1].trim();
  var given = u.match(/DATE\s*GIVEN\s*[:\-]?\s*([^\n]{1,24})/); if (given) p.given_text = given[1].trim();
  if (/\bREPAIR\b/.test(u) && !/\bNEW\s*JOB\b/.test(u)) p.type_hint = 'repair';
  var k = u.match(/KARAT\s*(?:GOLD)?\s*[:\-]?\s*(\d{1,2}\s*K|AG|925|SILVER)/); if (k) p.karat_text = k[1].replace(/\s+/g, '');
  return p;
}

/* ======================= back office: To review ======================= */
var JOB_LOCATIONS = [['vault', 'In vault'], ['showroom', 'Showroom'], ['consigned', 'Consigned'], ['working', 'Being worked on'],
  ['queue', 'In queue'], ['pickup', 'For pickup'], ['sold', 'Sold'], ['archived', 'Archived']];
var JOB_LOC_STATUS = { working: 'active', queue: 'active', pickup: 'done', vault: 'done', showroom: 'done', consigned: 'done', sold: 'picked_up', archived: 'done' };
// Archived = the JO is on record but there is no physical piece. It stays searchable, never counts as stock and never shows on the job board.
var JOB_NOT_ON_HAND = { sold: true, archived: true };
function jobOnHand_(j) { var l = String(j.location || ''); return !!l && !JOB_NOT_ON_HAND[l]; }
// What the piece is. Each kind lists the extra fields that apply to it (flagged when empty). To add a kind, add a line here,
// or list extra labels in the Settings tab: key item_types_extra, value e.g. "Watch, Coin" (those show description only).
var JOB_ITEM_TYPES = [
  ['jewelry', 'Jewelry', ['metal', 'karat']],
  ['loose_stone', 'Loose stone', ['stone_type', 'stone_size', 'grade']],
  ['pearl', 'Pearl', ['stone_type', 'stone_size', 'grade']],
  ['raw_material', 'Raw material', ['material', 'weight_g']],
  ['other', 'Other', []]
];
var JOB_EDIT = ['location', 'item_type', 'type', 'due_date', 'metal', 'karat', 'size', 'stone_type', 'stone_size', 'grade', 'material', 'weight_g',
  'description', 'status', 'client_id'];
var JOB_NEEDED = ['location', 'item_type', 'client', 'due_date', 'type', 'description']; // always flagged when empty; plus the item type's own fields
var JOB_STATUSES = ['draft', 'active', 'done', 'picked_up', 'cancelled'];
var JOB_ROLES = { admin: true, production_manager: true }; // everyone else: no access to these actions

function isJobAction_(a) { return /^job[A-Z]/.test(String(a || '')); }
function handleJob_(req, user) {
  jobItemTypesCache_ = null; // re-read Settings once per request
  var acts = { jobReviewList: jobReviewList_, jobPhoto: jobPhoto_, jobClientSearch: jobClientSearch_, jobReviewSave: jobReviewSave_, jobBulkLocation: jobBulkLocation_, jobSearch: jobSearch_ };
  if (!acts[req.action]) return { ok: false, error: 'Unknown action' };
  if (!JOB_ROLES[user.role]) { audit_(user.username, 'denied', req.action, req.device_id, 'role ' + user.role); return { ok: false, error: 'Not allowed', code: 'FORBIDDEN' }; }
  if (!jobTabsReady_()) return { ok: false, error: 'The Sheet is not set up for scans yet (run setupJobs).', code: 'NO_TABS' };
  var write = req.action === 'jobReviewSave' || req.action === 'jobBulkLocation';
  if (write && !isExec_(user) && req.set && PRICING.EXEC_ONLY.some(function (k) { return k in req.set; })) {
    audit_(user.username, 'denied', req.action, req.device_id, 'pricing field from role ' + user.role); return { ok: false, error: 'Prices and margins are for executives only', code: 'FORBIDDEN' };
  }
  var res = write ? withLock_(function () { return acts[req.action](req, user); }) : acts[req.action](req, user);
  return stripPricing_(res, user);
}
function jobStr_(v) { return v instanceof Date ? jobDay_(v) : String(v == null ? '' : v).trim(); }
function jobDay_(d) {
  if (d === '' || d == null) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim())) return d.trim();
  var x = d instanceof Date ? d : new Date(d); if (isNaN(x.getTime())) return String(d);
  return new Date(x.getTime() + 8 * 36e5).toISOString().slice(0, 10); // Asia/Manila
}
function jobClientsById_() { var m = {}; jobRows_('Clients').forEach(function (c) { m[String(c.client_id)] = c; }); return m; }
function jobPublicClient_(c, user) {
  if (!c) return null; var o = { client_id: String(c.client_id), name: String(c.name || '') };
  if (user.role === 'admin') o.phone = String(c.phone || ''); // PM sees client names only (spec §10)
  return o;
}
function jobView_(j, pages, clients, user) {
  var o = { jo: jobKey_(j.jo) }, cl = clients[String(j.client_id || '')];
  ['type', 'parent_jo', 'status', 'location', 'current_stage', 'description', 'metal', 'karat', 'size', 'item_type', 'stone_type', 'stone_size', 'grade',
    'material', 'weight_g', 'review_state', 'client_id'].forEach(function (k) { o[k] = jobStr_(j[k]); });
  o.due_date = jobDay_(j.due_date); o.client = jobPublicClient_(cl, user); o.pages = pages || []; o.pages_set = (pages && pages.set) || ''; o.pages_version = (pages && pages.version) || ''; o.version = String(j.version || ''); o.versions = j.versions || []; o.pages_date = (pages && pages.date) || ''; o.history = (pages && pages.history) || []; o.scanned_at = jobStr_(j.created_at);
  o.archived = o.location === 'archived'; o.on_hand = jobOnHand_(j);
  var it = jobItemTypes_().filter(function (t) { return t[0] === o.item_type; })[0];
  o.missing = JOB_NEEDED.concat(it ? it[2] : []).filter(function (k) { return k === 'client' ? !o.client : !o[k]; });
  return o;
}
var jobItemTypesCache_ = null;
function jobItemTypes_() { // built-in kinds + Settings item_types_extra (description only)
  if (jobItemTypesCache_) return jobItemTypesCache_;
  var out = JOB_ITEM_TYPES.slice(), have = {}; out.forEach(function (t) { have[t[0]] = true; });
  try {
    var sh = ss_().getSheetByName('Settings');
    if (sh) jobRows_('Settings').forEach(function (r) {
      if (String(r.key) !== 'item_types_extra') return;
      String(r.value || '').split(',').forEach(function (lab) {
        lab = lab.trim().replace(/\s+/g, ' ').slice(0, 30); var code = lab.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (code && !have[code]) { have[code] = true; out.splice(out.length - 1, 0, [code, lab, []]); }
      });
    });
  } catch (e) {}
  return (jobItemTypesCache_ = out);
}
/** Scan set of a file name: '26-001-p1-101726b.jpg' -> '101726b'; an older name without a date tag ('26-001-p1.jpg') -> '' (legacy, oldest). */
/** Scanner swipe-delete (Code.gs deletePage_): the OcrLog rows of trashed page files become review_state "deleted" (hidden everywhere). */
function markScanDeleted_(jo, fileIds) {
  if (!jobTabsReady_()) return 0;
  var key = jobKey_(jo), want = {}, n = 0; (fileIds || []).forEach(function (id) { want[String(id)] = true; });
  return withLock_(function () {
    jobRows_('OcrLog').forEach(function (r) {
      if (jobKey_(r.jo) === key && want[String(r.file_id)] && r.review_state !== 'deleted') { jobSet_('OcrLog', r._row, { review_state: 'deleted' }); n++; }
    });
    audit_('scanner', 'scanDeleted', key, '', n + ' page(s) moved to Drive Trash: ' + Object.keys(want).join(', '));
    return n;
  });
}
function jobScanSet_(name) { var m = String(name || '').match(/-p\d+-(\d{6}[a-z]?)\.jpe?g$/i); return m ? m[1].toLowerCase() : ''; }
function jobSetSort_(set) { return set ? '1' + set.slice(4, 6) + set.slice(0, 4) + (set.slice(6) || ' ') : '0'; } // MMDDYY[x] -> YYMMDD order; legacy first
function jobSetDay_(set) { return set ? '20' + set.slice(4, 6) + '-' + set.slice(0, 2) + '-' + set.slice(2, 4) : ''; }
/** jo -> pages of the LATEST scan set (array, as before) with .history = older sets, newest first:
 *  [{ set: '101726', version: 'B', date: '2026-10-17', n: 2, pages: [{ page, file_id, scan_id, version }] }].
 *  Order: highest version letter first (26-287B > 26-287A > 26-287), then newest date tag; untagged older files last within their version. */
function jobPages_() {
  var sets = {}, firstAt = {};
  jobRows_('OcrLog').forEach(function (r) {
    if (r.review_state === 'replaced' || r.review_state === 'discarded' || r.review_state === 'deleted' || !r.file_id) return;
    var k = jobKey_(r.jo), v = jobRowVersion_(r), st = v + '|' + (String(r.scan_set || '') || jobScanSet_(r.file_name)), pg = Number(r.page) || 1;
    sets[k] = sets[k] || {}; sets[k][st] = sets[k][st] || {};
    sets[k][st][pg] = { page: pg, file_id: String(r.file_id), scan_id: String(r.scan_id), version: v };
    var fk = k + '|' + st; if (!firstAt[fk] && r.created_at) firstAt[fk] = r.created_at;
  });
  var out = {};
  Object.keys(sets).forEach(function (k) {
    var sk = function (st) { var i = st.indexOf('|'); return (st.slice(0, i) || ' ') + jobSetSort_(st.slice(i + 1)); }; // ' ' sorts below 'A'
    var L = Object.keys(sets[k]).sort(function (a, b) { var x = sk(a), y = sk(b); return x < y ? 1 : x > y ? -1 : 0; }).map(function (st) {
      var i = st.indexOf('|'), set = st.slice(i + 1), ver = st.slice(0, i);
      var pgs = Object.keys(sets[k][st]).map(Number).sort(function (a, b) { return a - b; }).map(function (p) { return sets[k][st][p]; });
      return { set: set, version: ver, date: set ? jobSetDay_(set) : jobDay_(firstAt[k + '|' + st] || ''), n: pgs.length, pages: pgs };
    });
    var latest = L[0].pages.slice(); latest.set = L[0].set; latest.version = L[0].version; latest.date = L[0].date; latest.history = L.slice(1);
    out[k] = latest;
  });
  return out;
}
/** Draft JOs from scans (review_state draft, not cancelled), oldest JO number first. */
function jobReviewList_(req, user) {
  var pages = jobPages_(), clients = jobClientsById_();
  var jobs = jobRows_('JobOrders').filter(function (j) { return jobKey_(j.jo) && j.review_state === 'draft' && j.status !== 'cancelled'; })
    .map(function (j) { return jobView_(j, pages[jobKey_(j.jo)], clients, user); })
    .sort(function (a, b) { return a.jo < b.jo ? -1 : a.jo > b.jo ? 1 : 0; });
  return { ok: true, jobs: jobs, locations: JOB_LOCATIONS, item_types: jobItemTypes_(), can_see_phone: user.role === 'admin' };
}
/** Search every JO (reviewed or not, archived included) by JO number, description or client name. Up to 50, JO order. */
function jobSearch_(req, user) {
  var q = String(req.q || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (q.length < 2) return { ok: true, q: q, jobs: [] };
  var clients = jobClientsById_(), joQ = jobKey_(q);
  var hits = jobRows_('JobOrders').filter(function (j) {
    if (!jobKey_(j.jo) || j.status === 'cancelled') return false;
    var cl = clients[String(j.client_id || '')];
    return jobKey_(j.jo).indexOf(joQ || q) === 0 || jobKey_(j.jo).indexOf(q) >= 0 || String(j.description || '').toUpperCase().indexOf(q) >= 0
      || (cl && (String(cl.name || '') + ' ' + String(cl.aliases || '')).toUpperCase().indexOf(q) >= 0);
  }).map(function (j) {
    var o = jobView_(j, null, clients, user);
    return { jo: o.jo, description: o.description, location: o.location, archived: o.archived, on_hand: o.on_hand, status: o.status,
      review_state: o.review_state, item_type: o.item_type, client: o.client ? { name: o.client.name } : null, parent_jo: o.parent_jo };
  }).sort(function (a, b) { return a.jo < b.jo ? -1 : a.jo > b.jo ? 1 : 0; });
  return { ok: true, q: q, total: hits.length, jobs: hits.slice(0, 50), locations: JOB_LOCATIONS };
}
/** A card photo as a data URL, only for a file that OcrLog ties to that JO (Drive files stay private). */
function jobPhoto_(req, user) {
  var key = jobKey_(req.jo), id = String(req.file_id || '');
  var mine = jobRows_('OcrLog').some(function (r) { return jobKey_(r.jo) === key && String(r.file_id) === id && r.review_state !== 'discarded' && r.review_state !== 'deleted'; });
  if (!key || !id || !mine) { audit_(user.username, 'denied', 'jobPhoto', req.device_id, key + ' ' + id); return { ok: false, error: 'Not allowed', code: 'FORBIDDEN' }; }
  try {
    var f = DriveApp.getFileById(id), b = req.size === 'full' ? f.getBlob() : (f.getThumbnail() || f.getBlob());
    if (b.getBytes().length > 6e6) return { ok: false, error: 'Photo too large to show' };
    return { ok: true, src: 'data:' + (b.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(b.getBytes()) };
  } catch (e) { return { ok: true, src: '', error: 'Photo not found in Drive' }; }
}
function jobClientSearch_(req, user) {
  var q = jobName_(req.q), ph = jobPhone_(req.q);
  if (q.length < 2) return { ok: true, clients: [] };
  var hits = jobRows_('Clients').filter(function (c) {
    return jobName_(c.name).indexOf(q) >= 0 || jobName_(c.aliases).indexOf(q) >= 0 || (user.role === 'admin' && ph.length >= 4 && jobPhone_(c.phone).indexOf(ph) >= 0);
  }).slice(0, 12);
  return { ok: true, clients: hits.map(function (c) { return jobPublicClient_(c, user); }) };
}
function jobClean_(k, v) {
  v = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  if (k === 'location' && v && !JOB_LOCATIONS.some(function (l) { return l[0] === v; })) throw new Error('Unknown location');
  if (k === 'type' && v && ['new', 'repair', 'revision'].indexOf(v) < 0) throw new Error('Unknown type');
  if (k === 'item_type' && v && !jobItemTypes_().some(function (t) { return t[0] === v; })) throw new Error('Unknown item type');
  if (k === 'weight_g' && v && !/^\d+(\.\d+)?$/.test(v.replace(/\s*g$/i, ''))) throw new Error('Weight must be grams, e.g. 12.5');
  if (k === 'weight_g') v = v.replace(/\s*g$/i, '');
  if (k === 'status' && v && JOB_STATUSES.indexOf(v) < 0) throw new Error('Unknown status');
  if (k === 'due_date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Due date must look like 2026-01-17');
  return v.slice(0, k === 'description' ? 300 : 80);
}
/**
 * Save the review form. set = new values, seen = the values the form showed when it opened.
 * A filled cell is only changed if it still equals what the person saw (never a blind overwrite);
 * otherwise NOTHING is saved and the conflicts are returned with the current values.
 */
function jobReviewSave_(req, user) {
  var key = jobKey_(req.jo), row = jobRows_('JobOrders').filter(function (j) { return jobKey_(j.jo) === key; })[0];
  if (!row) return { ok: false, error: 'No such JO' };
  var set = req.set || {}, seen = req.seen || {}, want = {}, conflicts = [];
  try { Object.keys(set).forEach(function (k) { if (JOB_EDIT.indexOf(k) >= 0) want[k] = jobClean_(k, set[k]); }); }
  catch (e) { return { ok: false, error: e.message }; }
  var t = now_(), by = user.username, nc = req.new_client;
  if (nc && (String(nc.name || '').trim() || String(nc.phone || '').trim())) {
    if (!String(nc.name || '').trim()) return { ok: false, error: 'Type the client name' };
    var c = jobClient_({ client_name: nc.name, client_phone: nc.phone }, by, t);
    if (!c.id) return { ok: false, error: c.note || 'Could not add the client' };
    want.client_id = c.id;
  }
  var changes = {};
  Object.keys(want).forEach(function (k) {
    if (!(k in row)) return; // column not in this Sheet
    var cur = k === 'due_date' ? jobDay_(row[k]) : jobStr_(row[k]), nv = want[k];
    if (nv === cur) return;
    if (cur !== '' && jobStr_(seen[k]) !== cur) { conflicts.push({ field: k, now: cur, yours: nv }); return; }
    changes[k] = nv;
  });
  if (conflicts.length) return { ok: false, code: 'CONFLICT', error: 'Someone changed this JO while you were editing. Check the highlighted fields.', conflicts: conflicts };
  var loc = 'location' in changes ? changes.location : jobStr_(row.location), st = 'status' in changes ? changes.status : jobStr_(row.status);
  if (loc && (st === 'draft' || st === '') && !('status' in want)) changes.status = JOB_LOC_STATUS[loc];
  if (req.mark_reviewed) {
    if (!loc) return { ok: false, error: 'Pick where the piece is (location) before marking it reviewed' };
    if (row.review_state !== 'reviewed') changes.review_state = 'reviewed';
    if (('status' in changes ? changes.status : st) === 'draft') changes.status = JOB_LOC_STATUS[loc];
  }
  var log = Object.keys(changes).map(function (k) { return k + ': ' + (jobStr_(row[k]) || '—') + ' -> ' + (changes[k] || '—'); });
  if (log.length) {
    changes.updated_at = t; changes.updated_by = by; jobSet_('JobOrders', row._row, changes);
    audit_(by, 'jobReview', key, req.device_id, log.join('; ').slice(0, 1000));
  }
  if (changes.review_state === 'reviewed') jobRows_('OcrLog').forEach(function (r) {
    if (jobKey_(r.jo) === key && r.review_state === 'draft') jobSet_('OcrLog', r._row, { review_state: 'saved', reviewed_by: by, reviewed_at: t });
  });
  var fresh = jobRows_('JobOrders').filter(function (j) { return jobKey_(j.jo) === key; })[0];
  return { ok: true, changed: log, job: jobView_(fresh, jobPages_()[key], jobClientsById_(), user) };
}
/** Set one location on many JOs. A JO that already has a different location is left alone unless overwrite:true. */
function jobBulkLocation_(req, user) {
  var loc; try { loc = jobClean_('location', req.location); } catch (e) { return { ok: false, error: e.message }; }
  if (!loc) return { ok: false, error: 'Pick a location' };
  var want = (req.jos || []).map(jobKey_).filter(String); if (!want.length) return { ok: false, error: 'Select at least one JO' };
  if (want.length > 500) return { ok: false, error: 'At most 500 at a time' };
  var rows = {}; jobRows_('JobOrders').forEach(function (j) { var k = jobKey_(j.jo); if (k && !rows[k]) rows[k] = j; });
  var t = now_(), done = [], kept = [], missing = [];
  want.forEach(function (k) {
    var r = rows[k]; if (!r) { missing.push(k); return; }
    var cur = jobStr_(r.location); if (cur === loc) { done.push(k); return; }
    if (cur && req.overwrite !== true) { kept.push({ jo: k, location: cur }); return; }
    var ch = { location: loc, updated_at: t, updated_by: user.username };
    if (jobStr_(r.status) === 'draft' || !jobStr_(r.status)) ch.status = JOB_LOC_STATUS[loc];
    jobSet_('JobOrders', r._row, ch); done.push(k);
  });
  audit_(user.username, 'jobBulkLocation', loc, req.device_id, done.length + ' set' + (kept.length ? ', ' + kept.length + ' kept' : '') + (req.overwrite === true ? ' (overwrite)' : '') + ': ' + done.join(', ').slice(0, 800));
  return { ok: true, set: done, kept: kept, missing: missing };
}

/**
 * OPTIONAL one-time import of cards scanned BEFORE JobSync was installed (Drive "Job Order Cards/<JO>/<JO>-pN.jpg").
 * Adds OcrLog rows (no OCR text) and draft JobOrders rows exactly like a new scan; skips any file already in OcrLog.
 * Stops after ~4.5 minutes; run it again until the log says "done".
 */
function importExistingScans() {
  if (!jobTabsReady_()) throw new Error('Run setupJobs first');
  var start = Date.now(), root = DriveApp.getRootFolder().getFoldersByName(PARENT_FOLDER);
  if (!root.hasNext()) { Logger.log('No "' + PARENT_FOLDER + '" folder in Drive; nothing to import.'); return { done: true, added: 0 }; }
  var logged = {}; jobRows_('OcrLog').forEach(function (r) { logged[String(r.file_id)] = true; });
  var it = root.next().getFolders(), added = 0, seenJos = 0;
  while (it.hasNext()) {
    var f = it.next(), jo = jobKey_(f.getName()); if (!jo) continue; seenJos++;
    var files = f.getFiles();
    while (files.hasNext()) {
      var file = files.next(), name = file.getName(), m = name.match(/-p(\d+)(?:-\d{6}[a-z]?)?\.jpe?g$/i);
      if (logged[file.getId()] || (file.isTrashed && file.isTrashed())) continue;
      if (Date.now() - start > 270000) { Logger.log('Paused after ' + added + ' pages. Run importExistingScans again to continue.'); return { done: false, added: added }; }
      var r = recordScan_({ jo: f.getName(), page: m ? Number(m[1]) : 1, device_id: 'import' }, jo, file, f, '', [], 'imported (no OCR)');
      if (r.ok) { logged[file.getId()] = true; added++; }
    }
  }
  Logger.log('Done: ' + added + ' pages added from ' + seenJos + ' JO folders.');
  return { done: true, added: added };
}

/**
 * OPTIONAL, owner-approved only: move page photos from old version folders ("Job Order Cards/26-287A", ".../26-287B")
 * into the JO's own folder ("Job Order Cards/26-287"). File names are NOT changed (they keep the letter), file ids stay the same,
 * so the Sheet and the back office need nothing else. Nothing is deleted; an emptied version folder is left in place.
 *   mergeSuffixFolders()       DRY RUN (default): only logs what it would move. Changes nothing.
 *   mergeSuffixFoldersApply()  really moves the files (creates the JO folder if it is missing).
 * The back office already shows version folders under their JO without this.
 */
function mergeSuffixFolders(apply) {
  apply = apply === true;
  var root = DriveApp.getRootFolder().getFoldersByName(PARENT_FOLDER), plan = [], made = [];
  if (!root.hasNext()) { Logger.log('No "' + PARENT_FOLDER + '" folder.'); return { apply: apply, moves: [] }; }
  var cards = root.next(), it = cards.getFolders(), vers = [];
  while (it.hasNext()) { var f = it.next(), n = String(f.getName()); if (jobKey_(n) && jobVersion_(n) && /^\s*\d{2}-\d{3,4}\s?[A-Z]\s*$/i.test(n)) vers.push(f); }
  vers.forEach(function (f) {
    var key = jobKey_(f.getName()), dest = cards.getFoldersByName(key), to = dest.hasNext() ? dest.next() : null, files = f.getFiles();
    while (files.hasNext()) {
      var x = files.next(); if (x.isTrashed && x.isTrashed()) continue;
      plan.push(f.getName() + '/' + x.getName() + ' -> ' + key + '/' + x.getName());
      if (apply) { if (!to) { to = cards.createFolder(key); made.push(key); } x.moveTo(to); }
    }
  });
  Logger.log((apply ? 'MOVED ' : 'DRY RUN, would move ') + plan.length + ' file(s) from ' + vers.length + ' version folder(s):\n' + (plan.join('\n') || '(nothing)')
    + (made.length ? '\nCreated JO folders: ' + made.join(', ') : '') + (apply ? '\nThe emptied version folders are left in place.' : '\nTo really move them, run mergeSuffixFoldersApply.'));
  try { if (apply) audit_('setup', 'mergeSuffixFolders', '', '', plan.length + ' file(s) moved'); } catch (e) {}
  return { apply: apply, folders: vers.length, moves: plan, created: made };
}
function mergeSuffixFoldersApply() { return mergeSuffixFolders(true); }

/* ======================= pricing visibility (server-side) ======================= */
/**
 * Executive-only: markups, stone pricing beyond the raw input cost, SRP, "your price", margin, agreed/selling values.
 * The production manager may enter and see material + labor inputs and their raw costs only.
 * Executive roles = Script Property EXEC_ROLES (comma list, e.g. "admin" or "admin,owner"); default "admin".
 * Every response a non-executive gets can be passed through stripPricing_ so a field added later can't leak by accident.
 */
var PRICING = {
  EXEC_ROLES_DEFAULT: ['admin'],
  EXEC_ONLY: ['markup', 'markup_pct', 'premium_pct', 'stone_price', 'stone_markup', 'srp', 'your_price', 'price', 'price_php', 'selling_price',
    'margin', 'margin_pct', 'profit', 'agreed_value', 'value', 'suggested_php_g', 'quote_amount', 'month_sales', 'sales']
};
function execRoles_() {
  var p = ''; try { p = PropertiesService.getScriptProperties().getProperty('EXEC_ROLES') || ''; } catch (e) {}
  var l = p.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return ROLES.indexOf(s) >= 0; });
  return l.length ? l : PRICING.EXEC_ROLES_DEFAULT.slice();
}
function isExec_(user) { return !!user && execRoles_().indexOf(String(user.role)) >= 0; }
/** Deep copy without executive-only keys (for anyone who isn't an executive). */
function stripPricing_(o, user) {
  if (isExec_(user)) return o;
  var bad = {}; PRICING.EXEC_ONLY.forEach(function (k) { bad[k] = true; });
  var walk = function (v) {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) { var r = {}; Object.keys(v).forEach(function (k) { if (!bad[k]) r[k] = walk(v[k]); }); return r; }
    return v;
  };
  return walk(o);
}
