// 月度平衡补丁：data.js 是基线，这里按日期记录之后的改动（战力、粮草、效果文字），载入时套用到最新。
// 每条改动都写旧值和新值：对局推算时按对局日期回退到当时的版本（rawAt），旧对局不受新补丁影响。
// 字段：pw 战力、pv 粮草、tx 中文效果、txe 英文效果，都写成 [旧, 新]；效果文字改了的牌要同步改 cards.js（gwent_numbers_check.js 会查）。
(function (root) {
  'use strict';
  const PATCHES = [
    // { date: '2025-08-05', title: '2025 年 8 月社区补丁', src: 'https://…', cards: [
    //   { n: '牌名', pw: [5, 6], pv: [8, 7], tx: ['旧效果', '新效果'], txe: ['old', 'new'], note: '' },
    // ] },
  ];
  const COL = { pw: 4, pv: 5, tx: 8, txe: 10 };
  const sorted = () => PATCHES.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  // 把 RAW 就地更新到最新（浏览器载入时、测试里调用）；已经是新值的跳过，重复调用无害
  function applyAll(RAW) {
    const by = {}; RAW.forEach(r => { by[r[0]] = r; });
    const miss = [];
    for (const p of sorted()) for (const c of p.cards) {
      const r = by[c.n]; if (!r) { miss.push(c.n); continue; }
      for (const [k, i] of Object.entries(COL)) if (c[k]) r[i] = String(c[k][1]);
    }
    return miss;
  }
  // 某天的版本：从最新回退该日期之后的补丁（只复制改到的行）
  function rawAt(RAW, date) {
    const later = sorted().filter(p => date && p.date > date).reverse();
    if (!later.length) return RAW;
    const idx = {}; RAW.forEach((r, i) => { idx[r[0]] = i; });
    const out = RAW.slice();
    for (const p of later) for (const c of p.cards) {
      const i = idx[c.n]; if (i == null) continue;
      if (out[i] === RAW[i]) out[i] = RAW[i].slice();
      for (const [k, j] of Object.entries(COL)) if (c[k]) out[i][j] = String(c[k][0]);
    }
    return out;
  }
  // 一张牌的改动历史（卡牌详情显示）
  function history(name) {
    const out = [];
    for (const p of sorted()) for (const c of p.cards) if (c.n === name) out.push(Object.assign({ date: p.date, title: p.title }, c));
    return out;
  }
  const API = { PATCHES, applyAll, rawAt, history, latest: () => (sorted().pop() || {}).date || null };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else { root.GwentPatches = API; if (typeof RAW !== 'undefined') applyAll(RAW); }
})(this);
