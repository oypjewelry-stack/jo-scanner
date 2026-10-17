/**
 * OYP scan -> Sheet sync. Every card page the scanner uploads also lands in the Sheet the dashboard and
 * customer portal read (the SHEET_ID spreadsheet from Auth.gs), so paper JOs show up online.
 * Paste as a new SCRIPT file "JobSync" in the same Apps Script project as Code.gs + Auth.gs.
 *
 * Hook (Code.gs doPost, on its own line right after `var found = findJOs_(ocrText);`):
 *   var job = typeof recordScan_ === 'function' ? recordScan_(req, jo, file, folder, ocrText, found, ocrError) : null; // JobSync.gs
 *
 * Per scanned page:
 *   - OcrLog: one new row (the OCR text is kept, review_state=draft). An earlier DRAFT row for the same JO+page is marked "replaced".
 *   - JobOrders: first scan of a JO adds a row (status=draft, review_state=draft, stage intake). A re-scan never adds a second row
 *     and never changes a filled-in cell; it only fills blanks. Changing a filled cell needs overwrite:true in the request.
 *     status, current_stage, review_state, due_date, description etc. are never touched by a re-scan.
 *   - JobStages: the first stage (intake, or receive_inspect for repairs) is added once, only if the JO has no stages yet.
 *   - Clients: only when the request carries client_name / client_phone (the scanner doesn't send them yet).
 *     Matches an existing client by phone, then by name/alias; adds one only if nothing matches; never links when 2+ match.
 * Never deletes, never edits rows it didn't create apart from filling blanks, never throws: a Sheet problem can't fail an upload.
 * One-time: run setupJobs() to ADD the tabs JobOrders, JobStages, Clients, OcrLog (existing tabs are left as they are).
 */
var JOB_TABS = {
  JobOrders: ['jo', 'type', 'parent_jo', 'root_jo', 'status', 'current_stage', 'item_id', 'client_id', 'description', 'metal', 'karat',
    'size', 'due_date', 'rate_snapshot_id', 'product_photo_file_id', 'drive_folder_id', 'review_state',
    'created_at', 'created_by', 'updated_at', 'updated_by'],
  JobStages: ['stage_id', 'jo', 'seq', 'stage_code', 'status', 'started_at', 'ended_at', 'assignee', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  Clients: ['client_id', 'name', 'aliases', 'phone', 'email', 'billing_info', 'notes', 'portal_code', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  OcrLog: ['scan_id', 'jo', 'page', 'file_id', 'ocr_text', 'jo_found', 'match', 'ocr_error', 'parsed_json', 'review_state',
    'reviewed_by', 'reviewed_at', 'created_at', 'created_by']
};
var JOB_SCAN_FIELDS = ['type', 'parent_jo', 'root_jo', 'client_id', 'drive_folder_id']; // the only JobOrders cells a scan may fill
var JOB_OCR_MAX = 45000; // a Sheet cell holds 50,000 characters

/** ONE-TIME SETUP: select setupJobs and click Run. Adds missing tabs only; never changes a tab that exists. */
function setupJobs() {
  var ss = ss_(), added = [], kept = [];
  Object.keys(JOB_TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) { var miss = jobMissingCols_(sh, name); kept.push(name + (miss.length ? ' (no column: ' + miss.join(', ') + ')' : '')); return; }
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
      var key = jobKey_(req.jo) || jobKey_(jo), by = 'scanner', t = now_(), out = { ok: true, jo: key, created: false, filled: [], kept: [] };
      if (!key) return { ok: false, error: 'no JO number' };
      if (!jobTabsReady_()) return { ok: false, error: 'run setupJobs first' };
      var page = Number(req.page) || 1, fileId = file && file.getId ? file.getId() : '', folderId = folder && folder.getId ? folder.getId() : '';
      var parsed = jobParse_(ocrText);

      // 1. OcrLog (always a new row; older drafts of the same page become "replaced")
      jobRows_('OcrLog').forEach(function (r) {
        if (jobKey_(r.jo) === key && Number(r.page) === page && r.review_state === 'draft') jobSet_('OcrLog', r._row, { review_state: 'replaced' });
      });
      out.scan_id = 'scan-' + randHex_(8);
      jobAppend_('OcrLog', { scan_id: out.scan_id, jo: key, page: page, file_id: fileId, ocr_text: String(ocrText || '').slice(0, JOB_OCR_MAX),
        jo_found: (found || []).join(', '), match: (found || []).indexOf(key) >= 0, ocr_error: ocrError || '', parsed_json: JSON.stringify(parsed),
        review_state: 'draft', created_at: t, created_by: by });

      // 2. Client (only if the scanner sent one)
      var client = jobClient_(req, by, t); if (client.note) out.client_note = client.note;

      // 3. JobOrders: add once, then fill blanks only
      var rev = key.match(/^(\d{2}-\d{3,4})([A-Z])$/), type = rev ? 'revision' : (req.type === 'repair' ? 'repair' : 'new');
      var want = { type: (rev || req.type) ? type : '', parent_jo: rev ? rev[1] : '', root_jo: rev ? rev[1] : '', client_id: client.id || '', drive_folder_id: folderId };
      var row = jobRows_('JobOrders').filter(function (r) { return jobKey_(r.jo) === key; });
      if (row.length > 1) out.warning = row.length + ' JobOrders rows for ' + key + '; only the first is used';
      if (!row.length) {
        jobAppend_('JobOrders', { jo: key, type: type, parent_jo: want.parent_jo, root_jo: want.root_jo, status: 'draft',
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
function jobKey_(s) { // same rules as the scanner: '26-001', 'JO 26-005b' -> '26-005B'
  var m = String(s || '').toUpperCase().match(/(\d{2})\s*[-,.\/ ]?\s*(\d{3,4})(?:\s?([A-Z])(?![A-Z0-9]))?/);
  return m ? m[1] + '-' + m[2] + (m[3] || '') : '';
}
function jobTabsReady_() { var ss = ss_(); return ['JobOrders', 'JobStages', 'OcrLog'].every(function (n) { return !!ss.getSheetByName(n); }); }
function jobHeader_(sh) { return sh.getLastRow() ? sh.getDataRange().getValues()[0].map(function (x) { return String(x).trim(); }) : []; }
function jobMissingCols_(sh, name) { var h = jobHeader_(sh); return JOB_TABS[name].filter(function (k) { return h.indexOf(k) < 0 && /^(jo|client_id|status|stage_code|scan_id|name)$/.test(k); }); }
function jobRows_(name) {
  var sh = ss_().getSheetByName(name); if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues(), h = v[0].map(function (x) { return String(x).trim(); }), out = [];
  for (var i = 1; i < v.length; i++) { var o = { _row: i + 1 }; for (var j = 0; j < h.length; j++) if (h[j]) o[h[j]] = v[i][j]; out.push(o); }
  return out;
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
