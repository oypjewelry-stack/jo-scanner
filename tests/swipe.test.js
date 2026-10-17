// Swipe-to-delete on the scanner page strip: gesture rules, phone queue, Drive delete safety (Code.gs deletePage_ + JobSync markScanDeleted_).
const assert = require('assert'); const fs = require('fs'); const vm = require('vm'); const Q = require('../queue.js'); const load = require('./gasmock');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const tick = () => new Promise(r => setImmediate(r)); async function settle() { for (let i = 0; i < 40; i++) await tick(); }
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const grab = name => { const one = src.match(new RegExp('^(?:async )?function ' + name + '\\([^)]*\\) \\{[^\\n]*\\}$', 'm')); return one ? one[0] : src.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'))[0]; };

(async () => {
  // 1. gesture rules
  const G = new Function(src.match(/const SWIPE = \{[^\n]*\};/)[0] + grab('swipeAxis') + grab('swipePast') + '; return { swipeAxis, swipePast, SWIPE };')();
  ok(G.swipeAxis(-4, 3) === null && G.swipeAxis(-12, 2) === 'h', 'small moves wait; a clear left drag is a swipe');
  ok(G.swipeAxis(3, 30) === 'v' && G.swipeAxis(-14, 12) === 'v', 'up/down (or diagonal) stays a scroll');
  ok(G.swipeAxis(30, 1) === 'v', 'right drag never deletes');
  ok(!G.swipePast(-79, 200) && G.swipePast(-80, 200) && !G.swipePast(-120, 360) && G.swipePast(-126, 360), 'threshold: 80px or 35% of the row, whichever is more');
  ok(/data-sw=/.test(grab('rowHtml')) && /it\.state !== 'failed'/.test(grab('rowHtml')) && /data-rm=/.test(grab('rowHtml')), 'failed rows keep Retry/Remove and are not swipeable');
  ok(/touch-action:pan-y/.test(fs.readFileSync(__dirname + '/../style.css', 'utf8')), 'rows allow vertical scrolling (touch-action: pan-y)');

  // 2. phone queue
  function rig(sendImpl, delImpl) {
    const t = { now: 1000, online: true, timers: [] }, store = Q.memoryStore(), sent = [], dels = [], notes = [];
    const opts = { store, now: () => t.now, online: () => t.online,
      setTimeout: (f, ms) => { const x = { f, at: t.now + ms }; t.timers.push(x); return x; }, clearTimeout: x => { t.timers = t.timers.filter(y => y !== x); },
      send: async it => { sent.push(it.filename); return sendImpl(it); }, del: async it => { dels.push(Object.assign({}, it)); return delImpl(it, dels.length); }, onDeleted: (it, r) => notes.push([it.page, r]) };
    const q = Q.create(opts);
    t.advance = async ms => { t.now += ms; const due = t.timers.filter(x => x.at <= t.now); t.timers = t.timers.filter(x => x.at > t.now); due.forEach(x => x.f()); await settle(); };
    return { t, store, q, sent, dels, notes, opts };
  }
  const pg = (p, extra) => Object.assign({ jo: '26-001', page: p, filename: `26-001-p${p}-101726.jpg`, scan: '26-001@s', image: 'data:image/jpeg;base64,AAAA', thumb: 't' }, extra);
  { const r = rig(async () => new Promise(() => {}), async () => ({ ok: true, deleted: 1 }));
    r.t.online = false; await r.q.add(pg(1)); await settle(); const id = r.q.list()[0].id;
    const x = await r.q.discard(id); r.t.online = true; r.q.wake(); await settle();
    ok(x.phase === 'removed' && r.q.list().length === 0 && r.sent.length === 0 && r.dels.length === 0, 'waiting page: removed from the phone, never uploaded, nothing to delete in Drive'); }
  { const r = rig(async it => ({ ok: true, match: true, joFound: ['26-001'], fileId: 'F' + it.page, filename: it.filename.replace('.jpg', 'b.jpg') }), async () => ({ ok: true, deleted: 1 }));
    await r.q.add(pg(1)); await r.q.add(pg(2)); await settle();
    ok(r.q.list()[0].fileId === 'F1' && r.q.list()[0].savedName === '26-001-p1-101726b.jpg', 'upload reply fileId + saved name kept on the page');
    const x = await r.q.discard(r.q.list()[0].id); await settle();
    ok(x.phase === 'deleting' && r.dels.length === 1 && r.dels[0].fileId === 'F1' && r.dels[0].savedName === '26-001-p1-101726b.jpg', 'saved page: Drive delete sent with its file id + name');
    ok(r.q.list().length === 1 && r.q.list()[0].page === 2 && r.q.counts().total === 1 && r.store._map.size === 1 && r.notes[0][1].deleted === 1, 'gone from the list and the store; "deleted" reported'); }
  { let answer; const r = rig(it => new Promise(res => { answer = () => res({ ok: true, match: true, joFound: [], fileId: 'FX', filename: it.filename }); }), async () => ({ ok: true, deleted: 1 }));
    await r.q.add(pg(3)); await settle(); ok(r.q.list()[0].state === 'uploading', 'page is uploading');
    const x = await r.q.discard(r.q.list()[0].id); await settle();
    ok(x.phase === 'after-upload' && r.q.list().length === 0 && r.dels.length === 0, 'uploading page: hidden at once, delete waits for the upload');
    answer(); await settle();
    ok(r.dels.length === 1 && r.dels[0].fileId === 'FX' && r.store._map.size === 0, 'when the upload answers, its saved file is trashed'); }
  { let fail; const r = rig(() => new Promise((_, rej) => { fail = () => rej(new Error('timed out')); }), async () => ({ ok: true, deleted: 1 }));
    await r.q.add(pg(4)); await settle(); await r.q.discard(r.q.list()[0].id); fail(); await settle();
    ok(r.dels.length === 1 && !r.dels[0].fileId && r.dels[0].scan === '26-001@s' && r.dels[0].page === 4, 'upload timed out after the swipe: delete by session + page (in case it got saved)'); }
  { const r = rig(async it => ({ ok: true, match: true, joFound: [], fileId: 'F9', filename: it.filename }), async (it, k) => { if (k < 3) throw new Error('no connection'); return { ok: true, deleted: 1 }; });
    await r.q.add(pg(5)); await settle(); await r.q.discard(r.q.list()[0].id); await settle();
    ok(r.dels.length === 1 && r.store._map.size === 1 && r.q.list().length === 0, 'no connection: delete kept (hidden) for a retry');
    await r.t.advance(4000); await r.t.advance(11000); await settle();
    ok(r.dels.length === 3 && r.store._map.size === 0 && r.notes.length === 1, 'retried with backoff until Drive confirms');
    // reload in the middle of a pending delete
    const r2 = rig(async it => ({ ok: true, match: true, joFound: [], fileId: 'G', filename: it.filename }), async () => { throw new Error('no connection'); });
    await r2.q.add(pg(6)); await settle(); await r2.q.discard(r2.q.list()[0].id); await settle();
    const dels = []; const q3 = Q.create({ store: r2.store, send: async () => ({ ok: true }), del: async it => { dels.push(it.fileId); return { ok: true, deleted: 1 }; } });
    await q3.load(); await settle(); ok(dels.join() === 'G' && q3.list().length === 0 && r2.store._map.size === 0, 'after a reload the pending delete still goes through'); }
  { const r = rig(async it => ({ ok: true, match: true, joFound: [], fileId: 'F1', filename: it.filename }), async () => ({ unsupported: true }));
    await r.q.add(pg(7)); await settle(); await r.q.discard(r.q.list()[0].id); await settle();
    ok(r.notes[0][1].unsupported && r.store._map.size === 0, 'old script: removed from phone, reported as needing the update'); }
  { const r = rig(async it => ({ ok: true, match: true, joFound: [] }), async () => ({ ok: true }));
    await r.q.add(pg(8)); await settle(); const id = r.q.list()[0].id; await r.q.discard(id);
    ok((await r.q.discard(id)).phase === 'none', 'a second discard does nothing'); }

  // 3. app deletePage(): reply mapping (old script says "Missing image")
  const mk = reply => new Function('fetch', 'api', 'LS', 'localStorage', grab('deletePage') + '; return deletePage;')(async () => ({ json: async () => reply, status: 200 }), () => 'x', { token: 't' }, { getItem: () => 'tok' });
  ok((await mk({ ok: false, error: 'Missing image' })({ jo: '26-001', page: 1 })).unsupported, 'old Code.gs ("Missing image") -> unsupported, no crash');
  ok((await mk({ ok: true, deleted: 1 })({ jo: '26-001', page: 1 })).deleted === 1, 'new Code.gs -> deleted');
  let threw = null; try { await mk({ ok: false, error: 'Not a page of this JO', code: 'FORBIDDEN' })({ jo: '26-001' }); } catch (e) { threw = e; }
  ok(threw && threw.permanent, 'refused by the server -> not retried');
  const oldGs = require('child_process').execSync('git -C ' + __dirname + '/.. show 9ea15b5:apps-script/Code.gs').toString();
  const go = load(); vm.runInContext(oldGs, go); const oldR = go.call({ op: 'deletePage', jo: '26-001', page: 1, scan: 's' });
  ok(!oldR.ok && /missing image/i.test(oldR.error), 'the live (rescan) Code.gs really answers "Missing image" to a delete');

  // 4. backend safety
  const g = load(); g._.props.SEED_USERS = 'miriam:admin:3816'; g.setupAuth(); g.setupJobs();
  const adm = g.call({ action: 'login', username: 'miriam', code: '3816', device_id: 'm' }).session;
  const img = Buffer.from('jpeg').toString('base64');
  const up = (jo, p, scan, tag) => g.call({ jo, page: p, scan, filename: `${jo}-p${p}-${tag || '101726'}.jpg`, imageBase64: img });
  const a1 = up('26-001', 1, '26-001@a', '101526'), a2 = up('26-001', 2, '26-001@a', '101526'), b1 = up('26-001', 1, '26-001@b'), b2 = up('26-001', 2, '26-001@b'), o1 = up('26-002', 1, '26-002@x');
  ok(b1.fileId && b1.filename === '26-001-p1-101726.jpg', 'upload reply has fileId');
  const F = id => g._.fileReg[id], ocr = id => { const d = g._.sheets.OcrLog.data, h = d[0]; const r = d.find(x => x[h.indexOf('file_id')] === id); return r[h.indexOf('review_state')]; };
  let r = g.call({ op: 'deletePage', jo: '26-001', file_id: o1.fileId });
  ok(r.code === 'FORBIDDEN' && !F(o1.fileId).trashed, "another JO's file is refused (wrong folder)");
  const stray = g.DriveApp.getRootFolder().getFoldersByName('Job Order Cards').next().getFoldersByName('26-001').next().createFile({ name: 'invoice.pdf' });
  r = g.call({ op: 'deletePage', jo: '26-001', file_id: stray.id }); ok(r.code === 'FORBIDDEN' && !stray.trashed, 'a non-page file in the JO folder is refused');
  const elsewhere = g.DriveApp.getRootFolder().createFile({ name: '26-001-p1-101726.jpg' });
  r = g.call({ op: 'deletePage', jo: '26-001', file_id: elsewhere.id }); ok(r.code === 'FORBIDDEN' && !elsewhere.trashed, 'a same-named file outside Job Order Cards/26-001 is refused');
  r = g.call({ op: 'deletePage', jo: '26-001', file_id: b2.fileId, filename: '26-001-p1-101726.jpg' }); ok(r.code === 'FORBIDDEN' && !F(b2.fileId).trashed, 'file id + a different name is refused');
  r = g.call({ op: 'deletePage', jo: '26-001', file_id: b2.fileId, filename: b2.filename });
  ok(r.ok && r.deleted === 1 && F(b2.fileId).trashed && F(b2.fileId).trashed === true, 'deleted = moved to Drive Trash');
  const fld = g.DriveApp.getRootFolder().getFoldersByName('Job Order Cards').next().getFoldersByName('26-001').next();
  ok(fld.files.some(x => x.id === b2.fileId), 'never deleted for good (the file still exists, trashed)');
  ok(ocr(b2.fileId) === 'deleted' && r.marked === 1, 'its OcrLog row is marked deleted');
  let j = g.call({ action: 'jobReviewList', session: adm, device_id: 'm' }).jobs.find(x => x.jo === '26-001');
  ok(j.pages.map(p => p.page).join() === '1' && j.pages_set === '101726' && j.history[0].pages.length === 2, 'back office: deleted page gone; newest set still first');
  ok(g.call({ action: 'jobPhoto', session: adm, jo: '26-001', file_id: b2.fileId, device_id: 'm' }).code === 'FORBIDDEN', 'a deleted page photo is no longer served');
  r = g.call({ op: 'deletePage', jo: '26-001', page: 1, scan: '26-001@b' });
  ok(r.ok && r.deleted === 1 && F(b1.fileId).trashed && !F(a1.fileId).trashed, 'delete by session + page trashes only that session\'s page');
  j = g.call({ action: 'jobReviewList', session: adm, device_id: 'm' }).jobs.find(x => x.jo === '26-001');
  ok(j.pages_set === '101526' && j.pages.length === 2 && j.history.length === 0, 'whole newest set deleted -> the earlier scan is newest again');
  ok(g.call({ op: 'deletePage', jo: '26-001', page: 1, scan: '' }).ok === false && !F(a1.fileId).trashed, 'no session and no file id -> refused');
  ok(g.call({ op: 'deletePage', jo: '26-001', file_id: b2.fileId }).deleted === 0, 'deleting twice is harmless');
  ok(g.call({ op: 'deletePage', jo: '26-404', page: 1, scan: 's' }).deleted === 0, 'unknown JO: nothing to delete');
  g._.props.TOKEN = 'sekret';
  r = g.call({ op: 'deletePage', jo: '26-001', file_id: a2.fileId }); ok(r.error === 'Bad token' && !F(a2.fileId).trashed, 'with TOKEN set, a delete without it is refused');
  r = g.call({ token: 'sekret', op: 'deletePage', jo: '26-001', file_id: a2.fileId }); ok(r.ok && F(a2.fileId).trashed, 'same TOKEN as uploads works');
  ok(g._.sheets.AuditLog.data.some(x => x.includes('scanDeleted')), 'delete written to the AuditLog');
  const g2 = load(); vm.runInContext('markScanDeleted_ = undefined;', g2); const u = g2.call({ jo: '26-005', page: 1, scan: 'z', filename: '26-005-p1-101726.jpg', imageBase64: img });
  ok(g2.call({ op: 'deletePage', jo: '26-005', file_id: u.fileId }).deleted === 1, 'works even without JobSync (typeof-guarded)');
  console.log('swipe tests passed:', n);
})().catch(e => { console.error(e); process.exit(1); });
