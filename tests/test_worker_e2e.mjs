// moj-worker.js の自動照合を Node で通しで動かす。国土地理院の住所検索・ベクトルタイルは疑似の応答に差し替える。
// 使い方: node test_worker_e2e.mjs <docsフォルダ> <11347-0304-88.xml> <profile: default|wide> [角度] [縮尺]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [docs, xmlPath, profile = 'wide', angS = '-9', sS = '1.055'] = process.argv.slice(2);
const M = await import(pathToFileURL(docs + '/moj.js'));
const A = await import(pathToFileURL(docs + '/moj-auto.js'));
const map = M.parseMojXml(readFileSync(xmlPath, 'utf8'), '88');
const anchor = [(map.bbox[0] + map.bbox[2]) / 2, (map.bbox[1] + map.bbox[3]) / 2];
const TRUTH = { center: [36.055, 139.425], angle: +angS, scale: +sS, anchor };
// 正解の位置に置いた図面の線（半分は欠ける・雑音）と無関係な線
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const lines = [];
for (const [x0, y0, x1, y1] of A.featureEdges(map.parcels)) {
  if (rnd() < 0.5) continue;
  const a = M.arbToLatLng(x0, y0, TRUTH), b = M.arbToLatLng(x1, y1, TRUTH), j = () => (rnd() - 0.5) * 3e-5;
  lines.push([[a[1] + j(), a[0] + j()], [b[1] + j(), b[0] + j()]]);
}
for (let k = 0; k < 3000; k++) { const lon = 139.425 + (rnd() - 0.5) * 0.08, lat = 36.055 + (rnd() - 0.5) * 0.06, g = rnd() * Math.PI, l = (50 + rnd() * 400) / 1e5; lines.push([[lon, lat], [lon + Math.cos(g) * l, lat + Math.sin(g) * l]]); }
// ベクトルタイル（MVT）の最小限のエンコーダ
const Z = 16, n2 = 2 ** Z, EXT = 4096;
const tileOf = ([lon, lat]) => [Math.floor((lon + 180) / 360 * n2), Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n2)];
const px = ([lon, lat], x, y) => [Math.round(((lon + 180) / 360 * n2 - x) * EXT), Math.round(((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n2 - y) * EXT)];
const vi = n => { const o = []; while (n >= 128) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const zz = n => (n << 1) ^ (n >> 31);
const field = (f, w, body) => [...vi(f * 8 + w), ...(w === 2 ? vi(body.length) : []), ...body];
function encodeTile(x, y) {
  const feats = [];
  for (const L of lines) {
    const [tx, ty] = tileOf(L[0]); if (tx !== x || ty !== y) continue;
    const p = L.map(q => px(q, x, y)); const g = [...vi(9), ...vi(zz(p[0][0])), ...vi(zz(p[0][1])), ...vi((p.length - 1) * 8 + 2)];
    for (let i = 1; i < p.length; i++) g.push(...vi(zz(p[i][0] - p[i - 1][0])), ...vi(zz(p[i][1] - p[i - 1][1])));
    feats.push(field(2, 2, [...field(3, 0, vi(2)), ...field(4, 2, g)]));
  }
  if (!feats.length) return null;
  const layer = [...field(15, 0, vi(2)), ...field(1, 2, [...new TextEncoder().encode('RdCL')]), ...feats.flat(), ...field(5, 0, vi(EXT))];
  return new Uint8Array(field(3, 2, layer)).buffer;
}
globalThis.fetch = async url => {
  url = String(url);
  if (url.includes('AddressSearch')) return { ok: true, status: 200, json: async () => [{ geometry: { coordinates: [139.433, 36.049] }, properties: { title: '疑似の大字中心（正解から約1km）' } }] };
  const m = url.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  const buf = m && encodeTile(+m[2], +m[3]);
  return buf ? { ok: true, status: 200, arrayBuffer: async () => buf } : { ok: false, status: 404 };
};
let result = null;
globalThis.self = { postMessage: m => { if (m.type === 'auto' || m.type === 'error') result = m; } };
await import(pathToFileURL(docs + '/moj-worker.js'));
const t0 = Date.now();
await self.onmessage({ data: { type: 'auto', id: 1, parcels: map.parcels, bbox: map.bbox, sheets: map.sheets, query: '疑似', radius: 2600, name: map.name, nParcels: map.parcels.length, profile } });
if (result.type === 'error') { console.log('error', result.message); process.exit(1); }
const dist = (a, b) => Math.hypot((a[0] - b[0]) * 110940, (a[1] - b[1]) * 90000);
const cnt = { high: [0, 0], mid: [0, 0], low: [0, 0] };
for (const [no, T] of Object.entries(result.sheets)) {
  const sh = map.sheets.find(s => s.no === no); let e = 0;
  for (const [X, Y] of sh.corners) e = Math.max(e, dist(M.arbToLatLng(X, Y, T), M.arbToLatLng(X, Y, TRUTH)));
  cnt[T.auto.confidence][e < 15 ? 0 : 1]++;
}
console.log(`profile=${profile} 正解 角度${angS} 縮尺${sS}  profile記録=${result.main.auto.profile}  ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
for (const [c, [ok, ng]] of Object.entries(cnt)) console.log(`  ${c}: 正しい(15m未満) ${ok}  外れ ${ng}`);
