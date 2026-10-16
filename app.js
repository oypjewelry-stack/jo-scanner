/* OYP Card Scanner — static front-end, no build step. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const LS = { api: 'oypScanApi', token: 'oypScanToken', queue: 'oypScanQueue' };
const qs = new URLSearchParams(location.search);
if (qs.get('api')) localStorage.setItem(LS.api, qs.get('api'));
if (qs.get('token')) localStorage.setItem(LS.token, qs.get('token'));

const state = { jo: '', page: 0, stream: null, loop: null, lastQuad: null, steadySince: 0, cooldownUntil: 0, pages: [] };
const MAX_PX = 2000, QUALITY = 0.85, STEADY_MS = 800, COOLDOWN_MS = 2500;

/* ---------- JO normalisation (shared logic with Code.gs) ---------- */
function normJO(s) {
  const m = String(s || '').toUpperCase().match(/(\d{2})\s*[-,.\/ ]?\s*(\d{3,4})/);
  return m ? m[1] + '-' + m[2] : String(s || '').trim().toUpperCase().replace(/^J\.?O\.?\s*#?\s*/, '');
}
window.normJO = normJO;

/* ---------- settings ---------- */
const DEFAULT_API = 'https://script.google.com/macros/s/AKfycbzUmacbdvb0V2nw9ekharFhZPYdSqVgpFpADKiPM2qhSUUF3G5pJ_cAZ46eQPxeawhV/exec';
const api = () => localStorage.getItem(LS.api) || DEFAULT_API;
function refreshWarn() { $('apiWarn').classList.toggle('hidden', !!api()); }
$('btnSettings').onclick = () => { $('apiUrl').value = api(); $('apiToken').value = localStorage.getItem(LS.token) || ''; $('settings').showModal(); };
$('btnSave').onclick = () => { localStorage.setItem(LS.api, $('apiUrl').value.trim()); localStorage.setItem(LS.token, $('apiToken').value.trim()); refreshWarn(); retryAll(); };
refreshWarn();

/* ---------- start / done ---------- */
$('btnStart').onclick = async () => {
  const jo = normJO($('joInput').value);
  if (!jo) { $('joInput').focus(); return; }
  state.jo = jo; state.page = 0; state.pages = [];
  $('joLabel').textContent = jo; $('pages').innerHTML = ''; updatePageLabel();
  $('startView').classList.add('hidden'); $('scanView').classList.remove('hidden');
  const b = $('btnStart'); b.textContent = 'SCAN'; b.classList.remove('pulse');
  try { await startCamera(); } catch (e) { console.error(e); hint('Could not start: ' + (e.message || e)); }
};
$('joInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnStart').click(); });
$('btnDone').onclick = () => {
  const pending = state.pages.filter(p => p.status === 'err' || p.status === 'queued').length;
  if (pending && !confirm(pending + ' page(s) not uploaded yet. They stay queued on this phone. Continue?')) return;
  // keep the camera stream open so the next card needs no new permission prompt
  $('joInput').value = ''; $('scanView').classList.add('hidden'); $('startView').classList.remove('hidden'); $('joInput').focus();
};
function updatePageLabel() { $('pageLabel').textContent = state.page ? state.page + ' page(s)' : 'No pages yet'; }

/* ---------- camera ---------- */
const video = $('video'), overlay = $('overlay'), work = $('work');
const liveStream = () => state.stream && state.stream.active && state.stream.getVideoTracks().some(t => t.readyState === 'live');
let acquiring = null;
function acquireStream() { // one getUserMedia at a time; reuse a live stream
  if (liveStream()) return Promise.resolve(state.stream);
  if (acquiring) return acquiring;
  acquiring = navigator.mediaDevices.getUserMedia({ audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } } })
    .then(s => { state.stream = s; video.srcObject = s; video.muted = true; return s; })
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
function detect(cv) {
  const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return null;
  const s = DW / Math.max(vw, vh); work.width = Math.round(vw * s); work.height = Math.round(vh * s);
  const c = work.getContext('2d', { willReadFrequently: true }); c.drawImage(video, 0, 0, work.width, work.height);
  const m = cv.imread(work);
  try { const r = CardDetector.detectQuad(cv, m, { size: DW }); state.lastConf = r ? r.confidence : 0; state.lastDet = r ? { s: r.support, r: r.rect, a: r.asp, st: r.step, v: r.votes, m: r.method } : null; return r ? r.quad : null; } finally { m.delete(); }
}

function drawQuad(q, ok) {
  const r = overlay.getBoundingClientRect(); overlay.width = r.width; overlay.height = r.height;
  const c = overlay.getContext('2d'); c.clearRect(0, 0, r.width, r.height); if (!q) return;
  const vw = video.videoWidth, vh = video.videoHeight, s = Math.max(r.width / vw, r.height / vh);
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
      state.lastQuad = sm;
      const steady = now - state.steadySince >= STEADY_MS;
      drawQuad(sm, steady);
      if (now < state.cooldownUntil) { hint('Captured. Flip to the next page', true); return; }
      if (!$('autoSnap').checked) { hint('Card found. Tap the shutter', true); return; }
      // smoothed detector confidence over recent frames; temporal stability adds the rest
      state.confAvg = state.confAvg == null ? state.lastConf : state.confAvg * 0.6 + state.lastConf * 0.4;
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
function capture(quad, auto, conf) {
  if (!video.videoWidth || review.open) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  const src = document.createElement('canvas'); src.width = vw; src.height = vh; src.getContext('2d').drawImage(video, 0, 0);
  if (navigator.vibrate) navigator.vibrate(40);
  const q = quad ? quad.map(p => p.slice()) : [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]];
  if (!$('doCrop').checked) return savePage(src, null);
  if (quad && window.cv && window.cv.Mat) { // snap detected corners to the true card edges + small inset
    try { const m = cv.imread(src); const r = CardDetector.refineQuad(cv, m, CardDetector.order(q)); m.delete(); q.splice(0, 4, ...r); } catch (e) { console.warn('refine', e); } }
  if (auto && quad && conf >= AUTO_ACCEPT) { const pg = savePage(src, CardDetector.order(q)); showToast(pg, src, q); state.cooldownUntil = Date.now() + COOLDOWN_MS; state.steadySince = Date.now(); return; }
  openReview(src, q, !!quad);
}
let toastTimer = null;
function showToast(pg, src, q) {
  const t = $('toast'); $('toastImg').src = pg.dataUrl; t.classList.remove('hidden');
  $('toastAdjust').onclick = () => { clearTimeout(toastTimer); t.classList.add('hidden'); openReview(src, q.map(p => p.slice()), true, pg); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 1600);
}
function openReview(src, q, found, replace) {
  review.open = true; review.src = src; review.quad = q; review.replace = replace || null;
  $('rvEnhance').checked = enhanceOn();
  $('rvTitle').textContent = found ? 'Check the crop' : 'Card not found: drag the corners';
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
function closeReview() { review.open = false; $('review').classList.add('hidden'); state.cooldownUntil = Date.now() + COOLDOWN_MS; state.steadySince = Date.now(); }
$('rvRetake').onclick = () => { closeReview(); state.cooldownUntil = 0; };
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
  return out;
}
function savePage(src, quad, replace) {
  const enh = enhanceOn(), out = renderOut(src, quad, enh, MAX_PX);
  const dataUrl = out.toDataURL('image/jpeg', enh ? 0.8 : QUALITY);
  if (replace) { // re-crop of an already saved page: same filename, upload again (backend replaces it)
    replace.dataUrl = dataUrl; replace.status = 'queued'; if (replace.el) replace.el.remove(); addRow(replace); upload(replace); return replace; }
  state.page++; updatePageLabel();
  const pg = { jo: state.jo, page: state.page, filename: `${state.jo}-p${state.page}.jpg`, dataUrl, status: 'queued' };
  state.pages.push(pg); addRow(pg); upload(pg); return pg;
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
window.__scan = { state, review, openReview, capture, finalConfidence, AUTO_ACCEPT };

/* ---------- list + upload ---------- */
function addRow(pg) {
  const li = document.createElement('li');
  li.innerHTML = `<img alt=""><div><div class="nm"></div><div class="st"></div></div><button class="retry hidden">Retry</button>`;
  li.querySelector('img').src = pg.dataUrl; li.querySelector('.nm').textContent = pg.filename;
  li.querySelector('.retry').onclick = () => upload(pg);
  pg.el = li; $('pages').prepend(li); setStatus(pg, 'queued', api() ? 'Uploading…' : 'Waiting for backend URL');
}
function setStatus(pg, cls, text) {
  pg.status = cls; const st = pg.el.querySelector('.st'); st.className = 'st ' + cls; st.textContent = text;
  pg.el.querySelector('.retry').classList.toggle('hidden', !(cls === 'err' || cls === 'mm'));
}
async function upload(pg) {
  if (!api()) return setStatus(pg, 'err', 'No backend URL. Set it in Settings then Retry');
  setStatus(pg, 'queued', 'Uploading…');
  try {
    const res = await fetch(api(), { method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // simple request: no CORS preflight
      body: JSON.stringify({ token: localStorage.getItem(LS.token) || '', jo: pg.jo, page: pg.page, filename: pg.filename, imageBase64: pg.dataUrl.split(',')[1] }) });
    const r = await res.json();
    if (!r.ok) throw new Error(r.error || 'Upload failed');
    pg.result = r;
    const found = (r.joFound || []).map(normJO);
    if (r.match || found.includes(pg.jo)) setStatus(pg, 'ok', 'Saved ✓ JO verified');
    else if (!found.length) setStatus(pg, 'ok', 'Saved ✓ (no JO number read on this page)');
    else setStatus(pg, 'mm', 'Saved, but card reads ' + found.join(', ') + ' (typed ' + pg.jo + '). Check!');
  } catch (e) { setStatus(pg, 'err', 'Failed: ' + e.message); }
}
function retryAll() { state.pages.filter(p => p.status === 'err').forEach(upload); }
window.addEventListener('online', retryAll);
})();
