/* OYP Card Scanner — static front-end, no build step. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const LS = { api: 'oypScanApi', token: 'oypScanToken', rotate: 'oypScanRotate', auto: 'oypScanAuto', crop: 'oypScanCrop', role: 'oypScanRole', printJo: 'oypScanPrintJo', printTag: 'oypScanPrintTag' };
const qs = new URLSearchParams(location.search);
if (qs.get('api')) localStorage.setItem(LS.api, qs.get('api'));
if (qs.get('token')) localStorage.setItem(LS.token, qs.get('token'));
if (qs.has('role')) { // set by the back-office menu link: which menu items to show here
  if (qs.get('role')) localStorage.setItem(LS.role, qs.get('role')); else localStorage.removeItem(LS.role);
  qs.delete('role'); history.replaceState(null, '', location.pathname + (String(qs) ? '?' + qs : '') + location.hash);
}
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { jo: '', page: 0, scan: '', stream: null, loop: null, lastQuad: null, steadySince: 0, armed: true, cooldownUntil: 0 };
// Upload size: 1600px long edge, JPEG 0.8. Measured against a phone-sized card photo (see the PR):
// the JO number still OCRs cleanly, and the file is much smaller than the old 2400px / 0.9 camera path.
// Live shots and camera photos use the same size. The source is capped there too: the detector looks at 480px.
const MAX_PX = 1600, QUALITY = 0.8, THUMB_PX = 160, STEADY_MS = 900, COOLDOWN_MS = 2500;
const PHOTO = { maxPx: MAX_PX, quality: QUALITY }, PHOTO_SRC_PX = MAX_PX;
const JPEG_WORKER = 'jpeg-worker.js?v=20261021b';

/* ---------- JO normalisation (shared logic with Code.gs) ---------- */
function normJO(s) {
  // keeps a revision letter: '26-005B', '26-005 b' -> '26-005B'
  const m = String(s || '').toUpperCase().match(/(\d{2})\s*[-,.\/ ]?\s*(\d{3,4})(?:\s?([A-Z])(?![A-Z0-9]))?/);
  return m ? m[1] + '-' + m[2] + (m[3] || '') : String(s || '').trim().toUpperCase().replace(/^J\.?O\.?\s*#?\s*/, '');
}
window.normJO = normJO;
function realJO(s) { // a JO this phone will file. 'OCR' is the hold while the number is being read, not a number.
  const n = normJO(s);
  return /^\d{2}-\d{3,4}[A-Z]?$/.test(n) ? n : '';
}
function uniqueJOs(list) { // real JO numbers named in a readJo found list, once each
  const out = [];
  const found = Array.isArray(list) ? list : [];
  for (let i = 0; i < found.length; i++) {
    const n = realJO(found[i]);
    if (n && out.indexOf(n) < 0) out.push(n);
  }
  return out;
}
function joFromRead(r) { // readJo_ sets low when the crop text runs past 24 characters. One JO in found is still the number.
  if (!r || r.ok === false) return '';
  if (uniqueJOs(r.found).length === 1) return realJO(r.jo);
  if (r.low) return '';
  return realJO(r.jo);
}
function joFromPage(r) { // a whole-page read is filed only when it names exactly one JO
  if (!r || r.ok === false) return '';
  const one = uniqueJOs(r.found);
  return one.length === 1 ? one[0] : '';
}
if (typeof module !== 'undefined' && module.exports) module.exports.normJO = normJO;

/* ---------- settings ---------- */
const DEFAULT_API = 'https://script.google.com/macros/s/AKfycbzUmacbdvb0V2nw9ekharFhZPYdSqVgpFpADKiPM2qhSUUF3G5pJ_cAZ46eQPxeawhV/exec';
const api = () => localStorage.getItem(LS.api) || DEFAULT_API;
function refreshWarn() { $('apiWarn').classList.toggle('hidden', !!api()); }
// cards are shot on their side (rotated 90° counter-clockwise), so pages are turned 90° clockwise by default
const ROT = { cw: 90, none: 0, ccw: -90, '180': 180 };
const rotation = () => { const v = localStorage.getItem(LS.rotate); return v in ROT ? v : 'cw'; };
function rotateCanvas(c, key) { // canvas pixels have no EXIF, so this is the only rotation (no double turn)
  const d = ROT[key == null ? rotation() : key] || 0; if (!d) return c;
  const o = document.createElement('canvas'), side = d % 180 !== 0;
  o.width = side ? c.height : c.width; o.height = side ? c.width : c.height;
  const x = o.getContext('2d'); x.translate(o.width / 2, o.height / 2); x.rotate(d * Math.PI / 180); x.drawImage(c, -c.width / 2, -c.height / 2);
  c.width = c.height = 0; return o;
}
function openSettings() { $('apiRotate').value = rotation(); $('apiUrl').value = api(); $('apiToken').value = localStorage.getItem(LS.token) || ''; $('settings').showModal(); }
$('btnSave').onclick = () => { localStorage.setItem(LS.rotate, $('apiRotate').value); localStorage.setItem(LS.api, $('apiUrl').value.trim()); localStorage.setItem(LS.token, $('apiToken').value.trim()); refreshWarn(); queue.retryFailed(); queue.wake(); };
refreshWarn();

/* ---------- back-office menu (same list as oypjewelry.com, from its nav.js; copy below if offline) ---------- */
const STAFF_URL = 'https://oypjewelry.com/staff/'; // back office (oypjewelry.com/ itself is the customer landing page)
const NAV_FALLBACK = { SITE: STAFF_URL, STAFF: STAFF_URL, OFFICE_NAV: { // same full lists as nav.js OFFICE_NAV, used only if that file has not loaded
  admin: [['dashboard', 'Dashboard'], ['appts', 'Appointments'], ['jos', 'Inventory'], ['consignment', 'Consignment'], ['review', 'To review'], ['scanner', 'Scanner'], ['production', 'Production'], ['estimate', 'Cost estimator'], ['inventory', 'Materials'], ['prices', 'Material prices'], ['customers', 'Customers'], ['payments', 'Quotes / payments'], ['shop', 'Shop listings'], ['settings', 'Settings']],
  production_manager: [['dashboard', 'Dashboard'], ['appts', 'Appointments'], ['jos', 'Inventory'], ['consignment', 'Consignment'], ['review', 'To review'], ['scanner', 'Scanner'], ['production', 'Production'], ['estimate', 'Cost estimator'], ['inventory', 'Materials'], ['prices', 'Material prices'], ['balances', 'Balances']],
  accounting: [['dashboard', 'Dashboard'], ['appts', 'Appointments'], ['jos', 'Inventory (view)'], ['payments', 'Payments'], ['quotes', 'Quotes'], ['balances', 'Balances'], ['clients', 'Clients (billing)']],
  staff: [['home', 'Home'], ['appts', 'Appointments'], ['scanner', 'Scanner']] } };
function menuUser(N, role) {
  let saved = null;
  try { saved = N.readUser && N.readUser(); } catch (e) {}
  const r = (saved && saved.role) || role;
  if (!r) return null;
  if (saved && saved.role === r) return saved;
  return { role: r, username: (saved && saved.username) || 'device' };
}
function menuItems(N, role) { // full staff list, in the user's saved order when nav.js provides it. Not the shortened scanner list.
  const user = menuUser(N, role), full = N.OFFICE_NAV || N.NAV || {};
  if (user && user.role === 'staff') return full.staff || null;
  if (user && typeof N.ordered === 'function') { const list = N.ordered(user); if (list && list.length) return list; }
  return user ? full[user.role] : null;
}
function printerRow() { // the shared nav.js row: plain text under Settings, green/red dot. Not a header button.
  const N = window.OYPNav;
  if (N && typeof N.printerItemHtml === 'function') return N.printerItemHtml();
  return '<a data-oyp-printer="1" role="button" tabindex="0" title="Printer not connected">Printer<span class="oyp-pr-dot" aria-hidden="true"></span></a>';
}
function buildMenu() {
  const N = window.OYPNav || NAV_FALLBACK, role = localStorage.getItem(LS.role), items = menuItems(N, role), site = N.STAFF || STAFF_URL, c = queue.counts();
  let h = '', placed = false;
  if (items) h = items.map(([k, t]) => {
    const a = k === 'scanner' ? `<a href="#" data-m="scanner" class="on">${esc(t)}</a>` : `<a href="${site}#/${k}">${esc(t)}</a>`;
    if (k === 'settings') { placed = true; return a + printerRow(); }
    return a;
  }).join('');
  else h = `<a href="${site}">${role === 'staff' ? 'Home' : 'Back office'}</a>`;
  if (!placed) h += printerRow(); // same place nav.js uses when the role has no Settings row
  h += `<hr><a href="#" data-m="queue">Pending uploads${c.pending + c.failed ? ` <span class="badge">${c.pending + c.failed}</span>` : ''}</a><a href="#" data-m="settings">Scanner settings</a>`;
  if (role) h += `<a href="${site}#/logout" data-m="logout">Log out</a>`;
  else h += `<p class="mnote">Open the scanner from the back-office menu once to see your full menu here.</p>`;
  return h;
}
const menu = $('menu');
$('btnMenu').onclick = e => { e.stopPropagation(); if (!menu.classList.contains('hidden')) return menu.classList.add('hidden'); menu.innerHTML = buildMenu(); menu.classList.remove('hidden'); };
menu.addEventListener('click', e => {
  const a = e.target.closest('[data-m]'); if (!a) return;
  const m = a.dataset.m; menu.classList.add('hidden');
  if (m === 'logout') { localStorage.removeItem(LS.role); return; } // the link signs out on the back office
  e.preventDefault();
  if (m === 'queue') showQueue(); else if (m === 'settings') openSettings();
  else if (m === 'scanner' && !$('queueView').classList.contains('hidden')) closeQueue();
});
document.addEventListener('click', e => { if (!e.target.closest('#menu,#btnMenu')) menu.classList.add('hidden'); });

/* ---------- views: start / scan / pending uploads ---------- */
let backTo = 'startView';
function showView(id) { ['startView', 'scanView', 'queueView', 'capView'].forEach(v => { const n = $(v); if (n) n.classList.toggle('hidden', v !== id); }); if (id === 'scanView') setTimeout(() => ensureLive('view'), 50); if (id === 'capView' || id === 'startView') applySticker(); }
function showQueue() { const cur = ['startView', 'scanView', 'capView'].find(v => { const n = $(v); return n && !n.classList.contains('hidden'); }); if (cur) backTo = cur; showView('queueView'); renderQueue(); window.scrollTo(0, 0); }
function closeQueue() { showView(backTo); }
$('btnQBack').onclick = closeQueue;
$('btnQueue').onclick = showQueue; $('scanStatus').onclick = showQueue;
$('btnRetryFailed').onclick = () => queue.retryFailed();

$('btnStart').onclick = async () => {
  const jo = normJO($('joInput').value);
  if (!jo) { $('joInput').focus(); return; }
  state.jo = jo; state.page = 0; state.scan = jo + '@' + Date.now().toString(36); state.armed = true; state.cooldownUntil = 0;
  $('joLabel').textContent = jo; updatePageLabel(); renderQueue();
  showView('scanView');
  $('btnScanJO').classList.remove('pulse');
  try { await startCamera(); } catch (e) { console.error(e); hint('Could not start: ' + (e.message || e)); }
};
$('joInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('joInput').blur(); $('btnScanJO').classList.add('pulse'); } }); // Enter: keyboard away, Scan JO ready
$('btnDone').onclick = () => {
  // nothing to confirm: every page is already stored on this phone and keeps uploading in the background
  const c = queue.counts();
  $('joInput').value = ''; showView('startView'); $('joInput').focus();
  if (c.pending) note(c.pending + (c.pending > 1 ? ' pages are' : ' page is') + ' still uploading. They keep going in the background, even if you close this page.');
};
function updatePageLabel() { $('pageLabel').textContent = String(state.page || 0); }
let noteTimer = null;
function note(t) { const n = $('note'); n.textContent = t; n.classList.remove('hidden'); clearTimeout(noteTimer); noteTimer = setTimeout(() => n.classList.add('hidden'), 4500); }

/* ---------- camera ---------- */
const video = $('video'), overlay = $('overlay'), work = $('work');
const liveStream = () => state.stream && state.stream.active && state.stream.getVideoTracks().some(t => t.readyState === 'live');
let acquiring = null;
function acquireStream() { // one getUserMedia at a time; reuse a live stream
  if (liveStream()) return Promise.resolve(state.stream);
  if (acquiring) return acquiring;
  acquiring = navigator.mediaDevices.getUserMedia({ audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } } })
    .then(s => { state.stream = s; video.srcObject = s; video.muted = true;
      s.getVideoTracks().forEach(t => { try { const fm = t.getCapabilities && (t.getCapabilities().focusMode || []); if (fm.includes && fm.includes('continuous')) t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); } catch (e) {} });
      s.getVideoTracks().forEach(t => { t.addEventListener('ended', () => ensureLive('track ended')); t.addEventListener('unmute', () => ensureLive('track unmuted')); });
      return s; })
    .finally(() => { acquiring = null; });
  return acquiring;
}
// called synchronously from the mic tap (user gesture) so iOS allows the camera
// the phone's own camera is the default now, and it can only open from a tap: after voice, pulse Scan JO for that one tap
window.prewarmCamera = () => Promise.resolve(false);
window.askTapToStart = () => { const b = $('btnScanJO'); b.classList.add('pulse'); b.focus(); };
async function startCamera() {
  try {
    await acquireStream();
    if (video.srcObject !== state.stream) video.srcObject = state.stream;
    await video.play();
    hint('Align the card inside the frame');
    runLoop();
  } catch (e) {
    console.error('startCamera failed', e); state.camError = e;
    // iOS can refuse camera start outside a tap (e.g. after voice); let the user tap the preview to retry
    hint('Camera blocked (' + (e && (e.name || e.message) || 'error') + '). Tap here to start the camera'); const h = $('hint');
    const retry = () => { h.removeEventListener('click', retry); video.removeEventListener('click', retry); startCamera(); };
    h.style.pointerEvents = 'auto'; h.addEventListener('click', retry); video.addEventListener('click', retry);
  }
}
function stopStream() { if (state.stream) state.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); state.stream = null; }
/* Live-view watchdog. Root cause of the frozen viewfinder: nothing ever restarted the live view. iOS pauses the <video> or
   mutes/ends the camera track (memory pressure after big captures, app switch, lock, notification, mic) and the element then
   keeps showing its last frame, i.e. the page just snapped. Now: resume on pause/visibility/unmute, and re-open the camera
   when the track ended or frames stop advancing. */
const scanLive = () => !$('scanView').classList.contains('hidden') && !review.open && document.visibilityState === 'visible';
let healing = false, lastT = -1, lastTAt = 0;
async function ensureLive(why) {
  if (healing || !scanLive()) return; healing = true;
  try {
    if (!liveStream()) { stopStream(); await acquireStream(); }
    if (video.srcObject !== state.stream) video.srcObject = state.stream;
    if (video.paused || video.ended) await video.play();
    lastTAt = Date.now(); state.heals = (state.heals || 0) + 1; state.lastHeal = why;
  } catch (e) {
    console.warn('camera restart failed (' + why + ')', e);
    hint('Camera paused. Tap here to restart it'); const h = $('hint');
    const retry = () => { h.removeEventListener('click', retry); video.removeEventListener('click', retry); startCamera(); };
    h.style.pointerEvents = 'auto'; h.addEventListener('click', retry); video.addEventListener('click', retry);
  } finally { healing = false; }
}
setInterval(() => {
  if (!scanLive() || !state.stream) { lastTAt = 0; return; }
  if (video.paused || video.ended || !liveStream()) return ensureLive('paused');
  const t = video.currentTime;
  if (t !== lastT) { lastT = t; lastTAt = Date.now(); return; }
  if (!lastTAt) { lastTAt = Date.now(); return; }
  if (Date.now() - lastTAt > 2500) { stopStream(); ensureLive('stalled'); } // frames stopped: re-open the camera
}, 700);
video.addEventListener('pause', () => setTimeout(() => ensureLive('video paused'), 150));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { setTimeout(() => ensureLive('visible'), 300); queue.wake(); } });
window.addEventListener('pageshow', () => setTimeout(() => ensureLive('pageshow'), 300));
function hint(t, ok) { const h = $('hint'); h.textContent = t; h.classList.toggle('ok', !!ok); }

/* ---------- OpenCV.js card detection (lazy-loaded) ---------- */
const CV_URLS = ['https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js', 'https://docs.opencv.org/4.9.0/opencv.js'];
let cvReady = null;
function loadCV() {
  if (cvReady) return cvReady;
  cvReady = new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= CV_URLS.length) { cvReady = null; return reject(new Error('detector failed to load')); }
      const sc = document.createElement('script'); sc.async = true; sc.src = CV_URLS[i++];
      // the Emscripten module is itself a thenable; strip .then so resolving with it can't loop forever
      const done = m => { try { delete m.then; } catch (e) {} if (typeof m.then === 'function') m.then = undefined; window.cv = m; resolve(m); };
      sc.onload = () => { const c = window.cv;
        if (!c) return tryNext();
        if (c.Mat) return done(c);
        if (typeof c.then === 'function') return c.then(done);
        c.onRuntimeInitialized = () => done(window.cv); };
      sc.onerror = () => { sc.remove(); tryNext(); };
      document.head.appendChild(sc);
    };
    tryNext();
  });
  return cvReady;
}
// start downloading the detector shortly after first load, so it's ready by the time a card starts
window.addEventListener('load', () => setTimeout(() => loadCV().catch(() => {}), 600));

const DW = 480;
// tiny grayscale signature of the current frame, used to tell "same page still there" from "page flipped"
const sigC = document.createElement('canvas'); sigC.width = 32; sigC.height = 24;
function frameSig() { const c = sigC.getContext('2d', { willReadFrequently: true }); c.drawImage(video, 0, 0, 32, 24);
  const d = c.getImageData(0, 0, 32, 24).data, o = new Float32Array(768); for (let i = 0; i < 768; i++) o[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3; return o; }
function sigDiff(a, b) { if (!a || !b) return 1; let t = 0; for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]); return t / a.length / 255; }
const SIG_CHANGE = 0.06;
// hands-free state: armed = ready to snap the next page; disarmed after a snap until the page changes
function detect(cv, el) { // el: the live video (default) or a photo canvas
  el = el || video; const vw = el.videoWidth || el.width, vh = el.videoHeight || el.height; if (!vw) return null;
  const s = DW / Math.max(vw, vh); work.width = Math.round(vw * s); work.height = Math.round(vh * s);
  const c = work.getContext('2d', { willReadFrequently: true }); c.drawImage(el, 0, 0, work.width, work.height);
  const m = cv.imread(work);
  try { const r = CardDetector.detectQuad(cv, m, { size: DW }); state.lastConf = r ? r.confidence : 0; state.lastDet = r ? { s: r.support, r: r.rect, a: r.asp, st: r.step, v: r.votes, m: r.method, cut: r.cut, w: r.white } : null; return r ? r.quad : null; } finally { m.delete(); }
}

function drawQuad(q, ok) {
  const r = overlay.getBoundingClientRect(); overlay.width = r.width; overlay.height = r.height;
  const c = overlay.getContext('2d'); c.clearRect(0, 0, r.width, r.height); if (!q) return;
  const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(r.width / vw, r.height / vh);
  const ox = (r.width - vw * s) / 2, oy = (r.height - vh * s) / 2;
  c.strokeStyle = ok ? '#d4af37' : 'rgba(255,255,255,.9)'; c.lineWidth = 4; c.fillStyle = ok ? 'rgba(212,175,55,.18)' : 'rgba(255,255,255,.08)';
  c.beginPath(); q.forEach(([x, y], i) => c[i ? 'lineTo' : 'moveTo'](ox + x * vw * s, oy + y * vh * s)); c.closePath(); c.fill(); c.stroke();
}

const SMOOTH = 0.5, STEADY_TOL = 0.018, LOST_FRAMES = 3;
let missCount = 0, busy = false;
function runLoop() {
  clearInterval(state.loop);
  if (!window.cv || !window.cv.Mat) hint('Loading detector…');
  loadCV().then(cv => {
    clearInterval(state.loop);
    state.loop = setInterval(() => {
      if (busy || $('scanView').classList.contains('hidden') || review.open) return;
      busy = true;
      let q = null; try { q = detect(cv); } catch (e) { console.warn(e); }
      busy = false;
      const now = Date.now();
      if (!state.armed && (missCount >= LOST_FRAMES || sigDiff(frameSig(), state.snapSig) > SIG_CHANGE)) state.armed = true; // page removed / flipped
      if (!q) {
        if (++missCount < LOST_FRAMES && state.lastQuad) return; // ignore a single dropped frame
        state.lastQuad = null; state.steadySince = 0; drawQuad(null);
        hint($('autoSnap').checked ? 'Looking for the card… (tap shutter to crop by hand)' : 'Tap the shutter to capture'); return;
      }
      missCount = 0;
      const prev = state.lastQuad;
      const moved = prev ? CardDetector.maxDist(q, prev) : 1;
      // temporal smoothing of corners; a big jump means a new card/page, so reset
      const sm = prev && moved < 0.08 ? q.map((p, i) => [prev[i][0] * SMOOTH + p[0] * (1 - SMOOTH), prev[i][1] * SMOOTH + p[1] * (1 - SMOOTH)]) : q;
      if (moved > STEADY_TOL) state.steadySince = now;
      state.recentMoves = (state.recentMoves || []).concat(moved < 1 ? moved : 0).slice(-8);
      state.lastQuad = sm;
      const steady = now - state.steadySince >= STEADY_MS;
      drawQuad(sm, steady);
      if (now < state.cooldownUntil || !state.armed) { if (!state.armed && prev && moved > 0.08) state.armed = true; else { hint('Captured. Flip to the next page', true); return; } }
      // smoothed detector confidence over recent frames; temporal stability adds the rest
      state.confAvg = state.confAvg == null ? state.lastConf : state.confAvg * 0.6 + state.lastConf * 0.4;
      if (!$('autoSnap').checked) { hint('Card found. Tap the shutter', true); return; }
      if (steady) capture(sm, true, finalConfidence(state.confAvg, now - state.steadySince)); else hint('Card found. Hold steady…');
    }, 120);
  }).catch(() => hint('Detector unavailable: tap the shutter and set corners by hand'));
}

/* ---------- capture -> review (draggable corners) -> warp ---------- */
const review = { open: false, src: null, quad: null, replace: null, opt: null };
// Auto-accept: final = 0.85 * detector confidence + 0.15 * stability (1.0 once steady >= STEADY_MS)
const AUTO_ACCEPT = 0.80;
function finalConfidence(det, steadyMs) { return 0.85 * (det || 0) + 0.15 * Math.min(1, steadyMs / STEADY_MS); }
const enhanceOn = () => localStorage.getItem('enhance') !== '0';
$('btnCapture').onclick = () => capture(state.lastQuad, false);
// remembered toggles: auto-snap OFF unless turned on; crop ON unless turned off
$('autoSnap').checked = localStorage.getItem(LS.auto) === '1';
$('autoSnap').onchange = () => localStorage.setItem(LS.auto, $('autoSnap').checked ? '1' : '0');
$('doCrop').checked = localStorage.getItem(LS.crop) !== '0';
$('doCrop').onchange = () => localStorage.setItem(LS.crop, $('doCrop').checked ? '1' : '0');
function flashSnap() { const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
function capture(quad, auto, conf) {
  if (!video.videoWidth || review.open) return;
  state.armed = false; state.snapSig = frameSig(); state.snaps = (state.snaps || 0) + 1;
  const vw = video.videoWidth, vh = video.videoHeight;
  const src = document.createElement('canvas'); src.width = vw; src.height = vh; src.getContext('2d').drawImage(video, 0, 0);
  if (navigator.vibrate) navigator.vibrate(40); flashSnap();
  const q = quad ? quad.map(p => p.slice()) : [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]];
  if (!$('doCrop').checked) { const pg = savePage(src, null); src.width = src.height = 0; return pg; }
  let raw = q;
  if (quad && window.cv && window.cv.Mat) { // snap detected corners to the true card edges + small inset
    raw = q.map(p => p.slice());
    try { const m = cv.imread(src); const r = CardDetector.refineQuad(cv, m, CardDetector.order(q)); m.delete(); q.splice(0, 4, ...r); } catch (e) { console.warn('refine', e); } }
  const why = quad ? gateReason(state.lastDet, quad, raw, q) : 'manual';
  if (conf == null) conf = finalConfidence(state.confAvg, Date.now() - state.steadySince); // manual tap: same clean-detection test state.gateWhy = why; state.gateDbg = quad && { q: CardDetector.order(quad).map(p => p.map(v => +v.toFixed(3))), rf: +CardDetector.maxDist(CardDetector.order(raw), CardDetector.order(q)).toFixed(3) };
  if (quad && conf >= AUTO_ACCEPT && !why) { const pg = savePage(src, CardDetector.order(q)); showToast(pg, src, q); state.cooldownUntil = Date.now() + COOLDOWN_MS; state.steadySince = Date.now(); return; }
  openReview(src, q, !!quad);
}
// Confidence gate: auto-save only when every signal is clean; otherwise open the corner check.
// Returns a reason string when unsure, or '' when it is safe to auto-save.
function gateReason(d, quad, raw, refined) {
  if (!d) return 'no-detail';
  const B = 0.02, o = CardDetector.order(quad), nb = ([x, y]) => x < B || y < B || x > 1 - B || y > 1 - B;
  // a whole side lying on the frame border = the card is (or may be) cut off, or we locked onto a sheet behind it
  if (d.cut || [0, 1, 2, 3].some(i => nb(o[i]) && nb(o[(i + 1) % 4]))) return 'touches-frame';
  if (CardDetector.maxDist(CardDetector.order(raw), CardDetector.order(refined)) > 0.06) return 'big-refit';
  if (d.r < 0.85) return 'not-rectangular';
  if (d.a < 0.8) return 'wrong-aspect';
  if (d.st < 0.75) return 'low-contrast';
  if (d.s < 0.7) return 'weak-edges';
  if ((state.recentMoves || []).some(m => m > 0.03)) return 'unstable';
  return '';
}
let toastTimer = null;
function showToast(pg, src, q) {
  const t = $('toast'); $('toastImg').src = pg.thumb; t.classList.remove('hidden');
  $('toastAdjust').onclick = () => { clearTimeout(toastTimer); t.classList.add('hidden'); openReview(src, q.map(p => p.slice()), true, pg); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 1600);
}
function openReview(src, q, found, replace, opt) {
  review.open = true; review.src = src; review.quad = q; review.replace = replace || null; review.opt = opt || null;
  $('rvRetake').textContent = opt ? 'Cancel' : 'Retake';
  $('rvEnhance').checked = enhanceOn();
  $('rvTitle').textContent = found ? 'Check the crop' : 'Card not found';
  $('rvSub').textContent = found ? 'Drag the corners if needed, then Use' : 'Drag the corners to the card, or tap Skip crop';
  $('review').classList.remove('hidden');
  requestAnimationFrame(() => { layoutReview(); updatePreview(); });
}
let pvTimer = null;
function updatePreview() { // live preview of the final crop (with/without enhancement)
  clearTimeout(pvTimer); pvTimer = setTimeout(() => {
    if (!review.open) return; const c = renderOut(review.src, CardDetector.order(review.quad.map(p => p.slice())), $('rvEnhance').checked, 700);
    $('rvPreview').src = c.toDataURL('image/jpeg', 0.7); }, 120);
}
$('rvEnhance').onchange = () => { localStorage.setItem('enhance', $('rvEnhance').checked ? '1' : '0'); updatePreview(); };
function rvGeom() {
  const box = $('rvStage').getBoundingClientRect(), W = review.src.width, H = review.src.height;
  const s = Math.min(box.width / W, box.height / H);
  return { s, ox: (box.width - W * s) / 2, oy: (box.height - H * s) / 2, W, H };
}
function layoutReview() {
  const cvs = $('rvCanvas'), g = rvGeom();
  cvs.width = Math.round(g.W * g.s * devicePixelRatio); cvs.height = Math.round(g.H * g.s * devicePixelRatio);
  cvs.style.width = g.W * g.s + 'px'; cvs.style.height = g.H * g.s + 'px'; cvs.style.left = g.ox + 'px'; cvs.style.top = g.oy + 'px';
  cvs.getContext('2d').drawImage(review.src, 0, 0, cvs.width, cvs.height);
  drawReview();
}
function drawReview() {
  const g = rvGeom(), sv = $('rvLines'), box = $('rvStage').getBoundingClientRect();
  const P = review.quad.map(([x, y]) => [g.ox + x * g.W * g.s, g.oy + y * g.H * g.s]);
  sv.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const pts = P.map(p => p.join(',')).join(' ');
  sv.innerHTML = `<defs><mask id="m"><rect width="100%" height="100%" fill="#fff"/><polygon points="${pts}" fill="#000"/></mask></defs>` +
    `<rect width="100%" height="100%" fill="rgba(0,0,0,.45)" mask="url(#m)"/><polygon points="${pts}" fill="none" stroke="#d4af37" stroke-width="3"/>`;
  document.querySelectorAll('#rvStage .handle').forEach((h, i) => { h.style.left = P[i][0] + 'px'; h.style.top = P[i][1] + 'px'; });
}
document.querySelectorAll('#rvStage .handle').forEach((h, i) => {
  let off = null;
  h.addEventListener('pointerdown', e => { e.preventDefault(); h.setPointerCapture(e.pointerId); h.classList.add('drag');
    const r = h.getBoundingClientRect(); off = [e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)]; });
  h.addEventListener('pointermove', e => { if (!off) return; const g = rvGeom(), box = $('rvStage').getBoundingClientRect();
    const x = (e.clientX - off[0] - box.left - g.ox) / (g.W * g.s), y = (e.clientY - off[1] - box.top - g.oy) / (g.H * g.s);
    review.quad[i] = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]; drawReview(); });
  const up = () => { off = null; h.classList.remove('drag'); updatePreview(); };
  h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
});
window.addEventListener('resize', () => { if (review.open) layoutReview(); });
function closeReview() {
  review.open = false; review.src = null; $('review').classList.add('hidden');
  const c = $('rvCanvas'); c.width = c.height = 0; $('rvPreview').removeAttribute('src'); // free the snapped photo
  state.cooldownUntil = Date.now() + COOLDOWN_MS; state.steadySince = Date.now();
  setTimeout(() => ensureLive('review closed'), 0); // always back to the live camera, never the frozen shot
}
$('rvRetake').onclick = () => { closeReview(); state.cooldownUntil = 0; state.armed = true; };
$('rvNoCrop').onclick = () => { const s = review.src, r = review.replace, o = review.opt; closeReview(); savePage(s, null, r, o); };
$('rvUse').onclick = () => {
  const s = review.src, r = review.replace, o = review.opt, q = CardDetector.order(review.quad.map(p => p.slice())); closeReview(); savePage(s, q, r, o);
};
// pages are landscape cards: the 90° turn is for a card shot on its side, so a page that already comes out landscape
// (e.g. a native-camera photo taken with the phone sideways) is not turned again
function rotFor(c) { const k = rotation(); return (k === 'cw' || k === 'ccw') && c.width > c.height ? 'none' : k; }
function renderOut(src, quad, enh, maxPx) {
  let out;
  if (quad) out = warp(src, quad, maxPx);
  else { const s = Math.min(1, maxPx / Math.max(src.width, src.height)); out = document.createElement('canvas'); out.width = Math.round(src.width * s); out.height = Math.round(src.height * s); out.getContext('2d').drawImage(src, 0, 0, out.width, out.height); }
  const cv = window.cv;
  if (quad && cv && cv.Mat) { try { const m = cv.imread(out), d = CardDetector.deskew(cv, m); cv.imshow(out, d.mat); m.delete(); d.mat.delete(); } catch (err) { console.warn(err); } }
  if (enh && cv && cv.Mat) { try { const m = cv.imread(out), e = CardDetector.enhance(cv, m); cv.imshow(out, e); m.delete(); e.delete(); } catch (err) { console.warn(err); } }
  return rotateCanvas(out, rotFor(out)); // upright before compression, thumbnail, queue and upload (so Drive + OCR get the upright page)
}
// Drive name: <JO>-p<page>-<MMDDYY>.jpg, Manila date the page was shot. The server keeps every earlier scan and adds b, c… for a
// second session the same day; a re-crop in this session sends the same name + session id, so it replaces only its own page.
function dateTag(d) {
  const m = new Date((d ? d.getTime() : Date.now()) + 8 * 36e5).toISOString(); // Asia/Manila (UTC+8, no DST)
  return m.slice(5, 7) + m.slice(8, 10) + m.slice(2, 4);
}
function pageName(jo, page, d) { return `${jo}-p${page}-${dateTag(d)}.jpg`; }
async function savePage(src, quad, replace, opt) { // the one save path: live shots, photos and re-crops. Upload starts as soon as this page's JPEG is ready.
  opt = opt || {}; const enh = enhanceOn(), out = renderOut(src, quad, enh, opt.maxPx || MAX_PX);
  const ts = Math.min(1, THUMB_PX / Math.max(out.width, out.height) || 1), th = document.createElement('canvas');
  th.width = Math.max(1, Math.round(out.width * ts)); th.height = Math.max(1, Math.round(out.height * ts));
  th.getContext('2d').drawImage(out, 0, 0, th.width, th.height);
  const thumb = th.toDataURL('image/jpeg', 0.6);
  const image = await canvasJpeg(out, opt.quality || QUALITY); out.width = out.height = 0;
  let p;
  const shot = replace && replace.shot ? replace.shot : new Date();
  if (replace) p = { jo: replace.jo, page: replace.page, filename: replace.filename, scan: replace.scan, shot, held: !!replace.held }; // re-crop: same file name, replaces it
  else {
    state.page++; updatePageLabel();
    p = { jo: state.jo, page: state.page, filename: pageName(state.jo, state.page, shot), scan: state.scan, shot };
    if (state.jo === 'OCR') p.held = true; // number still unknown: keep the photo on this screen
    cap.pages.push(p); cap.saving = false;
  }
  p.thumb = thumb; p.quad = quad || null;
  if (p.held) p.image = image;
  if (replace && photo.last && photo.last.pg === replace) { // Adjust crop on a Scan JO photo
    photo.last.pg = Object.assign({ quad }, p);
    const i = cap.pages.findIndex(x => x === replace || (x.scan === replace.scan && x.filename === replace.filename && x.page === replace.page));
    if (i >= 0) cap.pages[i] = photo.last.pg;
  }
  if (p.held) { renderCapture(); return p; }
  queue.add(Object.assign({ image }, p)).catch(e => { console.error(e); note('Could not store the page on this phone: ' + (e.message || e)); });
  renderCapture();
  return p;
}
function warp(src, q, maxPx) {
  maxPx = maxPx || MAX_PX; // full-resolution perspective warp; OpenCV if loaded, else pure JS fallback
  const cv = window.cv;
  if (cv && cv.Mat) {
    const m = cv.imread(src), o = CardDetector.warpQuad(cv, m, q, maxPx), c = document.createElement('canvas');
    cv.imshow(c, o); m.delete(); o.delete(); return c;
  }
  return warpJS(src, q.map(([x, y]) => [x * src.width, y * src.height]), maxPx);
}
function homography(s, d) { // maps d -> s (8 unknowns, Gaussian elimination)
  const A = [], b = [];
  for (let i = 0; i < 4; i++) { const [x, y] = d[i], [u, v] = s[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); }
  for (let i = 0; i < 8; i++) { let m = i; for (let r = i + 1; r < 8; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
    [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]];
    for (let r = 0; r < 8; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c < 8; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; } }
  return b.map((v, i) => v / A[i][i]).concat(1);
}
function warpJS(src, q, maxPx) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const [W, H] = CardDetector.cardSize(q, maxPx || MAX_PX); // fixed card-size output, edge to edge
  const h = homography(q, [[0, 0], [W, 0], [W, H], [0, H]]);
  const sd = src.getContext('2d').getImageData(0, 0, src.width, src.height).data, sw = src.width, sh = src.height;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const oc = out.getContext('2d'), od = oc.createImageData(W, H), o = od.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const z = h[6] * x + h[7] * y + 1, u = Math.round((h[0] * x + h[1] * y + h[2]) / z), v = Math.round((h[3] * x + h[4] * y + h[5]) / z);
    if (u < 0 || v < 0 || u >= sw || v >= sh) continue; const si = (v * sw + u) * 4, di = (y * W + x) * 4;
    o[di] = sd[si]; o[di + 1] = sd[si + 1]; o[di + 2] = sd[si + 2]; o[di + 3] = 255; }
  oc.putImageData(od, 0, 0); return out;
}

/* ---------- Scan JO: the phone's own camera (or gallery) -> auto-crop -> enhance -> save, no review screen ----------
   The photo goes through the same detector, crop, enhance, rotation and savePage() as a live shot. It saves straight away
   (live shots save straight away when the outline is clean); the result card offers Adjust crop afterwards. */
const photo = { busy: false, cont: false, last: null };
const cap = { pages: [], saving: false, asking: false, reading: false }; // pages of the capture currently on screen

/* JO sticker and Jewelry tag: both on by default, each remembered on this phone.
   Page 1 sends printJo and printTag. Off posts with the original fetch so print.js
   (which queues a jo_card after every page-1 upload it can see) cannot add the one that was turned off. */
function stickerOn(which) {
  const key = which === 'tag' ? LS.printTag : LS.printJo;
  return localStorage.getItem(key) !== '0';
}
function applySticker() {
  ['jo', 'tag'].forEach(which => {
    const on = stickerOn(which);
    document.querySelectorAll('[data-sticker="' + which + '"]').forEach(el => { el.checked = on; });
    document.querySelectorAll('[data-sticker-val="' + which + '"]').forEach(el => { el.textContent = on ? 'On' : 'Off'; });
    document.querySelectorAll('[data-nostick="' + which + '"]').forEach(el => el.classList.toggle('hidden', on));
  });
}
function setSticker(which, on) { localStorage.setItem(which === 'tag' ? LS.printTag : LS.printJo, on ? '1' : '0'); applySticker(); }
document.addEventListener('change', e => { const t = e.target && e.target.closest && e.target.closest('[data-sticker]'); if (!t) return; setSticker(t.getAttribute('data-sticker'), !!t.checked); });
applySticker();

/* Resize / JPEG in a worker + OffscreenCanvas when the phone has them. Main thread is the fallback. */
let jpegWorker = null, jpegJobs = new Map(), jpegJob = 0, jpegWorkerBroken = false;
function jpegWorkerRef() {
  if (jpegWorkerBroken) return null;
  if (jpegWorker) return jpegWorker;
  if (typeof Worker !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  try { jpegWorker = new Worker(JPEG_WORKER); } catch (e) { jpegWorkerBroken = true; jpegWorker = null; return null; }
  jpegWorker.onmessage = e => {
    const j = jpegJobs.get(e.data && e.data.id); if (!j) return; jpegJobs.delete(e.data.id); clearTimeout(j.timer);
    if (e.data.error) j.reject(new Error(e.data.error)); else j.resolve(e.data);
  };
  jpegWorker.onerror = () => { jpegWorkerBroken = true; jpegJobs.forEach(j => { clearTimeout(j.timer); j.reject(new Error('worker failed')); }); jpegJobs.clear(); jpegWorker = null; };
  return jpegWorker;
}
function workerCall(msg, transfers) {
  const w = jpegWorkerRef(); if (!w) return Promise.reject(new Error('no worker'));
  const id = ++jpegJob;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { jpegJobs.delete(id); reject(new Error('worker timeout')); }, 20000);
    jpegJobs.set(id, { resolve, reject, timer });
    try { w.postMessage(Object.assign({ id }, msg), transfers || []); } catch (e) { clearTimeout(timer); jpegJobs.delete(id); reject(e); }
  });
}
function bytesToJpegUrl(buf) {
  const bytes = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'data:image/jpeg;base64,' + btoa(bin);
}
async function canvasJpeg(canvas, quality) {
  try {
    if (typeof createImageBitmap === 'function' && jpegWorkerRef()) {
      const bmp = await createImageBitmap(canvas);
      const res = await workerCall({ op: 'encode', bitmap: bmp, quality, maxPx: Math.max(canvas.width, canvas.height) }, [bmp]);
      return bytesToJpegUrl(res.buf);
    }
  } catch (e) { console.warn('jpeg worker', e); }
  return canvas.toDataURL('image/jpeg', quality);
}
function loadPhoto(file) { // EXIF orientation respected; very large photos scaled to PHOTO_SRC_PX so phones keep memory
  const viaWorker = () => file.arrayBuffer().then(buf => workerCall({ op: 'scale', buf, type: file.type || 'image/jpeg', maxPx: PHOTO_SRC_PX }, [buf])).then(res => {
    const bmp = res.bitmap, c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0); if (bmp.close) bmp.close(); return c;
  });
  const main = () => loadPhotoMain(file);
  if (!jpegWorkerRef()) return main();
  return viaWorker().catch(e => { console.warn('scale worker', e); return main(); });
}
function loadPhotoMain(file) {
  const draw = (el, w, h) => { const s = Math.min(1, PHOTO_SRC_PX / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s); c.getContext('2d').drawImage(el, 0, 0, c.width, c.height); return c; };
  const viaImg = () => new Promise((res, rej) => { const u = URL.createObjectURL(file), i = new Image();
    i.onload = () => { URL.revokeObjectURL(u); try { res(draw(i, i.naturalWidth, i.naturalHeight)); } catch (e) { rej(e); } };
    i.onerror = () => { URL.revokeObjectURL(u); rej(new Error(/hei[cf]/i.test(file.type + ' ' + file.name) ? 'this phone cannot open HEIC photos here. Use Scan JO (camera) instead' : 'could not open this photo')); };
    i.src = u; });
  if (typeof createImageBitmap !== 'function') return viaImg();
  return createImageBitmap(file, { imageOrientation: 'from-image' }).then(b => { try { return draw(b, b.width, b.height); } finally { b.close && b.close(); } }, viaImg);
}
const cvSoon = ms => Promise.race([loadCV().catch(() => null), new Promise(r => setTimeout(() => r(null), ms))]);
async function autoSave(src) {
  const cv = $('doCrop').checked ? await cvSoon(15000) : null;
  let q = null;
  if (cv && cv.Mat) { try { q = detect(cv, src); } catch (e) { console.warn('detect', e); }
    if (q) { try { const m = cv.imread(src); q = CardDetector.refineQuad(cv, m, CardDetector.order(q)); m.delete(); } catch (e) { console.warn('refine', e); } } }
  const quad = q && CardDetector.order(q), pg = await savePage(src, quad, null, PHOTO);
  if (pg) pg.quad = quad;
  return pg;
}
function photoBusy(on) {
  photo.busy = on; $('btnScanJO').classList.toggle('busy', on); $('lnkGallery').classList.toggle('dis', on);
  const n = $('btnNextPage'); if (n) n.classList.toggle('busy', on);
  const d = $('btnCapDone'); if (d) d.disabled = on;
}
function zonesNow() {
  try {
    if (window.OYPZones && typeof OYPZones.zones === 'function') {
      const z = OYPZones.zones();
      if (z && z.some(x => x && x.id === 'jo')) return z;
    }
  } catch (e) {}
  try { const z = JSON.parse(localStorage.getItem('oypScanZones') || '[]'); if (Array.isArray(z)) return z; } catch (e) {}
  return [];
}
function waitZones() {
  if (zonesNow().some(z => z && z.id === 'jo')) return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    window.addEventListener('oyp-zones-ready', finish, { once: true });
    setTimeout(finish, 1200);
  });
}
function cropZoneB64(dataUrl, zone) { // the JO-number box, as a JPEG. Same crop the zone script sends.
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
        let x = Math.round(zone.x * sw), y = Math.round(zone.y * sh), w = Math.round(zone.w * sw), h = Math.round(zone.h * sh);
        if (x < 0) x = 0; if (y < 0) y = 0;
        if (x + w > sw) w = sw - x; if (y + h > sh) h = sh - y;
        if (w < 8 || h < 8) return resolve('');
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
        const url = c.toDataURL('image/jpeg', 0.85), i = url.indexOf(',');
        resolve(i >= 0 ? url.slice(i + 1) : '');
      } catch (e) { resolve(''); }
    };
    img.onerror = () => resolve('');
    img.src = String(dataUrl || '').indexOf('data:') === 0 ? dataUrl : 'data:image/jpeg;base64,' + dataUrl;
  });
}
const READ_JO_MAX_B64 = 1500000; // readJo_ rejects ocrBase64 longer than 2,000,000 characters
function jpegPayload(dataUrl) { // base64 after the comma; that is the string readJo_ measures
  const s = String(dataUrl || '');
  const i = s.indexOf(',');
  return (i >= 0 ? s.slice(i + 1) : s).replace(/\s+/g, '');
}
function readJoFit(long, len) { // smaller long edge when this JPEG's base64 is not well under the readJo cap
  long = Math.max(1, Math.round(Number(long) || 1));
  if (!(len > READ_JO_MAX_B64)) return long;
  let edge = Math.round(long * Math.sqrt(READ_JO_MAX_B64 / len) * 0.85);
  if (!(edge > 0)) edge = Math.round(long * 0.75);
  if (edge >= long) edge = Math.round(long * 0.75);
  if (edge < 320 && long > 320) edge = 320;
  return edge < long ? edge : 0;
}
function loadDataUrl(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    const s = String(dataUrl || '');
    img.src = s.indexOf('data:') === 0 ? s : 'data:image/jpeg;base64,' + s;
  });
}
function canvasJpegB64(img, long) {
  try {
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    if (!w0 || !h0) return '';
    const s = Math.min(1, long / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.8), i = url.indexOf(',');
    c.width = c.height = 0;
    return i >= 0 ? url.slice(i + 1) : '';
  } catch (e) { return ''; }
}
async function pageReadB64(dataUrl) { // whole page 1, shrunk until the base64 stays well under 2,000,000 characters
  let b64 = jpegPayload(dataUrl);
  if (b64 && b64.length <= READ_JO_MAX_B64) return b64;
  const img = await loadDataUrl(dataUrl);
  const w = img && (img.naturalWidth || img.width), h = img && (img.naturalHeight || img.height);
  if (!w || !h) return '';
  let long = Math.max(w, h);
  for (let n = 0; n < 6; n++) {
    const len = b64 && b64.length ? b64.length : READ_JO_MAX_B64 + 1;
    const next = readJoFit(long, len);
    if (!(next > 0) || next >= long) break;
    long = next;
    b64 = canvasJpegB64(img, long);
    if (!b64) return '';
    if (b64.length <= READ_JO_MAX_B64) return b64;
  }
  return '';
}
async function postReadJo(b64) {
  const res = await (window.__oypNativeFetch || fetch)(api(), { method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ op: 'readJo', token: localStorage.getItem(LS.token) || '', ocrBase64: b64 }) });
  try { return await res.json(); } catch (e) { return null; }
}
async function ocrJoNumber(dataUrl) { // readJo on the JO-number zone only. A typed number never comes through here.
  await waitZones();
  const zone = zonesNow().find(z => z && z.id === 'jo');
  if (!zone) return '';
  const b64 = await cropZoneB64(dataUrl, zone);
  if (!b64) return '';
  return joFromRead(await postReadJo(b64));
}
async function ocrJoPage(dataUrl) { // one readJo of the whole first page when the zone crop named nothing
  const b64 = await pageReadB64(dataUrl);
  if (!b64 || b64.length > READ_JO_MAX_B64) return '';
  return joFromPage(await postReadJo(b64));
}
function fileHeld(jo) { // the number is known: rename the kept pages and upload them as that JO
  jo = realJO(jo); if (!jo) return false;
  const stamp = String(state.scan || '').split('@')[1] || Date.now().toString(36);
  state.jo = jo; state.scan = jo + '@' + stamp;
  cap.asking = false; cap.reading = false;
  const start = $('joInput'); if (start) start.value = jo;
  const ask = $('capJoInput'); if (ask) ask.value = '';
  cap.pages.forEach(p => {
    if (!p.held) return;
    const image = p.image;
    p.jo = jo; p.scan = state.scan; p.filename = pageName(jo, p.page, p.shot); p.held = false; delete p.image;
    if (image) queue.add(Object.assign({ image }, p)).catch(e => { console.error(e); note('Could not store the page on this phone: ' + (e.message || e)); });
  });
  if (photo.last && photo.last.pg) { photo.last.pg.jo = jo; photo.last.pg.scan = state.scan; photo.last.pg.filename = pageName(jo, photo.last.pg.page, photo.last.pg.shot); photo.last.pg.held = false; }
  renderCapture();
  return true;
}
function askForJo() { // the photo is already on the capture screen; she types the number once
  cap.asking = true; cap.reading = false; renderCapture();
  const input = $('capJoInput');
  if (input) setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 30);
}
async function readHeldJo() {
  if (cap.reading || cap.asking || realJO(state.jo)) return;
  const page = cap.pages.find(p => p.held && p.image && (parseInt(p.page, 10) || 1) === 1);
  if (!page) return;
  cap.reading = true; renderCapture();
  let jo = '';
  try { jo = await ocrJoNumber(page.image); } catch (e) { console.warn('readJo', e); }
  if (!jo && !realJO(state.jo)) { try { jo = await ocrJoPage(page.image); } catch (e) { console.warn('readJo page', e); } }
  cap.reading = false;
  if (realJO(state.jo)) return;
  if (jo) fileHeld(jo); else askForJo();
}
async function handlePhotos(files) {
  files = Array.from(files || []).filter(f => /^image\//.test(f.type) || /\.(hei[cf]|jpe?g|png|webp)$/i.test(f.name));
  if (!files.length) return;
  const typed = realJO($('joInput').value); // a number already in the box wins over the card
  const sameCard = !!(photo.cont && (realJO(state.jo) || state.jo === 'OCR'));
  const fresh = !sameCard;
  if (fresh) {
    state.jo = typed || 'OCR'; state.page = 0; state.scan = state.jo + '@' + Date.now().toString(36); cap.pages = [];
    cap.asking = false; cap.reading = false;
    const ask = $('capJoInput'); if (ask) ask.value = '';
  } else if (typed && state.jo === 'OCR') fileHeld(typed);
  photo.cont = false; // consumed; Next page sets it again on the tap that opens the camera
  showView('capView'); photoBusy(true);
  let saved = 0;
  try {
    for (const f of files) {
      cap.saving = true; renderCapture();
      let src; try { src = await loadPhoto(f); } catch (e) { cap.saving = false; note('Photo not saved: ' + (e.message || e)); continue; }
      await new Promise(r => setTimeout(r, 30)); // let "Saving…" paint before the heavy work
      const pg = await autoSave(src);
      cap.saving = false;
      if (!pg) continue;
      saved++;
      if (photo.last && photo.last.src !== src) { photo.last.src.width = photo.last.src.height = 0; } // keep only the latest photo for Adjust
      photo.last = { src, pg }; if (navigator.vibrate) navigator.vibrate(40);
      renderCapture(); // this page is already uploading, or kept here until the JO number is known
    }
  } catch (e) { console.error(e); note('Could not save the photo: ' + (e.message || e)); }
  finally { cap.saving = false; photoBusy(false); if (!saved && fresh && !cap.pages.length) showView('startView'); renderCapture(); }
  if (state.jo === 'OCR') readHeldJo();
}
function capMatch(pg) {
  const all = queue.list();
  return all.find(x => x.scan === pg.scan && x.filename === pg.filename) || all.find(x => x.scan === pg.scan && x.page === pg.page);
}
function capState(pg) {
  const it = capMatch(pg);
  if (!it) return (pg.held && cap.asking) ? { cls: 'mm', t: 'Type JO' } : (pg.held || pg.jo === 'OCR') ? { cls: 'busy', t: 'Reading…' } : { cls: 'busy', t: 'Waiting' };
  if (it.state === 'uploading') return { cls: 'busy', t: 'Uploading…' };
  if (it.state === 'waiting') return { cls: 'queued', t: isOn() ? (it.error ? 'Retrying' : 'Waiting') : 'Offline' };
  if (it.state === 'saved') return { cls: 'ok', t: 'Saved' };
  if (it.state === 'mismatch') return { cls: 'mm', t: 'Check JO' };
  if (it.state === 'failed') return { cls: 'err', t: 'Failed', retry: it.id };
  return { cls: 'queued', t: it.state };
}
function renderCapture() {
  const strip = $('capStrip'), box = $('lastScan');
  if ($('capJo')) {
    const known = realJO(state.jo);
    $('capJo').textContent = cap.asking ? 'Type the JO number' : known ? 'JO ' + known : ((cap.pages.length || cap.saving || cap.reading) ? 'Reading the JO number…' : '');
  }
  const askForm = $('capJoForm'); if (askForm) askForm.classList.toggle('hidden', !cap.asking);
  if ($('capCount')) $('capCount').textContent = cap.pages.length ? (cap.pages.length === 1 ? '1 page' : cap.pages.length + ' pages') : '';
  if (strip) {
    const tiles = cap.pages.map(pg => {
      const s = capState(pg);
      const retry = s.retry ? `<button type="button" class="retry" data-retry="${esc(s.retry)}">Retry</button>` : '';
      return `<li class="${esc(s.cls)}"><img alt="Page ${esc(pg.page)}" src="${esc(pg.thumb || '')}"><span class="pn">Page ${esc(pg.page)}</span><span class="st ${esc(s.cls)}">${esc(s.t)}</span>${retry}</li>`;
    }).join('');
    strip.innerHTML = tiles + (cap.saving ? '<li class="busy"><span class="ph" aria-hidden="true"></span><span class="pn">New page</span><span class="st busy">Saving…</span></li>' : '');
  }
  const states = cap.pages.map(capState);
  const pending = states.filter(s => s.cls === 'busy' || s.cls === 'queued').length + (cap.saving ? 1 : 0);
  const failed = states.filter(s => s.retry).length;
  const prog = $('capProg');
  if (prog) {
    const held = cap.pages.some(p => p.held);
    prog.className = 'capprog' + (failed ? ' err' : (pending || held) ? ' busy' : cap.pages.length ? ' ok' : '');
    prog.textContent = held ? (cap.asking ? 'This photo stays here until you tap Save.' : 'Reading the JO number…') : !cap.pages.length && !cap.saving ? '' : failed ? (failed + (failed > 1 ? ' pages failed' : ' page failed')) : pending ? (pending === 1 ? '1 page still uploading' : pending + ' pages still uploading') : 'All saved';
  }
  const retryAll = $('btnCapRetry'); if (retryAll) retryAll.classList.toggle('hidden', !failed);
  if (box) {
    const L = photo.last;
    if (!L || !L.pg) box.classList.add('hidden');
    else { box.innerHTML = '<div class="la"><button type="button" class="alt" data-adj>Adjust crop</button></div>'; box.classList.remove('hidden'); }
  }
  applySticker();
}
function finishCapture() {
  if (photo.busy || cap.reading) return; // the page being saved still goes into the queue when it finishes
  if (cap.pages.some(p => p.held)) return askForJo(); // the photo stays; she types the number here
  photo.cont = false;
  const c = queue.counts();
  cap.pages = []; cap.saving = false; photo.last = null;
  $('joInput').value = '';
  showView('startView'); renderCapture();
  if (c.pending) note(c.pending + (c.pending > 1 ? ' pages are' : ' page is') + ' still uploading. They keep going in the background, even if you close this page.');
  else if (c.failed) note(c.failed + (c.failed > 1 ? ' pages failed. ' : ' page failed. ') + 'Open Pending uploads to retry. Nothing was discarded.');
}
$('lastScan').addEventListener('click', e => {
  const L = photo.last; if (!L) return;
  if (e.target.closest('[data-adj]') && L.src && L.src.width) openReview(L.src, (L.pg.quad || [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]]).map(p => p.slice()), !!L.pg.quad, L.pg, PHOTO);
});
$('btnNextPage').addEventListener('click', e => {
  if (photo.busy || cap.reading) { e.preventDefault(); return; }
  photo.cont = true; // one tap opens the camera; no navigation, same JO
});
$('btnNextPage').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('btnNextPage').click(); } });
$('btnCapDone').onclick = finishCapture;
$('capJoForm').addEventListener('submit', e => {
  e.preventDefault();
  const jo = realJO($('capJoInput').value);
  if (!jo) { $('capJoInput').focus(); return; }
  fileHeld(jo);
});
$('btnCapRetry').onclick = () => { cap.pages.forEach(pg => { const s = capState(pg); if (s.retry) queue.retry(s.retry); }); };
// Scan JO and Upload from gallery always open. An empty box is read from the card after the photo.
$('btnScanJO').addEventListener('click', e => {
  photo.cont = false; $('btnScanJO').classList.remove('pulse');
  if (photo.busy) e.preventDefault();
});
$('btnScanJO').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('btnScanJO').click(); } });
$('lnkGallery').addEventListener('click', e => { photo.cont = false; if (photo.busy) e.preventDefault(); });
['filePhoto', 'fileGallery'].forEach(id => $(id).addEventListener('change', e => { const fs = e.target.files; handlePhotos(fs).finally(() => { e.target.value = ''; }); }));

/* ---------- upload queue (queue.js, IndexedDB) ---------- */
// Page 1 creates or identifies the JO and is the only page that queues stickers.
function scanPayload(it, token, stick) {
  stick = stick || {};
  const body = { token: token || '', jo: it.jo, page: it.page, filename: it.filename, scan: it.scan || '', imageBase64: it.image.split(',')[1] };
  if ((parseInt(it.page, 10) || 1) === 1) {
    body.printJo = stick.printJo !== false;
    body.printTag = stick.printTag !== false;
  }
  return body;
}
async function postScan(body, signal) {
  let payload = body, doFetch = fetch;
  if (body.printJo === false || body.printTag === false) {
    // print.js queues a jo_card after every page-1 upload it can see, and does not read these flags.
    // Skip that hook whenever either sticker is off. Zones still run: prepare() adds the JO-number crop.
    if (window.OYPZones && typeof OYPZones.prepare === 'function') {
      try { const next = await OYPZones.prepare(body); if (next && next.imageBase64) payload = next; } catch (e) { console.warn(e); }
    }
    doFetch = window.__oypNativeFetch || fetch;
  }
  return doFetch(api(), { method: 'POST', redirect: 'follow', signal,
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // simple request: no CORS preflight
    body: JSON.stringify(payload) });
}
async function sendPage(it) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, to = ctl && setTimeout(() => ctl.abort(), 120000);
  let res;
  try {
    res = await postScan(scanPayload(it, localStorage.getItem(LS.token) || '', { printJo: stickerOn('jo'), printTag: stickerOn('tag') }), ctl && ctl.signal);
  } catch (e) {
    const er = new Error(e && e.name === 'AbortError' ? 'timed out' : 'no connection'); er.offline = navigator.onLine === false; throw er;
  } finally { clearTimeout(to); }
  let r; try { r = await res.json(); } catch (e) { throw new Error('server error ' + res.status); }
  if (!r.ok) { const e = new Error(r.error || 'upload failed'); e.permanent = /bad token|missing jo|missing image/i.test(e.message); throw e; }
  return r;
}
// swipe-delete: tell Drive to trash a page (Code.gs deletePage_). An older script answers "Missing image": it can't delete yet.
async function deletePage(t) {
  let res;
  try {
    res = await fetch(api(), { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: localStorage.getItem(LS.token) || '', op: 'deletePage', jo: t.jo, page: t.page, scan: t.scan || '', file_id: t.fileId || '', filename: t.savedName || '' }) });
  } catch (e) { throw new Error('no connection'); }
  let r; try { r = await res.json(); } catch (e) { const er = new Error('server error ' + res.status); er.permanent = true; throw er; }
  if (!r.ok && /missing image|unknown/i.test(r.error || '')) return { unsupported: true };
  if (!r.ok) { const e = new Error(r.error || 'delete failed'); e.permanent = true; throw e; }
  return r;
}
function deletedNote(t, r) {
  const what = 'Page ' + t.page + ' of JO ' + t.jo;
  if (r && r.unsupported) return note('Removed from phone; delete in Drive needs the update.');
  if (r && r.ok === false) return note(what + ': removed from phone, but Drive said: ' + r.error);
  note(r && r.deleted ? what + ' deleted. It is in Drive Trash for 30 days.' : what + ' removed.');
}
let store;
try { store = window.indexedDB ? OYPQueue.idbStore() : OYPQueue.memoryStore(); } catch (e) { store = OYPQueue.memoryStore(); }
const queue = OYPQueue.create({ store, send: sendPage, del: deletePage, onDeleted: deletedNote, normJO, online: () => navigator.onLine !== false, onChange: () => renderQueue() });
const isOn = () => navigator.onLine !== false;
function statusText(c) {
  if (c.pending) return (isOn() ? c.pending + ' still uploading' : c.pending + ' waiting for internet') + (c.failed ? ' · ' + c.failed + ' failed' : '');
  if (c.failed) return c.failed + ' failed. Tap to retry';
  return c.total ? 'All saved ✓' : 'No pages waiting';
}
function rowHtml(it, withJO) {
  const st = it.state === 'saved' ? 'ok' : it.state === 'mismatch' ? 'mm' : it.state === 'failed' ? 'err' : 'queued';
  const btns = it.state === 'failed' ? `<div class="acts"><button class="retry" data-retry="${esc(it.id)}">Retry</button><button class="rm" data-rm="${esc(it.id)}">Remove</button></div>`
    : it.state === 'uploading' ? '<span class="spin" aria-hidden="true"></span>' : '';
  const sw = !withJO && it.state !== 'failed' ? ` data-sw="${esc(it.id)}"` : ''; // page strip: swipe left to delete (failed rows keep Remove)
  return `<li class="${it.state}"${sw}><img alt="" src="${esc(it.thumb)}"><div class="tx"><div class="nm">${withJO ? 'JO ' + esc(it.jo) + ' · page ' + esc(it.page) : esc(it.filename)}</div>`
    + `<div class="st ${st}">${esc(OYPQueue.label(it, isOn()))}</div></div>${btns}</li>`;
}
function renderQueue() {
  const c = queue.counts(), n = c.pending + c.failed, txt = statusText(c);
  document.querySelectorAll('.qbadge').forEach(b => { b.textContent = n; b.classList.toggle('hidden', !n); b.classList.toggle('bad', !!c.failed); });
  const qs = $('qStatus'); qs.textContent = c.total ? txt : ''; qs.className = 'qstatus' + (c.failed ? ' err' : c.pending ? ' busy' : ' ok');
  const ss = $('scanStatus'); ss.querySelector('span').textContent = txt; ss.className = 'sstat' + (c.failed ? ' err' : c.pending ? ' busy' : ' ok');
  renderCapture();
  const mine = queue.list().filter(x => x.scan && x.scan === state.scan).reverse();
  if (swHold) swDirty = true; else $('pages').innerHTML = mine.map(it => rowHtml(it, false)).join(''); // not while a row is being swiped / asked about
  if ($('queueView').classList.contains('hidden')) return;
  const all = queue.list().slice().reverse(), grp = (t, l) => l.length ? `<li class="grp">${t}</li>` + l.map(it => rowHtml(it, true)).join('') : '';
  const bad = all.filter(x => x.state === 'failed' || x.state === 'mismatch'), busy = all.filter(x => x.state === 'waiting' || x.state === 'uploading'),
    done = all.filter(x => x.state === 'saved');
  $('qSummary').textContent = c.total ? txt : 'Nothing here yet. Pages you scan show up here until they are safely saved.';
  $('qSummary').className = 'qsum' + (c.failed ? ' err' : c.pending ? ' busy' : ' ok');
  $('btnRetryFailed').classList.toggle('hidden', !c.failed);
  $('qList').innerHTML = grp('Needs a look', bad) + grp('Uploading', busy) + grp('Saved recently', done);
}
document.addEventListener('click', e => {
  const r = e.target.closest('[data-retry]'); if (r) return queue.retry(r.dataset.retry);
  const m = e.target.closest('[data-rm]');
  if (m && confirm('Remove this page from the phone? It is NOT saved in Drive, so scan it again later.')) queue.remove(m.dataset.rm);
});

/* ---------- swipe left to delete (page strip under the camera) ----------
   Pointer events (iOS + Android). Only a mostly-sideways drag counts; up/down stays a normal scroll (touch-action: pan-y). */
var swHold = false, swDirty = false; // var: renderQueue may run before this line
function swRelease() { swHold = false; if (swDirty) { swDirty = false; renderQueue(); } }
const SWIPE = { START: 10, RATIO: 1.5, MIN: 80, FRAC: 0.35 };
function swipeAxis(dx, dy) { // null = not decided yet
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < SWIPE.START && ay < SWIPE.START) return null;
  return ax > ay * SWIPE.RATIO && dx < 0 ? 'h' : 'v';
}
function swipePast(dx, width) { return -dx >= Math.max(SWIPE.MIN, (width || 0) * SWIPE.FRAC); }
const sw = { li: null, id: '', x0: 0, y0: 0, dx: 0, axis: null, pid: null, bg: null };
function swBack(li, bg) { if (!li) return; li.style.transition = 'transform .18s ease'; li.style.transform = '';
  setTimeout(() => { li.classList.remove('swiping'); li.style.transition = ''; if (bg) bg.remove(); swRelease(); }, 200); }
$('pages').addEventListener('pointerdown', e => {
  const li = e.target.closest('li[data-sw]'); if (!li || e.target.closest('button') || (e.pointerType === 'mouse' && e.button !== 0)) return;
  Object.assign(sw, { li, id: li.dataset.sw, x0: e.clientX, y0: e.clientY, dx: 0, axis: null, pid: e.pointerId, bg: null });
});
$('pages').addEventListener('pointermove', e => {
  if (!sw.li || e.pointerId !== sw.pid) return;
  const dx = e.clientX - sw.x0, dy = e.clientY - sw.y0;
  if (!sw.axis) { sw.axis = swipeAxis(dx, dy); if (!sw.axis) return;
    if (sw.axis === 'v') { sw.li = null; return; }
    swHold = true;
    try { sw.li.setPointerCapture(e.pointerId); } catch (_) {}
    const bg = document.createElement('div'); bg.className = 'swbg'; bg.innerHTML = '<span>Delete</span>';
    bg.style.top = sw.li.offsetTop + 'px'; bg.style.height = sw.li.offsetHeight + 'px'; sw.li.parentElement.appendChild(bg); sw.bg = bg;
    sw.li.classList.add('swiping'); }
  e.preventDefault();
  sw.dx = Math.min(0, Math.max(dx, -sw.li.offsetWidth * 0.9)); sw.li.style.transform = `translateX(${sw.dx}px)`;
  sw.bg.classList.toggle('go', swipePast(sw.dx, sw.li.offsetWidth));
});
function swEnd(e) {
  if (!sw.li || (e && e.pointerId !== sw.pid)) return;
  const { li, id, bg, dx, axis } = sw; sw.li = null; if (axis !== 'h') return;
  if (!swipePast(dx, li.offsetWidth) || (e && e.type === 'pointercancel')) return swBack(li, bg);
  li.style.transition = 'transform .15s ease'; li.style.transform = `translateX(${-Math.max(SWIPE.MIN, li.offsetWidth * SWIPE.FRAC)}px)`;
  const it = queue.get(id); if (!it) return swBack(li, bg);
  askDelete(it).then(yes => { if (!yes) return swBack(li, bg); if (bg) bg.remove(); li.remove(); swDirty = true; swRelease(); queue.discard(id).then(r => { if (r.phase === 'removed') note('Page ' + it.page + ' of JO ' + it.jo + ' removed. It was not uploaded yet.'); }); });
}
$('pages').addEventListener('pointerup', swEnd); $('pages').addEventListener('pointercancel', swEnd);
function askDelete(it) {
  return new Promise(done => {
    const sent = it.state !== 'waiting', d = document.createElement('div'); d.className = 'swconf'; d.setAttribute('role', 'dialog');
    d.innerHTML = `<div class="box"><p>Delete page ${esc(it.page)} of JO ${esc(it.jo)}?${sent ? ' It goes to Drive Trash (30 days).' : ' It was not uploaded yet.'}</p>`
      + '<div class="row"><button type="button" class="ghost" data-no>Cancel</button><button type="button" class="del" data-yes>Delete</button></div></div>';
    const close = v => { d.remove(); done(v); };
    d.addEventListener('click', e => { if (e.target.closest('[data-yes]')) close(true); else if (e.target.closest('[data-no]') || e.target === d) close(false); });
    document.body.appendChild(d); d.querySelector('[data-no]').focus();
  });
}
window.addEventListener('online', () => { queue.wake(); renderQueue(); });
window.addEventListener('offline', renderQueue);
queue.load().then(() => queue.wake()).catch(e => { console.error('queue', e); note('This phone could not open its upload store: ' + (e.message || e)); });
const SCAN_HELP = "Tap to scan the JO and choose which sticker to print. If the JO has no number or it's hard to read, type it in the box.";
function scanHelp() { const h = document.querySelector('#startView .help'); if (h && h.textContent !== SCAN_HELP) h.textContent = SCAN_HELP; }
scanHelp();
window.addEventListener('oyp-zones-ready', () => setTimeout(scanHelp, 50));
window.__scan = { handlePhotos, loadPhoto, photo, cap, rotFor, swipeAxis, swipePast, rotateCanvas, rotation, state, review, openReview, capture, finalConfidence, AUTO_ACCEPT, queue, ensureLive, stickerOn, setSticker, scanPayload, renderCapture, finishCapture, realJO, joFromRead, fileHeld };
})();

// owner: stone background only while the start screen is shown
(function () {
  const sv = document.getElementById('startView');
  const sync = () => document.documentElement.classList.toggle('on-start', !sv.classList.contains('hidden'));
  new MutationObserver(sync).observe(sv, { attributes: true, attributeFilter: ['class'] }); sync();
})();

// size the preview box to the camera's own aspect so the whole frame shows, always inside the page's white margins
function fitStage() {
  const st = video.closest('.stage'); if (!st || !video.videoWidth) return;
  const box = st.parentElement, cs = getComputedStyle(box);
  const availW = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = window.innerHeight * 0.62, ar = video.videoWidth / video.videoHeight;
  let w = availW, h = w / ar; if (h > availH) { h = availH; w = h * ar; }
  st.style.aspectRatio = 'auto'; st.style.width = Math.floor(w) + 'px'; st.style.height = Math.floor(h) + 'px';
  const ctl = st.parentElement.querySelector('.controls'); if (ctl) { ctl.style.width = Math.floor(w) + 'px'; } const jb = document.querySelector('#scanView .jobar'); if (jb) { jb.style.width = Math.floor(w) + 'px'; }
}
video.addEventListener('loadedmetadata', fitStage);
video.addEventListener('resize', fitStage);
window.addEventListener('resize', fitStage);
