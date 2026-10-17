/**
 * OYP Card Scanner backend (Google Apps Script web app).
 * Deploy: Execute as "Me", Who has access "Anyone".
 * Requires the Drive advanced service (v3) for free OCR.
 * Optional: Script Property TOKEN = shared secret the phone must send.
 */
var PARENT_FOLDER = 'Job Order Cards';

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.action) return json_(handleAction_(req)); // sign-in / roles (Auth.gs)
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (token && req.token !== token) return json_({ ok: false, error: 'Bad token' });
    if (req.op === 'deletePage') return json_(deletePage_(req)); // scanner swipe-delete (same TOKEN as uploads)
    var jo = normJO_(req.jo), full = joFull_(req.jo); // 26-287B: folder 26-287 (the JO), file name keeps the B (its version)
    if (!jo) return json_({ ok: false, error: 'Missing JO number' });
    if (!req.imageBase64) return json_({ ok: false, error: 'Missing image' });
    var lock = LockService.getScriptLock(); lock.waitLock(20000); // avoid duplicate folders + names on fast uploads
    var folder, filename, file, blob;
    try {
      folder = getOrCreate_(getOrCreate_(DriveApp.getRootFolder(), PARENT_FOLDER), jo);
      filename = scanName_(folder, full, req); // e.g. 26-001-p1-101726.jpg; a later session the same day gets ...-101726b.jpg
      blob = Utilities.newBlob(Utilities.base64Decode(req.imageBase64), 'image/jpeg', filename);
      var existing = folder.getFilesByName(filename);
      while (existing.hasNext()) existing.next().setTrashed(true); // re-crop / retake in the SAME session replaces its page; older scans are kept
      file = folder.createFile(blob);
      try { file.setDescription(SCAN_TAG + scanSession_(req)); } catch (e) {}
    } finally { lock.releaseLock(); }

    var ocrText = '', ocrError = '';
    try { ocrText = ocr_(blob, filename); } catch (err) { ocrError = String(err); }
    var found = findJOs_(ocrText);
    var job = typeof recordScan_ === 'function' ? recordScan_(req, jo, file, folder, ocrText, found, ocrError) : null; // JobSync.gs
    return json_({ ok: true, filename: filename, fileId: file.getId(), fileUrl: file.getUrl(), folderUrl: folder.getUrl(), ocrText: ocrText,
      joFound: found, match: found.some(function (x) { return normJO_(x) === jo; }), ocrError: ocrError });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() { return json_({ ok: true, service: 'OYP Card Scanner', auth: typeof handleAction_ === 'function' }); }

/** Free OCR: import image as a Google Doc with OCR, read text, trash temp doc. */
function ocr_(blob, name) {
  var doc = Drive.Files.create({ name: 'OCR tmp ' + name, mimeType: 'application/vnd.google-apps.document' },
    blob, { ocrLanguage: 'en', fields: 'id' });
  try { return DocumentApp.openById(doc.id).getBody().getText(); }
  finally { DriveApp.getFileById(doc.id).setTrashed(true); }
}

/* ---------- scan file names: every scan is kept; the date tag tells versions apart ----------
 * <JO>-p<page>-<MMDDYY>.jpg (Manila date the page was shot). One scanning session = one set: all its pages share one name tag,
 * so a re-crop / retake in that session reuses the name and replaces the page. A different session never replaces anything:
 * the first set of the day has no letter, the next ones get b, c, … (26-001-p1-101726b.jpg). Older files named <JO>-p<page>.jpg stay as they are. */
var SCAN_TZ = 'Asia/Manila', SCAN_TAG = 'oyp-scan:';
function scanSession_(req) { return String(req.scan || '').replace(/[^\w@.\-]/g, '').slice(0, 80) || 'no-session'; }
function scanDateTag_(req) {
  var m = String(req.filename || '').match(/-(\d{6})[a-z]?\.jpe?g$/i); // the phone puts the date the page was shot (uploads can wait offline)
  return m ? m[1] : Utilities.formatDate(new Date(), SCAN_TZ, 'MMddyy');
}
function scanName_(folder, jo, req) {
  var page = Math.max(1, parseInt(req.page, 10) || 1), tag = scanDateTag_(req), session = scanSession_(req), base = safeName_(jo);
  var re = new RegExp('^' + base.replace(/[.\-]/g, '\\$&') + '-p\\d+-' + tag + '([a-z]?)\\.jpe?g$', 'i');
  var used = {}, mine = null, it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next(); if (f.isTrashed && f.isTrashed()) continue;
    var m = String(f.getName()).match(re); if (!m) continue;
    var sfx = m[1].toLowerCase(), d = ''; used[sfx] = true;
    try { d = String(f.getDescription() || ''); } catch (e) {}
    if (mine === null && d === SCAN_TAG + session) mine = sfx;
  }
  if (mine === null) { var abc = 'bcdefghijklmnopqrstuvwxyz', i = 0; mine = ''; while (used[mine] && i < abc.length) mine = abc.charAt(i++); }
  return base + '-p' + page + '-' + tag + mine + '.jpg';
}

/* ---------- scanner swipe-delete ----------
 * {op:'deletePage', jo, file_id?, filename?, scan?, page?}. Only ever moves a page photo to Drive Trash (recoverable for 30 days),
 * never deletes for good, and only a file that sits in "Job Order Cards/<JO>" and is named like a page of that JO.
 * With file_id: that file (and, if filename is sent, it must match). Without: the page the given scan session saved (file description).
 * The OcrLog row of a trashed file is marked "deleted" (JobSync.gs), so the back office stops showing it. */
function deletePage_(req) {
  var jo = normJO_(req.jo); if (!jo) return { ok: false, error: 'Missing JO number' };
  var root = DriveApp.getRootFolder().getFoldersByName(PARENT_FOLDER); if (!root.hasNext()) return { ok: true, deleted: 0 };
  var fit = root.next().getFoldersByName(jo); if (!fit.hasNext()) return { ok: true, deleted: 0 };
  var folder = fit.next(), base = safeName_(jo).replace(/[.\-]/g, '\\$&');
  var pageRe = new RegExp('^' + base + '[A-Z]?-p\\d+(?:-\\d{6}[a-z]?)?\\.jpe?g$', 'i'), targets = [];
  if (req.file_id) {
    var f; try { f = DriveApp.getFileById(String(req.file_id)); } catch (e) { return { ok: true, deleted: 0, note: 'not found' }; }
    // inside the JO folder, or an older version folder of the same JO (Job Order Cards/26-287A)
    var inside = false, ps = f.getParents(); while (ps.hasNext()) { var pf = ps.next(); if (pf.getId() === folder.getId() || (normJO_(pf.getName()) === jo && joFull_(pf.getName()) !== jo && joParentOk_(pf))) inside = true; }
    if (!inside || !pageRe.test(f.getName()) || (req.filename && f.getName() !== safeName_(req.filename))) return { ok: false, error: 'Not a page of this JO', code: 'FORBIDDEN' };
    targets.push(f);
  } else {
    var session = String(req.scan || '').replace(/[^\w@.\-]/g, '').slice(0, 80), page = parseInt(req.page, 10);
    if (!session || !(page > 0)) return { ok: false, error: 'Missing file' };
    var one = new RegExp('^' + safeName_(joFull_(req.jo)).replace(/[.\-]/g, '\\$&') + '-p' + page + '-\\d{6}[a-z]?\\.jpe?g$', 'i'), it = folder.getFiles();
    while (it.hasNext()) {
      var x = it.next(); if (x.isTrashed && x.isTrashed()) continue;
      var d = ''; try { d = String(x.getDescription() || ''); } catch (e) {}
      if (one.test(x.getName()) && d === SCAN_TAG + session) targets.push(x);
    }
  }
  var ids = [];
  targets.forEach(function (t) { if (t.isTrashed && t.isTrashed()) return; t.setTrashed(true); ids.push(t.getId()); }); // Drive Trash only
  var marked = 0; try { if (ids.length && typeof markScanDeleted_ === 'function') marked = markScanDeleted_(jo, ids); } catch (e) {} // JobSync.gs
  return { ok: true, deleted: ids.length, file_ids: ids, marked: marked };
}

function getOrCreate_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** The JO itself: '26-001', 'JO 26-001', 'JO# 26,001', '26 001' -> '26-001'. A letter is a newer version of the SAME JO:
 *  '26-287B' -> '26-287' (folder, Sheet, lookups). joFull_ keeps the letter ('26-287B', for file names), joVersion_ is the letter. */
function normJO_(s) {
  var m = String(s || '').toUpperCase().match(/(\d{2})\s*[-,.\/ ]?\s*(\d{3,4})(?:\s?([A-Z])(?![A-Z0-9]))?/);
  return m ? m[1] + '-' + m[2] : String(s || '').trim().toUpperCase().replace(/^J\.?O\.?\s*#?\s*/, '');
}
function joFull_(s) {
  var m = String(s || '').toUpperCase().match(/(\d{2})\s*[-,.\/ ]?\s*(\d{3,4})(?:\s?([A-Z])(?![A-Z0-9]))?/);
  return m ? m[1] + '-' + m[2] + (m[3] || '') : String(s || '').trim().toUpperCase().replace(/^J\.?O\.?\s*#?\s*/, '');
}
function joVersion_(s) { var f = joFull_(s), j = normJO_(s); return f.length > j.length ? f.slice(j.length) : ''; }
function joParentOk_(f) { try { var ps = f.getParents(); while (ps.hasNext()) if (ps.next().getName() === PARENT_FOLDER) return true; } catch (e) {} return false; }

/** All JO-looking numbers in OCR text, normalised, unique. Prefers ones labelled JO. */
function findJOs_(text) {
  var t = String(text || '').toUpperCase(), out = [], m;
  var labelled = /J\.?\s*O\.?\s*(?:NO\.?|#)?\s*[:#]?\s*(\d{2})\s*[-,.\/ ]\s*(\d{3,4})([A-Z])?(?![A-Z0-9])/g;
  while ((m = labelled.exec(t))) push_(out, m[1] + '-' + m[2] + (m[3] || ''));
  var bare = /\b(\d{2})\s?[-,.\/]\s?(\d{3})([A-Z])?\b/g; // e.g. 26-001, 26-005B (skips dates like 1-7-26)
  while ((m = bare.exec(t))) push_(out, m[1] + '-' + m[2] + (m[3] || ''));
  return out;
}
function push_(a, v) { if (a.indexOf(v) === -1) a.push(v); }
function safeName_(s) { return String(s).replace(/[^\w.\-]/g, '_'); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
