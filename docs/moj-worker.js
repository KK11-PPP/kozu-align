// 地図XMLの読み込みを画面の裏側で行うWorker。
import { arbToLatLng } from './moj.js';
import { listZip, extractZip, decodeText, innerXml, innerHead, headInfo, parseSearchList, parseMojXml } from './moj.js';

import { featureEdges, edgePoints, decodeMvt, tileRange, searchAlignment, refineSheet, toTransform, linesToLocal } from './moj-auto.js';

let bundle = null; // { buf, entries, name }

// ───── 国土地理院ベクトルタイルの取得（端末内にキャッシュ） ─────
const TILESET = 'optimal_bvmap-v1', TZ = 16;
let cacheDb = null;
function openCache() {
  if (cacheDb) return cacheDb;
  cacheDb = new Promise(res => {
    try {
      const r = indexedDB.open('kozu-gsi-cache', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('tiles');
      r.onsuccess = () => res(r.result); r.onerror = () => res(null);
    } catch { res(null); }
  });
  return cacheDb;
}
async function cacheGet(k) { const db = await openCache(); if (!db) return undefined; return new Promise(res => { const q = db.transaction('tiles').objectStore('tiles').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
async function cachePut(k, v) { const db = await openCache(); if (!db) return; return new Promise(res => { const t = db.transaction('tiles', 'readwrite'); t.objectStore('tiles').put(v, k); t.oncomplete = t.onerror = () => res(); }); }

async function fetchLines(lat0, lon0, half, onProg) {
  const tr = tileRange(lat0, lon0, half, TZ);
  const jobs = [];
  for (let x = tr.x0; x <= tr.x1; x++) for (let y = tr.y0; y <= tr.y1; y++) jobs.push([x, y]);
  const lines = []; let done = 0, failed = 0, lastErr = '';
  async function one([x, y]) {
    const k = `v2/${TILESET}/${TZ}/${x}/${y}`;
    let v = await cacheGet(k);
    if (!v) {
      try {
        const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/${TILESET}/${TZ}/${x}/${y}.pbf`);
        v = r.status === 404 ? [] : r.ok ? decodeMvt(await r.arrayBuffer(), TZ, x, y) : null;
        if (v) await cachePut(k, v); else { failed++; lastErr = 'HTTP ' + r.status; }
      } catch (e) { failed++; v = null; lastErr = String(e && e.message || e); }
    }
    if (v) lines.push(...v);
    onProg(++done, jobs.length);
  }
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await one(queue.shift()); }));
  return { lines, tiles: jobs.length, failed, lastErr };
}

async function findPrior(q) {
  try {
    const r = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q));
    const js = await r.json();
    if (js && js.length) { const c = js[0].geometry.coordinates; return { lat: c[1], lon: c[0], title: js[0].properties.title }; }
  } catch {}
  return null;
}

async function autoAlign(data, id) {
  const { parcels, bbox, sheets, query, fallback, radius } = data;
  const say = text => post('progress', { id, text });
  let prior = query ? await findPrior(query) : null;
  if (!prior && fallback) prior = { lat: fallback[0], lon: fallback[1], title: '仮配置の位置' };
  if (!prior) throw new Error('探す範囲の目安（大字の位置）が分かりませんでした');
  const edges = featureEdges(parcels);
  const mapAnchor = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const allPts = edgePoints(edges, mapAnchor, 4);
  if (allPts.length / 2 < 200) throw new Error('照合に使える境界線（道路・水路に面した辺）が少なすぎます');
  let S = 0; for (let i = 0; i < allPts.length; i += 2) S = Math.max(S, Math.hypot(allPts[i], allPts[i + 1]));
  const R = radius || 2600;
  say(`「${prior.title}」付近の道路・水路データを取得中…`);
  const got = await fetchLines(prior.lat, prior.lon, Math.max(S, 800) + R + 300, (d, n) => { if (d % 10 === 0 || d === n) say(`道路・水路データを取得中… ${d}/${n}`); });
  if (!got.lines.length) throw new Error('国土地理院のデータを取得できませんでした');

  // 図郭ごとに探す。見つかった図郭の隣は、その結果から予想した位置の近くだけを探す（速く・確実に）
  const info = sheets.map(sh => {
    const c = sh.corners && sh.corners.length ? [sh.corners.reduce((a, q) => a + q[0], 0) / sh.corners.length, sh.corners.reduce((a, q) => a + q[1], 0) / sh.corners.length] : null;
    const pts = c ? edgePoints(edges, c, 3, sh.no) : new Float64Array();
    return { no: sh.no, anchor: c, pts, n: pts.length / 2 };
  }).filter(x => x.anchor && x.n >= 120);
  const solved = new Map();
  const near = (a, b) => Math.hypot(a.anchor[0] - b.anchor[0], a.anchor[1] - b.anchor[1]);
  const todo = info.slice().sort((a, b) => b.n - a.n);
  let wideTries = 0, k = 0;
  const priorLocal = linesToLocal(got.lines, prior.lat, prior.lon);
  while (todo.length) {
    // 解けた図郭に一番近い図郭を優先
    let idx = 0, bestD = Infinity, ref = null;
    for (let i = 0; i < todo.length; i++) for (const [no, r] of solved) {
      if (r.conf === 'low') continue;
      const d = near(todo[i], r.sheet);
      if (d < bestD) { bestD = d; idx = i; ref = r; }
    }
    const sh = todo.splice(ref ? idx : 0, 1)[0];
    k++;
    say(`図郭ごとに位置を探索中… ${k}/${info.length}（図郭${sh.no}）`);
    let res, lat0, lon0;
    if (ref && bestD < 900) {
      // 隣の結果から予想した位置の近くだけ
      const [plat, plon] = arbToLatLng(sh.anchor[0], sh.anchor[1], ref.T);
      lat0 = plat; lon0 = plon;
      const a0 = ref.T.angle;
      res = searchAlignment(sh.pts, linesToLocal(got.lines, lat0, lon0), { radius: 220, fftSize: 256, minCell: 4, angles: [-3, -1.5, 0, 1.5, 3].map(d => a0 + d), scales: [ref.T.scale * 0.98, ref.T.scale, ref.T.scale * 1.02] });
    } else {
      if (wideTries >= 6 && solved.size === 0) break; // 広く探しても見つからない図面
      wideTries++;
      lat0 = prior.lat; lon0 = prior.lon;
      res = searchAlignment(sh.pts, priorLocal, { radius: R, minCell: 6, angles: [-6, -4, -2, 0, 2, 4, 6], scales: [0.97, 1, 1.03] });
    }
    const b = res.best;
    const T = { ...toTransform(b, sh.anchor, lat0, lon0), method: 'auto', pairs: [], rms: null,
      auto: { confidence: res.confidence, inlier: +b.inlier.toFixed(3), contrast: +b.contrast.toFixed(3), ratio: +res.ratio.toFixed(2), rmsInlier: b.rmsInlier != null ? +b.rmsInlier.toFixed(2) : null, sheet: true, local: !!ref } };
    solved.set(sh.no, { T, conf: res.confidence, sheet: sh });
  }
  // 解けなかった図郭は、一番近い「高・中」の図郭の結果から予想（信頼度：低）
  const good = [...solved.values()].filter(r => r.conf !== 'low');
  const sheetT = {};
  for (const r of solved.values()) {
    if (r.conf !== 'low' || !good.length) { sheetT[r.sheet.no] = r.T; continue; }
    const g = good.reduce((m, x) => near(x.sheet, r.sheet) < near(m.sheet, r.sheet) ? x : m);
    sheetT[r.sheet.no] = { ...g.T, auto: { ...g.T.auto, confidence: 'low', inherited: g.sheet.no, sheet: true } };
  }
  const best = good.sort((a, b) => b.T.auto.contrast - a.T.auto.contrast)[0];
  const cnt = { high: 0, mid: 0, low: 0 };
  for (const t of Object.values(sheetT)) cnt[t.auto.confidence]++;
  const conf = !best ? 'low' : cnt.high >= Math.max(2, info.length * 0.4) ? 'high' : cnt.high + cnt.mid >= Math.max(2, info.length * 0.3) ? 'mid' : 'low';
  const base = best ? best.T : { center: [prior.lat, prior.lon], angle: 0, scale: 1, anchor: mapAnchor };
  const main = { ...base, method: 'auto', pairs: [], rms: null,
    auto: { confidence: conf, inlier: best ? best.T.auto.inlier : 0, sheetsHigh: cnt.high, sheetsMid: cnt.mid, sheetsLow: cnt.low, sheetsTotal: sheets.length, prior: prior.title, tiles: got.tiles, failedTiles: got.failed } };
  post('auto', { id, main, sheets: sheetT, candidates: [] });
}

function post(type, data, transfer) { self.postMessage({ type, ...data }, transfer || []); }

function transferList(map) { return map.parcels.map(p => p.ring.buffer); }

self.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    if (data.type === 'open') {
      const file = data.file;
      const buf = await file.arrayBuffer();
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.xml')) {
        bundle = null;
        const map = parseMojXml(decodeText(new Uint8Array(buf)), file.name);
        return post('maps', { id, maps: [map], sourceFile: file.name }, transferList(map));
      }
      const entries = listZip(buf);
      const zips = entries.filter(e => /\.zip$/i.test(e.name));
      const xmls = entries.filter(e => /\.xml$/i.test(e.name));
      const csvEnt = entries.find(e => /search-list\.csv$/i.test(e.name));
      if (!zips.length && xmls.length) {
        // 内側ZIP（XMLが直接入っている）
        bundle = null;
        const maps = [];
        for (const e of xmls) {
          post('progress', { id, text: e.name + ' を解析中…' });
          maps.push(parseMojXml(new TextDecoder().decode(await extractZip(buf, e)), file.name));
        }
        return post('maps', { id, maps, sourceFile: file.name }, maps.flatMap(transferList));
      }
      if (!zips.length) throw new Error('地図XMLが入っていないZIPです');
      // G空間のまとめZIP：図面一覧と地番索引だけ先に返す
      bundle = { buf, entries, name: file.name };
      post('progress', { id, text: '図面の一覧を作成中…' });
      const list = [];
      for (const e of zips) {
        let info = { name: '', crs: '' };
        try { info = headInfo(await innerHead(buf, e)); } catch {}
        list.push({ entry: e.name, size: e.usize, ...info });
      }
      let index = null;
      if (csvEnt) {
        post('progress', { id, text: '地番の索引を読み込み中…' });
        index = parseSearchList(decodeText(await extractZip(buf, csvEnt)));
      }
      return post('bundle', { id, file: file.name, list, index });
    }
    if (data.type === 'auto') return await autoAlign(data, id);
    if (data.type === 'load') {
      if (!bundle) throw new Error('先にZIPを選び直してください');
      const maps = [];
      for (const name of data.entries) {
        const e = bundle.entries.find(x => x.name === name);
        if (!e) continue;
        post('progress', { id, text: `${name} を展開・解析中…（${maps.length + 1}/${data.entries.length}）` });
        const map = parseMojXml(await innerXml(bundle.buf, e), name);
        map.entry = name;
        maps.push(map);
      }
      return post('maps', { id, maps, sourceFile: bundle.name }, maps.flatMap(transferList));
    }
  } catch (err) {
    post('error', { id, message: err && err.message ? err.message : String(err) });
  }
};
