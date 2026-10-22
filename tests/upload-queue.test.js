// Page 1 before later pages, retry after a stretch offline, IndexedDB across a reload, no second save when the response is lost.
const assert = require('assert');
const Q = require('../queue.js');
const load = require('./gasmock');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const tick = () => new Promise(r => setImmediate(r));
async function settle() { for (let i = 0; i < 40; i++) await tick(); }
function rig(sendImpl) {
  const t = { now: 1000, online: true, timers: [] }, store = Q.memoryStore(), calls = [];
  const q = Q.create({ store, now: () => t.now, online: () => t.online,
    setTimeout: (f, ms) => { const x = { f, at: t.now + ms }; t.timers.push(x); return x; }, clearTimeout: x => { t.timers = t.timers.filter(y => y !== x); },
    send: async it => { calls.push({ filename: it.filename, clientId: it.clientId, page: it.page, printJo: it.printJo, printTag: it.printTag, token: it.token }); return sendImpl(it, calls.length); } });
  t.advance = async ms => { t.now += ms; const due = t.timers.filter(x => x.at <= t.now); t.timers = t.timers.filter(x => x.at > t.now); due.forEach(x => x.f()); await settle(); };
  return { t, store, q, calls };
}
const page = (jo, p, extra) => Object.assign({ jo, page: p, filename: `${jo}-p${p}.jpg`, image: 'data:image/jpeg;base64,AAAA', thumb: 't', clientId: jo + '-p' + p, printJo: p === 1, printTag: p === 1, token: 'tok', shot: 1 }, extra);
const netErr = () => Object.assign(new Error('Failed to fetch'), { offline: false });

(async () => {
  { // page 1s of every JO start before any later page, even when the later pages were queued first
    const r = rig(async () => ({ ok: true, joFound: [], match: true }));
    r.t.online = false;
    await r.q.add(page('26-100', 2));
    await r.q.add(page('26-100', 3));
    await r.q.add(page('26-200', 1));
    await r.q.add(page('26-300', 4));
    await r.q.add(page('26-400', 1));
    ok(r.calls.length === 0, 'nothing uploads while offline');
    r.t.online = true; r.q.wake(); await settle();
    const order = r.calls.map(c => c.filename);
    const firstLater = order.findIndex(f => !/-p1\.jpg$/.test(f));
    const pageOnes = order.filter(f => /-p1\.jpg$/.test(f));
    ok(pageOnes.join() === '26-200-p1.jpg,26-400-p1.jpg' && firstLater > pageOnes.length - 1, 'both front cards upload before any later page: ' + order.join(', '));
    ok(r.calls.filter(c => c.page === 1).every(c => c.printJo === true && c.printTag === true && c.token === 'tok'), 'page 1 keeps the sticker switches and token it was shot with');
    ok(r.q.counts().saved === 5 && r.q.list().every(x => x.image === ''), 'photos leave the store only after the server confirms');
  }
  { // a front card with no JO number waits, then the typed number sends it ahead of later pages
    const r = rig(async it => ({ ok: true, joFound: [it.jo], match: true }));
    r.t.online = false;
    await r.q.add(page('OCR', 1, { held: true, clientId: 'front', filename: 'OCR-p1.jpg', scan: 'OCR@s1' }));
    await r.q.add(page('OCR', 2, { held: true, clientId: 'back', filename: 'OCR-p2.jpg', scan: 'OCR@s1' }));
    await r.q.add(page('26-500', 2));
    ok(r.q.counts().needsjo === 2 && r.q.counts().waiting === 1, 'an unread JO stays on the phone and is not uploaded');
    await r.q.bindJo('OCR@s1', '26-777', '26-777@s1', it => '26-777-p' + it.page + '.jpg');
    r.t.online = true; r.q.wake(); await settle();
    ok(r.calls[0].filename === '26-777-p1.jpg' && r.calls[0].clientId === 'front', 'typing the number queues that front card first');
    ok(r.calls[0].filename === '26-777-p1.jpg' && r.calls.every((c, i) => i === 0 || c.page !== 1), 'no later page starts before that front card');
    ok(r.q.counts().needsjo === 0 && r.q.counts().saved === 3, 'the sticker page and the later pages are saved');
  }
  { // offline period: a failed attempt does not burn retries, and the same photo goes again when the phone is back
    const r = rig(async (it, k) => {
      if (k === 1) { r.t.online = false; const e = new Error('no connection'); e.offline = true; throw e; }
      return { ok: true, joFound: ['26-004'], match: true };
    });
    await r.q.add(page('26-004', 1)); await settle();
    const it = r.q.list()[0];
    ok(it.state === 'waiting' && it.tries === 0 && it.image && it.clientId === '26-004-p1', 'a dropped connection keeps the photo and does not count a try');
    r.t.online = false;
    await r.t.advance(10 * 60e3);
    ok(r.calls.length === 1 && r.q.list()[0].state === 'waiting', 'asleep and offline: no further attempt');
    r.t.online = true; r.q.wake(); await settle();
    ok(r.calls.length === 2 && r.calls[1].clientId === r.calls[0].clientId && r.q.counts().saved === 1, 'online again: the same photo is sent once more and saved');
  }
  { // lost response: the server already has the client id, the retry must not create a second save
    const drive = new Map();
    const r = rig(async it => {
      if (drive.has(it.clientId)) return { ok: true, deduped: true, match: true, joFound: [it.jo], fileId: drive.get(it.clientId) };
      drive.set(it.clientId, 'file-' + it.clientId);
      throw netErr(); // the file was saved, the response never came back
    });
    await r.q.add(page('26-008', 1)); await settle();
    ok(r.q.list()[0].state === 'waiting' && r.q.list()[0].tries === 1 && drive.size === 1, 'first try saved on the server and is waiting to retry');
    await r.t.advance(Q.BACKOFF[0]);
    ok(r.calls.length === 2 && drive.size === 1 && r.calls[0].clientId === r.calls[1].clientId && r.q.counts().saved === 1, 'the retry uses the same client id and does not save a second file');
    ok(r.q.list()[0].image === '', 'the phone copy is removed only after the confirmed retry');
  }
  { // IndexedDB survives a new queue on the same database (reload / app reopen)
    globalThis.indexedDB = require('fake-indexeddb').indexedDB;
    const store = Q.idbStore('oypScanQueueReload');
    const q = Q.create({ store, send: async () => new Promise(() => {}) });
    await q.add(page('26-009', 2, { clientId: 'later' }));
    await q.add(page('26-009', 1, { clientId: 'front', printJo: false, printTag: true, token: 'secret' }));
    await q.add(page('OCR', 1, { held: true, clientId: 'unread', filename: 'OCR-p1.jpg', scan: 'OCR@z', token: 'secret' }));
    await settle();
    const store2 = Q.idbStore('oypScanQueueReload');
    const calls = [];
    const q2 = Q.create({ store: store2, send: async it => { calls.push(it); return { ok: true, joFound: [it.jo], match: true }; } });
    await q2.load();
    const names = q2.list().map(x => x.clientId).sort();
    ok(names.join() === 'front,later,unread', 'reload reads the same photos back from IndexedDB');
    const front = q2.list().find(x => x.clientId === 'front');
    ok(front.printJo === false && front.printTag === true && front.token === 'secret' && front.state === 'waiting', 'reload keeps the sticker switches, token, and an interrupted upload');
    ok(q2.list().find(x => x.clientId === 'unread').state === 'needsjo' && q2.list().find(x => x.clientId === 'unread').image, 'an unread JO is still on the phone after reload');
    q2.kick(); await settle();
    ok(calls[0].clientId === 'front' && calls[0].page === 1, 'after reopen, page 1 uploads before the later page');
    ok(!calls.some(c => c.clientId === 'unread'), 'the unread JO is not uploaded until a number is typed');
  }
  { // Apps Script: the same clientId returns the file already saved
    const g = load();
    const img = Buffer.from('jpeg-bytes').toString('base64');
    const body = { jo: '26-010', page: 1, filename: '26-010-p1-101726.jpg', scan: '26-010@s1', imageBase64: img, clientId: 'cid-1', printJo: true, printTag: true };
    const a = g.call(body);
    const b = g.call(body);
    const root = g.DriveApp.getRootFolder();
    const cards = root.getFoldersByName('Job Order Cards').next();
    const fld = cards.getFoldersByName('26-010').next();
    const live = fld.files.filter(f => !f.trashed);
    ok(a.ok && !a.deduped && b.ok && b.deduped === true && a.fileId === b.fileId && live.length === 1, 'a lost response retried with the same client id leaves one Drive file');
    const again = g.call(Object.assign({}, body, { clientId: 'cid-2' }));
    ok(again.ok && !again.deduped && again.filename === a.filename && fld.files.filter(f => !f.trashed).length === 1, 'a new photo in the same session still replaces that page instead of adding one');
    const kept = fld.files.filter(f => !f.trashed)[0];
    ok(String(kept.getDescription()).indexOf('oyp-cid:cid-2') > 0 && String(kept.getDescription()).indexOf('oyp-scan:26-010@s1') === 0, 'the file description keeps the session and the client id');
  }
  console.log('upload-queue tests passed:', n);
})().catch(e => { console.error(e); process.exit(1); });
