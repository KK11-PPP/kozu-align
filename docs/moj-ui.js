// 登記所備付地図データ（法務省地図XML）の画面部分。
// 読み込み → 地図に筆を描く → 任意座標の図面を目印で位置合わせ → 端末に保存・GeoJSON出力。
import { planeToLatLng, arbToLatLng, latLngToArb, fitSimilarity, ringCentroid, normalizeKey } from './moj.js';

const FA = window.FA;
const { map, $, toast } = FA;
const renderer = L.canvas({ padding: 0.5 });
const labelLayer = L.layerGroup().addTo(map);
const pairLayer = L.layerGroup().addTo(map);

const maps = new Map();      // key → 図面レコード
let bundle = null;           // { file, list, index, city }
let active = null;           // 位置合わせ中 { rec, unit, T, saved }
let pickMode = null;         // 'src' | 'dst'
let pendingSrc = null;
let highlighted = null;

const COLORS = { pub: '#2f6fd6', ok: '#14875a', prov: '#e0861a', hi: '#e2342b' };

// ───────────── Worker ─────────────
const worker = new Worker(new URL('./moj-worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const waiting = new Map();
worker.onmessage = ({ data }) => {
  const w = waiting.get(data.id);
  if (!w) return;
  if (data.type === 'progress') return status(data.text);
  waiting.delete(data.id);
  data.type === 'error' ? w.reject(new Error(data.message)) : w.resolve(data);
};
worker.onerror = e => { status('読み込み処理でエラーが発生しました：' + (e.message || '')); };
function ask(msg) {
  const id = ++seq;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
}

function status(t) { $('mojstatus').textContent = t || ''; }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortArea = (s, city) => String(s || '').replace(city || '', '').trim() || '（大字なし）';
const fmt = n => Number(n).toLocaleString('ja-JP');
// スマホ（地図が上・操作欄が下）では、地図操作の前に地図までスクロールする
const showMapOnPhone = () => { if (window.innerWidth <= 750) document.querySelector('.mapwrap').scrollIntoView({ behavior: 'smooth', block: 'start' }); };

// ───────────── 保存（IndexedDB の mojmaps ストア） ─────────────
async function store(mode, fn) {
  const db = await FA.dbp;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('mojmaps', mode);
    const r = fn(tx.objectStore('mojmaps'));
    let out; r.onsuccess = () => { out = r.result; };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}
function plain(rec) {
  const { _layer, ...rest } = rec;
  return { ...rest, parcels: rec.parcels.map(({ id, oaza, chome, koaza, chiban, sheet, ring }) => ({ id, oaza, chome, koaza, chiban, sheet, ring })) };
}
async function persist(rec) {
  try { await store('readwrite', s => s.put(plain(rec))); }
  catch (e) { toast('端末に保存できませんでした（容量不足の可能性）'); throw e; }
}

// ───────────── 変換と描画 ─────────────
function savedTransform(rec, sheet) {
  return (rec.transforms.sheets && rec.transforms.sheets[sheet]) || rec.transforms.all || null;
}
function inActiveUnit(rec, p) {
  if (!active || active.rec !== rec) return false;
  return active.unit === 'all' ? !rec.transforms.sheets[p.sheet] : p.sheet === active.unit;
}
function transformFor(rec, p) {
  return inActiveUnit(rec, p) ? active.T : savedTransform(rec, p.sheet);
}
function placeState(rec, p) {
  if (!rec.arbitrary) return 'pub';
  const t = transformFor(rec, p);
  if (!t) return 'none';
  return t.pairs && t.pairs.length ? 'ok' : 'prov';
}
function ringLatLngs(rec, p) {
  const out = [], r = p.ring;
  if (!rec.arbitrary) { for (let i = 0; i < r.length; i += 2) out.push(planeToLatLng(r[i], r[i + 1], rec.zone)); return out; }
  const t = transformFor(rec, p);
  if (!t) return null;
  for (let i = 0; i < r.length; i += 2) out.push(arbToLatLng(r[i], r[i + 1], t));
  return out;
}
function styleFor(st) {
  const c = st === 'pub' ? COLORS.pub : st === 'ok' ? COLORS.ok : COLORS.prov;
  return { renderer, color: c, weight: st === 'prov' ? 1 : 1.2, opacity: 0.9, fillColor: c, fillOpacity: 0.06, dashArray: st === 'prov' ? '4 3' : null };
}

function render(rec, onlyActiveUnit = false) {
  if (!rec._layer) rec._layer = L.layerGroup();
  if (rec.visible === false) { rec._layer.remove(); return; }
  rec._layer.addTo(map);
  for (const p of rec.parcels) {
    if (onlyActiveUnit && !inActiveUnit(rec, p)) continue;
    const ll = ringLatLngs(rec, p);
    p._ll = ll;
    if (!ll) { if (p._poly) { p._poly.remove(); p._poly = null; } continue; }
    const c = rec.arbitrary ? arbToLatLng(...ringCentroid(p.ring), transformFor(rec, p)) : planeToLatLng(...ringCentroid(p.ring), rec.zone);
    p._c = c;
    const st = placeState(rec, p);
    const style = p === highlighted ? { ...styleFor(st), color: COLORS.hi, fillColor: COLORS.hi, fillOpacity: 0.3, weight: 2.5 } : styleFor(st);
    if (!p._poly) {
      p._poly = L.polygon(ll, style).addTo(rec._layer);
      p._poly.on('click', e => onParcelClick(rec, p, e));
    } else { p._poly.setLatLngs(ll); p._poly.setStyle(style); }
  }
  refreshLabels();
}

function refreshLabels() {
  labelLayer.clearLayers();
  if (map.getZoom() < 18) return;
  const b = map.getBounds().pad(0.1);
  let n = 0;
  for (const rec of maps.values()) {
    if (rec.visible === false) continue;
    for (const p of rec.parcels) {
      if (!p._c || !b.contains(p._c)) continue;
      L.marker(p._c, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'chiban-label', html: esc(p.chiban), iconSize: [90, 14], iconAnchor: [45, 7] }) }).addTo(labelLayer);
      if (++n >= 400) return;
    }
  }
}
map.on('moveend zoomend', refreshLabels);

// ───────────── 筆のポップアップ ─────────────
function placeText(rec, p) {
  const st = placeState(rec, p);
  if (st === 'pub') return `公共座標（${esc(rec.crs)}）`;
  if (st === 'prov') return '<b style="color:#b06a0c">位置未確定（仮配置）</b>';
  const t = transformFor(rec, p);
  return `推定位置（目印${t.pairs.length}点${t.rms != null ? '・誤差 約' + t.rms.toFixed(1) + 'm' : ''}）`;
}
function onParcelClick(rec, p, e) {
  if (FA.mode || pickMode) return; // 目印・対象地の指定中は地図クリックとして扱う
  showParcel(rec, p, e.latlng);
}
function showParcel(rec, p, at) {
  setHighlight(rec, p);
  const c = p._c;
  const html = `<div class="mojpopup"><b>${esc(shortArea(p.oaza, ''))} ${esc(p.chiban)}</b><br>${esc(rec.city)}<br>図面：${esc(rec.name)}${p.sheet ? '（図郭 ' + esc(p.sheet) + '）' : ''}<br>位置：${placeText(rec, p)}<br>中心：${c[0].toFixed(7)}, ${c[1].toFixed(7)}<br><button data-moj="target">この筆を対象地にする</button>${rec.arbitrary ? ' <button data-moj="align">この図面を位置合わせ</button>' : ''}</div>`;
  const pop = L.popup({ maxWidth: 280 }).setLatLng(at || c).setContent(html).openOn(map);
  const el = pop.getElement();
  el.querySelector('[data-moj="target"]').onclick = () => {
    FA.setTarget(c, { municipality: String(rec.city || '').replace(/^.+?郡/, ''), district: String(p.oaza || '').replace(/^大字/, ''), parcel: p.chiban });
    map.closePopup();
    toast(placeState(rec, p) === 'prov' ? '対象地にしました（位置は仮配置のため未確定です）' : '対象地にしました');
  };
  const al = el.querySelector('[data-moj="align"]');
  if (al) al.onclick = () => { map.closePopup(); openAlign(rec, p.sheet && rec.transforms.sheets[p.sheet] ? p.sheet : 'all'); };
}
function setHighlight(rec, p) {
  const prev = highlighted; highlighted = p;
  if (prev && prev._poly) for (const r of maps.values()) if (r.parcels.includes(prev)) { prev._poly.setStyle(styleFor(placeState(r, prev))); break; }
  if (p && p._poly) { p._poly.setStyle({ color: COLORS.hi, fillColor: COLORS.hi, fillOpacity: 0.3, weight: 2.5 }); p._poly.bringToFront(); }
}
function focusParcel(rec, p) {
  if (rec.visible === false) { rec.visible = true; render(rec); renderMapList(); }
  if (!p._ll) return toast('この図面はまだ地図に置かれていません。「位置合わせ」から仮置きしてください');
  showMapOnPhone();
  map.fitBounds(L.latLngBounds(p._ll), { maxZoom: 19, padding: [40, 40] });
  setTimeout(() => showParcel(rec, p), 350);
}

// ───────────── ファイル読み込み ─────────────
$('mojfile').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  status(f.name + ' を読み込み中…');
  try {
    const res = await ask({ type: 'open', file: f });
    if (res.type === 'maps') { await addMaps(res.maps, res.sourceFile); return; }
    bundle = { file: res.file, list: res.list, index: res.index, city: (res.list.find(x => x.city) || {}).city || '' };
    setupBundle();
    const arb = res.list.filter(x => x.crs === '任意座標系').length;
    status(`${res.file}：図面${res.list.length}件（うち任意座標${arb}件）${res.index ? '・地番' + fmt(res.index.zip.length) + '筆' : ''}。大字か地番で図面を選んで読み込んでください。`);
  } catch (err) { status('読み込めませんでした：' + err.message); }
};

function setupBundle() {
  $('mojbundle').hidden = false;
  const sel = $('mojoaza');
  sel.replaceChildren();
  if (!bundle.index) {
    for (const it of bundle.list) sel.add(new Option(`${it.name || it.entry}（${it.crs || '座標系不明'}）`, 'E:' + it.entry));
    return;
  }
  const areas = new Map();
  const ix = bundle.index;
  for (let i = 0; i < ix.zip.length; i++) {
    let a = areas.get(ix.area[i]);
    if (!a) areas.set(ix.area[i], a = { n: 0, entries: new Set() });
    a.n++; a.entries.add(ix.zip[i]);
  }
  [...areas.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([area, a]) => {
    sel.add(new Option(`${shortArea(area, bundle.city)}（${fmt(a.n)}筆・図面${a.entries.size}件）`, 'A:' + area));
  });
  bundle.areas = areas;
}

$('mojloadoaza').onclick = async () => {
  if (!bundle) return;
  const v = $('mojoaza').value;
  const entries = v.startsWith('E:') ? [v.slice(2)] : [...bundle.areas.get(v.slice(2)).entries];
  await loadEntries(entries);
};

async function loadEntries(entries) {
  const todo = entries.filter(e => ![...maps.values()].some(m => m.entry === e && m.bundleFile === bundle.file));
  if (!todo.length) { toast('読み込み済みです'); return [...maps.values()].filter(m => entries.includes(m.entry)); }
  try {
    const res = await ask({ type: 'load', entries: todo });
    return await addMaps(res.maps, res.sourceFile);
  } catch (err) { status('読み込めませんでした：' + err.message); return []; }
}

async function addMaps(list, sourceFile) {
  const added = [];
  for (const m of list) {
    const key = [m.cityCode, m.name, m.entry || m.source].join('|');
    const old = maps.get(key);
    if (old && old._layer) old._layer.remove();
    const rec = {
      key, name: m.name, source: m.source, entry: m.entry || '', bundleFile: m.entry ? sourceFile : '',
      crs: m.crs, zone: m.zone, arbitrary: m.arbitrary, cityCode: m.cityCode, city: m.city,
      bbox: m.bbox, sheets: m.sheets, parcels: m.parcels, importedAt: new Date().toISOString(), visible: true,
      transforms: old ? old.transforms : { all: null, sheets: {} },
    };
    maps.set(key, rec);
    added.push(rec);
  }
  // 任意座標の図面は、まず近くに仮置きする（同じ大字の公共座標の図面があればそこ、無ければ今の地図の中心）
  for (const rec of added) if (rec.arbitrary && !rec.transforms.all) rec.transforms.all = provisional(rec, guessCenter(rec));
  for (const rec of added) { render(rec); try { await persist(rec); } catch {} }
  renderMapList();
  const pub = added.filter(r => !r.arbitrary).length, arb = added.length - pub;
  status(`${added.length}件の図面を読み込みました（公共座標${pub}件・任意座標${arb}件）。${arb ? '任意座標の図面は仮配置（オレンジの点線）です。「位置合わせ」で目印を指定してください。' : ''}`);
  const b = L.latLngBounds([]);
  for (const r of added) for (const p of r.parcels) if (p._ll) b.extend(p._ll[0]);
  if (b.isValid()) map.fitBounds(b, { maxZoom: 17, padding: [30, 30] });
  return added;
}

function anchorOf(rec, sheet) {
  if (sheet && sheet !== 'all') {
    const s = rec.sheets.find(x => x.no === sheet);
    if (s && s.corners.length) return [s.corners.reduce((a, c) => a + c[0], 0) / s.corners.length, s.corners.reduce((a, c) => a + c[1], 0) / s.corners.length];
  }
  return [(rec.bbox[0] + rec.bbox[2]) / 2, (rec.bbox[1] + rec.bbox[3]) / 2];
}
function provisional(rec, center, sheet = 'all') {
  return { center: [center[0], center[1]], angle: 0, scale: 1, anchor: anchorOf(rec, sheet), pairs: [], rms: null, updatedAt: new Date().toISOString() };
}
function guessCenter(rec) {
  const oazas = new Set(rec.parcels.map(p => p.oaza));
  let best = null;
  for (const r of maps.values()) {
    if (r.arbitrary || r.cityCode !== rec.cityCode) continue;
    const same = r.parcels.some(p => oazas.has(p.oaza));
    if (!best || same) best = r;
    if (same) break;
  }
  if (best) return planeToLatLng((best.bbox[0] + best.bbox[2]) / 2, (best.bbox[1] + best.bbox[3]) / 2, best.zone);
  const c = map.getCenter(); return [c.lat, c.lng];
}

// ───────────── 図面一覧 ─────────────
function mapSummary(rec) {
  if (!rec.arbitrary) return '<span class="mojbadge pub">公共座標</span>';
  const ts = [rec.transforms.all, ...Object.values(rec.transforms.sheets || {})].filter(Boolean);
  const aligned = ts.filter(t => t.pairs && t.pairs.length);
  if (!aligned.length) return '<span class="mojbadge arb">任意座標・仮配置</span>';
  return `<span class="mojbadge ok">任意座標・位置合わせ済${Object.keys(rec.transforms.sheets || {}).length ? '（図郭別あり）' : ''}</span>`;
}
function renderMapList() {
  $('mojloaded').hidden = maps.size === 0;
  const box = $('mojmaps');
  box.replaceChildren();
  for (const rec of [...maps.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'))) {
    const d = document.createElement('div');
    d.className = 'mojitem';
    d.innerHTML = `<b>${esc(rec.name)}</b>${mapSummary(rec)}<br><span class="muted">${esc(rec.city)}・${fmt(rec.parcels.length)}筆・図郭${rec.sheets.length}枚${rec.entry ? '・' + esc(rec.entry) : ''}</span><div class="row"><button data-a="vis">${rec.visible === false ? '表示する' : '隠す'}</button>${rec.arbitrary ? '<button data-a="align">位置合わせ</button>' : ''}<button data-a="zoom">移動</button><button data-a="del">削除</button></div>`;
    d.querySelector('[data-a="vis"]').onclick = () => { rec.visible = rec.visible === false; render(rec); renderMapList(); persist(rec).catch(() => {}); };
    d.querySelector('[data-a="zoom"]').onclick = () => {
      if (rec.visible === false) { rec.visible = true; render(rec); renderMapList(); }
      const b = L.latLngBounds([]); for (const p of rec.parcels) if (p._ll) b.extend(p._ll[0]);
      if (b.isValid()) map.fitBounds(b, { padding: [30, 30] });
    };
    const al = d.querySelector('[data-a="align"]'); if (al) al.onclick = () => openAlign(rec, 'all');
    d.querySelector('[data-a="del"]').onclick = async () => {
      if (!confirm(`「${rec.name}」と、その位置合わせ結果を端末から削除しますか？`)) return;
      if (active && active.rec === rec) closeAlign(false);
      if (rec._layer) rec._layer.remove();
      maps.delete(rec.key);
      try { await store('readwrite', s => s.delete(rec.key)); } catch {}
      renderMapList(); refreshLabels();
    };
    box.append(d);
  }
}

// ───────────── 地番検索 ─────────────
function parseQuery(q) {
  const terms = normalizeKey(q).split(/\s+/).filter(Boolean);
  return { nums: terms.filter(t => /^[0-9]/.test(t)), words: terms.filter(t => !/^[0-9]/.test(t)) };
}
function matchChiban(chiban, nums) {
  const c = normalizeKey(chiban);
  return nums.every(n => c === n || c.startsWith(n + '-') || (n.includes('-') ? c.startsWith(n) : false) || c.startsWith(n));
}
function rank(chiban, nums) { const c = normalizeKey(chiban); return nums.some(n => c === n) ? 0 : nums.some(n => c.startsWith(n + '-')) ? 1 : 2; }

$('mojfind').oninput = () => {
  const box = $('mojfindres'); box.replaceChildren();
  if (!bundle || !bundle.index) return;
  const { nums, words } = parseQuery($('mojfind').value);
  if (!nums.length && !words.length) return;
  const ix = bundle.index, hits = [];
  for (let i = 0; i < ix.zip.length && hits.length < 400; i++) {
    const area = normalizeKey(ix.area[i]);
    if (!words.every(w => area.includes(w))) continue;
    if (nums.length && !matchChiban(ix.chiban[i], nums)) continue;
    if (!nums.length && hits.length >= 30) break;
    hits.push(i);
  }
  hits.sort((a, b) => rank(ix.chiban[a], nums) - rank(ix.chiban[b], nums));
  const info = Object.fromEntries(bundle.list.map(x => [x.entry, x]));
  for (const i of hits.slice(0, 30)) {
    const it = info[ix.zip[i]] || {};
    const loaded = [...maps.values()].find(m => m.entry === ix.zip[i] && m.bundleFile === bundle.file);
    const d = document.createElement('div');
    d.className = 'mojitem';
    d.innerHTML = `<b>${esc(shortArea(ix.area[i], bundle.city))} ${esc(ix.chiban[i])}</b>${it.crs === '任意座標系' ? '<span class="mojbadge arb">任意座標</span>' : '<span class="mojbadge pub">公共座標</span>'}<br><span class="muted">図面：${esc(it.name || ix.zip[i])}</span><div class="row"><button class="primary">${loaded ? '地図で見る' : '図面を読み込んで見る'}</button></div>`;
    d.querySelector('button').onclick = async () => {
      const got = loaded ? [loaded] : await loadEntries([ix.zip[i]]);
      const rec = got.find(r => r.entry === ix.zip[i]) || [...maps.values()].find(m => m.entry === ix.zip[i]);
      const p = rec && rec.parcels.find(x => x.chiban === ix.chiban[i] && x.oaza && ix.area[i].endsWith(x.oaza));
      if (rec && p) focusParcel(rec, p); else toast('図面内にこの地番の形状が見つかりませんでした');
    };
    box.append(d);
  }
  if (!hits.length) box.innerHTML = '<p class="note">一致する地番がありません。</p>';
};

$('mojsearch').oninput = () => {
  const box = $('mojsearchres'); box.replaceChildren();
  const { nums, words } = parseQuery($('mojsearch').value);
  if (!nums.length && !words.length) return;
  const hits = [];
  for (const rec of maps.values()) for (const p of rec.parcels) {
    const area = normalizeKey(p.oaza + ' ' + rec.name);
    if (!words.every(w => area.includes(w))) continue;
    if (nums.length && !matchChiban(p.chiban, nums)) continue;
    hits.push([rec, p]);
    if (hits.length > 300) break;
  }
  hits.sort((a, b) => rank(a[1].chiban, nums) - rank(b[1].chiban, nums));
  for (const [rec, p] of hits.slice(0, 30)) {
    const st = placeState(rec, p);
    const d = document.createElement('div');
    d.className = 'mojitem';
    d.style.cursor = 'pointer';
    d.innerHTML = `<b>${esc(p.oaza)} ${esc(p.chiban)}</b><span class="mojbadge ${st === 'pub' ? 'pub' : st === 'ok' ? 'ok' : 'arb'}">${st === 'pub' ? '公共座標' : st === 'ok' ? '推定位置' : '仮配置'}</span><br><span class="muted">${esc(rec.name)}${p.sheet ? '・図郭' + esc(p.sheet) : ''}</span>`;
    d.onclick = () => focusParcel(rec, p);
    box.append(d);
  }
  if (!hits.length) box.innerHTML = '<p class="note">読み込んだ図面に一致する地番がありません。</p>';
};

// ───────────── 位置合わせ ─────────────
function openAlign(rec, unit) {
  if (active) closeAlign(false);
  const sel = $('mojunit');
  sel.replaceChildren(new Option(`図面全体（${fmt(rec.parcels.length)}筆）`, 'all'));
  for (const s of rec.sheets) sel.add(new Option(`図郭 ${s.no}（${s.count}筆）${rec.transforms.sheets[s.no] ? '・個別に合わせ済' : ''}`, s.no));
  sel.value = unit;
  startUnit(rec, unit);
  $('mojalign').hidden = false;
  $('mojalign').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function startUnit(rec, unit) {
  const saved = unit === 'all' ? rec.transforms.all : rec.transforms.sheets[unit];
  let T;
  if (saved) T = JSON.parse(JSON.stringify(saved));
  else {
    // 図郭を初めて個別に合わせるときは、全体の配置を引き継いで基準点だけ図郭の中心にする
    const base = rec.transforms.all || provisional(rec, guessCenter(rec));
    const anchor = anchorOf(rec, unit);
    const c = arbToLatLng(anchor[0], anchor[1], base);
    T = { ...base, center: c, anchor, pairs: [], rms: null };
  }
  active = { rec, unit, T };
  pickMode = null; pendingSrc = null;
  syncAlignUi();
  render(rec, true);
  drawPairs();
}
function syncAlignUi() {
  const { rec, unit, T } = active;
  $('mojaligntitle').textContent = `位置合わせ：${rec.name}${unit === 'all' ? '' : '・図郭 ' + unit}`;
  $('mojangle').value = T.angle; $('mojangleval').textContent = T.angle.toFixed(1) + '°';
  $('mojscale').value = T.scale.toFixed(4);
  const n = T.pairs.length;
  $('mojalignstate').innerHTML = !n ? '状態：<b>仮配置</b>（目印なし）'
    : `状態：目印 <b>${n}点</b>${n >= 3 && T.rms != null ? `・残差 約<b>${T.rms.toFixed(1)}m</b>` : n === 1 ? '（移動のみ）' : '（誤差は3点以上で計算）'}${T.manual ? '・手動調整あり' : ''}`;
}
function applyActive(fit = true) {
  if (fit && active.T.pairs.length) {
    try { active.T = { ...fitSimilarity(active.T.pairs, active.T), manual: false }; }
    catch (e) { toast(e.message); active.T.pairs.pop(); }
  }
  active.T.updatedAt = new Date().toISOString();
  syncAlignUi();
  render(active.rec, true);
  drawPairs();
}
function drawPairs() {
  pairLayer.clearLayers();
  if (!active) return;
  for (const pr of active.T.pairs) {
    const s = arbToLatLng(pr.src[0], pr.src[1], active.T);
    L.polyline([s, pr.dst], { color: '#d33', weight: 2, interactive: false }).addTo(pairLayer);
    L.circleMarker(pr.dst, { radius: 6, color: '#fff', weight: 2, fillColor: '#2463c9', fillOpacity: 1, interactive: false }).addTo(pairLayer);
    L.circleMarker(s, { radius: 5, color: '#fff', weight: 2, fillColor: COLORS.prov, fillOpacity: 1, interactive: false }).addTo(pairLayer);
  }
  if (pendingSrc) L.circleMarker(arbToLatLng(pendingSrc[0], pendingSrc[1], active.T), { radius: 8, color: COLORS.prov, weight: 3, fill: false, interactive: false }).addTo(pairLayer);
}

$('mojunit').onchange = () => {
  if (!active) return;
  const rec = active.rec;
  active = null; pairLayer.clearLayers();
  render(rec); // 保存されていない作業中の配置を元に戻してから切り替える
  startUnit(rec, $('mojunit').value);
};
$('mojplace').onclick = () => {
  if (!active) return;
  const c = map.getCenter();
  active.T = { ...active.T, center: [c.lat, c.lng], pairs: [], rms: null };
  pendingSrc = null; pickMode = null;
  applyActive(false);
  toast('今の地図の中心に置きました。目印で位置を合わせてください');
};
$('mojaddpt').onclick = () => {
  if (!active) return;
  pickMode = 'src'; pendingSrc = null;
  showMapOnPhone();
  $('mojalignhelp').textContent = '① 図面（オレンジの線）の上で、目印にする角をタップしてください。近くの角に自動で吸い付きます。';
  toast('図面上の目印をタップしてください');
};
$('mojangle').oninput = () => {
  if (!active) return;
  active.T.angle = Number($('mojangle').value); active.T.manual = true;
  applyActive(false);
};
$('mojscale').oninput = () => {
  if (!active) return;
  const v = Number($('mojscale').value);
  if (!(v > 0.2 && v < 5)) return;
  active.T.scale = v; active.T.manual = true;
  applyActive(false);
};
$('mojundo').onclick = () => { if (active && active.T.pairs.length) { active.T.pairs.pop(); applyActive(true); } };
$('mojclearpts').onclick = () => { if (active) { active.T.pairs = []; active.T.rms = null; pendingSrc = null; pickMode = null; applyActive(false); } };
$('mojsavealign').onclick = async () => {
  if (!active) return;
  const { rec, unit, T } = active;
  if (unit === 'all') rec.transforms.all = T; else rec.transforms.sheets[unit] = T;
  try { await persist(rec); toast('位置合わせを保存しました'); } catch {}
  renderMapList();
  closeAlign(true);
};
$('mojclosealign').onclick = () => closeAlign(false);
function closeAlign() {
  if (!active) return;
  const rec = active.rec;
  active = null; pickMode = null; pendingSrc = null;
  pairLayer.clearLayers();
  $('mojalign').hidden = true;
  $('mojalignhelp').textContent = '図面上の道路の角などをタップし、続けて航空写真の同じ場所をタップします。1点で移動、2点で回転・縮尺、3点以上で誤差を計算します。';
  render(rec);
}

// 図面の角に吸い付ける（画面上で24px以内）
function snapVertex(latlng) {
  const { rec } = active;
  const cp = map.latLngToContainerPoint(latlng);
  let best = null, bd = 24 * 24;
  for (const p of rec.parcels) {
    if (!inActiveUnit(rec, p) || !p._ll) continue;
    for (let i = 0; i < p._ll.length; i++) {
      const q = map.latLngToContainerPoint(p._ll[i]);
      const d = (q.x - cp.x) ** 2 + (q.y - cp.y) ** 2;
      if (d < bd) { bd = d; best = [p.ring[i * 2], p.ring[i * 2 + 1]]; }
    }
  }
  return best;
}

map.on('click', e => {
  if (!active || !pickMode || FA.mode) return;
  if (pickMode === 'src') {
    pendingSrc = snapVertex(e.latlng) || latLngToArb(e.latlng.lat, e.latlng.lng, active.T);
    pickMode = 'dst';
    $('mojalignhelp').textContent = '② 航空写真で、同じ場所をタップしてください。';
    drawPairs();
    toast('航空写真の同じ場所をタップしてください');
  } else {
    active.T.pairs.push({ src: pendingSrc, dst: [e.latlng.lat, e.latlng.lng] });
    pendingSrc = null; pickMode = null;
    applyActive(true);
    const n = active.T.pairs.length;
    $('mojalignhelp').textContent = n === 1 ? '1点目で図面を移動しました。離れた場所に2点目を追加すると、回転と縮尺も合います。'
      : n === 2 ? '2点で合わせました。3点目以上を追加すると誤差（残差）が分かります。' : '目印を追加するほど図面全体のずれが平均化されます。残差が大きい目印は取り消してください。';
    toast(`目印${n}点で合わせました`);
  }
});

// ───────────── GeoJSON 出力 ─────────────
$('mojexport').onclick = () => {
  const features = [];
  let skipped = 0;
  for (const rec of maps.values()) for (const p of rec.parcels) {
    const st = placeState(rec, p);
    const ll = ringLatLngs(rec, p);
    if (st === 'prov' || st === 'none' || !ll) { skipped++; continue; }
    const t = rec.arbitrary ? savedTransform(rec, p.sheet) : null;
    const ring = ll.map(([a, b]) => [+b.toFixed(8), +a.toFixed(8)]);
    ring.push(ring[0]);
    features.push({
      type: 'Feature',
      properties: {
        市区町村コード: rec.cityCode, 市区町村名: rec.city, 大字: p.oaza, 丁目: p.chome || undefined, 小字: p.koaza || undefined, 地番: p.chiban,
        図面: rec.name, 図郭: p.sheet || undefined, 座標系: rec.crs,
        位置: st === 'pub' ? '公共座標' : '推定（目印による位置合わせ）', 推定: st !== 'pub',
        目印数: t ? t.pairs.length : undefined, 残差m: t && t.rms != null ? +t.rms.toFixed(2) : undefined,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }
  if (!features.length) return toast('出力できる筆がありません（仮配置の図面は出力しません）');
  const fc = {
    type: 'FeatureCollection', schema: 'moj-parcels/v1', createdAt: new Date().toISOString(),
    note: '任意座標の図面は目印による推定位置です。筆界の確定や測量には使えません。', features,
  };
  const city = [...maps.values()][0]?.city || '地番';
  const url = URL.createObjectURL(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }));
  const a = document.createElement('a');
  a.href = url; a.download = `${city}_地番_${new Date().toISOString().slice(0, 10)}.geojson`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`${fmt(features.length)}筆を出力しました${skipped ? `（仮配置の${fmt(skipped)}筆は除外）` : ''}`);
};

// ───────────── 起動時：保存済みの図面を復元 ─────────────
(async () => {
  try {
    const rows = await store('readonly', s => s.getAll());
    for (const r of rows || []) {
      r.transforms = r.transforms || { all: null, sheets: {} };
      r.transforms.sheets = r.transforms.sheets || {};
      maps.set(r.key, r);
      render(r);
    }
    renderMapList();
  } catch { /* 保存機能が使えない環境 */ }
})();
