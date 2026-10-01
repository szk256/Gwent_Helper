// 纯代码导出 / 导入（v2）：牌用 gwent 官方卡牌编号（cardids.js），动作、位置、状态都用 ASCII 代码，自己写的文字做 URL 编码。
// 目标是精确、稳定：导出再导入能完整还原每条记录（不依赖语言、牌名改动）。和 app.js 共用全局（BY、db、deckById 等只在调用时用到）。
// 对局：#GWLOG v2 … ；卡组：#GWDECK v2 … ；牌库：#GWCOLL v2 …
(function () {
  'use strict';
  const IDS = Object.assign({}, (typeof GwentCardIds !== 'undefined' && GwentCardIds) || {});
  // 补丁里新增的牌带官方编号（cardids.js 还没重新生成时也能用）
  if (typeof GwentPatches !== 'undefined') for (const p of GwentPatches.PATCHES) for (const c of p.cards) if (c.id && c.n && IDS[c.n] == null) IDS[c.n] = c.id;
  const NAME = {}; for (const [n, id] of Object.entries(IDS)) NAME[id] = n;
  // 整排效果名、固定词 → 代码
  const WORD = { '霜': 'hz:frost', '雨': 'hz:rain', '雾': 'hz:fog', '风暴': 'hz:storm', '龙之梦': 'hz:dream', '血月': 'hz:moon', '灾厄': 'hz:ruin', '墓场': 'G' };
  const UNWORD = {}; for (const [k, v] of Object.entries(WORD)) UNWORD[v] = k;
  // 自己写的文字：只保留可打印 ASCII（去掉 % = 空格），其余 URL 编码
  const enc = s => String(s).replace(/[^\x21-\x7e]|[%=\s]/g, c => encodeURIComponent(c));
  const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  // 牌名 / 词 → 代码：官方编号 > 固定词 > N:原文
  const card = n => n == null ? '' : IDS[n] != null ? String(IDS[n]) : WORD[n] || 'N:' + enc(n);
  const uncard = t => /^\d+$/.test(t) ? (NAME[+t] || 'N' + t) : UNWORD[t] || (t.startsWith('N:') ? dec(t.slice(2)) : dec(t));
  // 改战力 / 金币等的值：中文状态词换成代码
  const VMAP = [['盾', 'sh'], ['锁', 'lk'], ['坚', 'rs'], ['遮', 'vl'], ['潜', 'sp'], ['伏', 'am'], ['赏', 'bt'], ['甲', 'ar'], ['活', 'vi'], ['伤', 'bl'], ['，', ',']];
  const encV = v => { let s = String(v); for (const [a, b] of VMAP) s = s.split(a).join('~' + b); return enc(s); };
  const decV = v => { let s = dec(v); for (const [a, b] of VMAP) s = s.split('~' + b).join(a); return s; };
  const ACODE = { play: 'P', summon: 'S', spawn: 'Y', tactic: 'T', effect: 'E', order: 'O', leader: 'L', draw: 'D', fx: 'F', move: 'V', kill: 'K', adj: 'J', coin: 'G', hand: 'H', real: 'C', mull: 'X', pass: '-', note: 'N', end: 'Z' };
  const ADEC = {}; for (const [k, v] of Object.entries(ACODE)) ADEC[v] = k;
  const SIDE = s => s === 'me' ? 'A' : s === 'op' ? 'B' : enc(s);
  const UNSIDE = s => s === 'A' ? 'me' : s === 'B' ? 'op' : dec(s);
  const COIN = { '先': '1', '后': '2' }, UNCOIN = { 1: '先', 2: '后' };
  const RES = { '胜': 'W', '负': 'L', '平': 'D' }, UNRES = { W: '胜', L: '负', D: '平' };   // 整场结果
  // 已知字段按固定写法编码，其他字段（以后新增的）走 x.<键>=JSON，保证不丢
  const KNOWN = new Set(['id', 'r', 'who', 'a', 'c', 'row', 'pos', 'side', 'via', 'tgts', 'tgt', 'pw', 'pay', 'fz', 'dn', 'v', 'vt', 't', 'uid', 'into', 'cards', 'dur', 'fix', 'armor']);

  function encodeGame(g) {
    const num = {}; g.log.forEach((x, i) => { num[x.id] = i + 1; });
    const ref = k => { if (k == null) return ''; if (typeof k === 'number' && g.log[k]) k = g.log[k].id; const s = String(k); const m = s.match(/^([^/]+)\/(\d+)$/); if (m && num[m[1]]) return num[m[1]] + '/' + m[2]; if (num[s]) return String(num[s]); return s === 'tac' ? 'tac' : 'x:' + enc(s); };
    const o = typeof outcome === 'function' && g.rounds ? outcome(g.rounds) : null;
    const d = typeof deckById === 'function' ? deckById(g.deck) : null;
    const kv = (k, v) => v == null || v === '' || v === false ? '' : ' ' + k + '=' + v;
    const L = ['#GWLOG v2 ids=gwent'];
    L.push('G' + kv('date', g.date) + kv('me', g.myF) + kv('ld', g.leader && card(g.leader)) + kv('op', g.fac) + kv('old', g.opLeader && card(g.opLeader)) +
      kv('coin', COIN[g.coin]) + kv('res', (g.res || (o && o.res)) && (RES[g.res || o.res] || enc(g.res || o.res))) + kv('tac', g.tacCard ? 1 : '') + kv('hand', g.hand ? 1 : '') + kv('diff', g.diff) +
      kv('build', g.ver && enc(g.ver.build)) + kv('data', g.ver && enc(g.ver.data)) + kv('deck', g.deckName && enc(g.deckName)));
    if (d) L.push('D' + kv('f', d.f) + kv('ld', d.leader && card(d.leader)) + kv('tac', d.tactic && card(d.tactic)) + ' ' + Object.entries(d.cards).map(([n, k]) => card(n) + 'x' + k).join(' '));
    if (g.stuck && g.stuck.length) L.push('S ' + g.stuck.map(card).join(' '));
    if (g.note) L.push('M ' + enc(g.note));
    const nR = Math.max(g.rounds.length, ...g.log.map(x => x.r + 1), 0);
    for (let ri = 0; ri < nR; ri++) {
      const R = g.rounds[ri];
      L.push('R' + (ri + 1) + (R ? kv('res', enc(R.res)) + kv('me', R.me) + kv('op', R.op) + kv('hm', R.hm) + kv('ho', R.ho) + kv('sec', R.sec) : ' open=1'));
      g.log.forEach((x, i) => {
        if (x.r !== ri) return;
        let s = (i + 1) + ' ' + SIDE(x.who) + ' ' + (ACODE[x.a] || 'x:' + enc(x.a));
        if (x.c != null) s += kv('c', x.a === 'note' ? enc(x.c) : card(x.c));
        s += kv('row', x.row && enc(x.row)) + kv('pos', x.pos) + kv('side', x.side && SIDE(x.side)) + kv('via', x.via && card(x.via));
        if (x.tgts && x.tgts.length) s += kv('tg', x.tgts.map(t => t.row ? 'R:' + t.row : ref(t.uid)).join(','));
        s += kv('tgt', x.tgt && enc(x.tgt)) + kv('pw', x.pw) + kv('pay', x.pay == null ? '' : x.pay ? 1 : 0) + kv('fz', x.fz == null ? '' : x.fz ? 1 : 0) + kv('dn', x.dn);
        s += kv('v', x.v != null && encV(x.v)) + kv('vt', x.vt && enc(x.vt)) + kv('t', x.t) + kv('uid', x.uid != null && ref(x.uid)) + kv('into', x.into && card(x.into));
        if (x.cards && x.cards.length) s += kv('cards', x.cards.map(card).join(','));
        s += kv('dur', x.dur) + kv('fix', x.fix ? 1 : '') + kv('armor', x.armor);
        for (const [k, v] of Object.entries(x)) if (!KNOWN.has(k) && v != null) s += ' x.' + enc(k) + '=' + enc(JSON.stringify(v));
        L.push(s);
      });
    }
    return L.join('\n');
  }

  // 解析 v2 对局代码 → { game, deck }（deck = 代码里带的卡组，导入时找同名同内容的，没有就新建）
  function decodeGame(txt) {
    const lines = String(txt || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!lines.length || !/^#GWLOG v2\b/.test(lines[0])) return null;
    const kvs = parts => { const o = {}; for (const p of parts) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i)] = p.slice(i + 1); } return o; };
    const g = { date: '', deckName: '', myF: 'NR', leader: '', fac: 'NR', coin: null, rounds: [], cur: 0, diff: null, opLeader: null, hand: false, log: [], stuck: [], note: '' };
    let deck = null, ri = -1; const open = [];
    const unref = s => { if (!s) return null; if (s === 'tac') return 'tac'; if (s.startsWith('x:')) return dec(s.slice(2)); const m = s.match(/^(\d+)(\/\d+)?$/); return m ? 'e' + m[1] + (m[2] || '') : s; };
    for (const line of lines.slice(1)) {
      const parts = line.split(/\s+/), head = parts[0], o = kvs(parts.slice(1));
      if (head === 'G') {
        Object.assign(g, { date: o.date || '', myF: o.me || 'NR', leader: o.ld ? uncard(o.ld) : '', fac: o.op || 'NR', opLeader: o.old ? uncard(o.old) : null,
          coin: UNCOIN[o.coin] || null, hand: o.hand === '1', diff: o.diff != null ? +o.diff : null, deckName: o.deck ? dec(o.deck) : '' });
        if (o.tac === '1') g.tacCard = true; if (o.res) g.res = UNRES[o.res] || dec(o.res); if (o.build || o.data) g.ver = { build: dec(o.build || ''), data: dec(o.data || '') };
      } else if (head === 'D') {
        deck = { f: o.f || g.myF, leader: o.ld ? uncard(o.ld) : '', tactic: o.tac ? uncard(o.tac) : '', cards: {} };
        for (const p of parts.slice(1)) { const m = p.match(/^(.+)x(\d+)$/); if (m && !p.includes('=')) deck.cards[uncard(m[1])] = +m[2]; }
      } else if (head === 'S') g.stuck = parts.slice(1).map(uncard);
      else if (head === 'M') g.note = dec(parts.slice(1).join(' '));
      else if (/^R\d+$/.test(head)) {
        ri = +head.slice(1) - 1;
        if (o.open === '1') open.push(ri);
        else g.rounds[ri] = { res: dec(o.res || ''), me: o.me ?? '', op: o.op ?? '', hm: o.hm != null && o.hm !== '' ? +o.hm : null, ho: o.ho != null && o.ho !== '' ? +o.ho : null, sec: o.sec != null ? +o.sec : null };
      } else if (/^\d+$/.test(head)) {
        const a = ADEC[parts[2]] || (parts[2].startsWith('x:') ? dec(parts[2].slice(2)) : parts[2]);
        const x = { id: 'e' + head, r: ri < 0 ? 0 : ri, who: UNSIDE(parts[1]), a };
        if (o.c != null) x.c = a === 'note' ? dec(o.c) : uncard(o.c);
        if (o.row) x.row = dec(o.row); if (o.pos != null) x.pos = +o.pos; if (o.side) x.side = UNSIDE(o.side); if (o.via) x.via = uncard(o.via);
        if (o.tg) x.tgts = o.tg.split(',').map(t => t.startsWith('R:') ? { row: t.slice(2) } : { uid: unref(t) });
        if (o.tgt) x.tgt = dec(o.tgt); if (o.pw != null) x.pw = +o.pw; if (o.pay != null) x.pay = o.pay === '1'; if (o.fz != null) x.fz = o.fz === '1'; if (o.dn != null) x.dn = +o.dn;
        if (o.v != null) x.v = decV(o.v); if (o.vt) x.vt = dec(o.vt); if (o.t != null) x.t = +o.t; if (o.uid) x.uid = unref(o.uid); if (o.into) x.into = uncard(o.into);
        if (o.cards) x.cards = o.cards.split(',').map(uncard); if (o.dur != null) x.dur = +o.dur; if (o.fix === '1') x.fix = true; if (o.armor != null) x.armor = +o.armor;
        for (const [k, v] of Object.entries(o)) if (k.startsWith('x.')) { try { x[dec(k.slice(2))] = JSON.parse(dec(v)); } catch (e) { /* 忽略坏字段 */ } }
        g.log.push(x);
      }
    }
    // 目标的显示标签（导出时不带）：按目标记录的牌名 / 排名重建
    const byId = {}; g.log.forEach(x => { byId[x.id] = x; });
    const sideName = s => s === 'me' ? '我方' : '对方', rowName = { m: '近战', r: '远程', all: '整个半场' };
    for (const x of g.log) for (const t of x.tgts || []) {
      if (t.row) t.label = sideName(t.row.startsWith('me') ? 'me' : 'op') + (rowName[t.row.slice(-1)] || '') + '排';
      else { const b = byId[String(t.uid).split('/')[0]]; t.label = b ? sideName(b.side || b.who) + ' ' + (String(t.uid).includes('/') ? (b.c || (b.a === 'end' ? '回合结束' : '这一步')) + ' 带出的单位' : b.c) : String(t.uid); }
    }
    g.nextE = g.log.reduce((m, x) => Math.max(m, +String(x.id).slice(1) || 0), 0) + 1;
    g.cur = g.rounds.filter(Boolean).length;
    return { game: g, deck, open: open.length > 0 };
  }

  function encodeDeck(d) {
    return '#GWDECK v2 f=' + d.f + (d.leader ? ' ld=' + card(d.leader) : '') + (d.tactic ? ' tac=' + card(d.tactic) : '') + ' name=' + enc(d.name || '') + '\n' +
      Object.entries(d.cards).map(([n, k]) => card(n) + 'x' + k).join(' ');
  }
  function decodeDeck(txt) {
    const t = String(txt || '').trim(); if (!/^#GWDECK v2\b/.test(t)) return null;
    const parts = t.split(/\s+/).slice(2); const d = { name: '导入的卡组', f: 'NR', leader: '', tactic: '', cards: {} };
    for (const p of parts) {
      let m;
      if ((m = p.match(/^(f|ld|tac|name)=(.*)$/))) { if (m[1] === 'f') d.f = m[2]; else if (m[1] === 'ld') d.leader = uncard(m[2]); else if (m[1] === 'tac') d.tactic = uncard(m[2]); else d.name = dec(m[2]); }
      else if ((m = p.match(/^(.+)x(\d+)$/))) d.cards[uncard(m[1])] = (d.cards[uncard(m[1])] || 0) + +m[2];
    }
    return d;
  }
  function encodeColl(owned) {
    return '#GWCOLL v2\n' + Object.entries(owned).filter(([, k]) => k > 0).map(([n, k]) => card(n) + 'x' + k).join(' ');
  }
  function decodeColl(txt) {
    const t = String(txt || '').trim(); if (!/^#GWCOLL v2\b/.test(t)) return null;
    const out = {}; for (const p of t.split(/\s+/).slice(2)) { const m = p.match(/^(.+)x(\d+)$/); if (m) out[uncard(m[1])] = +m[2]; }
    return out;
  }
  // ---------- 全部迁移 v2：整个 db，牌名换成 "#官方编号"，其余非 ASCII 字符转成 \uXXXX（纯 ASCII、无损） ----------
  const toId = n => typeof n === 'string' && IDS[n] != null ? '#' + IDS[n] : n;
  const fromId = v => typeof v === 'string' && /^#\d+$/.test(v) && NAME[+v.slice(1)] ? NAME[+v.slice(1)] : v;
  const mapKeys = (o, f) => o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [f(k), v])) : o;
  const NOCARD = new Set(['note', 'real', 'hand', 'coin', 'pass', 'fx', 'end']);   // 这些动作的 c 不是牌名
  function mapGame(g, f) {
    if (!g || typeof g !== 'object') return g;
    const o = Object.assign({}, g, { leader: f(g.leader), opLeader: f(g.opLeader) });
    if (Array.isArray(g.stuck)) o.stuck = g.stuck.map(f);
    if (Array.isArray(g.log)) o.log = g.log.map(x => {
      const y = Object.assign({}, x);
      if (x.c != null && !NOCARD.has(x.a)) y.c = f(x.c);
      if (x.into != null) y.into = f(x.into); if (x.via != null) y.via = f(x.via);
      if (Array.isArray(x.cards)) y.cards = x.cards.map(f);
      return y;
    });
    return o;
  }
  function mapDb(d, f) {
    const o = Object.assign({}, d);
    if (Array.isArray(d.decks)) o.decks = d.decks.map(k => Object.assign({}, k, { leader: f(k.leader), tactic: f(k.tactic), cards: mapKeys(k.cards, f) }));
    if (Array.isArray(d.games)) o.games = d.games.map(g => mapGame(g, f));
    if (d.live) o.live = mapGame(d.live, f);
    if (d.owned) o.owned = mapKeys(d.owned, f);
    if (d.edits) o.edits = mapKeys(d.edits, f);
    if (Array.isArray(d.tactics)) o.tactics = d.tactics.map(f);
    return o;
  }
  const asciiJSON = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const encodeDb = d => '#GWMIG v2 ids=gwent\n' + asciiJSON(mapDb(d, toId));
  const decodeDb = o => mapDb(o, fromId);
  window.GwentCodec = { encodeGame, decodeGame, encodeDeck, decodeDeck, encodeColl, decodeColl, encodeDb, decodeDb, card, uncard };
})();
