// Minimal in-memory Apps Script mock for testing Auth.gs + Code.gs routing in node.
const crypto = require('crypto'), fs = require('fs'), vm = require('vm');
module.exports = function load() {
  const props = {}, cache = {}, sheets = {}; let clock = Date.now();
  function Sheet(name) { this.name = name; this.data = []; }
  Sheet.prototype = {
    getRange(r, c, nr = 1, nc = 1) { const sh = this; return {
      setValues(v) { for (let i = 0; i < nr; i++) { sh.data[r - 1 + i] = sh.data[r - 1 + i] || []; for (let j = 0; j < nc; j++) sh.data[r - 1 + i][c - 1 + j] = v[i][j]; } },
      setValue(v) { sh.data[r - 1] = sh.data[r - 1] || []; sh.data[r - 1][c - 1] = v; } }; },
    setFrozenRows() {}, getLastRow() { return this.data.length; },
    appendRow(a) { this.data.push(a.slice()); },
    getDataRange() { const d = this.data, w = Math.max(...d.map(r => r.length)); return { getValues: () => d.map(r => Array.from({ length: w }, (_, i) => r[i] === undefined ? '' : r[i])) }; } };
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet(n)), getId: () => 'mock', getUrl: () => 'mock://sheet' };
  const ctx = {
    console, Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(clock); } static now() { return clock; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
    CacheService: { getScriptCache: () => ({ get: k => (cache[k] && cache[k].exp > clock ? cache[k].v : null), put: (k, v, s) => { cache[k] = { v, exp: clock + s * 1000 }; }, remove: k => { delete cache[k]; } }) },
    SpreadsheetApp: { openById: () => ss, create: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 }, getUuid: () => crypto.randomUUID(),
      computeDigest: (_, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map(b => b > 127 ? b - 256 : b) },
    ContentService: { MimeType: { JSON: 1 }, createTextOutput: t => ({ setMimeType: () => ({ text: t }) }) },
    Logger: { log() {} }, DriveApp: {}, Drive: {}, DocumentApp: {},
  };
  vm.createContext(ctx);
  for (const f of ['Code.gs', 'Auth.gs']) vm.runInContext(fs.readFileSync(__dirname + '/../apps-script/' + f, 'utf8'), ctx);
  ctx.call = req => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(req) } }).text);
  ctx._ = { props, cache, sheets, advance: ms => { clock += ms; } };
  return ctx;
};
