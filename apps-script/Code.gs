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
    var jo = normJO_(req.jo);
    if (!jo) return json_({ ok: false, error: 'Missing JO number' });
    if (!req.imageBase64) return json_({ ok: false, error: 'Missing image' });
    var lock = LockService.getScriptLock(); lock.waitLock(20000); // avoid duplicate folders + names on fast uploads
    var folder, filename, file, blob;
    try {
      folder = getOrCreate_(getOrCreate_(DriveApp.getRootFolder(), PARENT_FOLDER), jo);
      filename = scanName_(folder, jo, req); // e.g. 26-001-p1-101726.jpg; a later session the same day gets ...-101726b.jpg
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
    return json_({ ok: true, filename: filename, fileUrl: file.getUrl(), folderUrl: folder.getUrl(), ocrText: ocrText,
      joFound: found, match: found.indexOf(jo) !== -1, ocrError: ocrError });
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

function getOrCreate_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** '26-001', 'JO 26-001', 'JO# 26,001', '26 001' -> '26-001' */
function normJO_(s) {
  var m = String(s || '').toUpperCase().match(/(\d{2})\s*[-,.\/ ]?\s*(\d{3,4})(?:\s?([A-Z])(?![A-Z0-9]))?/);
  return m ? m[1] + '-' + m[2] + (m[3] || '') : String(s || '').trim().toUpperCase().replace(/^J\.?O\.?\s*#?\s*/, '');
}

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
