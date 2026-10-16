/* OYP Card Scanner — static front-end, no build step. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const LS = { api: 'oypScanApi', token: 'oypScanToken', queue: 'oypScanQueue' };
const qs = new URLSearchParams(location.search);
if (qs.get('api')) localStorage.setItem(LS.api, qs.get('api'));
if (qs.get('token')) localStorage.setItem(LS.token, qs.get('token'));

const state = { jo: '', page: 0, stream: null, loop: null, lastQuad: null, steadySince: 0, cooldownUntil: 0, pages: [] };
const MAX_PX = 2000, QUALITY = 0.85, STEADY_MS = 1000, COOLDOWN_MS = 2500;

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
  await startCamera();
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
async function startCamera() {
  if (state.stream && state.stream.active) { runLoop(); return; }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } } });
    video.srcObject = state.stream; await video.play();
    hint('Align the card inside the frame');
    runLoop();
  } catch (e) {
    // iOS can refuse camera start outside a tap (e.g. after voice); let the user tap the preview to retry
    hint('Tap here to start the camera'); const h = $('hint');
    const retry = () => { h.removeEventListener('click', retry); video.removeEventListener('click', retry); startCamera(); };
    h.style.pointerEvents = 'auto'; h.addEventListener('click', retry); video.addEventListener('click', retry);
  }
}
function hint(t, ok) { const h = $('hint'); h.textContent = t; h.classList.toggle('ok', !!ok); }

/* ---------- lightweight edge/paper detection ---------- */
const DW = 160;
function detect() {
  const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return null;
  const dh = Math.round(DW * vh / vw);
  work.width = DW; work.height = dh;
  const c = work.getContext('2d', { willReadFrequently: true });
  c.drawImage(video, 0, 0, DW, dh);
  const d = c.getImageData(0, 0, DW, dh).data, n = DW * dh, g = new Uint8Array(n), hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) { const v = (d[i*4]*77 + d[i*4+1]*150 + d[i*4+2]*29) >> 8; g[i] = v; hist[v]++; }
  // Otsu threshold
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = n - wB; if (!wF) break;
    sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; th = i; } }
  // largest bright connected component (card paper is lighter than the table)
  const lab = new Int32Array(n); let bestId = 0, bestSz = 0, id = 0; const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (lab[s] || g[s] <= th) continue; id++; let sp = 0, sz = 0; stack[sp++] = s; lab[s] = id;
    while (sp) { const p = stack[--sp]; sz++; const x = p % DW;
      const nb = [p - DW, p + DW, x > 0 ? p - 1 : -1, x < DW - 1 ? p + 1 : -1];
      for (const q of nb) if (q >= 0 && q < n && !lab[q] && g[q] > th) { lab[q] = id; stack[sp++] = q; } }
    if (sz > bestSz) { bestSz = sz; bestId = id; }
  }
  if (bestSz < n * 0.2 || bestSz > n * 0.97) return null;
  // corners = extremes of x+y and x-y
  let tl = [0,0,1e9], tr = [0,0,-1e9], br = [0,0,-1e9], bl = [0,0,1e9];
  for (let p = 0; p < n; p++) if (lab[p] === bestId) { const x = p % DW, y = (p / DW) | 0;
    if (x + y < tl[2]) tl = [x, y, x + y]; if (x + y > br[2]) br = [x, y, x + y];
    if (x - y > tr[2]) tr = [x, y, x - y]; if (x - y < bl[2]) bl = [x, y, x - y]; }
  const quad = [tl, tr, br, bl].map(p => [p[0] / DW, p[1] / dh]);
  const area = polyArea(quad); if (area < 0.2) return null;
  // reject if the blob is far from a quadrilateral (fill ratio)
  if (bestSz / n / area < 0.85) return null;
  return quad;
}
function polyArea(q) { let a = 0; for (let i = 0; i < 4; i++) { const [x1,y1] = q[i], [x2,y2] = q[(i+1)%4]; a += x1*y2 - x2*y1; } return Math.abs(a) / 2; }

function drawQuad(q, ok) {
  const r = overlay.getBoundingClientRect(); overlay.width = r.width; overlay.height = r.height;
  const c = overlay.getContext('2d'); c.clearRect(0, 0, r.width, r.height); if (!q) return;
  // map normalised video coords to the object-fit:cover element
  const vw = video.videoWidth, vh = video.videoHeight, s = Math.max(r.width / vw, r.height / vh);
  const ox = (r.width - vw * s) / 2, oy = (r.height - vh * s) / 2;
  c.strokeStyle = ok ? '#d4af37' : 'rgba(255,255,255,.8)'; c.lineWidth = 4; c.fillStyle = ok ? 'rgba(212,175,55,.18)' : 'rgba(255,255,255,.08)';
  c.beginPath(); q.forEach(([x, y], i) => c[i ? 'lineTo' : 'moveTo'](ox + x * vw * s, oy + y * vh * s)); c.closePath(); c.fill(); c.stroke();
}

function runLoop() {
  clearInterval(state.loop);
  state.loop = setInterval(() => {
    if ($('scanView').classList.contains('hidden')) return;
    const q = detect(), now = Date.now();
    if (!q) { state.lastQuad = null; state.steadySince = 0; drawQuad(null); hint('Align the card inside the frame'); return; }
    const moved = state.lastQuad ? Math.max(...q.map((p, i) => Math.hypot(p[0] - state.lastQuad[i][0], p[1] - state.lastQuad[i][1]))) : 1;
    state.lastQuad = q;
    if (moved > 0.02) state.steadySince = now;
    const steady = now - state.steadySince >= STEADY_MS;
    drawQuad(q, steady);
    if (now < state.cooldownUntil) { hint('Captured. Flip to the next page', true); return; }
    if (!$('autoSnap').checked) { hint('Card found. Tap the button to capture', true); return; }
    if (steady) capture(q); else hint('Card found. Hold steady…');
  }, 150);
}

/* ---------- capture + perspective correction ---------- */
$('btnCapture').onclick = () => capture(state.lastQuad);
function capture(quad) {
  if (!video.videoWidth) return;
  state.cooldownUntil = Date.now() + COOLDOWN_MS; state.steadySince = Date.now();
  const vw = video.videoWidth, vh = video.videoHeight;
  const src = document.createElement('canvas'); src.width = vw; src.height = vh; src.getContext('2d').drawImage(video, 0, 0);
  let out;
  if (quad && $('doCrop').checked) out = warp(src, quad.map(([x, y]) => [x * vw, y * vh]));
  else { const s = Math.min(1, MAX_PX / Math.max(vw, vh)); out = document.createElement('canvas'); out.width = vw * s; out.height = vh * s; out.getContext('2d').drawImage(src, 0, 0, out.width, out.height); }
  const dataUrl = out.toDataURL('image/jpeg', QUALITY);
  state.page++; updatePageLabel();
  const pg = { jo: state.jo, page: state.page, filename: `${state.jo}-p${state.page}.jpg`, dataUrl, status: 'queued' };
  state.pages.push(pg); addRow(pg); upload(pg);
  if (navigator.vibrate) navigator.vibrate(60);
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
function warp(src, q) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const s = Math.min(1, MAX_PX / Math.max(W, H)); W = Math.round(W * s); H = Math.round(H * s);
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
