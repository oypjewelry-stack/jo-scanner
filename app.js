/* OYP Card Scanner — static front-end, no build step. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const LS = { api: 'oypScanApi', token: 'oypScanToken', rotate: 'oypScanRotate', auto: 'oypScanAuto', crop: 'oypScanCrop', role: 'oypScanRole' };
const qs = new URLSearchParams(location.search);
if (qs.get('api')) localStorage.setItem(LS.api, qs.get('api'));
if (qs.get('token')) localStorage.setItem(LS.token, qs.get('token'));
if (qs.has('role')) { // set by the back-office menu link: which menu items to show here
  if (qs.get('role')) localStorage.setItem(LS.role, qs.get('role')); else localStorage.removeItem(LS.role);
  qs.delete('role'); history.replaceState(null, '', location.pathname + (String(qs) ? '?' + qs : '') + location.hash);
}
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { jo: '', page: 0, scan: '', stream: null, loop: null, lastQuad: null, steadySince: 0, armed: true, cooldownUntil: 0 };
// pages are downscaled before upload: ~1600px long edge JPEG 0.8 is plenty for the card and for OCR, and 3-5x smaller
const MAX_PX = 1600, QUALITY = 0.8, THUMB_PX = 160, STEADY_MS = 900, COOLDOWN_MS = 2500;

/* ---------- JO normalisation (shared logic with Code.gs) ---------- */
function normJO(s) {
  // keeps a revision letter: '26-005B', '26-005 b' -> '26-005B'
  const m = String(s || '').toUpperCase().match(/(\d{2})\s*[-,.\/ ]?\s*(\d{3,4})(?:\s?([A-Z])(?![A-Z0-9]))?/);
  return m ? m[1] + '-' + m[2] + (m[3] || '') : String(s || '').trim().toUpperCase().replace(/^J\.?O\.?\s*#?\s*/, '');
}
window.normJO = normJO;
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
const NAV_FALLBACK = { SITE: STAFF_URL, STAFF: STAFF_URL, NAV: {
  admin: [['dashboard', 'Dashboard'], ['review', 'To review'], ['estimate', 'Cost estimator'], ['jos', 'Inventory'], ['scanner', 'Scanner'], ['inventory', 'Materials'], ['prices', 'Material prices'], ['customers', 'Customers'], ['shop', 'Shop listings'], ['payments', 'Quotes / payments'], ['users', 'Staff logins'], ['settings', 'Settings']],
  production_manager: [['dashboard', 'Dashboard'], ['review', 'To review'], ['estimate', 'Cost estimator'], ['jos', 'Inventory'], ['scanner', 'Scanner'], ['production', 'Production'], ['inventory', 'Materials'], ['prices', 'Material prices']],
  accounting: [['dashboard', 'Dashboard'], ['payments', 'Payments'], ['quotes', 'Quotes'], ['balances', 'Balances'], ['clients', 'Clients (billing)'], ['jos', 'Inventory (view)']] } };
function buildMenu() {
  const N = window.OYPNav || NAV_FALLBACK, role = localStorage.getItem(LS.role), items = N.NAV[role], site = N.STAFF || STAFF_URL, c = queue.counts();
  let h = items ? items.map(([k, t]) => k === 'scanner' ? `<a href="#" data-m="scanner" class="on">${esc(t)}</a>` : `<a href="${site}#/${k}">${esc(t)}</a>`).join('')
    : `<a href="${site}">${role === 'staff' ? 'Home' : 'Back office'}</a>`;
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
function showView(id) { ['startView', 'scanView', 'queueView'].forEach(v => $(v).classList.toggle('hidden', v !== id)); if (id === 'scanView') setTimeout(() => ensureLive('view'), 50); }
function showQueue() { const cur = ['startView', 'scanView'].find(v => !$(v).classList.contains('hidden')); if (cur) backTo = cur; showView('queueView'); renderQueue(); window.scrollTo(0, 0); }
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
  const b = $('btnStart'); b.textContent = 'SCAN'; b.classList.remove('pulse');
  try { await startCamera(); } catch (e) { console.error(e); hint('Could not start: ' + (e.message || e)); }
};
$('joInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnStart').click(); });
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
      s.getVideoTracks().forEach(t => { t.addEventListener('ended', () => ensureLive('track ended')); t.addEventListener('unmute', () => ensureLive('track unmuted')); });
      return s; })
    .finally(() => { acquiring = null; });
  return acquiring;
}
// called synchronously from the mic tap (user gesture) so iOS allows the camera
window.prewarmCamera = () => acquireStream().then(() => { video.play().catch(() => {}); return true; })
  .catch(e => { console.error('camera prewarm failed', e); state.camError = e; return false; });
window.askTapToStart = () => { const b = $('btnStart'); b.textContent = 'SCAN'; b.classList.add('pulse'); b.focus(); };
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
function detect(cv) {
  const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return null;
  const s = DW / Math.max(vw, vh); work.width = Math.round(vw * s); work.height = Math.round(vh * s);
  const c = work.getContext('2d', { willReadFrequently: true }); c.drawImage(video, 0, 0, work.width, work.height);
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
const review = { open: false, src: null, quad: null, replace: null };
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
function openReview(src, q, found, replace) {
  review.open = true; review.src = src; review.quad = q; review.replace = replace || null;
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
$('rvNoCrop').onclick = () => { const s = review.src, r = review.replace; closeReview(); savePage(s, null, r); };
$('rvUse').onclick = () => {
  const s = review.src, r = review.replace, q = CardDetector.order(review.quad.map(p => p.slice())); closeReview(); savePage(s, q, r);
};
function renderOut(src, quad, enh, maxPx) {
  let out;
  if (quad) out = warp(src, quad, maxPx);
  else { const s = Math.min(1, maxPx / Math.max(src.width, src.height)); out = document.createElement('canvas'); out.width = Math.round(src.width * s); out.height = Math.round(src.height * s); out.getContext('2d').drawImage(src, 0, 0, out.width, out.height); }
  const cv = window.cv;
  if (quad && cv && cv.Mat) { try { const m = cv.imread(out), d = CardDetector.deskew(cv, m); cv.imshow(out, d.mat); m.delete(); d.mat.delete(); } catch (err) { console.warn(err); } }
  if (enh && cv && cv.Mat) { try { const m = cv.imread(out), e = CardDetector.enhance(cv, m); cv.imshow(out, e); m.delete(); e.delete(); } catch (err) { console.warn(err); } }
  return rotateCanvas(out); // upright before compression, thumbnail, queue and upload (so Drive + OCR get the upright page)
}
// Drive name: <JO>-p<page>-<MMDDYY>.jpg, Manila date the page was shot. The server keeps every earlier scan and adds b, c… for a
// second session the same day; a re-crop in this session sends the same name + session id, so it replaces only its own page.
function dateTag(d) {
  const m = new Date((d ? d.getTime() : Date.now()) + 8 * 36e5).toISOString(); // Asia/Manila (UTC+8, no DST)
  return m.slice(5, 7) + m.slice(8, 10) + m.slice(2, 4);
}
function pageName(jo, page, d) { return `${jo}-p${page}-${dateTag(d)}.jpg`; }
function savePage(src, quad, replace) {
  const enh = enhanceOn(), out = renderOut(src, quad, enh, MAX_PX);
  const image = out.toDataURL('image/jpeg', QUALITY);
  const ts = Math.min(1, THUMB_PX / Math.max(out.width, out.height)), th = document.createElement('canvas');
  th.width = Math.round(out.width * ts); th.height = Math.round(out.height * ts); th.getContext('2d').drawImage(out, 0, 0, th.width, th.height);
  const thumb = th.toDataURL('image/jpeg', 0.6); out.width = out.height = 0;
  let p;
  if (replace) p = { jo: replace.jo, page: replace.page, filename: replace.filename, scan: replace.scan }; // re-crop: same file name, replaces it
  else { state.page++; updatePageLabel(); p = { jo: state.jo, page: state.page, filename: pageName(state.jo, state.page), scan: state.scan }; }
  p.thumb = thumb;
  queue.add(Object.assign({ image }, p)).catch(e => { console.error(e); note('Could not store the page on this phone: ' + (e.message || e)); });
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

/* ---------- upload queue (queue.js, IndexedDB) ---------- */
async function sendPage(it) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, to = ctl && setTimeout(() => ctl.abort(), 120000);
  let res;
  try {
    res = await fetch(api(), { method: 'POST', redirect: 'follow', signal: ctl && ctl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // simple request: no CORS preflight
      body: JSON.stringify({ token: localStorage.getItem(LS.token) || '', jo: it.jo, page: it.page, filename: it.filename, scan: it.scan || '', imageBase64: it.image.split(',')[1] }) });
  } catch (e) {
    const er = new Error(e && e.name === 'AbortError' ? 'timed out' : 'no connection'); er.offline = navigator.onLine === false; throw er;
  } finally { clearTimeout(to); }
  let r; try { r = await res.json(); } catch (e) { throw new Error('server error ' + res.status); }
  if (!r.ok) { const e = new Error(r.error || 'upload failed'); e.permanent = /bad token|missing jo|missing image/i.test(e.message); throw e; }
  return r;
}
let store;
try { store = window.indexedDB ? OYPQueue.idbStore() : OYPQueue.memoryStore(); } catch (e) { store = OYPQueue.memoryStore(); }
const queue = OYPQueue.create({ store, send: sendPage, normJO, online: () => navigator.onLine !== false, onChange: () => renderQueue() });
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
  return `<li class="${it.state}"><img alt="" src="${esc(it.thumb)}"><div class="tx"><div class="nm">${withJO ? 'JO ' + esc(it.jo) + ' · page ' + esc(it.page) : esc(it.filename)}</div>`
    + `<div class="st ${st}">${esc(OYPQueue.label(it, isOn()))}</div></div>${btns}</li>`;
}
function renderQueue() {
  const c = queue.counts(), n = c.pending + c.failed, txt = statusText(c);
  document.querySelectorAll('.qbadge').forEach(b => { b.textContent = n; b.classList.toggle('hidden', !n); b.classList.toggle('bad', !!c.failed); });
  const qs = $('qStatus'); qs.textContent = c.total ? txt : ''; qs.className = 'qstatus' + (c.failed ? ' err' : c.pending ? ' busy' : ' ok');
  const ss = $('scanStatus'); ss.querySelector('span').textContent = txt; ss.className = 'sstat' + (c.failed ? ' err' : c.pending ? ' busy' : ' ok');
  const mine = queue.list().filter(x => x.scan && x.scan === state.scan).reverse();
  $('pages').innerHTML = mine.map(it => rowHtml(it, false)).join('');
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
window.addEventListener('online', () => { queue.wake(); renderQueue(); });
window.addEventListener('offline', renderQueue);
queue.load().then(() => queue.wake()).catch(e => { console.error('queue', e); note('This phone could not open its upload store: ' + (e.message || e)); });
window.__scan = { rotateCanvas, rotation, state, review, openReview, capture, finalConfidence, AUTO_ACCEPT, queue, ensureLive };
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
