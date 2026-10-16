/* OYP card detector (OpenCV.js). Works in browser (window.CardDetector) and Node (module.exports).
   detectQuad(cv, rgbaMat) -> {quad:[[x,y]x4 normalised TL,TR,BR,BL], score, method} | null */
(function (root) {
'use strict';
function order(pts) {
  const c = pts.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
  pts = pts.slice().sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
  // rotate so first is top-left (min x+y)
  let k = 0; pts.forEach((p, i) => { if (p[0] + p[1] < pts[k][0] + pts[k][1]) k = i; });
  return pts.slice(k).concat(pts.slice(0, k)); // TL,TR,BR,BL (clockwise in image coords)
}
function area(q) { let a = 0; for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; }
function angleOk(q) { // every interior angle 55..125 degrees
  for (let i = 0; i < 4; i++) { const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
    const a = [p[0] - c[0], p[1] - c[1]], b = [n[0] - c[0], n[1] - c[1]];
    const cos = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b) + 1e-9);
    if (Math.abs(cos) > 0.57) return false; }
  return true;
}
function quadsFromMask(cv, bin, W, H, method, out) {
  const cs = new cv.MatVector(), hi = new cv.Mat();
  cv.findContours(bin, cs, hi, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < cs.size(); i++) {
    const c = cs.get(i); const a = cv.contourArea(c);
    if (a < W * H * 0.2) { c.delete(); continue; }
    const hull = new cv.Mat(); cv.convexHull(c, hull, false, true);
    const peri = cv.arcLength(hull, true);
    for (const eps of [0.02, 0.035, 0.05]) {
      const ap = new cv.Mat(); cv.approxPolyDP(hull, ap, eps * peri, true);
      if (ap.rows === 4) {
        const pts = []; for (let j = 0; j < 4; j++) pts.push([ap.data32S[j * 2], ap.data32S[j * 2 + 1]]);
        const q = order(pts), qa = area(q) / (W * H);
        // edge support: fraction of the hull area actually filled by the contour (rejects L-shapes)
        const fill = a / (area(q) + 1e-9);
        // how many corners sit on the frame border (card cut off / whole-frame contour)
        const onB = q.filter(([x, y]) => x < 3 || y < 3 || x > W - 4 || y > H - 4).length;
        if (qa > 0.2 && qa < 0.985 && fill > 0.8 && angleOk(q) && onB < 3) {
          const s = qa * fill * (onB ? 0.75 : 1);
          out.push({ quad: q.map(([x, y]) => [x / W, y / H]), score: s, method, area: qa });
        }
        ap.delete(); break;
      }
      ap.delete();
    }
    // non-convex outline (e.g. card overlapping another sheet): intersect the 4 longest sides
    const ap2 = new cv.Mat(); cv.approxPolyDP(c, ap2, 0.012 * cv.arcLength(c, true), true);
    const n = ap2.rows;
    if (n > 4 && n < 16) {
      const P = []; for (let j = 0; j < n; j++) P.push([ap2.data32S[j * 2], ap2.data32S[j * 2 + 1]]);
      const E = P.map((p, j) => ({ j, a: p, b: P[(j + 1) % n], L: Math.hypot(P[(j + 1) % n][0] - p[0], P[(j + 1) % n][1] - p[1]) }));
      const top = E.slice().sort((x, y) => y.L - x.L).slice(0, 4).sort((x, y) => x.j - y.j);
      const pts = []; let ok = true;
      for (let j = 0; j < 4; j++) { const X = inter(top[j], top[(j + 1) % 4]); if (!X) { ok = false; break; } pts.push(X); }
      if (ok) { const q = order(pts), qa = area(q) / (W * H);
        if (qa > 0.2 && qa < 0.985 && angleOk(q) && q.every(([x, y]) => x > -0.05 * W && y > -0.05 * H && x < 1.05 * W && y < 1.05 * H))
          out.push({ quad: q.map(([x, y]) => [Math.min(1, Math.max(0, x / W)), Math.min(1, Math.max(0, y / H))]), score: qa, method: method + '-sides', area: qa }); }
    }
    ap2.delete(); hull.delete(); c.delete();
  }
  cs.delete(); hi.delete();
}

// ---- rectangle-constrained fitting -------------------------------------------------
// Cards are rectangles: find long straight edges, split them into two perpendicular
// families, and build quads from 2 lines of each family. A corner hidden under another
// sheet is then simply the intersection of the two extended sides.
function lineFamilies(cv, edges, W, H, extra) {
  const L = new cv.Mat(), mn = Math.min(W, H);
  cv.HoughLinesP(edges, L, 1, Math.PI / 180, 30, mn * 0.12, 8);
  const segs = [];
  const nL = L.data32S.length / 4; for (let i = 0; i < nL; i++) { const [x1, y1, x2, y2] = L.data32S.slice(i * 4, i * 4 + 4);
    const len = Math.hypot(x2 - x1, y2 - y1); let a = Math.atan2(y2 - y1, x2 - x1); if (a < 0) a += Math.PI; if (a >= Math.PI) a -= Math.PI;
    segs.push({ x1, y1, x2, y2, len, a }); }
  L.delete();
  // sides of contour-based quads join as long segments (catch faint edges Hough misses)
  for (const [p, q] of (extra || [])) { const len = Math.hypot(q[0] - p[0], q[1] - p[1]); let a = Math.atan2(q[1] - p[1], q[0] - p[0]); if (a < 0) a += Math.PI; if (a >= Math.PI) a -= Math.PI;
    segs.push({ x1: p[0], y1: p[1], x2: q[0], y2: q[1], len: len * 0.5, a, ex: 1 }); }
  if (segs.length < 4) return null;
  // dominant orientation modulo 90deg (length-weighted histogram, 1deg bins, smoothed)
  const hist = new Array(90).fill(0);
  for (const s of segs) if (!s.ex) hist[Math.floor(s.a * 180 / Math.PI) % 90] += s.len;
  let best = 0, bv = -1;
  for (let b = 0; b < 90; b++) { const v = hist[(b + 89) % 90] + 2 * hist[b] + hist[(b + 1) % 90]; if (v > bv) { bv = v; best = b; } }
  const th0 = (best + 0.5) * Math.PI / 180, tol = 5 * Math.PI / 180;
  const angDiff = (a, b) => { let d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };
  const fams = [th0, th0 + Math.PI / 2].map(th => {
    const nx = -Math.sin(th), ny = Math.cos(th), mem = segs.filter(s => angDiff(s.a, th) < tol);
    mem.forEach(s => s.d = nx * (s.x1 + s.x2) / 2 + ny * (s.y1 + s.y2) / 2);
    mem.sort((p, q) => p.d - q.d);
    const cl = []; // cluster by offset
    for (const s of mem) { const c = cl[cl.length - 1]; if (c && s.d - c.last < mn * 0.015) { c.s.push(s); c.last = s.d; } else cl.push({ s: [s], last: s.d }); }
    return cl.map(c => { // least-squares line through segment endpoints, weighted by length
      let sx = 0, sy = 0, sw = 0; for (const s of c.s) { sx += (s.x1 + s.x2) * s.len; sy += (s.y1 + s.y2) * s.len; sw += 2 * s.len; }
      const mx = sx / sw, my = sy / sw; let a = 0, b = 0, d = 0;
      for (const s of c.s) for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) { const u = x - mx, v = y - my; a += u * u * s.len; b += u * v * s.len; d += v * v * s.len; }
      const ang = 0.5 * Math.atan2(2 * b, a - d), tot = c.s.reduce((t, s) => t + s.len, 0);
      return { a: [mx, my], b: [mx + Math.cos(ang) * 100, my + Math.sin(ang) * 100], ang, tot };
    }).filter(l => l.tot > mn * 0.15).sort((p, q) => q.tot - p.tot).slice(0, 10);
  });
  return fams[0].length >= 2 && fams[1].length >= 2 ? fams : null;
}
function rectQuads(cv, edges, sup, W, H, prior, out) {
  const loc = [], extra = [];
  const nearB = ([x, y]) => x < 0.015 || y < 0.015 || x > 0.985 || y > 0.985;
  for (const c of out) for (let i = 0; i < 4; i++) if (!(nearB(c.quad[i]) && nearB(c.quad[(i + 1) % 4]))) extra.push([[c.quad[i][0] * W, c.quad[i][1] * H], [c.quad[(i + 1) % 4][0] * W, c.quad[(i + 1) % 4][1] * H]]);
  const fams = lineFamilies(cv, edges, W, H, extra); if (!fams) return;
  const [A, B] = fams;
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++)
  for (let k = 0; k < B.length; k++) for (let l = k + 1; l < B.length; l++) {
    const pts = [inter(A[i], B[k]), inter(A[i], B[l]), inter(A[j], B[l]), inter(A[j], B[k])];
    if (pts.some(p => !p || p[0] < -0.08 * W || p[1] < -0.08 * H || p[0] > 1.08 * W || p[1] > 1.08 * H)) continue;
    const q = order(pts), qa = area(q) / (W * H);
    if (qa < 0.2 || qa > 0.985 || !angleOk(q)) continue;
    const nq = q.map(([x, y]) => [Math.min(1, Math.max(0, x / W)), Math.min(1, Math.max(0, y / H))]), sp = support(sup, nq, W, H);
    loc.push({ quad: nq, method: 'rect', area: qa, s: qa * sp * sp * aspectScore(nq, W, H, prior) });
  }
  loc.sort((a, b) => b.s - a.s); for (const c of loc.slice(0, 12)) out.push(c);
}
// 1 = perfect rectangle seen head-on; drops as opposite sides stop being parallel
function rectangularity(q, W, H) {
  const P = q.map(([x, y]) => [x * W, y * H]), ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const dd = (a, b) => { let d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d) * 180 / Math.PI; };
  const p1 = dd(ang(P[0], P[1]), ang(P[3], P[2])), p2 = dd(ang(P[0], P[3]), ang(P[1], P[2]));
  const worst = Math.max(p1, p2); return worst < 4 ? 1 : Math.max(0.2, 1 - (worst - 4) / 12);
}
// soft prior on card shape (long/short side). JO cards measured ~1.55 (5.5x8.5in).
function aspectScore(q, W, H, prior) {
  const P = q.map(([x, y]) => [x * W, y * H]), d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = (d(P[0], P[1]) + d(P[3], P[2])) / 2, h = (d(P[0], P[3]) + d(P[1], P[2])) / 2;
  const r = Math.max(w, h) / Math.min(w, h), e = Math.abs(Math.log(r / prior));
  return e < 0.12 ? 1 : Math.max(0.3, 1 - (e - 0.12) * 3);
}
function detectQuad(cv, rgba, opts) {
  opts = opts || {}; const target = opts.size || 480;
  const sc = target / Math.max(rgba.cols, rgba.rows);
  const small = new cv.Mat(); cv.resize(rgba, small, new cv.Size(Math.round(rgba.cols * sc), Math.round(rgba.rows * sc)), 0, 0, cv.INTER_AREA);
  const W = small.cols, H = small.rows, cands = [];
  const gray = new cv.Mat(), blur = new cv.Mat(), edges = new cv.Mat(), tmp = new cv.Mat();
  cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
  // 1) Canny on gray at a few sensitivities (low contrast paper vs light desk)
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  for (const [lo, hi] of [[10, 30], [25, 75], [50, 150]]) {
    cv.Canny(blur, edges, lo, hi);
    for (const it of [1, 2]) { cv.dilate(edges, tmp, k3, new cv.Point(-1, -1), it); quadsFromMask(cv, tmp, W, H, 'canny' + lo + 'd' + it, cands); }
  }
  // 2) colour: paper is neutral white, desk is warmer/greyer. Use saturation + value via Otsu.
  const hsv = new cv.Mat(), ch = new cv.MatVector(), rgb = new cv.Mat();
  cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV); cv.split(hsv, ch);
  const k7 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  const masks = [[gray, cv.THRESH_BINARY, 'otsuV'], [ch.get(1), cv.THRESH_BINARY_INV, 'otsuS']];
  for (const [m, t, name] of masks) {
    const b = new cv.Mat(); cv.GaussianBlur(m, b, new cv.Size(7, 7), 0);
    cv.threshold(b, tmp, 0, 255, t | cv.THRESH_OTSU);
    cv.morphologyEx(tmp, tmp, cv.MORPH_CLOSE, k7, new cv.Point(-1, -1), 3); // fill grid lines / ink
    cv.morphologyEx(tmp, tmp, cv.MORPH_OPEN, k7, new cv.Point(-1, -1), 1);
    quadsFromMask(cv, tmp, W, H, name, cands); b.delete();
  }
  // 3) adaptive threshold (local contrast) closed into a blob
  cv.adaptiveThreshold(blur, tmp, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 51, -2);
  cv.morphologyEx(tmp, tmp, cv.MORPH_CLOSE, k7, new cv.Point(-1, -1), 2);
  quadsFromMask(cv, tmp, W, H, 'adapt', cands);
  const sup = new cv.Mat(); cv.Canny(blur, edges, 15, 45); cv.dilate(edges, sup, k3, new cv.Point(-1, -1), 2);
  const prior = opts.aspect || 1.55;
  cv.Canny(blur, edges, 20, 60); rectQuads(cv, edges, sup, W, H, prior, cands);
  for (const c of cands) { c.support = support(sup, c.quad, W, H); c.rect = rectangularity(c.quad, W, H); c.asp = aspectScore(c.quad, W, H, prior); c.step = edgeStep(gray, c.quad, W, H);
    const nb = ([x, y]) => x < 0.006 || y < 0.006 || x > 0.994 || y > 0.994; c.cut = [0, 1, 2, 3].filter(i => nb(c.quad[i]) && nb(c.quad[(i + 1) % 4])).length;
    c.score = c.area * Math.pow(c.support, 1.5) * c.rect * c.asp * c.step * c.step * Math.pow(0.7, c.cut); }
  sup.delete();
  // white-page gate: the inside must look like paper (bright, low chroma, brighter than the surround)
  const wp = whiteStats(small, W, H);
  for (const c of cands) c.white = wp(c.quad);
  const keep = cands.filter(c => c.white.ok && c.area >= 0.12);
  cands.length = 0; cands.push(...keep);
  [small, gray, blur, edges, tmp, hsv, rgb, k3, k7].forEach(m => m.delete()); ch.delete();
  if (!cands.length) return null;
  // consensus: prefer quads that several methods agree on
  for (const c of cands) c.votes = cands.filter(o => maxDist(o.quad, c.quad) < 0.03).length;
  cands.sort((a, b) => (b.score * (1 + 0.15 * Math.min(b.votes, 5))) - (a.score * (1 + 0.15 * Math.min(a.votes, 5))));
  const best = cands[0]; best.all = cands; best.confidence = confidence(best); return best;
}
function whiteStats(img, W, H) {
  const d = img.data, ch = img.channels();
  const at = (x, y) => { x = Math.max(0, Math.min(W - 1, x | 0)); y = Math.max(0, Math.min(H - 1, y | 0)); const i = (y * W + x) * ch;
    const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); return [(r + g + b) / 3, mx - mn]; };
  return q => {
    const P = q.map(([x, y]) => [x * W, y * H]), c = P.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    const lum = [], chr = []; let out = 0, on = 0;
    for (let u = 0.15; u <= 0.85; u += 0.07) for (let v = 0.15; v <= 0.85; v += 0.07) { // bilinear grid inside
      const top = [P[0][0] + (P[1][0] - P[0][0]) * u, P[0][1] + (P[1][1] - P[0][1]) * u], bot = [P[3][0] + (P[2][0] - P[3][0]) * u, P[3][1] + (P[2][1] - P[3][1]) * u];
      const [l, k] = at(top[0] + (bot[0] - top[0]) * v, top[1] + (bot[1] - top[1]) * v); lum.push(l); chr.push(k); }
    for (const p of P) for (let k = 0; k < 4; k++) { const n = P[(P.indexOf(p) + 1) % 4], x = p[0] + (n[0] - p[0]) * (k + .5) / 4, y = p[1] + (n[1] - p[1]) * (k + .5) / 4;
      const ox = x + (x - c[0]) * 0.08, oy = y + (y - c[1]) * 0.08; if (ox < 0 || oy < 0 || ox >= W || oy >= H) continue; out += at(ox, oy)[0]; on++; }
    lum.sort((a, b) => a - b); chr.sort((a, b) => a - b);
    const L = lum[lum.length >> 1], L75 = lum[(lum.length * 0.75) | 0], C = chr[chr.length >> 1], O = on ? out / on : null;
    const ok = L75 >= 140 && L >= 110 && C <= 40 && (O == null || L - O >= 12 || on < 4);
    return { ok, L: +L.toFixed(0), C: +C.toFixed(0), O: O == null ? null : +O.toFixed(0) };
  };
}
function inter(e1, e2) {
  const [x1, y1] = e1.a, [x2, y2] = e1.b, [x3, y3] = e2.a, [x4, y4] = e2.b;
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4); if (Math.abs(d) < 1e-6) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d; return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}
// fraction of points along the quad outline that lie on an edge pixel
function support(edge, q, W, H) {
  let hit = 0, tot = 0; const per = [];
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; let h = 0, t = 0;
    for (let k = 0.05; k < 0.95; k += 0.02) { const x = Math.round((a[0] + (b[0] - a[0]) * k) * W), y = Math.round((a[1] + (b[1] - a[1]) * k) * H);
      t++; const inside = x >= 0 && y >= 0 && x < W && y < H;
      if (inside && edge.ucharPtr(y, x)[0]) h++;
      else if (x < 6 || y < 6 || x >= W - 6 || y >= H - 6) h += 0.45; } // near/off frame: neutral-ish
    per.push(h / t); hit += h; tot += t; }
  return Math.min(...per) * 0.5 + (hit / tot) * 0.5;
}
// per-side brightness step across the edge (inside vs outside band). Printed lines inside the
// card have paper on both sides (no step); real card edges usually do. Returns 0..1.
function edgeStep(gray, q, W, H) {
  const P = q.map(([x, y]) => [x * W, y * H]), c = P.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
  let worst = 1, tot = 0;
  for (let i = 0; i < 4; i++) { const a = P[i], b = P[(i + 1) % 4]; let L = Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-9;
    let nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L; const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if ((c[0] - mx) * nx + (c[1] - my) * ny < 0) { nx = -nx; ny = -ny; } // n points inward
    let din = 0, dout = 0, n = 0, off = 0;
    for (let k = 0.1; k < 0.9; k += 0.04) { const x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k;
      const xi = Math.round(x + nx * 5), yi = Math.round(y + ny * 5), xo = Math.round(x - nx * 5), yo = Math.round(y - ny * 5);
      if (xo < 0 || yo < 0 || xo >= W || yo >= H || xi < 0 || yi < 0 || xi >= W || yi >= H) { off++; continue; }
      din += gray.ucharPtr(yi, xi)[0]; dout += gray.ucharPtr(yo, xo)[0]; n++; }
    const st = n < 3 ? 0.7 : Math.min(1, Math.abs(din - dout) / n / 25);
    worst = Math.min(worst, st); tot += st; }
  return 0.4 + 0.6 * (0.5 * worst + 0.5 * tot / 4);
}
// 0..1 confidence that the quad is exactly the card (temporal stability is added by the app)
function confidence(c) {
  if (!c) return 0;
  const sup = Math.min(1, Math.max(0, (c.support - 0.5) / 0.4));   // 0.5 -> 0, 0.9+ -> 1
  const step = Math.min(1, Math.max(0, (c.step - 0.5) / 0.35));
  const agree = Math.min(1, (c.votes || 1) / 3);
  const gate = Math.min(1, c.asp / 0.9) * (c.cut ? 0.85 : 1); // wrong shape or a side lost off-frame -> review
  return +((0.35 * sup + 0.2 * c.rect + 0.2 * c.asp + 0.15 * step + 0.1 * agree) * gate).toFixed(3);
}
// Document enhancement that keeps colour (highlighter, sticky notes): flatten shadows by dividing
// by a blurred paper background (per channel = white balance), stretch contrast, mild unsharp mask.
function enhance(cv, rgba) {
  const rgb = new cv.Mat(); cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  const W = rgb.cols, H = rgb.rows, f = 8, sm = new cv.Mat(), bg = new cv.Mat();
  cv.resize(rgb, sm, new cv.Size(Math.max(8, Math.round(W / f)), Math.max(8, Math.round(H / f))), 0, 0, cv.INTER_AREA);
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
  cv.dilate(sm, sm, k, new cv.Point(-1, -1), 2);           // lift ink/lines -> paper colour only
  cv.medianBlur(sm, sm, 7); cv.GaussianBlur(sm, sm, new cv.Size(0, 0), 4);
  cv.resize(sm, bg, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  const a = new cv.Mat(), b = new cv.Mat(), o = new cv.Mat();
  rgb.convertTo(a, cv.CV_32F); bg.convertTo(b, cv.CV_32F); const one = new cv.Mat(H, W, cv.CV_32FC3, new cv.Scalar(1, 1, 1)); cv.max(b, one, b); one.delete();
  cv.divide(a, b, o, 248);                                   // paper -> ~248 neutral white
  o.convertTo(rgb, cv.CV_8U);
  // contrast stretch from the 1st percentile of luminance (ink) to white
  const g = new cv.Mat(); cv.cvtColor(rgb, g, cv.COLOR_RGB2GRAY);
  const hist = new Array(256).fill(0), d = g.data; for (let i = 0; i < d.length; i += 7) hist[d[i]]++;
  const n = hist.reduce((x, y) => x + y, 0); let lo = 0, acc = 0; while (lo < 120 && (acc += hist[lo]) < n * 0.01) lo++;
  const sc = 255 / Math.max(80, 250 - lo); rgb.convertTo(rgb, -1, sc, -lo * sc);
  // unsharp mask for handwriting
  const bl = new cv.Mat(); cv.GaussianBlur(rgb, bl, new cv.Size(0, 0), 1.2); cv.addWeighted(rgb, 1.35, bl, -0.35, 0, rgb);
  const out = new cv.Mat(); cv.cvtColor(rgb, out, cv.COLOR_RGB2RGBA);
  [rgb, sm, bg, k, a, b, o, g, bl].forEach(m => m.delete()); return out;
}

// Snap each side to the true card edge: sample along the side, search along the normal for the
// strongest brightness step (paper vs background), robust line fit, re-intersect; then inset.
function refineQuad(cv, rgba, q, opts) {
  opts = opts || {}; const target = opts.size || 1200, inset = opts.inset == null ? 0.007 : opts.inset;
  const sc = Math.min(1, target / Math.max(rgba.cols, rgba.rows)), g = new cv.Mat(), sm = new cv.Mat();
  cv.resize(rgba, sm, new cv.Size(Math.round(rgba.cols * sc), Math.round(rgba.rows * sc)), 0, 0, cv.INTER_AREA);
  cv.cvtColor(sm, g, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(g, g, new cv.Size(3, 3), 0); sm.delete();
  const W = g.cols, H = g.rows, d = g.data, px = (x, y) => { x = Math.max(0, Math.min(W - 1, x | 0)); y = Math.max(0, Math.min(H - 1, y | 0)); return d[y * W + x]; };
  const P = q.map(([x, y]) => [x * W, y * H]), c = P.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
  const R = Math.round(Math.max(W, H) * 0.06), lines = [];
  for (let i = 0; i < 4; i++) {
    const a = P[i], b = P[(i + 1) % 4], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L; const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if ((c[0] - mx) * nx + (c[1] - my) * ny < 0) { nx = -nx; ny = -ny; }   // inward normal
    const pts = [];
    for (let k = 0.06; k <= 0.94; k += 0.02) {
      const x0 = a[0] + (b[0] - a[0]) * k, y0 = a[1] + (b[1] - a[1]) * k;
      if (x0 < 3 || y0 < 3 || x0 > W - 4 || y0 > H - 4) continue;
      let best = 0, bt = null;
      for (let t = -R; t <= R; t++) { // inside(t+2) brighter than outside(t-2): paper edge
        // wide bands: a thin printed line has paper on both sides, a real card edge does not
        let si = 0, so = 0, ok = true;
        for (let u = 3; u <= 9; u += 2) { const xo = x0 + nx * (t - u), yo = y0 + ny * (t - u);
          if (xo < 0 || yo < 0 || xo >= W || yo >= H) { ok = false; break; }
          si += px(x0 + nx * (t + u), y0 + ny * (t + u)); so += px(xo, yo); }
        if (!ok) continue; const st = (si - so) / 4; if (st > best) { best = st; bt = t; } }
      if (bt !== null && best > 12 && Math.abs(bt) < R - 1) { const p = [x0 + nx * bt, y0 + ny * bt]; p.k = k; pts.push(p); }
    }
    const fit = (pp, minFrac, maxDeg) => { // RANSAC-lite: best pair consensus, then least squares on inliers
      if (pp.length < 6) return null; let bestIn = [], bestOff = 0;
      for (let it = 0; it < 80; it++) { const p = pp[(it * 7) % pp.length], r = pp[(it * 13 + 5) % pp.length];
        const l = Math.hypot(r[0] - p[0], r[1] - p[1]); if (l < L * 0.15) continue;
        const ux = (r[0] - p[0]) / l, uy = (r[1] - p[1]) / l;
        const inl = pp.filter(z => Math.abs((z[0] - p[0]) * uy - (z[1] - p[1]) * ux) < 3);
        if (inl.length < Math.max(6, pp.length * minFrac)) continue;
        // among well-supported lines prefer the OUTERMOST: printed frame lines sit inside the card
        const off = inl.reduce((s2, z) => s2 + (z[0] - a[0]) * nx + (z[1] - a[1]) * ny, 0) / inl.length;
        if (off < -15) continue; // outward candidates are sheets/table, not this card
        if (!bestIn.length || off < bestOff - 6 || (Math.abs(off - bestOff) <= 6 && inl.length > bestIn.length)) { bestIn = inl; bestOff = off; } }
      if (!bestIn.length) return null;
      const n = bestIn.length, mx2 = bestIn.reduce((s, z) => s + z[0], 0) / n, my2 = bestIn.reduce((s, z) => s + z[1], 0) / n;
      let sxx = 0, sxy = 0, syy = 0; for (const [x, y] of bestIn) { sxx += (x - mx2) ** 2; sxy += (x - mx2) * (y - my2); syy += (y - my2) ** 2; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(ang), uy = Math.sin(ang);
      const cosd = Math.abs(ux * (b[0] - a[0]) / L + uy * (b[1] - a[1]) / L); // reject refits rotating the side > 5 deg
      return cosd > Math.cos((maxDeg || 4) * Math.PI / 180) ? { a: [mx2, my2], b: [mx2 + ux * 100, my2 + uy * 100], n: [nx, ny], cnt: n } : null;
    };
    // whole side first; if one end is hidden under another sheet, fit the visible half alone
    if (opts.debug) opts.debug.push({ i, pts: pts.map(p => [p.k.toFixed(2), Math.round((p[0] - a[0]) * nx + (p[1] - a[1]) * ny)]) });
    let line = fit(pts, 0.2, 4);
    if (!line) { const h1 = fit(pts.filter(p => p.k < 0.5), 0.5, 6), h2 = fit(pts.filter(p => p.k >= 0.5), 0.5, 6);
      line = h1 && h2 ? (h1.cnt >= h2.cnt ? h1 : h2) : (h1 || h2); }
    if (line) { // never move a side outward (that is how table/sheet gets into the crop)
      const offAt = k => { const x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k; // distance from side point to refit line along n
        const dx = line.b[0] - line.a[0], dy = line.b[1] - line.a[1], den = dx * ny - dy * nx; if (Math.abs(den) < 1e-6) return 0;
        return ((line.a[0] - x) * dy - (line.a[1] - y) * dx) / -den; };
      const o1 = offAt(0.05), o2 = offAt(0.95);
      if (Math.min(o1, o2) < -15 || Math.max(o1, o2) > Math.max(W, H) * 0.09) line = null; }
    if (opts.debug) opts.debug[opts.debug.length - 1].ok = !!line;
    lines.push(line || { a: P[i], b: P[(i + 1) % 4], n: [nx, ny] });
  }
  // rectangle constraint: a refit must not make a side LESS parallel to its opposite side
  // (that happens when a white sheet hides one end and the fit follows the sheet instead)
  const dirOf = l => Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]);
  const angD = (x, y) => { let d = Math.abs(x - y) % Math.PI; return Math.min(d, Math.PI - d) * 180 / Math.PI; };
  const orig = [0, 1, 2, 3].map(i => ({ a: P[i], b: P[(i + 1) % 4] }));
  for (let i = 0; i < 4; i++) { const j = (i + 2) % 4; if (lines[i].a === P[i]) continue;
    const before = angD(dirOf(orig[i]), dirOf(orig[j])), after = angD(dirOf(lines[i]), dirOf(lines[j]));
    if (after > before + 2) lines[i] = { a: P[i], b: P[(i + 1) % 4], n: lines[i].n }; }
  // inset each side inward by a fraction of the card size
  const size = Math.sqrt(area(P));
  const sh = lines.map(l => { const o = size * inset; return { a: [l.a[0] + l.n[0] * o, l.a[1] + l.n[1] * o], b: [l.b[0] + l.n[0] * o, l.b[1] + l.n[1] * o] }; });
  const out = []; for (let i = 0; i < 4; i++) { const X = inter(sh[(i + 3) % 4], sh[i]); if (!X) { g.delete(); return q; } out.push(X); }
  g.delete();
  const r = order(out).map(([x, y]) => [Math.min(1, Math.max(0, x / W)), Math.min(1, Math.max(0, y / H))]);
  return maxDist(r, q) > 0.15 || !angleOk(r) ? q : r; // safety: never jump far from the detection
}
// Residual skew of a warped card from its printed lines (degrees, + = clockwise needed)
function measureSkew(cv, rgba) {
  const g = new cv.Mat(), e = new cv.Mat(), L = new cv.Mat(), sc = 800 / Math.max(rgba.cols, rgba.rows), sm = new cv.Mat();
  cv.resize(rgba, sm, new cv.Size(Math.round(rgba.cols * sc), Math.round(rgba.rows * sc)), 0, 0, cv.INTER_AREA);
  cv.cvtColor(sm, g, cv.COLOR_RGBA2GRAY); cv.Canny(g, e, 50, 150);
  cv.HoughLinesP(e, L, 1, Math.PI / 720, 60, Math.min(sm.cols, sm.rows) * 0.25, 4);
  const A = [], n = L.data32S.length / 4;
  for (let i = 0; i < n; i++) { const [x1, y1, x2, y2] = L.data32S.slice(i * 4, i * 4 + 4);
    let a = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI; a = ((a % 90) + 135) % 90 - 45; // fold to [-45,45)
    if (Math.abs(a) < 8) A.push([a, Math.hypot(x2 - x1, y2 - y1)]); }
  [g, e, L, sm].forEach(m => m.delete());
  if (A.length < 3) return 0;
  A.sort((p, q) => p[0] - q[0]); const tot = A.reduce((s, z) => s + z[1], 0); let acc = 0;
  for (const [a, w] of A) { acc += w; if (acc >= tot / 2) return a; } return 0; // length-weighted median
}
function deskew(cv, rgba, maxDeg) {
  const a = measureSkew(cv, rgba);
  if (Math.abs(a) < 0.1 || Math.abs(a) > (maxDeg || 5)) return { mat: rgba.clone(), angle: 0 };
  const W = rgba.cols, H = rgba.rows, M = cv.getRotationMatrix2D(new cv.Point(W / 2, H / 2), a, 1), out = new cv.Mat();
  // zoom slightly so rotated corners don't reveal fill
  const r = Math.abs(a) * Math.PI / 180, z = Math.cos(r) + Math.sin(r) * Math.max(W / H, H / W);
  const M2 = cv.getRotationMatrix2D(new cv.Point(W / 2, H / 2), a, z);
  cv.warpAffine(rgba, out, M2, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE); M.delete(); M2.delete();
  return { mat: out, angle: a };
}

// Last line of defence after warp+deskew: trim edge rows/columns that still contain background
// (areas clearly darker than the paper after removing thin printed lines). Max 8% per side.
function trimBackground(cv, rgba, opts) {
  opts = opts || {}; const maxFrac = opts.maxFrac || 0.08;
  const sc = 600 / Math.max(rgba.cols, rgba.rows), sm = new cv.Mat(), g = new cv.Mat(), b = new cv.Mat();
  cv.resize(rgba, sm, new cv.Size(Math.round(rgba.cols * sc), Math.round(rgba.rows * sc)), 0, 0, cv.INTER_AREA);
  cv.cvtColor(sm, g, cv.COLOR_RGBA2GRAY); cv.medianBlur(g, b, 9);
  const W = b.cols, H = b.rows, d = b.data, c = [];
  for (let y = H * 0.25 | 0; y < H * 0.75; y += 4) for (let x = W * 0.25 | 0; x < W * 0.75; x += 4) c.push(d[y * W + x]);
  c.sort((p, q) => p - q); const ref = c[c.length * 0.8 | 0], thr = ref * 0.8;
  // background = large dark blobs: threshold, then open with a big kernel to drop text/lines/grids
  const mk = new cv.Mat(); cv.threshold(b, mk, thr, 255, cv.THRESH_BINARY_INV);
  const ker = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(13, 13)); cv.morphologyEx(mk, mk, cv.MORPH_OPEN, ker); ker.delete();
  const md = mk.data.slice(); mk.delete();
  const bad = (x, y) => md[y * W + x] > 0;
  const rowBad = y => { let k = 0; for (let x = 0; x < W; x++) if (bad(x, y)) k++; return k > W * 0.01; };
  const colBad = x => { let k = 0; for (let y = 0; y < H; y++) if (bad(x, y)) k++; return k > H * 0.01; };
  const mx = Math.round(W * maxFrac), my = Math.round(H * maxFrac);
  // walk inward until two consecutive clean lines
  const walk = (n, f) => { let last = 0; for (let i = 0; i < n; i++) if (f(i)) last = i + 1; return last; };
  let t = walk(my, y => rowBad(y)), bo = walk(my, i => rowBad(H - 1 - i)), l = walk(mx, x => colBad(x)), r = walk(mx, i => colBad(W - 1 - i));
  [sm, g, b].forEach(m => m.delete());
  if (!(t || bo || l || r)) return { mat: rgba.clone(), trim: [0, 0, 0, 0] };
  const pad = 2 / sc, X = Math.round(l / sc + (l ? pad : 0)), Y = Math.round(t / sc + (t ? pad : 0));
  const X2 = Math.round(rgba.cols - r / sc - (r ? pad : 0)), Y2 = Math.round(rgba.rows - bo / sc - (bo ? pad : 0));
  const roi = rgba.roi(new cv.Rect(X, Y, Math.max(1, X2 - X), Math.max(1, Y2 - Y))), out = new cv.Mat(); roi.copyTo(out); roi.delete();
  return { mat: out, trim: [t / H, r / W, bo / H, l / W].map(v => +(100 * v).toFixed(1)) };
}
function maxDist(a, b) { return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]))); }
// warp full-res rgba Mat by normalised quad -> new Mat oriented to card aspect, long side <= maxPx
const CARD_RATIO = 1.55;
function cardSize(P, maxPx) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]), L = maxPx || 2000, S = Math.round(L / CARD_RATIO);
  const w = d(P[0], P[1]) + d(P[3], P[2]), h = d(P[0], P[3]) + d(P[1], P[2]);
  return w >= h ? [L, S] : [S, L];
}
function warpQuad(cv, rgba, q, maxPx) {
  const P = q.map(([x, y]) => [x * rgba.cols, y * rgba.rows]);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // every page comes out the same size: card ratio, orientation from the quad, corners mapped edge to edge
  const sz = cardSize(P, maxPx), w = sz[0], h = sz[1];
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...P));
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const M = cv.getPerspectiveTransform(src, dst), out = new cv.Mat();
  cv.warpPerspective(rgba, out, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  src.delete(); dst.delete(); M.delete(); return out;
}
const api = { cardSize, CARD_RATIO, trimBackground, refineQuad, measureSkew, deskew, confidence, enhance, lineFamilies, rectangularity, aspectScore, detectQuad, warpQuad, order, area, maxDist };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CardDetector = api;
})(typeof self !== 'undefined' ? self : this);
