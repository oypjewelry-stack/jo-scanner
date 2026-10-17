const assert = require('assert'); const Q = require('../queue.js'); const load = require('./gasmock');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const tick = () => new Promise(r => setImmediate(r));
async function settle() { for (let i = 0; i < 30; i++) await tick(); }
function rig(sendImpl) {
  const t = { now: 1000, online: true, timers: [] }, store = Q.memoryStore(), calls = [];
  const q = Q.create({ store, now: () => t.now, online: () => t.online,
    setTimeout: (f, ms) => { const x = { f, at: t.now + ms }; t.timers.push(x); return x; }, clearTimeout: x => { t.timers = t.timers.filter(y => y !== x); },
    send: async it => { calls.push(it.filename); return sendImpl(it, calls.length); } });
  t.advance = async ms => { t.now += ms; const due = t.timers.filter(x => x.at <= t.now); t.timers = t.timers.filter(x => x.at > t.now); due.forEach(x => x.f()); await settle(); };
  return { t, store, q, calls };
}
const page = (jo, p, extra) => Object.assign({ jo, page: p, filename: `${jo}-p${p}.jpg`, image: 'data:image/jpeg;base64,AAAA', thumb: 't' }, extra);
const netErr = () => { const e = new Error('Failed to fetch'); return e; };

(async () => {
  { // 1. happy path, one at a time, in order
    let inFlight = 0, maxIn = 0;
    const r = rig(async () => { inFlight++; maxIn = Math.max(maxIn, inFlight); await tick(); inFlight--; return { ok: true, joFound: ['26-001'], match: true }; });
    await r.q.add(page('26-001', 1)); await r.q.add(page('26-001', 2)); await r.q.add(page('26-001', 3)); await settle();
    ok(r.calls.join() === '26-001-p1.jpg,26-001-p2.jpg,26-001-p3.jpg', 'uploads in order');
    ok(maxIn === 1, 'one upload at a time');
    ok(r.q.counts().saved === 3 && r.q.counts().pending === 0, 'all saved');
    ok(r.q.list().every(x => x.image === '' && x.thumb === 't'), 'image dropped after save, thumbnail kept');
    ok(Q.label(r.q.list()[0]) === 'Saved ✓ JO verified', 'verified label');
  }
  { // 2. persistence: a new queue on the same store (reload / new tab) picks up waiting + interrupted uploads
    const r = rig(async () => new Promise(() => {})); // never answers (tab closes mid-upload)
    await r.q.add(page('26-002', 1)); await r.q.add(page('26-002', 2)); await settle();
    ok([...r.store._map.values()].some(x => x.state === 'uploading'), 'first page uploading when tab "closes"');
    const calls = []; const q2 = Q.create({ store: r.store, send: async it => { calls.push(it.filename); return { ok: true, joFound: [] }; } });
    await q2.load(); ok(q2.counts().waiting === 2, 'after reload: interrupted upload is back to waiting');
    q2.kick(); await settle();
    ok(calls.join() === '26-002-p1.jpg,26-002-p2.jpg' && q2.counts().saved === 2, 'after reload: queue drains');
    ok(Q.label(q2.list()[0]).includes('no JO number'), 'saved without JO read label');
  }
  { // 3. network errors: backoff, then success; same filename every retry
    const r = rig(async (it, k) => { if (k < 3) throw netErr(); return { ok: true, joFound: ['26-003'] }; });
    await r.q.add(page('26-003', 1)); await settle();
    let it = r.q.list()[0];
    ok(it.state === 'waiting' && it.tries === 1 && it.nextAt === r.t.now + Q.BACKOFF[0], 'first failure waits 3s');
    await r.t.advance(Q.BACKOFF[0]); it = r.q.list()[0];
    ok(it.tries === 2 && it.nextAt === r.t.now + Q.BACKOFF[1], 'second failure waits longer');
    await r.t.advance(Q.BACKOFF[1]);
    ok(r.q.list()[0].state === 'saved' && r.calls.every(f => f === '26-003-p1.jpg') && r.calls.length === 3, 'third try saved, same file name each try');
  }
  { // 4. offline: no tries burned, resumes on wake()
    const r = rig(async () => ({ ok: true, joFound: ['26-004'] }));
    r.t.online = false; await r.q.add(page('26-004', 1)); await settle();
    ok(r.calls.length === 0 && r.q.list()[0].state === 'waiting' && r.q.list()[0].tries === 0, 'offline: waits, no attempt');
    ok(Q.label(r.q.list()[0], false) === 'Waiting for internet', 'offline label');
    r.t.online = true; r.q.wake(); await settle();
    ok(r.q.counts().saved === 1, 'online again: uploaded');
  }
  { // 5. too many failures -> Failed; Retry; Remove
    const r = rig(async () => { throw netErr(); });
    await r.q.add(page('26-005', 1)); await settle();
    for (const ms of Q.BACKOFF) await r.t.advance(ms);
    ok(r.q.list()[0].state === 'failed' && r.calls.length === Q.MAX_TRIES, 'gives up after ' + Q.MAX_TRIES + ' tries -> Failed');
    ok(Q.label(r.q.list()[0]) === 'Failed: Failed to fetch', 'failed label has the reason');
    ok(r.q.list()[0].image, 'failed page keeps its image for Retry');
    await r.q.retry(r.q.list()[0].id); await settle();
    ok(r.calls.length === Q.MAX_TRIES + 1, 'Retry tries again at once');
    await r.q.remove(r.q.list()[0].id); ok(r.q.counts().total === 0 && r.store._map.size === 0, 'Remove deletes it from the phone');
  }
  { // 6. server refusal is permanent (no pointless retries)
    const r = rig(async () => { const e = new Error('Bad token'); e.permanent = true; throw e; });
    await r.q.add(page('26-006', 1)); await settle();
    ok(r.q.list()[0].state === 'failed' && r.calls.length === 1, 'Bad token fails at once');
  }
  { // 7. mismatch
    const r = rig(async () => ({ ok: true, joFound: ['26-099'], match: false }));
    await r.q.add(page('26-007', 1)); await settle();
    ok(r.q.list()[0].state === 'mismatch' && Q.label(r.q.list()[0]).includes('26-099'), 'mismatch state + label');
  }
  { // 8. re-shoot of the same page replaces the queued one (no duplicate entry)
    let release; const r = rig(async (it, k) => { if (k === 1) await new Promise(res => { release = res; }); return { ok: true, joFound: [] }; });
    await r.q.add(page('26-008', 1, { image: 'old' })); await settle();
    await r.q.add(page('26-008', 1, { image: 'new' })); release(); await settle();
    ok(r.q.counts().total === 1 && r.q.counts().saved === 1 && r.calls.length === 2, 're-shoot while uploading: one entry, newer photo uploaded last');
  }
  { // 9. saved items are cleared after a while, failed ones are not
    const r = rig(async it => { if (it.page === 2) { const e = new Error('x'); e.permanent = true; throw e; } return { ok: true, joFound: [] }; });
    await r.q.add(page('26-009', 1)); await r.q.add(page('26-009', 2)); await settle();
    r.t.now += 13 * 3600e3; await r.q.prune();
    ok(r.q.counts().saved === 0 && r.q.counts().failed === 1, 'saved cleared after 12h, failed kept');
  }
  { // 10. backend: retrying the same page replaces the Drive file (idempotent, no duplicates)
    const g = load(); const img = Buffer.from('jpeg').toString('base64');
    for (let i = 0; i < 3; i++) g.call({ jo: '26-010', page: 1, filename: '26-010-p1.jpg', imageBase64: img });
    const root = g.DriveApp.getRootFolder(); const cards = root.getFoldersByName('Job Order Cards').next(); const fld = cards.getFoldersByName('26-010').next();
    let c = 0; const it = fld.getFilesByName('26-010-p1.jpg'); while (it.hasNext()) { it.next(); c++; }
    ok(c === 1, 'backend: 3 uploads of the same page leave one Drive file');
  }
  console.log('queue tests passed:', n);
})().catch(e => { console.error(e); process.exit(1); });
