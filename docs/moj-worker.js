// 地図XMLの読み込みを画面の裏側で行うWorker。
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
  const lines = []; let done = 0, failed = 0;
  async function one([x, y]) {
    const k = `${TILESET}/${TZ}/${x}/${y}`;
    let v = await cacheGet(k);
    if (!v) {
      try {
        const r = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/${TILESET}/${TZ}/${x}/${y}.pbf`);
        v = r.status === 404 ? [] : r.ok ? decodeMvt(await r.arrayBuffer(), TZ, x, y) : null;
        if (v) await cachePut(k, v); else failed++;
      } catch { failed++; v = null; }
    }
    if (v) lines.push(...v);
    onProg(++done, jobs.length);
  }
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await one(queue.shift()); }));
  return { lines, tiles: jobs.length, failed };
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
  const anchor = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const edges = featureEdges(parcels);
  const pts = edgePoints(edges, anchor, 4);
  if (pts.length / 2 < 200) throw new Error('照合に使える境界線（道路・水路に面した辺）が少なすぎます');
  let S = 0; for (let i = 0; i < pts.length; i += 2) S = Math.max(S, Math.hypot(pts[i], pts[i + 1]));
  const R = radius || 2000;
  say(`「${prior.title}」付近の道路・水路データを取得中…`);
  const got = await fetchLines(prior.lat, prior.lon, S * 1.05 + R + 150, (d, n) => { if (d % 10 === 0 || d === n) say(`道路・水路データを取得中… ${d}/${n}`); });
  if (!got.lines.length) throw new Error('国土地理院のデータを取得できませんでした');
  const local = linesToLocal(got.lines, prior.lat, prior.lon);
  say('位置を探索中…');
  const res = searchAlignment(pts, local, { radius: R, progress: f => say(`位置を探索中… ${Math.round(f * 100)}%`) });
  const b = res.best;
  const main = { ...toTransform(b, anchor, prior.lat, prior.lon), method: 'auto', pairs: [], rms: null,
    auto: { confidence: res.confidence, inlier: +b.inlier.toFixed(3), ratio: +res.ratio.toFixed(2), rmsInlier: b.rmsInlier != null ? +b.rmsInlier.toFixed(2) : null, prior: prior.title, failedTiles: got.failed } };
  // 図郭ごとの微調整
  const sheetT = {};
  if (res.confidence !== 'low') {
    say('図郭ごとに微調整中…');
    for (const sh of sheets) {
      const sp = edgePoints(edges, anchor, 3, sh.no);
      if (sp.length / 2 < 150) continue;
      const before = res.fine.stats(sp, b, 3).inlier;
      const r = refineSheet(res.fine, sp, b);
      if (r && r.inlier >= 0.3 && r.inlier > before + 0.03) {
        sheetT[sh.no] = { ...toTransform(r, anchor, prior.lat, prior.lon), method: 'auto', pairs: [], rms: null,
          auto: { confidence: r.inlier >= 0.45 ? 'high' : 'mid', inlier: +r.inlier.toFixed(3), before: +before.toFixed(3), rmsInlier: r.rmsInlier != null ? +r.rmsInlier.toFixed(2) : null, sheet: true } };
      }
    }
  }
  post('auto', { id, main, sheets: sheetT, candidates: res.candidates.slice(0, 4).map(c => ({ score: c.score, inlier: c.inlier, ...toTransform(c, anchor, prior.lat, prior.lon) })) });
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
