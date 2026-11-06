// 探索範囲（従来 default / 広い wide）の比較。疑似の道路線（正解の角度・縮尺で置いた図面の線＋ゆがみ・雑音・無関係な線）で照合する。
// 使い方: node test_search_profile.mjs <moj.js> <moj-auto.js> <11347-0304-88.xml>
import { readFileSync } from 'node:fs';
const M = await import(process.argv[2]); const A = await import(process.argv[3]);
const map = M.parseMojXml(readFileSync(process.argv[4], 'utf8'), '88');
const edges = A.featureEdges(map.parcels);
const P = {
  default: { angles: [-6, -4, -2, 0, 2, 4, 6], scales: [0.97, 1, 1.03], okA: [-8, 8], okS: [0.95, 1.05] },
  wide: { angles: [-12, -10, -8, -6, -4, -2, 0, 2, 4], scales: [0.97, 1, 1.03, 1.06], okA: [-14, 8], okS: [0.93, 1.10], boundRefine: { t: 40, ang: 3, s: 0.04 } },
};
const sheets = map.sheets.map(sh => { const c = [sh.corners.reduce((a, q) => a + q[0], 0) / 4, sh.corners.reduce((a, q) => a + q[1], 0) / 4]; const pts = A.edgePoints(edges, c, 3, sh.no); return { no: sh.no, c, pts, n: pts.length / 2 }; })
  .filter(s => s.n >= 120).sort((a, b) => b.n - a.n).slice(0, 4);
const truths = [{ ang: -2, s: 1.0 }, { ang: -5, s: 1.03 }, { ang: -8, s: 1.045 }, { ang: -10, s: 1.065 }, { ang: 3, s: 0.98 }];
const out = {};
for (const truth of truths) {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const a = truth.ang * Math.PI / 180, c = Math.cos(a) * truth.s, sn = Math.sin(a) * truth.s;
  const T = { tx: 640, ty: -420 };
  for (const sh of sheets) {
    // 図郭の中心を原点にした局所座標で、正解の変換をかけた線を作る（moj-auto の座標の向きに合わせる：x=東, y=北）
    const lines = [];
    for (const [x0, y0, x1, y1] of edges) {
      if (rnd() < 0.5) continue;
      const L = [];
      for (const [X, Y] of [[x0, y0], [x1, y1]]) {
        const e = Y - sh.c[1], nn = X - sh.c[0];
        const warp = 4 * Math.sin(e / 500) + 3 * Math.cos(nn / 350);
        L.push(T.tx + c * e + sn * nn + warp + gauss() * 2, T.ty - sn * e + c * nn - warp * 0.6 + gauss() * 2);
      }
      lines.push(Float64Array.from(L));
    }
    for (let k = 0; k < 1500; k++) { const x = (rnd() - 0.5) * 8000, y = (rnd() - 0.5) * 8000, g = rnd() * Math.PI, l = 50 + rnd() * 500; lines.push(Float64Array.from([x, y, x + Math.cos(g) * l, y + Math.sin(g) * l])); }
    for (let gx = -2600; gx < -900; gx += 28) lines.push(Float64Array.from([gx, -2200, gx + 15, -600]));
    for (const [name, p] of Object.entries(P)) {
      const t0 = Date.now();
      const res = A.searchAlignment(sh.pts, lines, { radius: 2600, minCell: 6, angles: p.angles, scales: p.scales, boundRefine: p.boundRefine });
      const b = res.best;
      let conf = res.confidence; if (b.ang < p.okA[0] || b.ang > p.okA[1] || b.s < p.okS[0] || b.s > p.okS[1]) conf = 'low';
      // 図郭の四隅の位置の誤差（m）
      let err = 0;
      for (const [X, Y] of map.sheets.find(s => s.no === sh.no).corners) {
        const e = Y - sh.c[1], nn = X - sh.c[0];
        const tx = T.tx + c * e + sn * nn, ty = T.ty - sn * e + c * nn;
        const ra = b.ang * Math.PI / 180, rc = Math.cos(ra) * b.s, rs = Math.sin(ra) * b.s;
        const px = b.tx + rc * e + rs * nn, py = b.ty - rs * e + rc * nn;
        err = Math.max(err, Math.hypot(px - tx, py - ty));
      }
      const k = `${name} 角度${truth.ang} 縮尺${truth.s}`;
      (out[k] ||= []).push({ sheet: sh.no, conf, ok: err < 15, err: Math.round(err), ang: +b.ang.toFixed(1), s: +b.s.toFixed(3), sec: (Date.now() - t0) / 1000 });
    }
  }
}
for (const [k, rs] of Object.entries(out)) {
  const acc = rs.filter(r => r.ok && r.conf !== 'low').length, wrongAcc = rs.filter(r => !r.ok && r.conf !== 'low').length;
  console.log(`${k}: 正しく採用 ${acc}/${rs.length}  誤って採用 ${wrongAcc}  誤差[m] ${rs.map(r => r.err).join(',')}  信頼度 ${rs.map(r => r.conf).join(',')}  平均${(rs.reduce((s, r) => s + r.sec, 0) / rs.length).toFixed(1)}秒`);
}
