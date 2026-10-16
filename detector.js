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
  [small, gray, blur, edges, tmp, hsv, rgb, k3, k7].forEach(m => m.delete()); ch.delete();
  if (!cands.length) return null;
  // consensus: prefer quads that several methods agree on
  for (const c of cands) c.votes = cands.filter(o => maxDist(o.quad, c.quad) < 0.03).length;
  cands.sort((a, b) => (b.score * (1 + 0.15 * Math.min(b.votes, 5))) - (a.score * (1 + 0.15 * Math.min(a.votes, 5))));
  const best = cands[0]; best.all = cands; best.confidence = confidence(best); return best;
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
function maxDist(a, b) { return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]))); }
// warp full-res rgba Mat by normalised quad -> new Mat oriented to card aspect, long side <= maxPx
function warpQuad(cv, rgba, q, maxPx) {
  const P = q.map(([x, y]) => [x * rgba.cols, y * rgba.rows]);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let w = Math.max(d(P[0], P[1]), d(P[3], P[2])), h = Math.max(d(P[0], P[3]), d(P[1], P[2]));
  const s = Math.min(1, (maxPx || 2000) / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s);
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...P));
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const M = cv.getPerspectiveTransform(src, dst), out = new cv.Mat();
  cv.warpPerspective(rgba, out, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  src.delete(); dst.delete(); M.delete(); return out;
}
const api = { confidence, enhance, lineFamilies, rectangularity, aspectScore, detectQuad, warpQuad, order, area, maxDist };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CardDetector = api;
})(typeof self !== 'undefined' ? self : this);
