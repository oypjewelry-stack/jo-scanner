/**
 * OYP JO Card Scanner backend (Google Apps Script web app).
 * Deploy: Execute as "Me", Who has access "Anyone".
 * Requires the Drive advanced service (v3) for free OCR.
 * Optional: Script Property TOKEN = shared secret the phone must send.
 */
var PARENT_FOLDER = 'Job Order Cards';

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (token && req.token !== token) return json_({ ok: false, error: 'Bad token' });
    var jo = normJO_(req.jo);
    if (!jo) return json_({ ok: false, error: 'Missing JO number' });
    if (!req.imageBase64) return json_({ ok: false, error: 'Missing image' });
    var filename = safeName_(req.filename || (jo + '-p' + (req.page || 1) + '.jpg'));

    var lock = LockService.getScriptLock(); lock.waitLock(20000); // avoid duplicate folders on fast uploads
    var folder;
    try { folder = getOrCreate_(getOrCreate_(DriveApp.getRootFolder(), PARENT_FOLDER), jo); }
    finally { lock.releaseLock(); }

    var blob = Utilities.newBlob(Utilities.base64Decode(req.imageBase64), 'image/jpeg', filename);
    var existing = folder.getFilesByName(filename);
    while (existing.hasNext()) existing.next().setTrashed(true); // re-shoot replaces the page
    var file = folder.createFile(blob);

    var ocrText = '', ocrError = '';
    try { ocrText = ocr_(blob, filename); } catch (err) { ocrError = String(err); }
    var found = findJOs_(ocrText);
    return json_({ ok: true, fileUrl: file.getUrl(), folderUrl: folder.getUrl(), ocrText: ocrText,
      joFound: found, match: found.indexOf(jo) !== -1, ocrError: ocrError });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() { return json_({ ok: true, service: 'OYP JO Card Scanner' }); }

/** Free OCR: import image as a Google Doc with OCR, read text, trash temp doc. */
function ocr_(blob, name) {
  var doc = Drive.Files.create({ name: 'OCR tmp ' + name, mimeType: 'application/vnd.google-apps.document' },
    blob, { ocrLanguage: 'en', fields: 'id' });
  try { return DocumentApp.openById(doc.id).getBody().getText(); }
  finally { DriveApp.getFileById(doc.id).setTrashed(true); }
}

function getOrCreate_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** '26-001', 'JO 26-001', 'JO# 26,001', '26 001' -> '26-001' */
function normJO_(s) {
  var m = String(s || '').toUpperCase().match(/(\d{2})\s*[-,.\/ ]?\s*(\d{3,4})/);
  return m ? m[1] + '-' + m[2] : String(s || '').trim().toUpperCase().replace(/^J\.?O\.?\s*#?\s*/, '');
}

/** All JO-looking numbers in OCR text, normalised, unique. Prefers ones labelled JO. */
function findJOs_(text) {
  var t = String(text || '').toUpperCase(), out = [], m;
  var labelled = /J\.?\s*O\.?\s*(?:NO\.?|#)?\s*[:#]?\s*(\d{2})\s*[-,.\/ ]\s*(\d{3,4})/g;
  while ((m = labelled.exec(t))) push_(out, m[1] + '-' + m[2]);
  var bare = /\b(\d{2})\s?[-,.\/]\s?(\d{3})\b/g; // e.g. 26-001 (skips dates like 1-7-26)
  while ((m = bare.exec(t))) push_(out, m[1] + '-' + m[2]);
  return out;
}
function push_(a, v) { if (a.indexOf(v) === -1) a.push(v); }
function safeName_(s) { return String(s).replace(/[^\w.\-]/g, '_'); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
