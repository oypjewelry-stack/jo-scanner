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
  for (const c of cands) { c.support = support(sup, c.quad, W, H); c.score = c.area * c.support * c.support; }
  sup.delete();
  [small, gray, blur, edges, tmp, hsv, rgb, k3, k7].forEach(m => m.delete()); ch.delete();
  if (!cands.length) return null;
  // consensus: prefer quads that several methods agree on
  for (const c of cands) c.votes = cands.filter(o => maxDist(o.quad, c.quad) < 0.03).length;
  cands.sort((a, b) => (b.score * (1 + 0.15 * Math.min(b.votes, 5))) - (a.score * (1 + 0.15 * Math.min(a.votes, 5))));
  const best = cands[0]; best.all = cands; return best;
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
      if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) { h += 0.6; t++; continue; } // off-frame side: neutral
      t++; if (edge.ucharPtr(y, x)[0]) h++; }
    per.push(h / t); hit += h; tot += t; }
  return Math.min(...per) * 0.5 + (hit / tot) * 0.5;
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
const api = { detectQuad, warpQuad, order, area, maxDist };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CardDetector = api;
})(typeof self !== 'undefined' ? self : this);
