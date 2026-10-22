/* One-time move from https://oypjewelry-stack.github.io/jo-scanner/ to https://oypjewelry.com/scan/.
   Saved settings travel in the URL fragment, which the browser does not send to the server.
   The token is never placed in the query string. */
(function (root) {
'use strict';
var HOME = 'https://oypjewelry.com/scan/';
var SENT = 'oypScanHandoffSent';
var KEYS = ['oypScanApi', 'oypScanToken', 'oypScanRotate', 'oypScanAuto', 'oypScanCrop', 'oypScanRole', 'oypScanPrintJo', 'oypScanPrintTag', 'enhance', 'oypScanZones', 'oypScanZonesShared', 'oypPrint', 'oypDevice'];

function shouldLeave(loc) {
  var host = String(loc && loc.hostname || '');
  var path = String(loc && loc.pathname || '');
  return host === 'oypjewelry-stack.github.io' && /(^|\/)jo-scanner(\/|$)/.test(path);
}
function encodePayload(obj) {
  var bytes = new TextEncoder().encode(JSON.stringify(obj));
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function decodePayload(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  var bin = atob(s), bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var data = JSON.parse(new TextDecoder().decode(bytes));
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}
function pack(storage) {
  var data = {};
  KEYS.forEach(function (k) {
    var v;
    try { v = storage.getItem(k); } catch (e) { v = null; }
    if (typeof v === 'string' && v) data[k] = v;
  });
  return data;
}
function apply(storage, data) {
  if (!data || typeof data !== 'object') return;
  KEYS.forEach(function (k) {
    var v = data[k];
    if (typeof v !== 'string' || !v || v.length > 100000) return;
    try { if (storage.getItem(k) == null) storage.setItem(k, v); } catch (e) {}
  });
}
function destination(loc, storage) {
  var qs = new URLSearchParams(String(loc.search || '').replace(/^\?/, ''));
  var sent = false;
  try { sent = storage.getItem(SENT) === '1'; } catch (e) {}
  var data = sent ? {} : pack(storage);
  var token = qs.get('token');
  if (token && !data.oypScanToken) data.oypScanToken = token;
  var api = qs.get('api');
  if (api && !data.oypScanApi) data.oypScanApi = api;
  qs.delete('token');
  var search = qs.toString();
  var url = HOME + (search ? '?' + search : '');
  var keys = Object.keys(data);
  if (keys.length) url += '#h=' + encodePayload(data);
  return url;
}
function arrivalPath(loc, storage) {
  var m = /^#h=([A-Za-z0-9_-]*)$/.exec(String(loc.hash || ''));
  if (!m) return '';
  var data = {};
  try { if (m[1]) data = decodePayload(m[1]); } catch (e) { data = {}; }
  apply(storage, data);
  return String(loc.pathname || '/') + String(loc.search || '');
}
function decide(homeOk, waiting) {
  if (!homeOk) return 'stay';
  if (waiting > 0) return 'wait';
  return 'go';
}
function unfinished() {
  return new Promise(function (resolve) {
    if (typeof indexedDB === 'undefined') { resolve(0); return; }
    var req;
    try { req = indexedDB.open('oypScanQueue'); } catch (e) { resolve(0); return; }
    req.onupgradeneeded = function (e) { try { e.target.transaction.abort(); } catch (err) {} };
    req.onerror = function () { resolve(0); };
    req.onsuccess = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains('items')) { db.close(); resolve(0); return; }
      var q = db.transaction('items', 'readonly').objectStore('items').getAll();
      q.onerror = function () { db.close(); resolve(0); };
      q.onsuccess = function () {
        var n = 0;
        (q.result || []).forEach(function (it) {
          if (it && (it.state === 'waiting' || it.state === 'uploading' || it.state === 'failed' || it.state === 'deleting' || it.state === 'needsjo')) n++;
        });
        db.close();
        resolve(n);
      };
    };
  });
}
function boot() {
  if (typeof location === 'undefined' || typeof localStorage === 'undefined') return;
  var stayed = '';
  try { stayed = arrivalPath(location, localStorage); } catch (e) { stayed = ''; }
  if (stayed) {
    try { history.replaceState(null, '', stayed); } catch (e2) {}
    return;
  }
  if (!shouldLeave(location)) return;
  var rootEl = document.documentElement;
  if (rootEl) rootEl.classList.add('leaving');
  function show() { if (rootEl) rootEl.classList.remove('leaving'); }
  function leave() {
    var url;
    try { url = destination(location, localStorage); } catch (e) { show(); return; }
    try { localStorage.setItem(SENT, '1'); } catch (e2) {}
    location.replace(url);
  }
  function whenClear(homeOk) {
    if (decide(homeOk, 1) === 'stay') { show(); return; }
    var timer = setInterval(function () {
      unfinished().then(function (n) { if (!n) { clearInterval(timer); leave(); } }, function () {});
    }, 4000);
  }
  Promise.all([unfinished(), fetch(HOME, { method: 'GET', cache: 'no-store' }).then(function (res) { return !!(res && res.ok); }, function () { return false; })]).then(function (pair) {
    var choice = decide(pair[1], pair[0]);
    if (choice === 'go') leave();
    else if (choice === 'wait') { show(); whenClear(true); }
    else show();
  }, show);
}

var api = { HOME: HOME, KEYS: KEYS, SENT: SENT, shouldLeave: shouldLeave, encodePayload: encodePayload, decodePayload: decodePayload, pack: pack, apply: apply, destination: destination, arrivalPath: arrivalPath, decide: decide, unfinished: unfinished };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
root.OYPHandoff = api;
if (typeof document !== 'undefined') boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
