// 法務省 地図XML（登記所備付地図データ）の読み込み・座標変換・位置合わせ計算。
// DOMに依存しないので、Web Worker・ブラウザ本体・Node.js のどれでも動く。

// ───────────── ZIP（G空間のZIPは「ZIPの中にZIP」の二重構造） ─────────────

export function listZip(buf) {
  const dv = new DataView(buf);
  let e = buf.byteLength - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('ZIPファイルとして読めませんでした');
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIPの目次が壊れています');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const raw = new Uint8Array(buf, p + 46, nl);
    const name = (flags & 0x800) ? new TextDecoder().decode(raw) : decodeText(raw);
    if (!name.endsWith('/')) out.push({ name, method, csize, usize, lho });
    p += 46 + nl + el + cl;
  }
  return out;
}

function entryData(buf, ent) {
  const dv = new DataView(buf);
  if (dv.getUint32(ent.lho, true) !== 0x04034b50) throw new Error('ZIP内のファイルが壊れています: ' + ent.name);
  const nl = dv.getUint16(ent.lho + 26, true), el = dv.getUint16(ent.lho + 28, true);
  return new Uint8Array(buf, ent.lho + 30 + nl + el, ent.csize);
}

export async function extractZip(buf, ent) {
  const data = entryData(buf, ent);
  if (ent.method === 0) return data.slice();
  if (ent.method !== 8) throw new Error('対応していない圧縮形式です: ' + ent.name);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 先頭の数KBだけ展開する（図面一覧で座標系などを調べる用）
export async function extractHead(buf, ent, bytes = 6000) {
  const data = entryData(buf, ent);
  if (ent.method === 0) return data.slice(0, bytes);
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = []; let got = 0;
  while (got < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(got); let o = 0;
  for (const v of parts) { out.set(v, o); o += v.length; }
  return out.slice(0, bytes);
}

export function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('shift_jis').decode(bytes); }
}

// 内側ZIPの1本目のXMLを返す
export async function innerXml(outerBuf, ent) {
  const inner = await extractZip(outerBuf, ent);
  if (ent.name.toLowerCase().endsWith('.xml')) return new TextDecoder().decode(inner);
  const ib = inner.buffer.slice(inner.byteOffset, inner.byteOffset + inner.byteLength);
  const xmlEnt = listZip(ib).find(x => x.name.toLowerCase().endsWith('.xml'));
  if (!xmlEnt) throw new Error(ent.name + ' にXMLが見つかりません');
  return new TextDecoder().decode(await extractZip(ib, xmlEnt));
}

export async function innerHead(outerBuf, ent) {
  if (ent.name.toLowerCase().endsWith('.xml')) return decodeText(await extractHead(outerBuf, ent));
  // 内側ZIPのローカルヘッダは先頭にあるので、先頭だけ展開して中のXMLの冒頭を読む
  const innerStart = await extractHead(outerBuf, ent, 64 * 1024);
  const dv = new DataView(innerStart.buffer, innerStart.byteOffset, innerStart.byteLength);
  if (dv.getUint32(0, true) !== 0x04034b50) return '';
  const method = dv.getUint16(8, true), nl = dv.getUint16(26, true), el = dv.getUint16(28, true);
  const body = innerStart.subarray(30 + nl + el);
  if (method === 0) return decodeText(body.slice(0, 6000));
  try {
    const reader = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return new TextDecoder().decode(value || new Uint8Array());
  } catch { return ''; }
}

export function headInfo(text) {
  const g = t => (text.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')) || [])[1] || '';
  return { name: g('地図名'), crs: g('座標系'), cityCode: g('市区町村コード'), city: g('市区町村名') };
}

// G空間の search-list.csv（ZIPファイル名,出力日時,地番区域,地番,…）
export function parseSearchList(text) {
  const lines = text.split(/\r?\n/);
  const zip = [], area = [], chiban = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const c = l.split(',');
    zip.push(c[0]); area.push(c[2] || ''); chiban.push(c[3] || '');
  }
  return { zip, area, chiban };
}

// ───────────── 地図XMLの解析 ─────────────
// X＝北方向、Y＝東方向（メートル）。任意座標でも同じ向き。

const reNum = '([-+0-9.eE]+)';

export function parseMojXml(text, sourceName = '') {
  const head = text.slice(0, 5000);
  const info = headInfo(head);
  const zone = crsZone(info.crs);

  const pts = new Map();
  const rePt = new RegExp('<zmn:GM_Point id="([^"]+)">\\s*<zmn:GM_Point\\.position>\\s*<zmn:DirectPosition>\\s*<zmn:X>' + reNum + '</zmn:X>\\s*<zmn:Y>' + reNum + '</zmn:Y>', 'g');
  for (const m of text.matchAll(rePt)) pts.set(m[1], [+m[2], +m[3]]);

  const curves = new Map();
  const reCurve = /<zmn:GM_Curve id="([^"]+)">([\s\S]*?)<\/zmn:GM_Curve>/g;
  const reCol = /<zmn:GM_PointArray\.column>([\s\S]*?)<\/zmn:GM_PointArray\.column>/g;
  const reRef = /GM_PointRef\.point idref="([^"]+)"/;
  const reXY = new RegExp('<zmn:X>' + reNum + '</zmn:X>\\s*<zmn:Y>' + reNum + '</zmn:Y>');
  for (const m of text.matchAll(reCurve)) {
    const arr = [];
    for (const c of m[2].matchAll(reCol)) {
      const r = reRef.exec(c[1]);
      if (r) { const p = pts.get(r[1]); if (p) arr.push(p); }
      else { const xy = reXY.exec(c[1]); if (xy) arr.push([+xy[1], +xy[2]]); }
    }
    curves.set(m[1], arr);
  }

  const surfaces = new Map();
  const reSurf = /<zmn:GM_Surface id="([^"]+)">([\s\S]*?)<\/zmn:GM_Surface>/g;
  const reExt = /exterior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.exterior/;
  const reGen = /generator idref="([^"]+)"/g;
  for (const m of text.matchAll(reSurf)) {
    const ext = reExt.exec(m[2]);
    if (!ext) continue;
    const segs = [];
    for (const g of ext[1].matchAll(reGen)) { const c = curves.get(g[1]); if (c && c.length) segs.push(c); }
    surfaces.set(m[1], chainRing(segs));
  }

  const parcels = [];
  const reFude = /<筆 id="([^"]+)">([\s\S]*?)<\/筆>/g;
  const tag = (s, t) => { const r = new RegExp('<' + t + '>([^<]*)</' + t + '>').exec(s); return r ? r[1] : ''; };
  for (const m of text.matchAll(reFude)) {
    const body = m[2];
    const shape = /<形状 idref="([^"]+)"/.exec(body);
    const ring = shape ? surfaces.get(shape[1]) : null;
    if (!ring || ring.length < 3) continue;
    const flat = new Float64Array(ring.length * 2);
    ring.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
    parcels.push({
      id: m[1],
      oaza: tag(body, '大字名'), chome: tag(body, '丁目名'), koaza: tag(body, '小字名'),
      chiban: tag(body, '地番'), sheet: '', ring: flat,
    });
  }

  const byId = new Map(parcels.map(p => [p.id, p]));
  const sheets = [];
  const reZk = /<図郭>([\s\S]*?)<\/図郭>/g;
  const corner = (s, t) => {
    const r = new RegExp('<' + t + '>\\s*<zmn:X>' + reNum + '</zmn:X>\\s*<zmn:Y>' + reNum + '</zmn:Y>').exec(s);
    return r ? [+r[1], +r[2]] : null;
  };
  for (const m of text.matchAll(reZk)) {
    const s = m[1];
    const no = tag(s, '地図番号') || String(sheets.length + 1);
    let n = 0;
    for (const r of s.matchAll(/筆参照 idref="([^"]+)"/g)) { const p = byId.get(r[1]); if (p) { p.sheet = no; n++; } }
    sheets.push({
      no, type: tag(s, '地図種類'), scale: tag(s, '縮尺分母'), count: n,
      corners: ['左下座標', '左上座標', '右上座標', '右下座標'].map(t => corner(s, t)).filter(Boolean),
    });
  }

  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of parcels) for (let i = 0; i < p.ring.length; i += 2) {
    const x = p.ring[i], y = p.ring[i + 1];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  return {
    name: info.name || sourceName, source: sourceName, crs: info.crs, zone,
    arbitrary: !zone, cityCode: info.cityCode, city: info.city,
    bbox: [xmin, ymin, xmax, ymax], parcels, sheets,
  };
}

// 曲線をつないで閉じたリングにする（共有する境界線は向きが逆のことがある）
export function chainRing(segs) {
  if (!segs.length) return [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  let ring = segs[0].slice();
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    const end = ring[ring.length - 1];
    if (same(s[0], end)) ring.push(...s.slice(1));
    else if (same(s[s.length - 1], end)) ring.push(...s.slice(0, -1).reverse());
    else if (i === 1 && (same(s[0], ring[0]) || same(s[s.length - 1], ring[0]))) {
      ring.reverse();
      const e2 = ring[ring.length - 1];
      ring.push(...(same(s[0], e2) ? s.slice(1) : s.slice(0, -1).reverse()));
    } else ring.push(...s);
  }
  if (ring.length > 1 && same(ring[0], ring[ring.length - 1])) ring.pop();
  return ring;
}

export function crsZone(crs) {
  const m = /公共座標\s*([0-9０-９]+)\s*系/.exec(crs || '');
  if (!m) return 0;
  return parseInt(m[1].replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0)), 10) || 0;
}

// ───────────── 横メルカトル（国土地理院の計算式・GRS80） ─────────────

const A = 6378137, F = 1 / 298.257222101, N = F / (2 - F);
const AB = A / (1 + N) * (1 + N * N / 4 + N ** 4 / 64);
const ALPHA = [0, N / 2 - 2 / 3 * N * N + 5 / 16 * N ** 3, 13 / 48 * N * N - 3 / 5 * N ** 3, 61 / 240 * N ** 3];
const BETA = [0, N / 2 - 2 / 3 * N * N + 37 / 96 * N ** 3, 1 / 48 * N * N + 1 / 15 * N ** 3, 17 / 480 * N ** 3];
const DELTA = [0, 2 * N - 2 / 3 * N * N - 2 * N ** 3, 7 / 3 * N * N - 8 / 5 * N ** 3, 56 / 15 * N ** 3];
const AJ = [1 + N * N / 4 + N ** 4 / 64, -3 / 2 * (N - N ** 3 / 8), 15 / 16 * (N * N - N ** 4 / 4), -35 / 48 * N ** 3, 315 / 512 * N ** 4];
const RAD = Math.PI / 180;
const TS = 2 * Math.sqrt(N) / (1 + N);

// 平面直角座標系の原点（1〜19系）[緯度, 経度]
export const ZONES = [null,
  [33, 129.5], [33, 131], [36, 132 + 1 / 6], [33, 133.5], [36, 134 + 1 / 3], [36, 136], [36, 137 + 1 / 6],
  [36, 138.5], [36, 139 + 5 / 6], [40, 140 + 5 / 6], [44, 140.25], [44, 142.25], [44, 144.25], [26, 142],
  [26, 127.5], [26, 124], [26, 131], [20, 136], [26, 154]];

function meridian(phi0, m0) {
  let s = AJ[0] * phi0;
  for (let j = 1; j <= 4; j++) s += AJ[j] * Math.sin(2 * j * phi0);
  return m0 * A / (1 + N) * s;
}

// x＝北(m), y＝東(m) → [緯度, 経度]
export function tmInverse(x, y, lat0, lon0, m0 = 1) {
  const S0 = meridian(lat0 * RAD, m0);
  const xi = (x + S0) / (m0 * AB), eta = y / (m0 * AB);
  let xi2 = xi, eta2 = eta;
  for (let j = 1; j <= 3; j++) {
    xi2 -= BETA[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta2 -= BETA[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2));
  let lat = chi;
  for (let j = 1; j <= 3; j++) lat += DELTA[j] * Math.sin(2 * j * chi);
  const lon = lon0 * RAD + Math.atan(Math.sinh(eta2) / Math.cos(xi2));
  return [lat / RAD, lon / RAD];
}

// [緯度, 経度] → [x＝北, y＝東]
export function tmForward(lat, lon, lat0, lon0, m0 = 1) {
  const phi = lat * RAD, dl = (lon - lon0) * RAD;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - TS * Math.atanh(TS * Math.sin(phi)));
  const xi = Math.atan(t / Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let x = xi, y = eta;
  for (let j = 1; j <= 3; j++) {
    x += ALPHA[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    y += ALPHA[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return [m0 * AB * x - meridian(lat0 * RAD, m0), m0 * AB * y];
}

export function planeToLatLng(x, y, zone) {
  const o = ZONES[zone];
  if (!o) throw new Error('未対応の座標系です: ' + zone);
  return tmInverse(x, y, o[0], o[1], 0.9999);
}

// ───────────── 任意座標 → 緯度経度（相似変換） ─────────────
// t = { center:[緯度,経度], angle:度（時計回りが正）, scale, anchor:[X,Y] }
// anchor（任意座標上の基準点）が center に来て、そこを中心に回転・拡大縮小する。

export function arbToLatLng(X, Y, t) {
  const a = t.angle * RAD, c = Math.cos(a), s = Math.sin(a);
  const e = (Y - t.anchor[1]) * t.scale, n = (X - t.anchor[0]) * t.scale;
  return tmInverse(-e * s + n * c, e * c + n * s, t.center[0], t.center[1], 1);
}

export function latLngToArb(lat, lng, t) {
  const [n2, e2] = tmForward(lat, lng, t.center[0], t.center[1], 1);
  const a = t.angle * RAD, c = Math.cos(a), s = Math.sin(a);
  const e = (c * e2 - s * n2) / t.scale, n = (s * e2 + c * n2) / t.scale;
  return [t.anchor[0] + n, t.anchor[1] + e];
}

// 対応点（src＝任意座標[X,Y]、dst＝[緯度,経度]）から相似変換を最小二乗で求める。
// 1点なら平行移動だけ、2点以上なら回転・縮尺も。rms は残差の二乗平均平方根（m）。
export function fitSimilarity(pairs, base) {
  if (!pairs.length) return { ...base };
  // 計算の基準（局所平面の原点）を結果の中心に合わせ直して2回解く（子午線収差の分を消す）
  let r = fitOnce(pairs, base, pairs[0].dst[0], pairs[0].dst[1]);
  r = fitOnce(pairs, base, r.center[0], r.center[1]);
  return r;
}

function fitOnce(pairs, base, lat0, lon0) {
  const P = pairs.map(p => [p.src[1] - base.anchor[1], p.src[0] - base.anchor[0]]); // [東, 北]
  const Q = pairs.map(p => { const [n, e] = tmForward(p.dst[0], p.dst[1], lat0, lon0, 1); return [e, n]; });
  const mean = arr => [arr.reduce((s, v) => s + v[0], 0) / arr.length, arr.reduce((s, v) => s + v[1], 0) / arr.length];
  const pm = mean(P), qm = mean(Q);
  let ar, ai;
  if (pairs.length === 1) {
    const r = base.angle * RAD; ar = base.scale * Math.cos(r); ai = -base.scale * Math.sin(r);
  } else {
    let num_r = 0, num_i = 0, den = 0;
    for (let i = 0; i < P.length; i++) {
      const px = P[i][0] - pm[0], py = P[i][1] - pm[1], qx = Q[i][0] - qm[0], qy = Q[i][1] - qm[1];
      num_r += px * qx + py * qy; num_i += px * qy - py * qx; den += px * px + py * py;
    }
    if (den < 1) throw new Error('目印同士が近すぎます。離れた場所を選んでください');
    ar = num_r / den; ai = num_i / den;
  }
  const tx = qm[0] - (ar * pm[0] - ai * pm[1]), ty = qm[1] - (ar * pm[1] + ai * pm[0]);
  let sq = 0;
  for (let i = 0; i < P.length; i++) {
    const ex = tx + ar * P[i][0] - ai * P[i][1] - Q[i][0], ey = ty + ar * P[i][1] + ai * P[i][0] - Q[i][1];
    sq += ex * ex + ey * ey;
  }
  const center = tmInverse(ty, tx, lat0, lon0, 1);
  return {
    ...base, center, scale: Math.hypot(ar, ai), angle: -Math.atan2(ai, ar) / RAD,
    rms: pairs.length >= 3 ? Math.sqrt(sq / pairs.length) : null,
  };
}

export function ringCentroid(flat) {
  let a = 0, cx = 0, cy = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = flat[i * 2], y0 = flat[i * 2 + 1], x1 = flat[j * 2], y1 = flat[j * 2 + 1];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += flat[i * 2]; sy += flat[i * 2 + 1]; }
    return [sx / n, sy / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function normalizeKey(v) {
  return String(v || '').normalize('NFKC').toLowerCase().replace(/[‐‑–—−]/g, '-').trim();
}
