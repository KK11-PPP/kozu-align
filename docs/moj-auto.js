// 任意座標の図面の自動位置合わせ。
// 図面の「道・水・長狭物」の筆の輪郭を、国土地理院ベクトルタイル（道路縁・道路中心線・水涯線・河川中心線）に重ねて、
// 位置・回転・縮尺を探す。DOMに依存しない（Worker・Nodeで動く）。
import { tmForward, tmInverse } from './moj.js';

const RAD = Math.PI / 180;

// ───────────── 照合に使う筆と点 ─────────────
export function isLinearParcel(chiban) { return /^(道|水|長狭物|里道|水路|井|溝|堤)/.test(String(chiban || '')); }

// 照合に使う辺：①隣の筆と共有していない辺（道路・水路などのすき間に面している）②道・水などの筆の辺
// 旧公図は道路・水路を筆として描かず「すき間」にしていることが多いので、①が主な手がかりになる
export function featureEdges(parcels) {
  const key = (x, y) => x.toFixed(3) + ',' + y.toFixed(3);
  const cnt = new Map();
  const ek = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  for (const p of parcels) {
    const r = p.ring, n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const k = ek(key(r[i * 2], r[i * 2 + 1]), key(r[j * 2], r[j * 2 + 1]));
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
  }
  const edges = [];
  for (const p of parcels) {
    const lin = isLinearParcel(p.chiban), r = p.ring, n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const k = ek(key(r[i * 2], r[i * 2 + 1]), key(r[j * 2], r[j * 2 + 1]));
      if (lin || cnt.get(k) === 1) edges.push([r[i * 2], r[i * 2 + 1], r[j * 2], r[j * 2 + 1], p.sheet]);
    }
  }
  return edges;
}

// 辺を step(m) 間隔の点にする。戻り値は [東, 北] の組（anchor基準）を詰めた Float64Array
export function edgePoints(edges, anchor, step, sheet) {
  const out = [];
  for (const [x0, y0, x1, y1, sh] of edges) {
    if (sheet && sh !== sheet) continue;
    const k = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let t = 0; t < k; t++) { const f = t / k; out.push(y0 + (y1 - y0) * f - anchor[1], x0 + (x1 - x0) * f - anchor[0]); }
  }
  return Float64Array.from(out);
}

// 筆の輪郭を step(m) 間隔の点にする。戻り値は [東, 北] の組（anchor基準）を詰めた Float64Array
export function samplePoints(parcels, anchor, step) {
  const out = [];
  for (const p of parcels) {
    const r = p.ring, n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = r[i * 2], y0 = r[i * 2 + 1], x1 = r[j * 2], y1 = r[j * 2 + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const k = Math.max(1, Math.round(len / step));
      for (let t = 0; t < k; t++) {
        const f = t / k;
        out.push(y0 + (y1 - y0) * f - anchor[1], x0 + (x1 - x0) * f - anchor[0]);
      }
    }
  }
  return Float64Array.from(out);
}

function thin(pts, max) {
  const n = pts.length / 2;
  if (n <= max) return pts;
  const out = new Float64Array(max * 2), stride = n / max;
  for (let i = 0; i < max; i++) { const k = Math.floor(i * stride); out[i * 2] = pts[k * 2]; out[i * 2 + 1] = pts[k * 2 + 1]; }
  return out;
}

// ───────────── 国土地理院ベクトルタイル（Mapbox Vector Tile）の最小限の読み取り ─────────────
const WANT = new Set(['RdEdg', 'RdCL', 'WL', 'RvrCL']);

export function decodeMvt(buf, z, x, y) {
  const b = new Uint8Array(buf);
  const lines = [];
  const p = { i: 0 };
  const varint = (bb, q) => { let r = 0, s = 0, c; do { c = bb[q.i++]; r += (c & 127) * 2 ** s; s += 7; } while (c & 128); return r; };
  // 注意：q.i += varint(bb, q) と書くと、長さのバイト分を進めた結果が上書きされて位置がずれる
  const skip = (bb, q, w) => { if (w === 0) varint(bb, q); else if (w === 1) q.i += 8; else if (w === 2) { const l = varint(bb, q); q.i += l; } else if (w === 5) q.i += 4; };
  const n2 = 2 ** z;
  while (p.i < b.length) {
    const key = varint(b, p), f = key >> 3, w = key & 7;
    if (f !== 3 || w !== 2) { skip(b, p, w); continue; }
    const len = varint(b, p), end = p.i + len;
    let name = '', extent = 4096; const feats = [];
    const q = { i: p.i };
    while (q.i < end) {
      const k2 = varint(b, q), f2 = k2 >> 3, w2 = k2 & 7;
      if (f2 === 1 && w2 === 2) { const l = varint(b, q); name = new TextDecoder().decode(b.subarray(q.i, q.i + l)); q.i += l; }
      else if (f2 === 2 && w2 === 2) { const l = varint(b, q); feats.push([q.i, q.i + l]); q.i += l; }
      else if (f2 === 5 && w2 === 0) extent = varint(b, q);
      else skip(b, q, w2);
    }
    p.i = end;
    if (!WANT.has(name)) continue;
    for (const [fs, fe] of feats) {
      const r = { i: fs }; let type = 0, geom = null;
      while (r.i < fe) {
        const k3 = varint(b, r), f3 = k3 >> 3, w3 = k3 & 7;
        if (f3 === 3 && w3 === 0) type = varint(b, r);
        else if (f3 === 4 && w3 === 2) { const l = varint(b, r); geom = [r.i, r.i + l]; r.i += l; }
        else skip(b, r, w3);
      }
      if (!geom || (type !== 2 && type !== 3)) continue;
      const g = { i: geom[0] }; let cx = 0, cy = 0, cur = null;
      const toLL = (px, py) => {
        const lon = (x + px / extent) / n2 * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / extent) / n2))) / RAD;
        return [lon, lat];
      };
      while (g.i < geom[1]) {
        const cmd = varint(b, g), id = cmd & 7, count = cmd >> 3;
        if (id === 1 || id === 2) {
          for (let c = 0; c < count; c++) {
            const dx = varint(b, g), dy = varint(b, g);
            cx += (dx >> 1) ^ (-(dx & 1)); cy += (dy >> 1) ^ (-(dy & 1));
            if (id === 1) { if (cur && cur.length >= 4) lines.push(Float64Array.from(cur)); cur = []; }
            const [lo, la] = toLL(cx, cy); cur.push(lo, la);
          }
        } else if (id === 7 && cur && cur.length >= 2) { cur.push(cur[0], cur[1]); }
      }
      if (cur && cur.length >= 4) lines.push(Float64Array.from(cur));
    }
  }
  return lines;
}

export function tileRange(lat0, lon0, halfMeters, z) {
  const dLat = halfMeters / 111000, dLon = halfMeters / (111000 * Math.cos(lat0 * RAD));
  const tx = lon => Math.floor((lon + 180) / 360 * 2 ** z);
  const ty = lat => Math.floor((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2 * 2 ** z);
  return { z, x0: tx(lon0 - dLon), x1: tx(lon0 + dLon), y0: ty(lat0 + dLat), y1: ty(lat0 - dLat) };
}

// ───────────── 距離変換（Felzenszwalb） ─────────────
function dt1d(f, n, d, v, zz) {
  let k = 0; v[0] = 0; zz[0] = -Infinity; zz[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    while (true) {
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      if (s <= zz[k]) { k--; if (k < 0) { k = 0; break; } } else break;
    }
    k++; v[k] = q; zz[k] = s; zz[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (zz[k + 1] < q) k++; const r = q - v[k]; d[q] = r * r + f[v[k]]; }
}
// grid: 1=線あり。戻り値：セル単位の距離（Float32Array）
export function distanceTransform(grid, w, h) {
  const INF = 1e12, n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), zz = new Float64Array(n + 1);
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = grid[i] ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    dt1d(f, h, d, v, zz);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  const res = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    dt1d(f, w, d, v, zz);
    for (let x = 0; x < w; x++) res[y * w + x] = Math.sqrt(d[x]);
  }
  return res;
}

function rasterizeLines(lines, w, h, cell, ox, oy) {
  // lines: 局所平面[東,北]の Float64Array の配列。セル(i,j) ← 東 = ox + i*cell, 北 = oy + j*cell
  const g = new Uint8Array(w * h);
  for (const L of lines) {
    for (let k = 0; k + 3 < L.length; k += 2) {
      const x0 = (L[k] - ox) / cell, y0 = (L[k + 1] - oy) / cell, x1 = (L[k + 2] - ox) / cell, y1 = (L[k + 3] - oy) / cell;
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
      for (let s = 0; s <= steps; s++) {
        const xi = Math.round(x0 + (x1 - x0) * s / steps), yi = Math.round(y0 + (y1 - y0) * s / steps);
        if (xi >= 0 && yi >= 0 && xi < w && yi < h) g[yi * w + xi] = 1;
      }
    }
  }
  return g;
}

// ───────────── FFT（基数2） ─────────────
function fft1(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b2 = a + len / 2;
        const xr = re[b2] * cr - im[b2] * ci, xi = re[b2] * ci + im[b2] * cr;
        re[b2] = re[a] - xr; im[b2] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function fft2(re, im, n, inv) {
  const rr = new Float64Array(n), ii = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    const o = y * n;
    for (let x = 0; x < n; x++) { rr[x] = re[o + x]; ii[x] = im[o + x]; }
    fft1(rr, ii, inv);
    for (let x = 0; x < n; x++) { re[o + x] = rr[x]; im[o + x] = ii[x]; }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) { rr[y] = re[y * n + x]; ii[y] = im[y * n + x]; }
    fft1(rr, ii, inv);
    for (let y = 0; y < n; y++) { re[y * n + x] = rr[y]; im[y * n + x] = ii[y]; }
  }
}

// ───────────── 採点 ─────────────
function transformPts(pts, tx, ty, angDeg, s) {
  const a = angDeg * RAD, c = Math.cos(a) * s, sn = Math.sin(a) * s;
  const out = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const e = pts[i], n = pts[i + 1];
    out[i] = tx + c * e + sn * n; out[i + 1] = ty - sn * e + c * n;
  }
  return out;
}

class FineGrid {
  constructor(lines, cx, cy, half, cell) {
    this.cell = cell; this.w = this.h = Math.ceil(half * 2 / cell);
    this.ox = cx - half; this.oy = cy - half;
    this.d = distanceTransform(rasterizeLines(lines, this.w, this.h, cell, this.ox, this.oy), this.w, this.h);
  }
  dist(e, n) {
    const fx = (e - this.ox) / this.cell, fy = (n - this.oy) / this.cell;
    const x = Math.floor(fx), y = Math.floor(fy);
    if (x < 0 || y < 0 || x >= this.w - 1 || y >= this.h - 1) return 1e9;
    const ax = fx - x, ay = fy - y, w = this.w, d = this.d, i = y * w + x;
    return ((d[i] * (1 - ax) + d[i + 1] * ax) * (1 - ay) + (d[i + w] * (1 - ax) + d[i + w + 1] * ax) * ay) * this.cell;
  }
  score(pts, prm, tau) {
    const a = prm.ang * RAD, c = Math.cos(a) * prm.s, sn = Math.sin(a) * prm.s;
    let sum = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const e = pts[i], n = pts[i + 1];
      const d = this.dist(prm.tx + c * e + sn * n, prm.ty - sn * e + c * n);
      if (d < tau) sum += 1 - d / tau;
    }
    return sum / (pts.length / 2);
  }
  stats(pts, prm, tol = 3) {
    const q = transformPts(pts, prm.tx, prm.ty, prm.ang, prm.s);
    let inl = 0, sq = 0;
    for (let i = 0; i < q.length; i += 2) { const d = this.dist(q[i], q[i + 1]); if (d < tol) { inl++; sq += d * d; } }
    const n = q.length / 2;
    return { inlier: inl / n, rmsInlier: inl ? Math.sqrt(sq / inl) : null };
  }
}

// パターン探索で細かく詰める
function refine(grid, pts, start, opt) {
  let prm = { ...start };
  const lim = opt.limits || {};
  const ok = p => (!lim.t || Math.hypot(p.tx - lim.t[0], p.ty - lim.t[1]) <= lim.tMax) && (!lim.ang || Math.abs(p.ang - lim.ang[0]) <= lim.ang[1]) && (!lim.s || Math.abs(p.s - lim.s[0]) <= lim.s[1]);
  for (const tau of opt.taus) {
    let step = { tx: opt.step0, ty: opt.step0, ang: opt.angStep0, s: opt.sStep0 };
    let best = grid.score(pts, prm, tau);
    for (let it = 0; it < 400; it++) {
      let improved = false;
      for (const k of ['tx', 'ty', 'ang', 's']) {
        for (const sg of [1, -1]) {
          const cand = { ...prm, [k]: prm[k] + sg * step[k] };
          if (!ok(cand)) continue;
          const v = grid.score(pts, cand, tau);
          if (v > best + 1e-6) { best = v; prm = cand; improved = true; }
        }
      }
      if (!improved) {
        step = { tx: step.tx / 2, ty: step.ty / 2, ang: step.ang / 2, s: step.s / 2 };
        if (step.tx < opt.minStep) break;
      }
    }
    prm.score = best;
  }
  return prm;
}

// ───────────── メイン：図面1枚の自動位置合わせ ─────────────
// srcPts: samplePoints の結果（anchor基準の[東,北]）、lines: 局所平面（prior原点）の線
// 戻り値の tx,ty は anchor が来る局所平面の位置（m）、ang は時計回り（度）、s は縮尺
export function searchAlignment(srcPts, lines, opt = {}) {
  const R = opt.radius ?? 2000;
  const angles = opt.angles ?? range(-6, 6, 1);
  const scales = opt.scales ?? [0.97, 1, 1.03];
  const progress = opt.progress || (() => {});
  let S = 0;
  for (let i = 0; i < srcPts.length; i += 2) S = Math.max(S, Math.hypot(srcPts[i], srcPts[i + 1]));
  S *= Math.max(...scales);
  const N = opt.fftSize ?? 1024;
  const cell = Math.max(opt.minCell ?? 5, Math.ceil(2 * (S + R) / N));
  const half = N * cell / 2;
  const tau = opt.coarseTau ?? Math.max(12, cell * 2);

  // 照合相手（線）の採点マップ
  const g = rasterizeLines(lines, N, N, cell, -half, -half);
  const dt = distanceTransform(g, N, N);
  const Wre = new Float64Array(N * N), Wim = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) { const d = dt[i] * cell; Wre[i] = d < tau ? 1 - d / tau : 0; }
  // 線が密集した場所（市街地など）ほど偶然の一致が増えるので、周囲の平均を引いて割り引く
  const blur = boxBlur(Wre, N, Math.max(2, Math.round((opt.densityRadius ?? 150) / cell)));
  for (let i = 0; i < N * N; i++) Wre[i] -= blur[i];
  fft2(Wre, Wim, N, false);

  const coarse = thin(srcPts, 60000);
  const nPts = coarse.length / 2;
  const maxShift = Math.floor(R / cell);
  const peaks = [];
  let done = 0;
  for (const s of scales) for (const ang of angles) {
    const q = transformPts(coarse, 0, 0, ang, s);
    const re = new Float64Array(N * N), im = new Float64Array(N * N);
    for (let i = 0; i < q.length; i += 2) {
      const x = Math.round(q[i] / cell + N / 2), y = Math.round(q[i + 1] / cell + N / 2);
      if (x >= 0 && y >= 0 && x < N && y < N) re[y * N + x] += 1;
    }
    fft2(re, im, N, false);
    for (let i = 0; i < N * N; i++) {
      const ar = re[i], ai = -im[i]; // conj(S) * W
      const r2 = ar * Wre[i] - ai * Wim[i], i2 = ar * Wim[i] + ai * Wre[i];
      re[i] = r2; im[i] = i2;
    }
    fft2(re, im, N, true);
    // シフト t（-maxShift..maxShift）の上位を拾う
    const local = [];
    for (let ty = -maxShift; ty <= maxShift; ty++) {
      const yy = (ty + N) % N;
      for (let tx = -maxShift; tx <= maxShift; tx++) {
        const v = re[yy * N + ((tx + N) % N)] / (N * N) / nPts;
        if (local.length < 12 || v > local[local.length - 1].v) {
          local.push({ v, tx, ty });
          local.sort((a, b) => b.v - a.v);
          // 近すぎる候補を間引く
          for (let a = 0; a < local.length; a++) for (let b2 = local.length - 1; b2 > a; b2--) if (Math.hypot(local[a].tx - local[b2].tx, local[a].ty - local[b2].ty) * cell < 60) local.splice(b2, 1);
          if (local.length > 12) local.length = 12;
        }
      }
    }
    for (const l of local) peaks.push({ v: l.v, tx: (l.tx + 0) * cell + (0), ty: l.ty * cell, ang, s });
    progress(++done / (scales.length * angles.length));
  }
  // 候補：位置が離れたものを上位から
  peaks.sort((a, b) => b.v - a.v);
  const cands = [];
  for (const p of peaks) {
    if (cands.every(c => Math.hypot(c.tx - p.tx, c.ty - p.ty) > 80)) cands.push(p);
    if (cands.length >= (opt.candidates ?? 6)) break;
  }
  // 細かい格子で詰める
  const fineCell = opt.fineCell ?? 2;
  const fine = new FineGrid(lines, 0, 0, Math.min(half, S + R + 100), fineCell);
  const fpts = thin(srcPts, 25000);
  const refined = cands.map(c => {
    const r = refine(fine, fpts, { tx: c.tx, ty: c.ty, ang: c.ang, s: c.s }, { taus: [10, 5], step0: cell, angStep0: 0.5, sStep0: 0.01, minStep: 0.25 });
    return { ...r, coarse: c.v, ...fine.stats(fpts, r, 3) };
  });
  // コントラスト：その位置から60m・120mずらしたときの点数の平均との差。正しい位置ほど大きい
  for (const r of refined) r.contrast = contrast(fine, fpts, r);
  refined.sort((a, b) => b.contrast - a.contrast);
  const best = refined[0];
  const second = refined.find(r => Math.hypot(r.tx - best.tx, r.ty - best.ty) > 50);
  const ratio = second ? best.contrast / Math.max(second.contrast, 1e-3) : 9;
  const confidence = best.contrast >= 0.12 && ratio >= 1.5 ? 'high' : best.contrast >= 0.07 && ratio >= 1.2 ? 'mid' : 'low';
  return { best, candidates: refined, ratio, confidence, cell, fine, fpts };
}

function contrast(fine, pts, prm, tau = 5) {
  const base = fine.score(pts, prm, tau);
  let sum = 0, n = 0;
  for (const d of [60, 120]) for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4;
    sum += fine.score(pts, { ...prm, tx: prm.tx + Math.cos(a) * d, ty: prm.ty + Math.sin(a) * d }, tau); n++;
  }
  return base - sum / n;
}

function boxBlur(src, n, r) {
  // 正方格子 n×n の箱型平均（半径 r セル）。端は内側だけで平均
  const tmp = new Float64Array(n * n), out = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    let acc = 0; const o = y * n;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < n) acc += src[o + x];
    for (let x = 0; x < n; x++) {
      const lo = Math.max(0, x - r), hi = Math.min(n - 1, x + r);
      tmp[o + x] = acc / (hi - lo + 1);
      if (x - r >= 0) acc -= src[o + x - r];
      if (x + r + 1 < n) acc += src[o + x + r + 1];
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < n) acc += tmp[y * n + x];
    for (let y = 0; y < n; y++) {
      const lo = Math.max(0, y - r), hi = Math.min(n - 1, y + r);
      out[y * n + x] = acc / (hi - lo + 1);
      if (y - r >= 0) acc -= tmp[(y - r) * n + x];
      if (y + r + 1 < n) acc += tmp[(y + r + 1) * n + x];
    }
  }
  return out;
}

// 図郭ごとの微調整（全体の結果から小さく動かす）
export function refineSheet(fine, sheetPts, start, opt = {}) {
  if (sheetPts.length / 2 < (opt.minPts ?? 150)) return null;
  const r = refine(fine, sheetPts, start, {
    taus: [6, 4], step0: 4, angStep0: 0.4, sStep0: 0.008, minStep: 0.2,
    limits: { t: [start.tx, start.ty], tMax: opt.tMax ?? 40, ang: [start.ang, opt.angMax ?? 3], s: [start.s, opt.sMax ?? 0.05] },
  });
  return { ...r, ...fine.stats(sheetPts, r, 3) };
}

function range(a, b, st) { const o = []; for (let v = a; v <= b + 1e-9; v += st) o.push(+v.toFixed(4)); return o; }

// 局所平面の結果 → アプリの変換パラメータ（center は anchor が来る緯度経度）
export function toTransform(prm, anchor, lat0, lon0) {
  return { center: tmInverse(prm.ty, prm.tx, lat0, lon0, 1), angle: prm.ang, scale: prm.s, anchor: [anchor[0], anchor[1]] };
}
export function linesToLocal(llLines, lat0, lon0) {
  return llLines.map(L => {
    const out = new Float64Array(L.length);
    for (let i = 0; i < L.length; i += 2) { const [n, e] = tmForward(L[i + 1], L[i], lat0, lon0, 1); out[i] = e; out[i + 1] = n; }
    return out;
  });
}
