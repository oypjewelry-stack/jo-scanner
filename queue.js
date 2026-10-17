/* OYP Card Scanner: persistent upload queue.
   Pages are written to IndexedDB the moment they are taken and uploaded one at a time in the background,
   with retry + backoff. Survives Done, new scans, reload and closing the tab.
   Works in the browser (window.OYPQueue) and in Node for tests (module.exports). */
(function (root) {
'use strict';
const STATES = ['waiting', 'uploading', 'saved', 'mismatch', 'failed']; // + 'deleting': a swiped-away page whose Drive copy is still to be trashed (never listed)
const KEEP_SAVED_MS = 12 * 3600e3, KEEP_SAVED_MAX = 60, MAX_TRIES = 6;
// backoff: 3s, 10s, 30s, 1m, 2m, then give up as Failed (Retry is always offered)
const BACKOFF = [3e3, 10e3, 30e3, 60e3, 120e3];
const backoff = tries => BACKOFF[Math.min(tries - 1, BACKOFF.length - 1)];
const keyOf = (jo, filename, scan) => jo + '|' + filename + (scan ? '|' + scan : ''); // one entry per page per session: a re-crop replaces it, a later session never does

/* ---------- storage ---------- */
function memoryStore() {
  const m = new Map();
  return { all: async () => [...m.values()].map(x => Object.assign({}, x)), put: async x => { m.set(x.id, Object.assign({}, x)); },
    del: async id => { m.delete(id); }, _map: m };
}
function idbStore(name) {
  name = name || 'oypScanQueue';
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => { dbp = null; rej(r.error); };
  }));
  const tx = (mode, fn) => db().then(d => new Promise((res, rej) => {
    const t = d.transaction('items', mode), s = t.objectStore('items'); let out;
    const q = fn(s); if (q) q.onsuccess = () => { out = q.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
  return { all: () => tx('readonly', s => s.getAll()), put: x => tx('readwrite', s => s.put(x)), del: id => tx('readwrite', s => s.delete(id)) };
}

/* ---------- queue ---------- */
// send(item) -> resolves { ok:true, joFound:[], match } or throws Error (err.permanent = true to skip retries)
function create(opts) {
  const store = opts.store, send = opts.send, now = opts.now || (() => Date.now());
  const online = opts.online || (() => true), onChange = opts.onChange || (() => {});
  const setT = opts.setTimeout || ((f, ms) => setTimeout(f, ms)), clearT = opts.clearTimeout || (t => clearTimeout(t));
  const normJO = opts.normJO || (s => String(s || '').toUpperCase());
  // del(tombstone) -> { ok, deleted } | { unsupported: true } (older script) ; throws on no connection (retried later)
  const del = opts.del || null, onDeleted = opts.onDeleted || (() => {});
  let items = new Map(), running = false, timer = null, loaded = null, seq = 0, reaping = false, reapTimer = null;

  const all = () => [...items.values()].sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
  const list = () => all().filter(x => x.state !== 'deleting');
  const emit = () => { try { onChange(api); } catch (e) { console.error(e); } };
  async function save(it) { items.set(it.id, it); await store.put(it); }

  function load() {
    if (loaded) return loaded;
    loaded = (async () => {
      const all = await store.all();
      for (const it of all) {
        if (it.state === 'uploading') { it.state = 'waiting'; it.nextAt = 0; await store.put(it); } // tab closed mid-upload
        if (it.state === 'deleting' && it.inflight) { it.inflight = false; await store.put(it); } // closed mid-upload: delete by session + page
        seq = Math.max(seq, it.seq || 0); items.set(it.id, it);
      }
      await prune(); emit(); reap();
    })();
    return loaded;
  }
  async function prune() {
    const t = now(), saved = list().filter(x => x.state === 'saved' || x.state === 'mismatch').sort((a, b) => b.savedAt - a.savedAt);
    for (let i = 0; i < saved.length; i++) {
      const x = saved[i];
      // mismatches stay a full day so they get checked; plain saves clear after 12h or past the newest 60
      const keep = x.state === 'mismatch' ? KEEP_SAVED_MS * 2 : KEEP_SAVED_MS;
      if (t - x.savedAt > keep || i >= KEEP_SAVED_MAX) { items.delete(x.id); await store.del(x.id); }
    }
  }
  // add a page; a re-shoot of the same JO page replaces the earlier entry (same Drive file name)
  async function add(p) {
    await load();
    const id = keyOf(p.jo, p.filename, p.scan), old = items.get(id);
    const it = { id, jo: p.jo, page: p.page, filename: p.filename, scan: p.scan || '', image: p.image, thumb: p.thumb || '',
      state: 'waiting', tries: 0, nextAt: 0, error: '', found: [], createdAt: now(), seq: ++seq, rev: ((old && old.rev) || 0) + 1, savedAt: 0 };
    await save(it); emit(); kick(); return it;
  }
  function schedule() {
    clearT(timer); timer = null;
    const w = list().filter(x => x.state === 'waiting');
    if (!w.length || running) return;
    const next = Math.min(...w.map(x => x.nextAt || 0)), wait = Math.max(0, next - now());
    timer = setT(() => { timer = null; pump(); }, wait);
  }
  function kick() { if (!running) { clearT(timer); timer = null; pump(); } }
  async function pump() {
    await load();
    if (running) return; running = true;
    try {
      for (;;) {
        if (!online()) break; // wait for the 'online' event
        const it = list().find(x => x.state === 'waiting' && (x.nextAt || 0) <= now());
        if (!it) break;
        const rev = it.rev; it.state = 'uploading'; it.error = ''; await save(it); emit();
        let res = null, err = null;
        try { res = await send(it); } catch (e) { err = e; }
        const cur = items.get(it.id);
        if (cur && cur.state === 'deleting' && cur.rev === rev) { // swiped away while it was uploading: trash whatever got saved
          cur.inflight = false; if (!err && res) { cur.fileId = res.fileId || ''; cur.savedName = res.filename || ''; }
          await store.put(cur); reap(); continue;
        }
        if (!cur || cur.rev !== rev) continue; // removed or re-shot while uploading: the newer entry goes next
        if (!err) {
          const found = (res.joFound || []).map(normJO), jo = normJO(cur.jo);
          cur.found = found; cur.state = (res.match || found.includes(jo) || !found.length) ? 'saved' : 'mismatch';
          cur.verified = !!(res.match || found.includes(jo)); cur.savedAt = now(); cur.image = ''; // free the space, keep the thumbnail
          cur.fileId = res.fileId || ''; cur.savedName = res.filename || ''; // what Drive saved (for a later swipe-delete)
          cur.error = ''; await save(cur);
        } else {
          const offline = !online() || err.offline;
          if (!offline) cur.tries++;
          cur.error = String((err && err.message) || err || 'Upload failed');
          if (err.permanent || cur.tries >= MAX_TRIES) cur.state = 'failed';
          else { cur.state = 'waiting'; cur.nextAt = offline ? 0 : now() + backoff(cur.tries); }
          await save(cur);
        }
        await prune(); emit();
      }
    } finally { running = false; schedule(); }
  }
  async function retry(id) { await load(); const it = items.get(id); if (!it || !it.image) return false;
    it.state = 'waiting'; it.tries = 0; it.nextAt = 0; it.error = ''; await save(it); emit(); kick(); return true; }
  async function retryFailed() { await load(); for (const it of list()) if (it.state === 'failed' && it.image) { it.state = 'waiting'; it.tries = 0; it.nextAt = 0; await save(it); } emit(); kick(); }
  async function remove(id) { await load(); items.delete(id); await store.del(id); emit(); }
  // swipe-delete: gone from every list at once. Never uploaded -> just removed. Saved -> its Drive file is trashed (del).
  // Uploading -> the upload can't be called back once sent, so it is marked and its file is trashed as soon as the upload answers.
  async function discard(id) {
    await load(); const it = items.get(id); if (!it || it.state === 'deleting') return { phase: 'none' };
    if (it.state === 'waiting' || it.state === 'failed') { await remove(id); return { phase: 'removed' }; }
    const t = Object.assign({}, it, { state: 'deleting', inflight: it.state === 'uploading', image: '', delTries: 0, delAt: 0 });
    await save(t); emit(); reap(); return { phase: t.inflight ? 'after-upload' : 'deleting' };
  }
  async function reap() {
    if (!del || reaping) return; reaping = true; clearT(reapTimer); reapTimer = null;
    try {
      for (;;) {
        const t = all().find(x => x.state === 'deleting' && !x.inflight && (x.delAt || 0) <= now() && (online() || false));
        if (!t) break;
        let r = null, err = null;
        try { r = await del(t); } catch (e) { err = e; }
        if (err && !err.permanent) { t.delTries = (t.delTries || 0) + 1; t.delAt = now() + backoff(t.delTries); await store.put(t); continue; }
        items.delete(t.id); await store.del(t.id);
        try { onDeleted(t, err ? { ok: false, error: String(err.message || err) } : (r || { ok: true })); } catch (e) { console.error(e); }
      }
    } finally {
      reaping = false;
      const w = all().filter(x => x.state === 'deleting' && !x.inflight);
      if (w.length && online()) reapTimer = setT(reap, Math.max(1000, Math.min(...w.map(x => x.delAt || 0)) - now()));
    }
  }
  function wake() { for (const it of items.values()) { if (it.state === 'waiting') it.nextAt = 0; if (it.state === 'deleting') it.delAt = 0; } kick(); reap(); } // back online / app opened
  function counts() {
    const c = { waiting: 0, uploading: 0, saved: 0, mismatch: 0, failed: 0 };
    for (const it of items.values()) if (it.state in c) c[it.state]++;
    c.pending = c.waiting + c.uploading; c.total = c.waiting + c.uploading + c.saved + c.mismatch + c.failed; return c;
  }
  const api = { load, add, pump, kick, wake, retry, retryFailed, remove, discard, reap, counts, list, get: id => items.get(id), prune, deleting: () => all().filter(x => x.state === 'deleting') };
  return api;
}
// one line of status text per item, shared by every list
function label(it, isOnline) {
  switch (it.state) {
    case 'waiting': return it.error ? (isOnline === false ? 'Waiting for internet' : 'Waiting, will retry (' + it.error + ')') : (isOnline === false ? 'Waiting for internet' : 'Waiting to upload');
    case 'uploading': return 'Uploading…';
    case 'saved': return it.verified ? 'Saved ✓ JO verified' : 'Saved ✓ (no JO number read on this page)';
    case 'mismatch': return 'Saved, but card reads ' + (it.found || []).join(', ') + ' (typed ' + it.jo + '). Check!';
    case 'failed': return 'Failed: ' + (it.error || 'upload failed');
  }
  return it.state;
}
const api = { create, memoryStore, idbStore, label, keyOf, STATES, MAX_TRIES, BACKOFF };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OYPQueue = api;
})(typeof window !== 'undefined' ? window : globalThis);
