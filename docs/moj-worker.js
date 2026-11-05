// 地図XMLの読み込みを画面の裏側で行うWorker。
import { listZip, extractZip, decodeText, innerXml, innerHead, headInfo, parseSearchList, parseMojXml } from './moj.js';

let bundle = null; // { buf, entries, name }

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
