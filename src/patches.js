// 月度平衡补丁：data.js 是基线，这里按日期记录之后的改动（战力、粮草、效果文字），载入时套用到最新。
// 每条改动都写旧值和新值：对局推算时按对局日期回退到当时的版本（rawAt），旧对局不受新补丁影响。
// 字段：pw 战力、pv 粮草、tx 中文效果、txe 英文效果，都写成 [旧, 新]；效果文字改了的牌要同步改 cards.js（gwent_numbers_check.js 会查）。
(function (root) {
  'use strict';
  // data.js 的基线版本：v14.9.0（2026-09-01），和 gwent.one 核对过。之后的补丁用 tools/sync_gwentone.js 生成；
  // 基线之前的版本也可以补进来（数值已经是新值，applyAll 不变；只用于把更早的对局回退到当时的数值）。
  const BASE = { ver: '14.9.0', date: '2026-09-01' };
  const PATCHES = [
    // 格式：{ date: '2026-10-01', ver: '14.10.0', title: '…', src: 'https://…', cards: [
    //   { n: '牌名', pw: [5, 6], pv: [8, 7], tx: ['旧效果', '新效果'], txe: ['old', 'new'], code: '已同步' } ] },
    { "date": "2026-09-01", "ver": "14.9.0", "title": "v14.9.0 平衡委员会", "src": "https://gwent.one/en/cards/changelog/14.9.0", "cards": [{ "n": "杰洛特：伊格尼法印", "pw": [2, 3] }, { "n": "虚无", "pv": [8, 9] }, { "n": "“瘸子”戈温", "pw": [5, 6] }, { "n": "阿瓦拉克：贤者", "pv": [7, 8] }, { "n": "布拉维坎的音乐家", "pw": [2, 1] }, { "n": "全知的她", "pw": [11, 12] }, { "n": "巨章鱼怪", "pv": [7, 6] }, { "n": "孽狐", "pv": [5, 4] }, { "n": "篡位者 - 军官", "pw": [6, 5] }, { "n": "威戈佛特兹：变节法师", "pv": [12, 11] }, { "n": "布拉森斯", "pw": [4, 3] }, { "n": "重弩海尔格", "pv": [9, 10] }, { "n": "寇格林姆", "pv": [10, 9] }, { "n": "凡赫玛", "pw": [3, 4] }, { "n": "弑王者", "pv": [5, 6] }, { "n": "永夜之蚀助祭", "pw": [4, 3] }, { "n": "战场动员", "pv": [16, 15], "txe": ["Order: Spawn a base copy of an allied bronze Soldier on its row and boost both units by 3. / This ability adds 16 provisions to your deck's provisions limit.", "Order: Spawn a base copy of an allied bronze Soldier on its row and boost both units by 3. / This ability adds 15 provisions to your deck's provisions limit."], "tx": ["指令：生成 1 个铜色友军“士兵”单位的 1 张基础同名牌至同排，并使两者都获得 3 点增益。 / 该能力可为牌组附加 15 人口上限。", "指令：生成 1 个铜色友军“士兵”单位的 1 张基础同名牌至同排，并使两者都获得 3 点增益。 / 该能力可为牌组附加 15 人口上限。"], "code": "无需改" }, { "n": "罗契：冷酷之心", "pv": [11, 10] }, { "n": "夏妮", "pv": [9, 10] }, { "n": "弗农·罗契", "pv": [9, 10] }, { "n": "斯坦尼斯王子", "pw": [5, 6] }, { "n": "巨魔魔", "pw": [5, 4] }, { "n": "染血连枷", "pv": [6, 5] }, { "n": "莱里亚强弩手", "pv": [5, 6] }, { "n": "巨橡", "pw": [9, 10] }, { "n": "艾尔丹恩", "pw": [5, 4] }, { "n": "鹿灵", "pv": [6, 5] }, { "n": "精灵剑术大师", "pw": [4, 5] }, { "n": "驾鹰", "pw": [3, 4] }, { "n": "“快嘴”古德蒙", "pv": [12, 13] }, { "n": "哈罗德·奎特", "pw": [6, 5] }, { "n": "布兰王", "pv": [11, 10] }, { "n": "海之新娘", "pw": [4, 3] }, { "n": "史璀伯格符文石", "pv": [4, 5] }, { "n": "海玫家族草药医生", "pw": [1, 2] }, { "n": "帕西佛罗拉一夜", "pv": [13, 12] }, { "n": "西吉·卢文", "pw": [4, 3] }, { "n": "坑道钻机", "pv": [7, 8] }, { "n": "爱佛琳·加罗", "pw": [6, 5] }, { "n": "变异兄弟", "pw": [11, 12] }] },
    // @@SYNC@@
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
  const API = { BASE, PATCHES, applyAll, rawAt, history, latest: () => (sorted().pop() || {}).date || null };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else { root.GwentPatches = API; if (typeof RAW !== 'undefined') applyAll(RAW); }
})(this);
