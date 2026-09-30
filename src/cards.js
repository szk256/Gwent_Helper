/* 卡牌行为 v0.1：只写“这张牌做什么”，数值（战力、护甲、粮草、标签）来自对局簿 RAW。
 * 每张牌由积木组合：boost / damage / armor / status / spawn / summon / reset / duel / infuse / pick ...
 * 标 ASSUME 的地方是卡面没写清、按推测建模的，靠比分校准。
 */
(function (root) {
'use strict';
const isKnight = u => (u.tags || []).includes('骑士');
const isElf = u => (u.tags || []).includes('精灵');
// 己方打出：按打出者算（不忠牌落在对面半场，但仍是打出者“打出”的，ASSUME）
const own = (c, d) => (d.by || d.unit.side) === c.side;
// 手动指定目标：免疫的不能选，对方有卫士时只能选卫士（引擎 targetable）
const T = (c, prompt, from) => c.pick({ prompt, from: c.targets(from) });
const has = (u, t) => (u.tags || []).includes(t);
const bronze = u => u.def.color === '铜';
const neutral = u => u.def.fac === 'NE';
const R = (c, prompt, from) => c.pick({ kind: 'random', prompt, from });          // 随机：结果来自记录
const rightOf = (c, u) => { u = u || c.self; const row = c.g.rowOf(u); return row[row.indexOf(u) + 1] || null; };
const posRight = c => c.g.rowOf(c.self).indexOf(c.self) + 1;
const fromDeck = (c, prompt) => c.pick({ prompt, kind: 'deck', from: ['?'] });   // 牌组/墓场/创造出的牌名：来自记录里带出的后续
const highestOf = (c, us, prompt) => { if (!us.length) return null; const m = Math.max(...us.map(u => u.power)); const t = us.filter(u => u.power === m); return t.length > 1 ? R(c, prompt, t) : t[0]; };
const lowestOf = (c, us, prompt) => { if (!us.length) return null; const m = Math.min(...us.map(u => u.power)); const t = us.filter(u => u.power === m); return t.length > 1 ? R(c, prompt, t) : t[0]; };
const noop = () => {};   // 只影响手牌/牌组/墓场，场面靠后续记录和落地战力

const B = {};

// ================= 北方王国 · 用户卡组 =================
B['雷纳德·奥多'] = {
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self, run: (c, d) => c.boost(d.unit, 1) }],
  bless: [{ at: 12, run: c => boostAllBoosted(c) }],
  order: c => boostAllBoosted(c),
};
function boostAllBoosted(c) { c.allies().filter(u => c.g.isBoosted(u) && (c.g.rules.reynardSelf || u !== c.self)).forEach(u => c.boost(u, 1)); }

B['赤红男爵'] = {
  formation: true,
  order: c => {
    const t = T(c, '重置目标', c.g.units());
    if (!t) return;
    const insp = c.g.inspired(c.self);
    const lost = c.reset(t);
    if (insp && lost > 0) c.status(t, 'bleed', lost);
  },
};

B['安赛斯王子'] = {
  formation: true,
  order: c => {
    const t = T(c, '安赛斯目标', c.enemies());
    if (!t) return;
    if (c.g.inspired(c.self)) c.duel(t); else c.damage(t, 4);
  },
};

B['法利波'] = {
  abilities: [{ on: 'boosted', when: (c, d) => d.unit === c.self, run: (c, d) => {
    const t = c.pick({ kind: 'random', prompt: '法利波随机伤害', from: c.enemies() });
    if (t) c.damage(t, d.n);
  } }],
};

B['少女的盾牌'] = {
  status: { shield: true },
  bless: [
    { at: 8, run: c => { const row = c.g.rowOf(c.self); c.spawn('“无畏者”布朗温', c.side, c.self.row, row.indexOf(c.self) + 1); } },
    { at: 14, run: c => { const b = c.pick({ prompt: '布朗温', from: c.allies().filter(u => u.name === '“无畏者”布朗温') }); if (b) c.boost(b, 3); } },
  ],
  deathwish: c => c.allies().filter(u => u.name === '“无畏者”布朗温').forEach(u => c.lock(u)),
};

const BRONWEN_INF = { name: '布朗温灌注' };
function bronwen(c) {
  const t = T(c, '布朗温灌注目标', c.allies());
  if (t) c.infuse(t, { name: '布朗温灌注', on: 'boosted',
    when: (cc, d) => d.unit === cc.self && d.src !== BRONWEN_INF,
    run: (cc, d) => cc.g.boost(cc.self, d.n, BRONWEN_INF) });
}
B['“无畏者”布朗温'] = { status: { immune: true }, bless: [{ at: 5, run: bronwen }], order: bronwen };

B['不朽者'] = {
  status: { shield: true },
  abilities: [
    { on: 'shieldLost', when: (c, d) => d.unit === c.self && c.self.row === 'm', run: c => c.boost(c.self, 2) },
    { on: 'turnEnd', when: (c, d) => d.side === c.side && !c.self.status.shield, run: c => c.status(c.self, 'shield', true) },
  ],
};

B['亚特里的温德哈姆'] = {
  status: { shield: true },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.status.shield, run: c => c.boost(c.self, 2) }],
  bless: [{ at: 10, run: c => c.status(c.self, 'shield', true) }],
  order: c => c.status(c.self, 'shield', true),
};

B['范德格里夫特之剑'] = {
  deploy: c => { const t = T(c, '剑：5 伤害', c.enemies()); if (t) c.damage(t, 5); },
  deathblow: (c, victim) => { c.self.stored = victim.base; },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && c.self.stored, run: (c, d) => { c.boost(d.unit, c.self.stored); c.destroy(c.self); } }],
};

B['不朽者骑兵'] = {
  status: { shield: true },
  deploy: c => { const row = c.g.rowOf(c.self); c.spawn('不朽者骑兵', c.side, c.self.row, row.indexOf(c.self) + 1); },
};

B['游侠骑士'] = {
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => {
    const adj = c.adjacent();
    const up = adj.filter(u => c.g.isBoosted(u)).length, down = adj.filter(u => c.g.isDamaged(u)).length;
    if (up) c.boost(c.self, up);
    for (let i = 0; i < down; i++) c.damage(c.self, 1);
  } }],
  bless: [{ at: 9, run: c => c.adjacent().forEach(u => {
    c.status(u, 'shield', true);
    c.infuse(u, { name: '游侠骑士灌注', on: 'shieldLost', when: (cc, d) => d.unit === cc.self, run: cc => cc.boost(cc.self, 2) });
  }) }],
};

B['滚油'] = {
  onPlay: c => { const t = T(c, '滚油：5 伤害', c.g.units(c.foe)); if (t) c.damage(t, 5); },
  deathblow: (c, victim) => (victim.adjBefore || []).forEach(u => c.purify(u)),
};

B['疯狂的冲锋'] = {
  onPlay: c => {
    const t = T(c, '疯狂的冲锋目标', c.g.units(c.side));
    if (!t) return;
    c.boost(t, 5); c.armor(t, 2);
    if (isKnight(t)) c.status(t, 'vitality', 2);
  },
};

B['科德温骑士'] = {
  abilities: [{ on: 'unitEnter', when: (c, d) => d.unit === c.self && (c.self.origin === 'deck' || c.self.origin === 'summon'), run: c => c.boost(c.self, 3) }],
};

B['拉多维德皇家护卫'] = {
  formation: true,
  order: c => {
    const insp = c.g.inspired(c.self);                 // ASSUME：激励是指令的附加条件（同赤红男爵）
    const t = T(c, '皇家护卫：2 增益', c.allies());
    if (t) c.boost(t, 2);
    if (insp) c.armor(c.self, 2);
  },
};

B['骑士随从'] = {
  order: c => { c.self.pending = true; },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && c.self.pending && d.unit !== c.self, run: (c, d) => {
    c.self.pending = false;
    c.boost(d.unit, 2);
    if (isKnight(d.unit)) c.infuse(d.unit, { name: '骑士随从灌注', on: 'turnEnd', when: (cc, e) => e.side === cc.side, run: cc => cc.boost(cc.self, 1) });
  } }],
};

B['辛特拉骑士'] = {
  deploy: c => { const t = T(c, '辛特拉骑士：2 伤害', c.enemies()); if (t) c.damage(t, 2); },
  deathblow: c => c.status(c.self, 'vitality', 2),
  bless: [{ at: 6, run: c => c.boost(c.self, 2) }],
};

B['神殿守卫'] = {
  // ASSUME：“相邻的 3 个友军单位”按左右各延伸取最近的 3 个
  deployRow: { m: c => {
    const row = c.g.rowOf(c.self), i = row.indexOf(c.self);
    const near = row.filter(u => u !== c.self).sort((a, b) => Math.abs(row.indexOf(a) - i) - Math.abs(row.indexOf(b) - i)).slice(0, 3);
    near.forEach(u => c.boost(u, 1));
  } },
};

B['瑞达尼亚骑士'] = {
  abilities: [
    { on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.row === 'r' && c.self.armor > 0, run: c => c.boost(c.self, 1) },
    { on: 'armorBroken', when: (c, d) => d.unit === c.self, run: c => {
      if (c.self.row !== 'm') c.move(c.self, 'm');
      const top = c.g.highest(c.foe);
      const t = top.length > 1 ? c.pick({ prompt: '瑞达尼亚骑士：战力最高者', from: top }) : top[0];
      if (t) c.damage(t, 2);
    } },
  ],
  bless: [{ at: 8, run: c => c.adjacent().forEach(u => c.boost(u, 1)) }],
};

B['贝罗恒王'] = {
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self, run: (c, d) => {
    const lim = c.vars.devotion === false ? 5 : 6;    // 赤诚：起始牌组没有中立牌
    if (d.unit.power < lim) c.setPower(d.unit, lim); // ASSUME：设为上限值
  } }],
};

// 维拉克萨斯：王子 →（小局开始，在手牌或牌组时历变）流放者 →（赤诚，再历变）国王
// “重置指令能力”：已用次数、冷却清零
function resetOrder(c, zeal) {
  const t = T(c, '重置指令的友军', c.allies().filter(u => u !== c.self && u.def.fac !== 'NE' && u.def.order));
  if (!t) return;
  t.orderUsed = 0; t.cd = 0;
  if (zeal) t.zeal = true;
  c.g.log('重置指令', { uid: t.uid, name: t.name, zeal: !!zeal, by: c.self.name });
}
B['维拉克萨斯王子'] = { order: c => resetOrder(c, false) };
B['流放者维拉克萨斯'] = { formation: true, order: c => resetOrder(c, true) };
B['维拉克萨斯国王'] = {
  formation: true, status: { veil: true }, order: c => resetOrder(c, true),
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && (d.unit.tags || []).includes('士兵'), run: (c, d) => c.boost(d.unit, 1) }],
};

B['骑士册封'] = {
  onPlay: (c, o) => {
    const name = c.pick({ prompt: '骑士册封：从牌组打出的骑士', kind: 'deck', from: ['?'] });
    const row = (o && o.row) || 'm';
    const u = c.playFromDeck(name, row, o && o.pos);
    // “己方每控制 1 名骑士”：是否算被拉出的骑士自己，见 rules.knightSummonSelf（未确认）
    if (u) c.boost(u, c.allies().filter(v => isKnight(v) && (c.g.rules.knightSummonSelf || v !== u)).length);
  },
};

B['水路突袭'] = {
  onPlay: (c, o) => {
    const name = c.pick({ prompt: '水路突袭：从牌组打出的单位', kind: 'deck', from: ['?'] });
    const u = c.playFromDeck(name, (o && o.row) || 'm', o && o.pos);
    if (u) c.boost(u, Math.max(0, 9 - (u.def.prov || 0)));
  },
};

B['落难的少女'] = {
  status: { doomed: true },
  deploy: c => {
    c.self.chapter = 0;
    const name = c.pick({ prompt: '序章：召唤的铜色骑士', kind: 'deck', from: ['?'] });
    const row = c.g.rowOf(c.self);
    if (name) c.summon(name, c.side, c.self.row, row.indexOf(c.self) + 1);
  },
  abilities: [
    { on: 'unitPlayed', when: (c, d) => own(c, d) && isKnight(d.unit) && c.self.chapter < 2, run: c => {
      c.self.chapter++;
      c.g.log('剧情推进', { name: c.self.name, chapter: c.self.chapter });
      if (c.self.chapter === 2) c.g.play(c.side, '疯狂的冲锋', null, null, { spawned: true });
    } },
    { on: 'blessed', when: (c, d) => c.self.chapter >= 1 && d.unit.side === c.side, run: (c, d) => c.adjacent(d.unit).forEach(u => c.boost(u, 2)) },
  ],
};

B['皇家激励'] = {
  charges: 1,
  order: c => {
    const h = c.self, amt = 5 - (h.vars.dec || 0);
    const t = T(c, '皇家激励目标', c.g.units(c.side));
    if (!t) return;
    const before = c.g.blessCount || 0;
    c.boost(t, amt);
    if ((c.g.blessCount || 0) > before) { h.charges++; h.vars.dec = (h.vars.dec || 0) + 1; c.g.log('皇家激励刷新', { next: amt - 1 }); }
  },
};

B['战术优势'] = { charges: 1, order: c => { const t = T(c, '战术优势目标', c.g.units(c.side)); if (t) c.boost(t, 5); } };


// ================= 北方王国 · 批量补全 =================
// 领袖
B['军需储备'] = { charges: 3, order: (c, o) => {
  const row = (o && o.row) || 'm';
  c.g.spawn('志愿军', c.side, row, o && o.pos, c.self);
  c.g.units(c.side).filter(u => u.row === row && !neutral(u)).forEach(u => c.reduceCd(u, 1));
} };
B['四面夹击'] = { charges: 2, order: c => c.g.spawn('志愿军', c.side, 'm', null, c.self) };
B['战场动员'] = { order: c => {
  const t = T(c, '战场动员：铜色士兵', c.allies().filter(u => bronze(u) && has(u, '士兵')));
  if (!t) return;
  const cp = c.g.spawn(t.name, c.side, t.row, c.g.rowOf(t).indexOf(t) + 1, c.self);
  c.boost(t, 3); if (cp) c.boost(cp, 3);
} };
B['揭竿而起'] = { charges: 3, order: (c, o) => {
  const t = T(c, '揭竿而起：1 增益', c.allies()); if (t) c.boost(t, 1);
  if (c.self.charges === 0 && !c.self.vars.done) { c.self.vars.done = true; c.spawnPlay('莱里亚镰刀手', (o && o.row) || 'm', o && o.pos); }
} };
B['灼心狂热'] = { charges: 3, order: c => { const t = T(c, '灼心狂热：2 增益', c.allies()); if (!t) return; c.boost(t, 2); if (!neutral(t)) t.zeal = true; } };
B['钢铁盾墙'] = { charges: 3, order: c => { const t = T(c, '钢铁盾墙：2 增益和护盾', c.allies()); if (t) { c.boost(t, 2); c.status(t, 'shield', true); } } };

// 神器
B['凯尔塞壬'] = { deploy: c => { const n = fromDeck(c, '凯尔塞壬：生成并打出的狮鹫学派'); if (n) c.spawnPlay(n, c.self.row, posRight(c)); }, order: noop };
B['卓肯波'] = {
  deploy: c => { const n = fromDeck(c, '卓肯波：召唤的单位'); if (!n) return; const u = c.summon(n, c.side, c.self.row, posRight(c)); if (u) { c.lock(u); c.self.vars.sum = u; } },
  order: c => { const t = T(c, '卓肯波：活力', c.allies()); const s = c.self.vars.sum; const n = s ? Math.max(0, s.power - s.base) : 0; if (t && n) c.status(t, 'vitality', n); },
};
B['围攻'] = {
  status: { doomed: true },
  deploy: c => { c.self.chapter = 0; c.g.spawn('加强型投石机', c.side, 'r', null, c.self); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit !== c.self && (d.def.tags || []).includes('攻城器械') && c.self.chapter < 2, run: c => {
    c.self.chapter++;
    c.g.log('剧情推进', { name: c.self.name, chapter: c.self.chapter });
    if (c.self.chapter === 1) c.g.spawn('攻城槌', c.side, 'r', null, c.self);
    else c.spawnPlay('炮击');
  } }],
};
B['梅里泰莉神庙：众祷'] = { order: noop };
B['法师分会'] = {
  deploy: c => c.spawnPlay('符文'),
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit && d.unit !== c.self && bronze(d.unit) && has(d.unit, '法师'), run: (c, d) => { c.self.vars.lastMage = d.unit.name; } }],
  order: c => { if (c.self.vars.lastMage) c.g.spawn(c.self.vars.lastMage, c.side, c.self.row, posRight(c), c.self); },
};
B['浮港'] = { deploy: noop, order: c => { const t = T(c, '浮港：刷新指令', c.allies().filter(u => bronze(u) && u.def.order)); if (t) { t.orderUsed = 0; t.cd = 0; t.zeal = true; } } };
B['突变装置'] = { abilities: [{ on: 'unitPlayed', when: (c, d) => (d.by || d.unit.side) === c.side && d.unit.side === c.side && d.unit.row === 'm', run: (c, d) => {
  const from = c.allies().filter(u => u.def.prov === d.unit.def.prov);   // ASSUME：包括刚打出的那个
  c.g.choose({ kind: 'random', prompt: '突变装置：5 个同人口单位', from, n: 5, upTo: true, source: c.self.name }).forEach(u => c.boost(u, 1));
} }] };

// 特殊牌
B['佐里亚符文石'] = { onPlay: (c, o) => { const n = fromDeck(c, '佐里亚符文石：创造并打出'); if (n) c.spawnPlay(n, o && o.row, o && o.pos); } };
B['增援'] = { onPlay: (c, o) => {
  const t = T(c, '增援：铜色友军单位', c.allies().filter(bronze));
  if (t) c.spawnPlay(t.name, (o && o.row) || t.row, o && o.pos);
} };
B['染血连枷'] = { onPlay: c => {
  const t = T(c, '染血连枷目标', c.enemies()); if (!t) return;
  const k = Math.min(8, c.allies().filter(u => has(u, '士兵')).length);
  for (let i = 0; i < k; i++) c.damage(t, 1);
  if (8 - k > 0) c.status(t, 'bleed', 8 - k);
} };
B['萨宾娜的地狱之火'] = { onPlay: c => {
  const hit = () => { let dead = false; c.g.units().filter(u => !has(u, '鬼灵')).forEach(u => { c.damage(u, 1); if (!c.g.find(u.uid)) dead = true; }); return dead; };
  if (hit()) hit();
} };
B['施法竞赛'] = { onPlay: c => { const t = T(c, '施法竞赛：5 增益', c.allies()); if (!t) return; c.boost(t, 5); if (bronze(t)) { t.orderUsed = 0; t.cd = 0; t.zeal = true; } } };
B['标靶练习'] = { onPlay: c => { const t = T(c, '标靶练习：4 增益', c.allies()); if (!t) return; c.boost(t, 4);
  if (c.g.rowOf(t).some(u => has(u, '猎魔人'))) c.g.spawn('猎魔人学徒', c.side, t.row, null, c.self); } };
B['炮击'] = { onPlay: c => {
  const n = 4 + c.allies().filter(u => has(u, '攻城器械')).length;
  c.g.choose({ kind: 'random', prompt: '炮击：' + n + ' 点随机分摊（可重复）', from: c.enemies(), n, source: '炮击' }).slice(0, n).forEach(u => c.damage(u, 1));
} };
B['烟熏火烤'] = { onPlay: (c, o) => {
  const row = (o && o.row) || 'm', boosted = c.allies().some(u => c.g.isBoosted(u));
  const a = c.g.spawn('志愿军', c.side, row, null, c.self), b = c.g.spawn('志愿军', c.side, row, null, c.self);
  if (boosted) [a, b].forEach(u => u && c.boost(u, 1));
} };
B['熟能生巧'] = { onPlay: (c, o) => {
  const t = T(c, '熟能生巧：洗回的铜色法师', c.allies().filter(u => bronze(u) && has(u, '法师'))); if (t) c.shuffleBack(t);
  const n = fromDeck(c, '熟能生巧：打出的法师'); if (n) c.playFromDeck(n, (o && o.row) || 'r', o && o.pos);   // 增益量靠落地战力
} };
B['禁术'] = { onPlay: c => { const t = T(c, '禁术：2 伤害', c.enemies()); if (t) c.damage(t, 2); },
  deathblow: c => c.g.spawn('科德温亡魂', c.side, 'm', null, c.self) };   // 随机一排：按记录里的生成位置摆
B['符文'] = { onPlay: (c, o) => { const n = fromDeck(c, '符文：创造并打出的法师'); if (!n) return; const u = c.spawnPlay(n, (o && o.row) || 'r', o && o.pos); if (u) c.status(u, 'shield', true); } };
B['绞盘'] = { onPlay: c => { const t = T(c, '绞盘：5 增益', c.allies()); if (t) { c.boost(t, 5); c.reduceCd(t, 3); } } };

// 金色单位
B['“咯咯哒”艾伯伦特'] = { order: c => c.adjacent().forEach(u => c.purify(u)) };
B['丹德里恩'] = { order: noop };
B['亨赛特国王'] = {
  deploy: c => { const n = fromDeck(c, '亨赛特：从牌组打出的操控单位'); if (n) c.playFromDeck(n, c.self.row, posRight(c)); },
  abilities: [{ on: 'cdReduced', when: (c, d) => c.adjacent().includes(d.unit), run: (c, d) => c.boost(c.self, d.n) }],
};
B['伊尔迪珂'] = {
  order: c => { const t = T(c, '伊尔迪珂：4 增益', c.allies()); if (t) c.boost(t, 4); },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && !neutral(d.unit), run: (c, d) => { d.unit.zeal = true; } }],
};
B['伊斯崔德'] = { order: noop };   // 抽牌：抽到非单位牌时自身 +1 无法推算，用改战力
B['休伯特·雷亚克'] = {};
B['凯尔达'] = { abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.special, run: c => c.g.spawn('猎魔人学徒', c.side, c.self.row, null, c.self) }] };
B['凯拉·梅兹'] = { order: c => { const n = fromDeck(c, '凯拉·梅兹：从墓场打出的法术'); if (n) c.g.play(c.side, n, c.self.row, null, { fromGrave: true }); } };
B['南尼克'] = { order: c => { if (c.self.row !== 'r') return; const t = T(c, '南尼克：1 增益', c.g.units()); if (t) c.boost(t, 1); } };
B['埃格蒙德'] = {
  order: c => { if (c.self.row !== 'm') return; const t = T(c, '埃格蒙德：3 伤害', c.enemies()); if (t) c.damage(t, 3); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.orderUsed === 0, run: c => { const r = rightOf(c); if (r) c.boost(r, 1); } }],
};
B['塔勒'] = { order: noop };
B['夏妮'] = { order: c => { const n = fromDeck(c, '夏妮：从墓场召唤的铜色人类'); if (!n) return; const u = c.summon(n, c.side, c.self.row, posRight(c)); if (u) c.status(u, 'doomed', true); } };
B['大狮鹫'] = {};
B['巨魔魔'] = {
  order: c => { const a = c.self.armor; c.self.armor = 0; if (a) { c.g.log('失去护甲', { name: c.self.name, n: a }); c.boost(c.self, a); } },
  abilities: [{ on: 'ordered', when: (c, d) => d.side === c.side && !d.ability && d.unit !== c.self, run: c => c.armor(c.self, 1) }],
};
B['布荷特'] = {
  order: c => { const t = T(c, '布荷特：复制的铜色士兵', c.allies().filter(u => bronze(u) && has(u, '士兵'))); if (t) c.g.spawn(t.name, c.side, c.self.row, posRight(c), c.self); },
  abilities: [{ on: 'unitSpawned', when: (c, d) => d.unit.side === c.side && has(d.unit, '士兵'), run: c => c.boost(c.self, 2) }],
};
B['帕薇塔公主'] = { deploy: noop };
B['席儿·德·坦沙维耶'] = {
  deploy: c => { const t = T(c, '席儿：部署 2 伤害', c.enemies()); if (t) c.damage(t, 2); },
  order: c => { const t = T(c, '席儿：指令 2 伤害', c.enemies()); if (t) c.damage(t, 2); },
};
B['异婴'] = {
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { const t = highestOf(c, c.enemies(), '异婴：最高敌军并列'); if (t) c.damage(t, 1); } }],
  order: c => c.transform(c.self, '家事妖精', { keepPower: true }),
};
B['家事妖精'] = {
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { const t = lowestOf(c, c.allies(), '家事妖精：最低友军并列'); if (t) c.boost(t, 1); } }],
  order: c => c.transform(c.self, '异婴', { keepPower: true }),
};
B['弗农·罗契'] = { deploy: c => { for (let i = 0; i < 2; i++) { const n = fromDeck(c, '弗农·罗契：打出牌组顶端的牌'); { const pl = c.self.owner || c.foe; if (n) c.g.play(pl, n, 'm', null, { fromDeck: true, player: pl }); } } } };
B['弗尔泰斯特之傲'] = { order: c => {
  const t = T(c, '弗尔泰斯特之傲：2 伤害', c.enemies()); if (t) { const adj = c.adjacent(t); c.damage(t, 2); adj.forEach(u => c.damage(u, 1)); }
  if (c.operate()) c.self.cd = 2;
} };
B['弗尔泰斯特国王'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { const r = rightOf(c); if (r) c.boost(r, 1); } }] };
B['德马维国王三世'] = { deploy: noop, order: (c, o) => { const n = fromDeck(c, '德马维：打出的同名牌'); if (n) c.spawnPlay(n, (o && o.row) || c.self.row, o && o.pos); } };
B['战灵'] = { order: c => {
  const t = T(c, '战灵：选一排（点该排的人类）', c.allies().filter(u => has(u, '人类'))); if (!t) return;
  c.g.rowOf(t).filter(u => has(u, '人类')).forEach(u => c.transform(u, '科德温亡魂', { keepPower: true }));
} };
B['战象'] = { order: c => {
  const adj = c.adjacent(); let hit = 0;
  adj.forEach(u => { c.damage(u, 4); hit++; });
  c.boost(c.self, c.operate() ? 8 : 4 * hit);
} };
B['战车'] = { order: c => {
  const both = c.operate();
  if (c.self.row === 'm' || both) { const t = T(c, '战车：重伤 4', c.enemies()); if (t) c.status(t, 'bleed', 4); }
  if (c.self.row === 'r' || both) { const t = T(c, '战车：移排', c.enemies()); if (t) c.move(t, t.row === 'm' ? 'r' : 'm'); }
} };
B['戴斯摩'] = { order: c => c.allies().filter(u => has(u, '法师')).forEach(u => c.boost(u, 1)) };
function radovidV(c) { const h = c.leader(); if (h && (h.def.charges || 1) > 1) { h.charges++; c.g.log('领袖充能 +1', { name: h.name, left: h.charges }); } }
B['拉多维德五世'] = { deploy: radovidV, order: radovidV };
B['拉多维德：审判'] = { order: c => { const n = c.g.s.sides[c.side].vars.leaderUses || 0; const t = T(c, '拉多维德：审判 伤害', c.enemies()); if (t) c.damage(t, n); } };
B['拉法达的复仇'] = {
  operateMages: true,
  order: c => { const n = fromDeck(c, '拉法达：从手牌打出的铜色单位'); if (n) c.g.play(c.side, n, c.self.row, posRight(c)); },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && c.adjacent().includes(d.unit) && c.operate(), run: c => { const t = R(c, '拉法达：随机 2 伤害', c.enemies()); if (t) c.damage(t, 2); } }],
};
B['拉维南·金柏特'] = { deploy: noop };
B['文森特·梅斯'] = { order: c => { if (c.self.row !== 'm') return; const t = T(c, '文森特：设为 1', c.enemies().filter(u => !c.g.isBoosted(u))); if (t) c.setPower(t, 1); } };
B['斯坦尼斯王子'] = { deployRow: {
  m: c => { const t = T(c, '斯坦尼斯：4 增益', c.allies().filter(u => u !== c.self)); if (t) c.boost(t, 4); },
  r: c => c.g.choose({ prompt: '斯坦尼斯：4 个友军各 1', from: c.targets(c.allies().filter(u => u !== c.self)), n: 4, upTo: true, source: c.self.name }).forEach(u => c.boost(u, 1)),
} };
B['普西拉'] = { order: c => {
  const t = T(c, '普西拉目标', c.allies()); if (!t) return;
  if (c.g.inspired(c.self)) c.boost(t, 4);
  else if (t.power < t.base) { const n = Math.min(4, t.base - t.power); t.power += n; c.g.log('治疗', { name: t.name, n }); }
  t.cd = 0;
} };
B['柯恩'] = { order: c => { const p = c.self.power; c.allies().filter(u => u !== c.self && u.power === p).forEach(u => c.boost(u, p)); } };
B['梅里泰莉'] = { deploy: c => { const t = T(c, '梅里泰莉：5 增益', c.allies().filter(u => u !== c.self)); if (t) c.boost(t, 5); } };
B['欧德林'] = {};
B['沃米尔'] = { deploy: c => { const t = T(c, '沃米尔目标', c.allies().filter(u => u !== c.self)); if (!t) return; c.allies().filter(u => u.name === t.name).forEach(u => { c.boost(u, 1); c.armor(u, 1); }); } };
B['没完没了的朗维德'] = { deploy: c => c.boost(c.self, 5) };
B['特罗伊的多尼米尔'] = { status: { defender: true, shield: true } };
B['玛格丽塔·露克斯安提尔'] = { order: c => { const t = T(c, '玛格丽塔：锁定', c.enemies()); if (t) c.lock(t); } };
B['班纳德·罗列'] = { order: c => { const t = R(c, '班纳德：随机对决目标', c.enemies()); if (t) c.duel(t); } };
B['疯狂的凯亚恩'] = { order: c => { const n = Math.max(0, c.self.power - c.self.base); const t = T(c, '凯亚恩：伤害', c.enemies()); if (t && n) c.damage(t, n); }, deathblow: c => c.reset(c.self) };
B['科沃的维索戈塔'] = {
  order: c => { if (c.self.row !== 'r') return; const t = T(c, '维索戈塔：1 增益', c.g.units()); if (t) c.boost(t, 1); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.unit !== c.self, run: c => { c.self.bonusCharges++; } }],
};
B['米薇女王'] = {
  timer: { n: 3, run: c => c.allies().forEach(u => c.boost(u, 1)) },
  abilities: [{ on: 'boosted', when: (c, d) => d.unit === c.self, run: c => c.armor(c.self, 1) }],
};
B['约翰·纳塔利斯'] = { deployRow: { m: c => { const n = fromDeck(c, '约翰·纳塔利斯：从牌组打出的战争牌'); if (n) c.playFromDeck(n, c.self.row, null); } } };
B['维赛基德'] = {
  deploy: c => { c.self.bonusCharges += c.allies().filter(u => c.g.isBoosted(u)).length; },
  order: c => { const t = T(c, '维赛基德：1 伤害', c.enemies()); if (t) c.damage(t, 1); },
};
B['罗契：冷酷之心'] = {
  deploy: c => { const t = T(c, '罗契：2 伤害', c.enemies()); if (t) c.damage(t, 2); },
  deathblow: c => { c.self.zeal = true; },
  order: c => c.g.spawn('蓝衣铁卫突击队', c.side, c.self.row, posRight(c), c.self),
};
B['罗格纳王'] = { deployRow: { m: c => { let k = 0; c.g.units().forEach(u => { if (u.status.shield) { u.status.shield = false; k++; c.g.emit('shieldLost', { unit: u, src: c.self }); } }); if (k) c.boost(c.self, 3 * k); } } };
B['肯尼特和伽尔'] = {
  order: c => { const lim = 2 + (c.self.vars.sp || 0); const t = T(c, '肯尼特和伽尔：摧毁', c.enemies().filter(u => u.power <= lim)); if (t) c.destroy(t); },
  abilities: [{ on: 'unitSpawned', when: (c, d) => d.unit.side === c.side && has(d.unit, '士兵'), run: c => { c.self.vars.sp = (c.self.vars.sp || 0) + 1; } }],
};
B['艾雷的戈尔哈特'] = { order: (c, o) => { const n = fromDeck(c, '戈尔哈特：创造并打出的法术'); if (n) c.spawnPlay(n, o && o.row, o && o.pos); } };
B['范德格里夫特'] = { bless: [{ at: 12, run: c => c.status(c.self, 'resilience', true) }] };
B['莱蒂西亚·沙博诺'] = { order: noop };
B['菲丽芭：盲眼怒火'] = { deploy: c => {
  const t = T(c, '菲丽芭：4 伤害', c.enemies()); if (t) c.damage(t, 4);
  for (const n of [3, 2, 1]) { const r = R(c, '菲丽芭：随机 ' + n + ' 伤害', c.enemies()); if (r) c.damage(r, n); }
} };
B['萨宾娜·葛丽维希格'] = { deathwish: c => c.g.s.sides[c.self.side].rows[c.self.row].slice().forEach(u => c.damage(u, 3)) };
B['蒂莎娅·德·维瑞斯'] = { deploy: c => { c.self.vars.turn = c.g.s.turn; },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.vars.turn === c.g.s.turn, run: c => c.allies().filter(u => has(u, '法师') && u.orderTurn === c.g.s.turn).forEach(u => { u.orderUsed = 0; u.cd = 0; }) }] };
B['薇丝'] = {
  deploy: c => { const t = T(c, '薇丝：2 伤害', c.enemies()); if (t) c.damage(t, 2); },
  order: c => { const t = T(c, '薇丝：狂热', c.allies()); if (t) t.zeal = true; },
};
B['迪杰斯特拉'] = { order: (c, o) => { const n = fromDeck(c, '迪杰斯特拉：从牌组打出的单位'); if (n) c.playFromDeck(n, (o && o.row) || c.self.row, o && o.pos); } };
B['雅妲公主'] = {
  deploy: c => { if (c.devotion()) c.status(c.self, 'immune', true); },
  abilities: [{ on: 'unitEnter', when: (c, d) => d.unit.side === c.side && d.unit !== c.self && has(d.unit, '诅咒生物') && c.self.vars.turn !== c.g.s.turn, run: (c, d) => { c.self.vars.turn = c.g.s.turn; c.boost(c.self, d.unit.base); } }],
};
B['黑蕾拉'] = { order: c => { if (c.self.row !== 'm') return; const t = T(c, '黑蕾拉：伤害', c.g.units()); if (t) c.damage(t, c.g.inspired(c.self) ? 2 : 1); } };

// 铜色单位
B['中邪的女术士'] = { order: c => { const t = T(c, '中邪的女术士：摧毁护盾', c.g.units().filter(u => u.status.shield)); if (t) { t.status.shield = false; c.g.emit('shieldLost', { unit: t, src: c.self }); } c.boost(c.self, 2); } };
B['云梯'] = { order: c => { const t = T(c, '云梯：移排', c.allies()); if (!t) return; c.move(t, t.row === 'm' ? 'r' : 'm'); if (c.operate()) c.boost(t, 2); } };
B['亚甸槌击者'] = { order: c => { if (c.self.row !== 'm') return; const t = T(c, '亚甸槌击者：2 伤害', c.enemies()); if (t) c.damage(t, 2); } };
B['冥想的法师'] = { order: c => { if (c.self.pat) c.status(c.self, 'vitality', c.self.pat); if (c.g.cohort(c.self)) c.status(c.self, 'resilience', true); } };
B['凯拉克城防守卫'] = {
  order: c => { const t = T(c, '城防守卫：移排', c.enemies()); if (t) c.move(t, t.row === 'm' ? 'r' : 'm'); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.orderUsed === 0, run: c => c.boost(c.self, 1) }],
};
B['凯拉克快刀手'] = { order: c => { const t = T(c, '快刀手：重伤 3', c.enemies()); if (t) c.status(t, 'bleed', 3); } };
B['凯拉克护卫舰'] = { order: c => { c.g.spawn('志愿军', c.side, c.self.row, posRight(c), c.self); if (c.operate()) c.self.cd = 1; } };
B['凯拉克海军'] = { order: c => { const t = T(c, '凯拉克海军：增益', c.allies()); if (t) c.boost(t, c.devotion() ? 4 : 2); } };
B['利维亚矛兵'] = { order: c => {
  const t = T(c, '利维亚矛兵：2 伤害', c.enemies()); if (!t) return;
  c.damage(t, 2);
  if (!c.g.find(t.uid) || c.g.inspired(c.self)) c.g.rowOf(c.self).forEach(u => c.reduceCd(u, 1));   // 致死；激励时总会触发
} };
B['加强型弩炮'] = { order: c => { const t = T(c, '加强型弩炮：1 伤害', c.g.units()); if (t) c.damage(t, 1); } };
B['加强型投石机'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && (c.self.row === 'r' || c.operate()), run: c => {
  const from = c.operate() ? c.enemies() : c.enemies().filter(u => u.row === 'r');
  const t = R(c, '加强型投石机：随机 1 伤害', from); if (t) c.damage(t, 1);
} }] };
B['可怜的步兵'] = { deploy: c => {
  const row = c.g.rowOf(c.self);
  c.g.spawn('左侧翼杂兵', c.side, c.self.row, row.indexOf(c.self), c.self);
  c.g.spawn('右侧翼杂兵', c.side, c.self.row, c.g.rowOf(c.self).indexOf(c.self) + 1, c.self);
  if (c.g.cohort(c.self)) c.boost(c.self, 3);
} };
B['弩炮'] = {
  deploy: c => { const t = T(c, '弩炮：1 伤害', c.enemies()); if (t) c.damage(t, 1); },
  order: c => { const t = T(c, '弩炮：2 伤害', c.enemies()); if (t) c.damage(t, 2); },
};
B['战地医师'] = { deploy: c => c.adjacent().forEach(u => c.boost(u, 2)) };
B['投石车'] = { abilities: [{ on: 'ordered', when: (c, d) => d.side === c.side, run: c => { const t = R(c, '投石车：随机 1 伤害', c.enemies()); if (t) c.damage(t, 1); } }] };
B['攻城后援'] = {
  deployRow: {
    m: c => { const t = T(c, '攻城后援：冷却 -1', c.allies().filter(u => u !== c.self)); if (t) c.reduceCd(t, 1); },
    r: c => { const t = T(c, '攻城后援：1 增益', c.allies().filter(u => u !== c.self)); if (t) c.boost(t, 1); },
  },
  order: c => { const t = T(c, '攻城后援：狂热', c.allies()); if (t) t.zeal = true; },
};
B['攻城塔'] = { order: c => { if (c.operate()) c.boost(c.self, 2); else c.status(c.self, 'vitality', 2); } };
B['攻城大师'] = { order: c => { const t = T(c, '攻城大师：冷却 -1', c.allies()); if (t) c.reduceCd(t, 1); } };
B['攻城槌'] = { order: c => {
  if (c.self.row === 'm') { c.move(c.self, 'r'); return; }
  c.move(c.self, 'm');
  const t = c.operate() ? T(c, '攻城槌：3 伤害', c.enemies()) : highestOf(c, c.enemies(), '攻城槌：最高敌军并列');
  if (t) c.damage(t, 3);
} };
B['旅行女祭司'] = {
  charges: 0,
  deploy: c => { c.self.bonusCharges += 1; },
  order: c => { const t = T(c, '旅行女祭司：1 增益', c.allies()); if (t) c.boost(t, 1); },
  abilities: [{ on: 'boosted', when: (c, d) => d.unit === c.self && c.g.inspired(c.self), run: c => { c.self.zeal = true; } }],
};
B['机动弩炮'] = {
  order: c => { if (c.self.row !== 'r') return; const t = T(c, '机动弩炮：2 伤害', c.enemies()); if (t) c.damage(t, 2); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.operate(), run: c => c.armor(c.self, 1) }],
};
B['泰莫利亚步兵'] = { order: c => { const h = c.leader(); const n = h ? Math.max(0, h.charges) : 0; const t = T(c, '泰莫利亚步兵：增益', c.allies()); if (t && n) c.boost(t, 2 * n); } };
B['泰莫利亚鼓手'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { const r = rightOf(c); if (r) c.boost(r, 1); } }] };
B['狮鹫学派猎魔人'] = { order: c => { if (c.self.row !== 'm') return; const t = T(c, '狮鹫学派猎魔人：1 伤害', c.enemies()); if (t) c.damage(t, 1); } };
B['狮鹫学派猎魔人学徒'] = { order: c => { const t = T(c, '学徒：转变的猎魔人', c.allies().filter(u => has(u, '猎魔人'))); if (t) c.transform(t, '狮鹫学派猎魔人学徒'); } };
B['狮鹫学派猎魔人导师'] = { deploy: noop };
B['狮鹫学派猎魔人游侠'] = {
  deploy: c => c.boost(c.self, Math.max(...['m', 'r'].map(r => c.g.s.sides[c.foe].rows[r].length))),   // ASSUME：选单位多的那排
  order: c => { const n = c.self.power - c.self.base; const t = T(c, '游侠：转移增益', c.allies().filter(u => u !== c.self)); if (t && n > 0) { c.self.power = c.self.base; c.g.log('转移增益', { from: c.self.name, to: t.name, n }); c.boost(t, n); } },
};
B['班·阿德导师'] = { abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.special && !(c.self.vars.seen || []).includes(d.name), run: (c, d) => { (c.self.vars.seen = c.self.vars.seen || []).push(d.name); c.boost(c.self, 2); } }] };
B['班阿德的学生'] = { order: c => { if (c.self.row !== 'm') return; const t = T(c, '班阿德的学生：伤害', c.enemies()); if (t && c.self.pat) c.damage(t, c.self.pat); } };
B['瑞达尼亚密探'] = { order: noop };
B['瑞达尼亚弓箭手'] = {
  order: c => { if (c.self.row !== 'r') return; const t = T(c, '瑞达尼亚弓箭手：1 伤害', c.enemies()); if (t) c.damage(t, 1); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0, run: c => { c.self.bonusCharges++; } }],
};
B['瑞达尼亚情报处'] = { order: c => { const t = T(c, '情报处：净化', c.allies()); if (t) c.purify(t); } };
B['瑞达尼亚精锐'] = { deploy: c => c.boost(c.self, 6), abilities: [{ on: 'armorBroken', when: (c, d) => d.unit === c.self, run: c => c.reset(c.self) }] };
B['科德温中士'] = { order: c => { const t = T(c, '科德温中士：1 增益', c.allies()); if (t) c.boost(t, 1); } };
B['科德温亡魂'] = {
  order: c => { const t = T(c, '亡魂：1 伤害', c.g.units()); if (t) c.damage(t, 1); },
  deathblow: c => c.g.spawn('科德温亡魂', c.side, c.self.row, posRight(c), c.self),
};
B['科德温骑兵'] = { abilities: [{ on: 'shieldLost', when: (c, d) => d.unit === c.self, run: c => c.boost(c.self, 2) }] };
B['舰载弩炮'] = { order: c => {
  const used = c.allies().filter(u => u.orderTurn === c.g.s.turn && u !== c.self).length;   // ASSUME：本回合己方其他单位已用指令数
  const t = T(c, '舰载弩炮：伤害', c.enemies()); if (t) c.damage(t, 2 + used);
} };
B['艾瑞图萨学徒'] = { order: c => { if (c.self.row !== 'r') return; const t = T(c, '艾瑞图萨学徒：增益', c.allies()); if (t && c.self.pat) c.boost(t, c.self.pat); } };
B['艾瑞图萨学院学员'] = { abilities: [{ on: 'patience', when: (c, d) => d.unit.side === c.side, run: c => c.boost(c.self, 1) }] };
B['莱里亚强弩手'] = {
  order: c => { const t = T(c, '莱里亚强弩手：1 伤害', c.g.units()); if (t) c.damage(t, 1); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit !== c.self && d.def.order, run: c => { c.self.bonusCharges++; } }],
};
B['莱里亚镰刀手'] = { deploy: c => c.boost(c.self, c.g.rowOf(c.self).filter(u => u !== c.self && c.g.isBoosted(u)).length) };
B['莱里亚长矛兵'] = { order: c => { const t = T(c, '莱里亚长矛兵：伤害', c.g.units()); if (t) c.damage(t, c.g.inspired(c.self) ? 3 : 1); } };
B['莱里亚骑兵'] = { abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && d.unit.def.order, run: c => c.boost(c.self, 1) }] };
B['蓝衣铁卫斥候'] = { deploy: noop };
B['蓝衣铁卫突击队'] = { order: noop };   // 召唤的同名牌由记录里的“召唤”步骤放上场
B['被诅咒的骑士'] = { deploy: c => { const t = T(c, '被诅咒的骑士：转变', c.allies().filter(u => u !== c.self && u.name !== '被诅咒的骑士')); if (t) c.transform(t, '被诅咒的骑士', { keepPower: true }); } };
B['袭击者斥候'] = { order: (c, o) => { const t = T(c, '袭击者斥候：复制的铜色士兵', c.allies().filter(u => bronze(u) && has(u, '士兵') && u.name !== c.self.name)); if (t) c.spawnPlay(t.name, (o && o.row) || c.self.row, o && o.pos); } };
B['袭击者猎人'] = {
  order: c => { const u = c.g.spawn('袭击者猎人', c.side, c.self.row, posRight(c), c.self); if (u) { u.base = Math.max(1, c.self.base - 1); u.power = u.base; } },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.row === 'm' && c.g.cohort(c.self), run: c => { const t = highestOf(c, c.enemies(), '袭击者猎人：最高敌军并列'); if (t) c.damage(t, 1); } }],
};
B['辛特拉使者'] = { order: noop };
B['辛特拉女术士'] = { deployRow: { r: c => { const t = T(c, '辛特拉女术士：活力', c.allies().filter(u => u !== c.self)); if (t) c.status(t, 'vitality', c.g.cohort(c.self) ? 4 : 2); } } };
B['辛特拉皇家护卫'] = { deploy: c => c.boost(c.self, 3 * c.allies().filter(u => u !== c.self && u.name === c.self.name).length) };
B['辛特拉织法者'] = {
  order: c => { const t = T(c, '辛特拉织法者：1 伤害', c.g.units()); if (t) c.damage(t, 1); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit !== c.self && ((d.def.tags || []).includes('法师') || (d.def.tags || []).includes('法术')), run: c => { c.self.bonusCharges++; } }],
};
B['梅里泰莉神庙：朝圣'] = { deploy: c => {
  const t = T(c, '朝圣：洗回的友军', c.allies()); if (!t) return;
  const lim = t.power; c.shuffleBack(t);
  const e = T(c, '朝圣：洗回的敌军', c.enemies().filter(u => u.power <= lim)); if (e) c.shuffleBack(e);
}, order: noop };


// ================= 怪兽 · 批量补全 =================
const DRONE = '雄蛛', BAT = '蝙魔', RAT = '老鼠';
const HZ2 = (kind, turns, extra) => Object.assign({ hazardCard: { kind, turns } }, extra || {});   // 生成整排效果：放在哪排按对局簿的“整排效果”记录
const frostTurnsOn = (c, side) => ['m', 'r'].reduce((a, r) => a + ((c.frost(side, r) || {}).turns || 0), 0);
const consumeT = (c, prompt, from) => { const t = T(c, prompt, from); if (t) c.consume(t); return t; };
const graveUnit = (c, prompt) => fromDeck(c, prompt);   // 墓场里的牌：牌名来自记录

// 领袖
B['不息虫群'] = { charges: 5, order: (c, o) => c.g.spawn(DRONE, c.side, (o && o.row) || 'm', o && o.pos, c.self) };
B['坚硬甲壳'] = { charges: 3, order: c => { const t = T(c, '坚硬甲壳：3 增益', c.allies()); if (!t) return; c.boost(t, 3); if (!neutral(t)) c.status(t, 'veil', true); } };
B['无尽渴望'] = { charges: 2, order: c => { const t = T(c, '无尽渴望：摧毁的友军', c.allies()); if (!t) return; const p = t.power, row = t.row; c.destroy(t); const b = c.g.spawn(BAT, c.side, row, null, c.self); if (b) c.boost(b, p); } };
B['沼泽果实'] = { order: (c, o) => c.g.spawn('格尼阔拉的果实', c.side, (o && o.row) || 'm', o && o.pos, c.self) };
B['白霜降临'] = HZ2('霜', 2, { charges: 2, order: c => { const t = T(c, '白霜降临：移排', c.enemies()); if (t) c.move(t, otherRow(t.row)); } });
B['腥膻之味'] = { charges: 3, order: (c, o) => {
  const t = T(c, '腥膻之味：重伤 3', c.enemies()); if (t) c.status(t, 'bleed', 3);
  if (c.self.charges === 0 && !c.self.vars.done) { c.self.vars.done = true; c.g.spawn(BAT, c.side, (o && o.row) || 'm', null, c.self); }
} };
B['自然之力'] = { order: (c, o) => c.spawnPlay('林妖', (o && o.row) || 'm', o && o.pos) };

// 神器
B['万魔窟'] = {
  deploy: c => { const n = fromDeck(c, '万魔窟：生成并打出'); if (n) c.spawnPlay(n, c.self.row, posRight(c)); },
  order: c => { const t = highestOf(c, c.g.units(), '万魔窟：最高单位并列'); if (t) c.shuffleBack(t); const row = c.g.rowOf(c.self);
    c.g.spawn(DRONE, c.side, c.self.row, row.indexOf(c.self), c.self); c.g.spawn(DRONE, c.side, c.self.row, c.g.rowOf(c.self).indexOf(c.self) + 1, c.self); },
};
B['庄园的隐秘事'] = {
  deploy: c => { c.self.chapter = 0; const u = c.g.spawn('受诅咒的少女', c.side, c.self.row, posRight(c), c.self); if (u) c.boost(u, 2); },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && d.unit.def.growth && c.self.chapter < 2, run: c => {
    c.self.chapter++; c.g.log('剧情推进', { name: c.self.name, chapter: c.self.chapter });
    if (c.self.chapter === 2) { const n = fromDeck(c, '庄园：从牌组打出的最高铜色单位'); if (n) c.playFromDeck(n, c.self.row); }
  } }],
};
B['提尔纳丽雅'] = { deploy: c => { const t = T(c, '提尔纳丽雅：增益', c.allies()); void t; }, order: c => c.spawnPlay('红骑士') };   // 增益量按起始牌组，靠改战力
B['畏惧者：休眠'] = {};
B['邪灵法典'] = { order: c => { const t = T(c, '邪灵法典：触发遗愿', c.allies().filter(u => bronze(u) && u.def.deathwish)); if (t) c.deathwishOf(t); } };
B['鬼婆'] = {
  status: { doomed: true },
  deploy: c => { c.self.chapter = 0; c.g.spawn('沙漠女妖', c.side, c.self.row, posRight(c), c.self); },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && d.unit.def.deathwish && c.self.chapter < 2, run: c => {
    c.self.chapter++; c.g.log('剧情推进', { name: c.self.name, chapter: c.self.chapter });
    c.spawnPlay(c.self.chapter === 1 ? '幽冥犬' : '夜之妖灵', c.self.row, posRight(c));
  } }],
};

// 特殊牌
B['伊勒瑞斯之怒'] = { onPlay: c => { const t = T(c, '伊勒瑞斯之怒：目标', c.enemies()); if (!t) return; if (c.frost(t.side, t.row)) c.destroy(t); else { const m = Math.max(0, ...c.allies().map(u => u.power)); c.damage(t, m); } } };
B['呢喃山丘'] = { onPlay: (c, o) => { const n = fromDeck(c, '呢喃山丘：打出的遗愿单位'); if (n) c.playFromDeck(n, (o && o.row) || 'm', o && o.pos); } };
B['女巫夜宴'] = {};   // 双方墓场召唤：靠记录里的召唤
B['寄生虫'] = { onPlay: c => { const t = T(c, '寄生虫：目标', c.g.units()); if (!t) return; if (t.side === c.side) c.boost(t, 6); else c.damage(t, 6); } };
B['巨人力量腰带'] = { onPlay: c => { const t = T(c, '腰带：10 增益', c.allies()); if (t) c.boost(t, 10); } };
B['戴维娜符文石'] = { onPlay: (c, o) => { const n = fromDeck(c, '戴维娜符文石：创造并打出'); if (n) c.spawnPlay(n, o && o.row, o && o.pos); } };
B['猩红诅咒'] = HZ2('血月', 5, { onPlay: (c, o) => { const row = (o && o.row) || 'm'; c.g.spawn(BAT, c.side, row, null, c); c.g.spawn(BAT, c.side, row, null, c); } });
B['纳吉尔法'] = { onPlay: (c, o) => { const n = fromDeck(c, '纳吉尔法：打出的金色牌'); if (n) c.playFromDeck(n, (o && o.row) || 'm', o && o.pos); } };
B['莉莉丝的预兆'] = { onPlay: (c, o) => { for (let i = 0; i < 2; i++) { const n = fromDeck(c, '莉莉丝的预兆：召唤的单位'); if (!n) break; const u = c.summon(n, c.side, (o && o.row) || 'm'); if (u) { c.status(u, 'doomed', true); c.status(u, 'rupture', true); } } } };
B['虫群思维'] = { onPlay: noop };
B['诸界之门'] = HZ2('霜', 3, { onPlay: noop });
B['酸液喷射'] = { onPlay: c => { const t = T(c, '酸液喷射：目标', c.enemies()); if (!t) return;
  const inf = { name: '酸液', on: 'unitSpawned', when: (cc, d) => d.unit.side !== cc.side && cc.self.power >= 1 && !cc.self.vars.acidTurn, run: cc => { cc.self.vars.acidTurn = true; cc.g.damage(cc.self, 1, { name: '酸液' }); } };
  c.infuse(t, inf);
} };
B['暗影之瓮'] = { order: c => { const t = T(c, '暗影之瓮：触发遗愿', c.allies().filter(u => u.def.deathwish)); if (t) c.deathwishOf(t); } };
B['可怖盛宴'] = { onPlay: c => { const e = T(c, '可怖盛宴：3 伤害', c.enemies()); if (e) c.damage(e, 3); const a = T(c, '可怖盛宴：3 增益', c.allies()); if (a) c.boost(a, 3); } };
B['捕食俯冲'] = { onPlay: c => { const a = lowestOf(c, c.allies(), '捕食俯冲：己方最低并列'), b = lowestOf(c, c.enemies(), '捕食俯冲：对方最低并列'); if (a) c.destroy(a); if (b) c.destroy(b); } };
B['殷红的塑像'] = { onPlay: c => { const n = graveUnit(c, '殷红的塑像：放逐的对方墓场单位'); const t = T(c, '殷红的塑像：增益', c.allies()); if (n && t) { const gr = c.g.s.sides[c.foe].grave, i = gr.indexOf(n); if (i >= 0) gr.splice(i, 1); c.boost(t, c.g.def(n).base || 0); } } };
B['物竞天择'] = { onPlay: c => { const t = T(c, '物竞天择：4 伤害', c.enemies()); if (!t) return; const over = Math.max(0, 4 - t.armor - t.power); c.damage(t, 4); for (let i = 0; i < over; i++) c.g.spawn(DRONE, c.side, 'm', null, c); } };
B['猩红盛宴'] = { onPlay: c => { const t = T(c, '猩红盛宴：目标', c.enemies()); if (!t) return; c.purify(t); c.damage(t, 3); if (c.allies().some(u => has(u, '吸血鬼'))) c.status(t, 'bleed', 3); } };
B['红骑士'] = HZ2('霜', 4, { onPlay: noop });   // 择一：回合数按记录；“重新打出狂猎单位”用记录
B['自然进化'] = { onPlay: c => {
  const t = T(c, '自然进化：友军', c.allies()); if (!t) return;
  if (has(t, '野兽')) c.boost(t, 9); else c.boost(t, 5);
  if (has(t, '类虫生物')) for (let i = 0; i < 3; i++) c.g.spawn(DRONE, c.side, t.row, null, c);
  if (has(t, '食人魔')) c.g.spawn('孽鬼', c.side, t.row, null, c);
} };
B['蟹蜘蛛巢穴'] = { onPlay: (c, o) => { for (let i = 0; i < 4; i++) c.g.spawn(DRONE, c.side, (o && o.row) || 'm', null, c); } };

// 金色单位
B['“魔兽”'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.power < Math.max(...c.g.units().map(u => u.power)), run: c => c.boost(c.self, 2) }] };
B['伊勒瑞斯'] = { deploy: noop };
B['伊迪尔'] = { charges: 0,
  abilities: [{ on: 'unitPlayed', when: (c, d) => foePlays(c, d), run: (c, d) => { c.damage(d.unit, 1); c.self.bonusCharges++; } }],
  order: c => c.g.spawn(DRONE, c.side, c.self.row, posRight(c), c.self) };
B['克尔图里斯'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.row === 'm', run: c => {
  const a = c.g.units('me').length, b = c.g.units('op').length; if (a === b) return;
  const t = lowestOf(c, c.g.units(a > b ? 'me' : 'op'), '克尔图里斯：最弱并列'); if (t) c.destroy(t);
} }] };
B['克鲁姆国王'] = { deploy: c => { if (c.might()) c.status(c.self, 'resilience', true); } };   // 基础战力按起始牌组：靠落地战力
B['全知的她'] = { abilities: [{ on: 'roundEnd', when: c => c.feast(), run: c => { const t = c.allies().sort((a, b) => b.base - a.base)[0]; if (t) c.status(t, 'resilience', true); } }] };
B['冬之女王'] = {};
B['加尔'] = { deployRow: { m: c => { const t = T(c, '加尔：伤害', c.enemies()); if (t) c.damage(t, t.status.bleed > 0 ? 3 : 1); } }, deathblow: (c, v) => c.boost(c.self, v.base) };
B['劳拉·朵兰'] = { deploy: c => { const n = frostTurnsOn(c, c.side); if (n) c.damage(c.self, n); }, deathwish: c => c.enemies().forEach(u => c.boost(u, 2)) };
B['卡兰希尔'] = { deploy: c => { const n = fromDeck(c, '卡兰希尔：手牌里的单位'); if (!n) return; const u = c.g.spawn(n, c.side, c.self.row, posRight(c), c.self); if (u) c.setPower(u, 1); } };
B['卡兰希尔：金童'] = {};
B['卡塔卡恩'] = {
  order: c => c.g.spawn(BAT, c.side, c.self.row, posRight(c), c.self),
  abilities: [{ on: 'statusGained', when: (c, d) => d.key === 'bleed' && d.unit.side === c.foe, run: c => c.reduceCd(c.self, 1) }],
};
B['卢恩'] = { deathwish: noop };   // 从墓场召唤并吞噬：靠记录
B['原蝠翼魔'] = { deploy: c => { const t = T(c, '原蝠翼魔：重伤 3', c.enemies()); if (t) { c.status(t, 'bleed', 3); c.boost(c.self, 3); } } };
B['呢喃婆'] = {
  deploy: c => { const t = T(c, '呢喃婆：伤害', c.enemies()); if (t) c.damage(t, 2 + 2 * ((c.g.s.sides[c.side].vars.played || {})['老巫妪'] || 0)); },
};
B['呢喃婆：献礼'] = { deployRow: { r: c => { const n = fromDeck(c, '献礼：打出的生物牌'); if (n) c.playFromDeck(n, c.self.row, posRight(c)); } } };
B['哥亚特'] = { deathwish: noop };   // 对方召唤：靠记录
B['夜之女王'] = { deployRow: {
  m: c => { const t = T(c, '夜之女王：重伤 3', c.enemies()); if (t) c.status(t, 'bleed', 3); },
  r: c => { const t = T(c, '夜之女王：净化', c.g.units().filter(u => u !== c.self)); if (t) c.purify(t); },
} };
B['奥莉安娜'] = {
  deploy: c => { const n = c.allies().filter(u => has(u, '吸血鬼')).length; const t = T(c, '奥莉安娜：重伤', c.enemies()); if (t && n) c.status(t, 'bleed', n); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.row === 'r', run: c => { const n = c.enemies().filter(u => u.status.bleed > 0).length; if (n) c.boost(c.self, n); } }],
};
B['奥贝伦王'] = { deploy: c => { const n = fromDeck(c, '奥贝伦王：生成并打出的狂猎'); if (n) c.spawnPlay(n, c.self.row, posRight(c)); } };
B['入侵者奥贝伦'] = { deploy: c => { const n = fromDeck(c, '入侵者奥贝伦：创造并打出的狂猎'); if (n) c.spawnPlay(n, c.self.row, posRight(c)); } };
B['女捕鼠人'] = { abilities: [
  { on: 'damaged', when: (c, d) => d.unit === c.self && d.dealt > 0 && !c.feast(), run: c => { c.self.base = Math.max(0, c.self.base - 1); } },
  { on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '残物'), run: c => c.g.strengthen(c.self, 1, c.self) },
] };
B['安德莱格女王'] = {
  deploy: c => { const t = consumeT(c, '安德莱格女王：吞噬', c.allies().filter(u => u !== c.self)); if (t) c.armor(c.self, t.def.prov || 0); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0, run: c => { c.damage(c.self, 1); c.g.spawn(DRONE, c.side, c.self.row, posRight(c), c.self); } }],
};
B['尼斯里拉'] = { order: c => { if (c.self.row !== 'm') return; const t = T(c, '尼斯里拉：伤害', c.g.units()); if (t) c.damage(t, c.dominance() ? 2 : 1); } };
B['巨型蜈蚣'] = { deploy: noop };   // 护甲 = 手牌数：靠改战力
B['巨章鱼怪'] = { deploy: c => c.g.choose({ prompt: '巨章鱼怪：吞噬 3 个友军', from: c.targets(c.allies().filter(u => u !== c.self)), n: 3, upTo: true, source: c.self.name }).forEach(u => c.consume(u)) };
B['帝国蝎尾狮'] = { deathwish: c => { const t = lowestOf(c, c.enemies(), '蝎尾狮：最低敌军并列'); if (t) c.destroy(t); } };
B['忏悔灵'] = { deathwish: noop };
B['挠挠先生'] = { order: noop };
B['暗影长者'] = {
  deploy: c => { const t = T(c, '暗影长者：重伤 4', c.enemies()); if (t) c.status(t, 'bleed', 4); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => {
    const t = R(c, '暗影长者：随机重伤 2', c.enemies().filter(u => !(u.status.bleed > 0))); if (t) c.status(t, 'bleed', 2);
    if (c.devotion()) c.enemies().filter(u => u.status.bleed > 0).forEach(u => { u.status.bleed--; c.damage(u, 1, { ignoreArmor: true, bleed: true }); });
  } }],
};
B['欧兹瑞尔'] = { deploy: c => { const n = graveUnit(c, '欧兹瑞尔：吞噬的墓场单位'); if (!n) return; const side = c.self.row === 'm' ? c.foe : c.side; const gr = c.g.s.sides[side].grave, i = gr.indexOf(n); if (i >= 0) { gr.splice(i, 1); c.g.s.sides[side].banished.push(n); } c.boost(c.self, c.g.def(n).base || 0); } };
B['污水怪'] = { deploy: c => { const ts = c.g.units().filter(u => u !== c.self && u.power === 1); ts.forEach(u => c.destroy(u)); if (ts.length) c.boost(c.self, 2 * ts.length); } };
B['涎魔'] = { deathwish: noop };
B['煮婆'] = {
  order: c => consumeT(c, '煮婆：吞噬', c.allies().filter(u => u !== c.self)),
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit !== c.self && (d.def.tags || []).includes('老巫妪'), run: c => { c.self.bonusCharges++; } }],
};
B['煮婆：仪式'] = { deathwish: noop };
B['狄拉夫·艾瑞廷'] = HZ2('血月', 2, {
  order: c => { const t = T(c, '狄拉夫：1 伤害', c.enemies().filter(u => u.status.bleed > 0)); if (t) c.damage(t, 1); },
  deathblow: c => c.g.spawn(BAT, c.side, c.self.row, posRight(c), c.self),
});
B['狄拉夫：高阶吸血鬼'] = { deathwish: noop };
B['狼人头领'] = { deployRow: {
  m: c => { const t = T(c, '狼人头领：野兽', c.allies().filter(u => has(u, '野兽'))); void t; },   // 增益量 = 手牌数：靠改战力
  r: c => c.allies().filter(u => has(u, '野兽')).forEach(u => c.boost(u, 1)),
} };
B['猩红夫人'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.feast(), run: c => {
  const row = c.g.rowOf(c.self); c.g.spawn('格尼阔拉的果实', c.side, c.self.row, row.indexOf(c.self), c.self);
  c.g.spawn('格尼阔拉的果实', c.side, c.self.row, c.g.rowOf(c.self).indexOf(c.self) + 1, c.self);
  c.transform(c.self, '格尼阔拉', { keepPower: true });
} }] };
function catman(c) { c.g.s.sides[c.foe].rows[c.self.row].slice().forEach(u => c.damage(u, 1)); }
B['猫人'] = { deploy: catman, deathwish: catman };
B['玛姆纳'] = { order: c => { const n = graveUnit(c, '玛姆纳：放逐的墓场铜色单位'); if (!n) return; const gr = c.g.s.sides[c.side].grave, i = gr.indexOf(n); if (i >= 0) { gr.splice(i, 1); c.g.s.sides[c.side].banished.push(n); } c.boost(c.self, c.g.def(n).base || 0); } };   // 召唤/打出同名牌：靠记录
B['瘟疫妖女'] = {
  deploy: c => { const r = T(c, '瘟疫妖女：摧毁的老鼠', c.g.units().filter(u => u.name === RAT)); if (r) c.destroy(r); const t = T(c, '瘟疫妖女：中毒', c.enemies()); if (t) c.status(t, 'poison'); },
  deathwish: c => { for (let i = 0; i < 7; i++) c.g.spawn(RAT, c.side, c.self.row, null, c.self); },
};
B['盖尔'] = { deploy: c => { const n = fromDeck(c, '盖尔：从牌组打出的狂猎牌'); if (n) c.playFromDeck(n, c.self.row, posRight(c)); } };
B['科斯切伊'] = { abilities: [{ on: 'growth', when: (c, d) => d.unit === c.self, run: c => c.g.spawn(DRONE, c.side, c.self.row, posRight(c), c.self) }] };
B['米卢娜'] = { deathwish: c => { const t = R(c, '米卢娜：随机抓捕', c.enemies().filter(u => u.power <= 4)); if (t) c.seize(t); } };
B['约顿'] = { deploy: noop };
B['织婆'] = { deploy: c => { const t = T(c, '织婆：增益', c.allies().filter(u => u !== c.self)); if (t) c.boost(t, 2 + 2 * ((c.g.s.sides[c.side].vars.played || {})['老巫妪'] || 0)); } };
B['织婆：咒文'] = {
  order: c => consumeT(c, '咒文：吞噬', c.allies().filter(u => u !== c.self)),
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && c.self.row === 'r' && d.unit.def.deathwish, run: (c, d) => c.deathwishOf(d.unit) }],
};
B['维尔金的女巨魔'] = { abilities: [{ on: 'destroyed', when: (c, d) => c.g.s.active === c.side && c.self.row === 'm' && d.unit !== c.self, run: c => c.boost(c.self, 2) }] };
B['老矛头'] = {};
B['老矛头：昏睡'] = { timer: { n: 3, run: noop } };   // 召唤老矛头：靠记录
B['艾瑞汀‧布里克‧葛拉斯'] = HZ2('霜', 2, {});
B['莫伍德'] = {};
B['莫恩塔特'] = { deploy: c => { const gr = c.g.s.sides[c.side].grave; const us = gr.filter(n => c.g.def(n).type === 'unit'); c.g.s.sides[c.side].grave = gr.filter(n => c.g.def(n).type !== 'unit'); c.g.s.sides[c.side].banished.push(...us); if (us.length) c.boost(c.self, us.length); } };
B['薇瑞娜'] = { deploy: c => { const t = T(c, '薇瑞娜：重伤 4', c.enemies()); if (t) c.status(t, 'bleed', 4); } };   // “重伤的敌军无法获得增益”：ASSUME 未实现
B['蜜蜂幽灵'] = {
  order: c => { if (c.self.row !== 'm') return; const t = T(c, '蜜蜂幽灵：3 伤害', c.enemies()); if (t) c.damage(t, 3); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.orderUsed === 0, run: c => c.boost(c.self, 1) }],
};
B['蟹蜘蛛女王'] = {
  deploy: c => { const t = consumeT(c, '蟹蜘蛛女王：吞噬', c.allies().filter(u => u !== c.self)); if (t) c.self.vars.eaten = t.name; },
  order: c => c.spawnPlay('蟹蜘蛛巢穴'),
  deathwish: c => { if (c.self.vars.eaten) c.g.spawn(c.self.vars.eaten, c.side, c.self.row, null, c.self); },
};
B['蟹蜘蛛巨兽'] = { deploy: c => { c.g.spawn(DRONE, c.side, c.self.row, posRight(c), c.self); c.g.spawn(DRONE, c.side, c.self.row, posRight(c), c.self);
  c.g.rowOf(c.self).filter(u => u !== c.self && has(u, '类虫生物')).forEach(u => c.boost(u, 1)); } };
B['蟾蜍王子'] = { deployRow: { m: c => consumeT(c, '蟾蜍王子：吞噬', c.g.units().filter(u => u !== c.self && u.power <= 4)) } };
B['裂流之主'] = { deployRow: { m: c => { const t = highestOf(c, c.enemies(), '裂流之主：最高敌军并列'); if (t) c.clash(t); } } };
B['装甲蟹蜘蛛'] = {
  deploy: c => { if (c.g.rowOf(c.self).length > 1) c.lock(c.self); },
  timer: { n: 3, run: c => { if (c.g.rowOf(c.self).length >= (c.g.rules.rowLimit === Infinity ? 9 : c.g.rules.rowLimit)) c.boost(c.self, 12); } },
};
B['达冈：应许者'] = {
  order: c => consumeT(c, '达冈：吞噬', c.allies().filter(u => u !== c.self)),
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && d.unit.def.deathwish, run: (c, d) => c.boost(d.unit, 1) }],
};
B['长者图戈'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => {
  const us = c.allies(); if (!us.length) return; const m = Math.min(...us.map(u => u.power)); const low = us.filter(u => u.power === m);
  if (c.might()) low.forEach(u => c.boost(u, 1)); else { const t = low.length > 1 ? R(c, '图戈：最低并列', low) : low[0]; if (t) c.boost(t, 1); }
} }] };
B['阿巴亚'] = { deploy: c => { const t = T(c, '阿巴亚：触发遗愿', c.allies().filter(u => u !== c.self && u.def.deathwish)); if (t) c.deathwishOf(t); } };
B['雅加婆婆'] = {
  deploy: c => { if (c.feast()) c.self.zeal = true; },
  order: c => { const lim = 4 + (c.self.vars.up || 0); const t = consumeT(c, '雅加婆婆：吞噬', c.g.units().filter(u => u !== c.self && (u.def.prov || 0) === lim)); if (t) c.self.vars.up = (c.self.vars.up || 0) + 1; },
};
B['雅妲：诅咒恶兽'] = { order: c => {
  const t = T(c, '雅妲：吞噬的衍生物', c.g.units().filter(u => u !== c.self && has(u, '衍生物') && u.power < c.self.power)); if (!t) return;
  const p = t.power, ally = t.side === c.side; c.consume(t); if (ally) c.boost(c.self, p);
} };
B['雷吉斯：重生'] = { deploy: c => { const t = T(c, '雷吉斯：汲食 3', c.enemies()); if (t) c.drain(t, 3); } };
B['鼠人'] = {
  order: c => { const n = Math.max(0, c.self.power - c.self.base); for (let i = 0; i < n; i++) { c.g.spawn(RAT, c.side, c.self.row, posRight(c), c.self); c.self.power--; } },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { const r = rightOf(c); if (r) c.consume(r); } }],
};
B['齐齐摩女王'] = { abilities: [
  { on: 'growth', when: (c, d) => d.unit === c.self, run: c => c.g.rowOf(c.self).filter(u => u !== c.self && has(u, '类虫生物')).forEach(u => c.boost(u, 1)) },
  { on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit !== c.self && (d.def.tags || []).includes('生物'), run: c => { c.boost(c.self, 1); c.g.emit('growth', { unit: c.self }); } },
] };

// 铜色单位
B['低阶女巫'] = { deploy: c => { if (c.g.cohort(c.self)) c.g.spawn('低阶女巫', c.side, c.self.row, posRight(c), c.self); else c.g.s.sides[c.side].grave.push('低阶女巫'); } };
B['冰巨魔'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.might(), run: c => c.boost(c.self, 1) }] };
B['叉尾龙'] = { deploy: c => c.g.units().filter(u => u !== c.self).forEach(u => c.damage(u, 1)) };
B['受诅咒的少女'] = { order: c => { const half = Math.floor(c.self.power / 2); c.self.power -= half; c.g.log('战力减半', { name: c.self.name, n: half });
  const t = T(c, '受诅咒的少女：摧毁', c.enemies().filter(u => u.power <= half)); if (t) c.destroy(t); } };
B['吸血鬼女'] = {
  deploy: c => { const t = T(c, '吸血鬼女：重伤 3', c.enemies()); if (t) c.status(t, 'bleed', 3); },
  order: c => { const t = T(c, '吸血鬼女：重伤 3', c.enemies()); if (t) c.status(t, 'bleed', 3); },
};
B['夜之妖灵'] = { deploy: c => { c.g.spawn(RAT, c.side, c.self.row, posRight(c), c.self); c.g.spawn(RAT, c.side, c.self.row, posRight(c), c.self); },
  deathwish: c => { c.g.spawn(RAT, c.side, c.self.row, null, c.self); c.g.spawn(RAT, c.side, c.self.row, null, c.self); } };
B['夜行吸血鬼'] = {
  order: c => { if (c.self.row !== 'm') return; const t = T(c, '夜行吸血鬼：重伤 2', c.enemies()); if (t) c.status(t, 'bleed', 2); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit !== c.self && (d.def.tags || []).includes('吸血鬼'), run: c => c.reduceCd(c.self, 1) }],
};
B['奇美拉'] = { deploy: c => consumeT(c, '奇美拉：吞噬', c.allies().filter(u => u !== c.self)) };
B['女夜魔'] = { deathwish: noop };
B['女巫学徒'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.feast(), run: c => c.boost(c.self, 2) }] };
B['女海妖'] = { order: c => consumeT(c, '女海妖：吞噬', c.allies().filter(u => u !== c.self)), deathwish: c => (c.self.adjBefore || []).filter(u => c.g.find(u.uid)).forEach(u => c.boost(u, 2)) };
B['孽鬼'] = { deploy: c => c.g.spawn('孽鬼', c.side, c.self.row, posRight(c), c.self) };
B['孽鬼战士'] = { deploy: c => {
  const before = c.g.trace.length; void before;
  // ASSUME：打出这张时己方没有成长单位被触发（己方没有战力比它低的成长单位）→ 自伤 3 并获得成长
  if (!c.allies().some(u => u !== c.self && u.def.growth && u.power < c.self.power)) { c.damage(c.self, 3); c.infuse(c.self, { name: '成长', on: 'unitPlayed', when: (cc, e) => (e.by || e.unit.side) === cc.side && e.unit !== cc.self && e.unit.power > cc.self.power, run: cc => cc.boost(cc.self, 1) }); }
} };
B['守桥巨魔'] = { deathwish: c => { const t = lowestOf(c, c.allies(), '守桥巨魔：最低友军并列'); if (t) c.boost(t, 4); } };
B['安德莱格幼虫'] = { deploy: c => c.g.spawn('安德莱格幼虫', c.side, c.self.row, posRight(c), c.self) };
B['安德莱格战士'] = { deploy: c => c.adjacent().slice().forEach(u => { const bug = has(u, '类虫生物'); c.consume(u); if (bug) c.self.bonusCharges++; }),
  order: c => c.g.spawn(DRONE, c.side, c.self.row, posRight(c), c.self) };
B['安德莱格虫卵'] = { deathwish: c => { for (let i = 0; i < 3; i++) c.g.spawn(DRONE, c.side, c.self.row, null, c.self); } };
B['小雾妖'] = HZ2('雾', 3, { deathwish: noop });
B['尖啸女妖'] = { deploy: c => { const t = T(c, '尖啸女妖：重伤 2', c.enemies()); if (t) c.status(t, 'bleed', 2); } };
B['巨型蟾蜍'] = { deploy: c => consumeT(c, '巨型蟾蜍：吞噬', c.allies().filter(u => u !== c.self)) };
B['巨棘魔树'] = { deathwish: noop };
B['幽冥犬'] = { deploy: c => consumeT(c, '幽冥犬：吞噬', c.allies().filter(u => u !== c.self)),
  order: c => { if (c.dominance()) consumeT(c, '幽冥犬：吞噬', c.allies().filter(u => u !== c.self)); } };
B['愤怒的独眼巨人'] = { timer: { n: 7, run: c => c.setPower(c.self, 10) } };   // 手牌里食人魔减少计时：靠改战力
B['无骨者'] = { deploy: c => { const t = T(c, '无骨者：触发遗愿', c.allies().filter(u => u !== c.self && bronze(u) && u.def.deathwish)); if (t) c.deathwishOf(t); } };
B['日间妖灵'] = { deathwish: c => { c.g.spawn(RAT, c.foe, 'm', null, c.self); c.g.spawn(RAT, c.foe, 'm', null, c.self); } };
B['杂交兽'] = { deployRow: {
  m: c => { if (c.g.s.lastDestroyTurn === c.g.s.turn) c.boost(c.self, 5); },
  r: c => consumeT(c, '杂交兽：吞噬', c.allies().filter(u => u !== c.self)),
} };
B['果园陷阱'] = { deployRow: {
  m: c => consumeT(c, '果园陷阱：吞噬', c.allies().filter(u => u !== c.self)),
  r: c => c.g.choose({ prompt: '果园陷阱：灌注成长的 2 个友军', from: c.targets(c.allies().filter(u => u !== c.self)), n: 2, upTo: true, source: c.self.name })
    .forEach(t => c.infuse(t, { name: '成长', on: 'unitPlayed', when: (cc, e) => (e.by || e.unit.side) === cc.side && e.unit !== cc.self && e.unit.power > cc.self.power, run: cc => cc.boost(cc.self, 1) })),
} };
B['梦魔'] = { deploy: noop };   // 双方墓场召唤：靠记录
B['水鬼'] = { deploy: c => { const t = T(c, '水鬼：移排', c.enemies()); if (t) { c.move(t, otherRow(t.row)); c.damage(t, 2); } } };
B['沙漠女妖'] = { order: c => consumeT(c, '沙漠女妖：吞噬', c.allies().filter(u => u !== c.self)),
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && d.unit.def.deathwish, run: c => c.boost(c.self, 1) }] };
B['渴血鸟怪'] = { deploy: c => { const t = T(c, '渴血鸟怪：重伤', c.enemies()); if (t) c.status(t, 'bleed', c.g.cohort(c.self) ? t.base : 2); } };
B['狂猎之犬'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.dominance(), run: c => c.boost(c.self, 1) }] };
B['狂猎导航员'] = { deploy: c => { const t = T(c, '导航员：增益', c.allies().filter(u => u !== c.self)); if (!t) return; const n = c.dominance() ? frostTurnsOn(c, c.foe) : ((c.frost(c.foe, t.row) || {}).turns || 0); if (n) c.boost(t, n); } };
B['狂猎战士'] = { deploy: c => { const t = T(c, '狂猎战士：2 伤害', c.enemies()); if (t) c.damage(t, 2); } };   // 统御时的霜：用“整排效果”记
B['狂猎碾压者'] = { deploy: c => { const t = T(c, '碾压者：移排', c.enemies()); if (!t) return; c.move(t, otherRow(t.row)); if (c.frost(t.side, t.row)) c.damage(t, 2); } };
B['狂猎骑士'] = {};
B['独眼巨人'] = { deploy: c => { const a = T(c, '独眼巨人：摧毁相邻友军', c.adjacent()); if (!a) return; const p = a.power; c.destroy(a); const t = T(c, '独眼巨人：伤害', c.enemies()); if (t) c.damage(t, p); } };
B['狮鹫'] = { deploy: c => { const others = c.g.rowOf(c.self).filter(u => u !== c.self); if (!others.length) { c.destroy(c.self); return; } const t = T(c, '狮鹫：摧毁同排友军', others); if (t) c.destroy(t); } };
B['狼人'] = { deploy: c => { const t = T(c, '狼人：掠食', c.enemies().filter(u => u.power < c.self.power)); if (t) c.boost(c.self, t.power); } };
B['甘·赛恩'] = { deploy: c => { const n = c.adjacent().filter(u => has(u, '残物')).length; if (n) c.g.strengthen(c.self, 2 * n, c.self); } };
B['石化鸡蛇'] = { deploy: c => { const n = c.adjacent().filter(u => has(u, '野兽')).length; if (n) c.boost(c.self, 2 * n); const t = T(c, '石化鸡蛇：中毒', c.enemies().filter(u => u.power < c.self.power)); if (t) c.status(t, 'poison'); } };
B['纳吉尔法工头'] = { deploy: c => { const t = T(c, '工头：净化', c.dominance() ? c.g.units().filter(u => u !== c.self) : c.enemies()); if (t) c.purify(t); } };
B['纳吉尔法船员'] = HZ2('霜', 2, { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.frost(c.foe, c.self.row), run: c => c.boost(c.self, 1) }] });
B['翼手龙'] = { deployRow: { r: c => { const t = T(c, '翼手龙：2 伤害', c.enemies()); if (t) c.damage(t, 2); } } };
B['腐食魔'] = { deathwish: c => { const t = R(c, '腐食魔：随机 5 伤害', c.enemies()); if (t) c.damage(t, 5); } };
B['艾恩·艾尔奴隶商'] = { deploy: c => {
  const n = frostTurnsOn(c, c.foe); if (n) c.status(c.self, 'vitality', n);
  const t = T(c, '奴隶商：灌注', c.enemies()); const me = c.self;
  if (t) c.infuse(t, { name: '奴隶商', on: 'turnEnd', when: (cc, d) => d.side === cc.side && cc.g.find(me.uid) && me.power > cc.self.power, run: cc => { cc.g.setPower(cc.self, 1, me); cc.g.lock(cc.self, me); } });
} };
B['艾恩·艾尔征服者'] = { deploy: c => { if (!c.devotion()) c.destroy(c.self); } };
B['艾恩·艾尔贵族'] = { order: c => { if (!c.dominance()) return; const t = T(c, '贵族：移排', c.enemies()); if (t) c.move(t, otherRow(t.row)); } };
B['蜥蜴人战士'] = { abilities: [{ on: 'destroyed', when: (c, d) => c.g.s.active === c.side && d.unit !== c.self, run: c => c.boost(c.self, 1) }] };
B['蝠翼脑魔'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.enemies().some(u => u.status.bleed > 0), run: c => c.boost(c.self, 1) }] };
B['蝠翼魔'] = { abilities: [{ on: 'statusGained', when: (c, d) => d.key === 'bleed' && d.unit.side === c.foe && c.self.vars.cnt !== c.g.s.turn, run: (c, d) => { c.self.vars.cnt = c.g.s.turn; c.boost(c.self, d.val); } }] };
B['赛尔伊诺鹰身女妖'] = { deploy: c => { consumeT(c, '鹰身女妖：吞噬', c.allies().filter(u => u !== c.self)); if (c.g.cohort(c.self)) c.g.spawn('鹰身女妖蛋', c.side, c.self.row, posRight(c), c.self); } };
B['远古小雾妖'] = { deploy: c => { const n = ['m', 'r'].reduce((a, r) => a + ((c.g.s.hazards[c.foe][r] || {}).turns || 0), 0); if (n && n !== Infinity) c.boost(c.self, n); } };
B['须岩怪'] = { order: c => consumeT(c, '须岩怪：吞噬', c.allies().filter(u => u !== c.self)) };
B['飞蜥'] = { order: c => consumeT(c, '飞蜥：吞噬同排友军', c.g.rowOf(c.self).filter(u => u !== c.self)) };
B['食人魔战士'] = { deploy: c => { const n = c.allies().filter(u => u !== c.self && u.power >= 10).length; if (n) c.boost(c.self, 2 * n); } };
B['食尸鬼'] = { deployRow: { m: c => { const n = graveUnit(c, '食尸鬼：吞噬的墓场铜色单位'); if (!n) return; const gr = c.g.s.sides[c.side].grave, i = gr.indexOf(n); if (i >= 0) { gr.splice(i, 1); c.g.s.sides[c.side].banished.push(n); } c.boost(c.self, c.g.def(n).base || 0); } } };
B['食己徒'] = {
  order: c => { const b = Math.floor(c.self.base / 2); c.self.base = b; c.self.power = Math.min(c.self.power, b); const u = c.g.spawn('食己徒', c.side, c.self.row, posRight(c), c.self); if (u) { u.base = b; u.power = b; } },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '残物'), run: c => c.g.strengthen(c.self, 1, c.self) }],
};
B['鹰身女妖蛋'] = { deathwish: c => c.g.spawn('鹰身女妖', c.side, c.self.row, null, c.self) };
B['鹿首魔'] = { deploy: c => { const n = c.g.s.sides[c.foe].rows[c.self.row].length; if (n) { c.self.base = Math.max(0, c.self.base - n); c.self.power = Math.max(0, c.self.power - n); c.g.log('基础战力降低', { name: c.self.name, n }); } } };
B['齐齐摩工兵'] = {
  abilities: [
    { on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '类虫生物'), run: c => c.armor(c.self, 1) },
    { on: 'armorBroken', when: (c, d) => d.unit === c.self, run: c => c.destroy(c.self) },
  ],
};
B['齐齐摩幼虫'] = {
  order: c => { if (c.self.power > c.self.base) { c.self.power--; } c.g.spawn(DRONE, c.side, c.self.row, posRight(c), c.self); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit !== c.self && (d.def.tags || []).includes('生物'), run: c => c.boost(c.self, 1) }],
};
B['齐齐摩追猎者'] = {
  order: c => {
    const t = T(c, '追猎者：伤害敌军或吞噬雄蛛', c.g.units().filter(u => u.power < c.self.power && (u.side === c.foe || u.name === DRONE)));
    if (!t) return; if (t.side === c.side) c.consume(t); else c.damage(t, 1);
  },
  abilities: [{ on: 'unitSpawned', when: (c, d) => d.unit.side === c.side && has(d.unit, '类虫生物') && c.self.vars.sp !== c.g.trace.length, run: c => { c.self.vars.sp = c.g.trace.length; c.self.bonusCharges++; } }],
};


// ================= 尼弗迦德 · 批量补全 =================
const statusN = u => Object.entries(u.status).filter(([k, v]) => v && k !== 'immune').length + (u.infused.length ? 1 : 0);
const hasStatus = u => statusN(u) > 0;
const conspire = (c, t) => !!(t && t.status.spying);
const runTurnEnd = (c, u) => (u.def.abilities || []).filter(a => a.on === 'turnEnd').forEach(a => { if (!a.when || a.when(c.g.ctx(u), { side: u.side })) a.run(c.g.ctx(u), { side: u.side }); });
const boostEnemy = (c, t, n) => { c.boost(t, n); c.g.s.sides[c.side].vars.lastEnemyBoost = n; };

// 领袖
B['怀柔兼济'] = { order: (c, o) => { const n = fromDeck(c, '怀柔兼济：创造并打出'); if (n) c.spawnPlay(n, (o && o.row) || 'm', o && o.pos); } };
B['奴役蛮夷'] = { order: c => { const t = T(c, '奴役蛮夷：抓捕', c.enemies().filter(u => u.power <= 3 + (c.self.vars.extra || 0))); if (t) c.seize(t); } };   // 谋略数加成：靠落地
B['帝国列阵'] = { charges: 4, order: c => {
  const ts = c.g.choose({ prompt: '帝国列阵：2 个友军', from: c.targets(c.allies()), n: 2, source: c.self.name }); ts.forEach(u => c.boost(u, 1));
  if (ts.length === 2) c.swap(ts[0], ts[1]); ts.filter(u => has(u, '士兵')).forEach(u => c.armor(u, 1));
} };
B['偷梁换柱'] = { order: c => {
  const t = T(c, '偷梁换柱：锁定', c.enemies()); if (!t) return; c.lock(t);
  const n = c.g.rowOf(t).filter(hasStatus).length; const u = c.g.spawn(t.name, c.side, t.row, null, c.self); if (u && n) c.boost(u, n);
} };
B['牢狱之灾'] = { charges: 2, order: c => { const t = T(c, '牢狱之灾：锁定并 3 伤害', c.enemies()); if (t) { c.lock(t); c.damage(t, 3); } } };
B['奴隶'] = { order: c => { const t = T(c, '奴隶：锁定并 3 伤害', c.enemies()); if (t) { c.lock(t); c.damage(t, 3); } } };
B['战术决策'] = { order: (c, o) => c.spawnPlay('莫尔凡·符里斯', (o && o.row) || 'm', o && o.pos) };
B['陶森特式好客'] = { order: c => c.spawnPlay('比武大赛') };

// 神器
B['日轮之师'] = { order: c => { const t = T(c, '日轮之师：潜伏或重伤（按检视到的牌）', c.enemies()); void t; } };   // 取决于牌组顶端：用改战力/状态修正
B['巴卡拉'] = {
  deploy: c => { const row = c.g.rowOf(c.self); c.g.spawn('帝国舰队', c.side, c.self.row, row.indexOf(c.self), c.self); c.g.spawn('帝国海军士兵', c.side, c.self.row, c.g.rowOf(c.self).indexOf(c.self) + 1, c.self); },
  order: c => { const ts = c.g.choose({ prompt: '巴卡拉：2 个友军', from: c.targets(c.allies()), n: 2, source: c.self.name }); ts.forEach(u => c.boost(u, 2)); if (ts.length === 2) c.swap(ts[0], ts[1]); },
};
B['鲍克兰'] = {
  deploy: c => { const t = T(c, '鲍克兰：设为敌军最高战力', c.allies()); const m = Math.max(0, ...c.enemies().map(u => u.power)); if (t) c.setPower(t, m); },
  order: c => { const t = T(c, '鲍克兰：重置', c.g.units()); if (t) c.reset(t); },
};
B['格斯维德'] = { deploy: c => { const n = fromDeck(c, '格斯维德：生成并打出的毒蛇学派'); if (n) c.spawnPlay(n, c.self.row, posRight(c)); }, order: noop };
B['假面舞会'] = {
  deploy: c => { c.self.chapter = 0; c.g.spawn('口渴的夫人', c.side, c.self.row, posRight(c), c.self); },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit.side === c.side && d.unit !== c.self && has(d.unit, '望族') && c.self.chapter < 2, run: c => {
    c.self.chapter++; c.g.log('剧情推进', { name: c.self.name, chapter: c.self.chapter }); c.spawnPlay('帝国毒牙', c.self.row, posRight(c));
  } }],
};
B['永夜之蚀'] = {
  deploy: c => { c.self.chapter = 0; c.g.spawn('永夜之蚀教徒', c.side, c.self.row, posRight(c), c.self); },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '呓语') && d.unit.def.color === '金' && c.self.chapter < 2, run: c => {
    c.self.chapter++; c.g.log('剧情推进', { name: c.self.name, chapter: c.self.chapter }); if (c.self.chapter === 2) c.spawnPlay('永夜之蚀助祭', c.self.row, posRight(c));
  } }],
};
B['军事会议'] = { deploy: c => { const n = fromDeck(c, '军事会议：打出的牌'); if (n) c.playFromDeck(n, c.self.row, posRight(c)); }, order: c => c.spawnPlay('战前准备') };

// 特殊牌
B['绑架'] = { onPlay: (c, o) => { const n = fromDeck(c, '绑架：从对方牌组打出的单位'); if (!n) return; const u = c.g.play(c.side, n, (o && o.row) || 'm', o && o.pos, { fromDeck: true, player: c.side, keepSide: true }); if (u) c.boost(u, Math.max(0, 10 - (u.def.prov || 0))); } };
B['集结站！'] = { onPlay: noop };   // 从手牌打出：靠记录
B['买通'] = { onPlay: (c, o) => { const n = fromDeck(c, '买通：创造并打出的对方单位'); if (n) c.spawnPlay(n, (o && o.row) || 'm', o && o.pos); } };
B['扼喉者之毒'] = { onPlay: c => { const t = T(c, '扼喉者之毒：中毒', c.enemies()); if (!t) return; const n = t.name, row = t.row; c.status(t, 'poison'); c.g.spawn(n, c.side, row, null, c); } };
B['致命一击'] = { onPlay: c => { const t = T(c, '致命一击：3 伤害', c.enemies()); if (!t) return; const n = t.name, row = t.row, sp = conspire(c, t); c.damage(t, 3); if (sp || !c.g.find(t.uid)) c.spawnPlay(n, row); } };
B['达兹伯格符文石'] = { onPlay: (c, o) => { const n = fromDeck(c, '达兹伯格符文石：创造并打出'); if (n) c.spawnPlay(n, o && o.row, o && o.pos); } };
B['亡者之舌'] = { onPlay: c => { const t = T(c, '亡者之舌：增益', c.allies()); void t; } };   // 增益量 = 放逐牌的人口：靠改战力
B['通敌'] = { onPlay: c => { const t = T(c, '通敌：潜伏', c.enemies()); if (!t) return; c.status(t, 'spying', true); const p = t.power; c.adjacent(t).forEach(u => c.damage(u, p)); } };
B['叶奈法的符咒'] = { onPlay: c => { const t = T(c, '叶奈法的符咒：移到牌组顶端', c.enemies()); if (t) { const row = c.g.rowOf(t); row.splice(row.indexOf(t), 1); c.g.s.sides[c.side].deck.unshift(t.name); c.g.log('移到牌组', { name: t.name }); } } };
B['大赦'] = { onPlay: c => { const t = T(c, '大赦：抓捕', c.enemies().filter(u => u.power <= 3)); if (!t) return; const sp = conspire(c, t) || c.devotion(); c.seize(t); if (sp) c.boost(t, 2); } };
B['暗袭'] = { onPlay: c => { const t = T(c, '暗袭：目标', c.g.units()); if (t) c.damage(t, Math.max(0, 6 - c.adjacent(t).filter(u => !u.status.spying).length)); } };
B['战前准备'] = { onPlay: c => { const t = T(c, '战前准备：友军', c.allies()); if (!t) return; c.boost(t, has(t, '士兵') ? 6 : 4); c.armor(t, 2); } };
B['比武大赛'] = { onPlay: c => { const e = T(c, '比武大赛：敌军 +3', c.enemies()); if (e) boostEnemy(c, e, 3); const a = T(c, '比武大赛：友军 +9', c.allies()); if (a) c.boost(a, 9); } };
B['涂毒武器'] = { onPlay: c => { const t = T(c, '涂毒武器：5 伤害', c.enemies()); if (t) c.damage(t, 5); } };
B['实验药品'] = { onPlay: (c, o) => { const n = fromDeck(c, '实验药品：对方墓场的铜色单位'); if (!n) return; const gr = c.g.s.sides[c.foe].grave, i = gr.indexOf(n); if (i >= 0) gr.splice(i, 1); c.g.play(c.side, n, (o && o.row) || 'm', o && o.pos, { player: c.side, keepSide: true, fromDeck: true }); } };
B['帝国外交'] = { onPlay: (c, o) => { const n = fromDeck(c, '帝国外交：创造并打出'); if (n) c.spawnPlay(n, (o && o.row) || 'm', o && o.pos); } };
B['黑曜石镜'] = { onPlay: c => c.g.choose({ prompt: '黑曜石镜：3 个敌军铜色单位', from: c.targets(c.enemies().filter(bronze)), n: 3, upTo: true, source: '黑曜石镜' })
  .forEach(t => { const u = c.g.spawn(t.name, c.side, t.row, null, c); if (u) { u.power = 1; } }) };
B['油膏'] = { onPlay: c => { const t = T(c, '油膏：5 增益', c.allies()); if (!t) return; c.boost(t, 5); if (bronze(t) && has(t, '士兵')) runTurnEnd(c, t); } };
B['马战'] = { onPlay: c => { const t = T(c, '马战：目标', c.g.units()); if (!t) return;
  if (t.side === c.side) { c.status(t, 'shield', true); c.boost(t, 4); } else { t.status.shield = false; c.damage(t, 4); } } };

// 金色单位
B['海军上将隆帕力'] = {
  order: c => { const ts = c.g.choose({ prompt: '隆帕力：锁定、中毒、潜伏的 3 个敌军', from: c.targets(c.enemies()), n: 3, upTo: true, source: c.self.name });
    if (ts[0]) c.lock(ts[0]); if (ts[1]) c.status(ts[1], 'poison'); if (ts[2]) c.status(ts[2], 'spying', true); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { const n = Math.max(0, ...c.enemies().map(statusN)); if (n) c.boost(c.self, n); } }],
};
B['亚凡·希尔格兰'] = { order: c => c.allies().filter(u => has(u, '士兵') && u.armor > 0).forEach(u => c.boost(u, 1)) };
B['亚伯力奇'] = {};
B['安娜·亨利叶塔'] = { deployRow: { r: noop } };
B['阿达尔·爱普·达西'] = { deployRow: { r: c => { const t = T(c, '阿达尔：送回对方手牌', c.enemies().filter(u => u.power <= 2 && !c.g.isDoomed(u))); if (t) { const row = c.g.rowOf(t); row.splice(row.indexOf(t), 1); c.g.log('回到手牌', { name: t.name }); } } } };
B['阿尔托·特拉诺瓦'] = { deploy: noop };
B['亚托列司·薇歌'] = { deploy: c => { const n = fromDeck(c, '亚托列司：创造并打出的 1 战力铜色单位'); if (!n) return; const u = c.spawnPlay(n, c.self.row, posRight(c)); if (u) c.setPower(u, 1); } };
B['艾希蕾·阿纳兴'] = { deploy: noop };
B['奥克斯'] = { deploy: c => { const t = T(c, '奥克斯：锁定', c.enemies()); if (t) c.lock(t); } };   // 手牌里有瑟瑞特时锁定所有同名：用记录
B['布拉森斯'] = { deploy: c => { const n = fromDeck(c, '布拉森斯：创造并打出的不忠单位'); if (n) c.spawnPlay(n, c.self.row); } };
B['卡西尔·迪弗林'] = { abilities: [{ on: 'boosted', when: (c, d) => d.unit.side === c.foe && c.g.s.active === c.side && c.self.row === 'm', run: (c, d) => c.boost(c.self, d.n) }] };
B['坎塔蕾拉'] = { deploy: c => { const n = fromDeck(c, '坎塔蕾拉：打出对方牌组顶端的牌'); if (n) { const pl = c.self.owner || c.foe; c.g.play(pl, n, 'm', null, { fromDeck: true, player: pl, keepSide: true }); } } };
B['契拉克·迪弗林'] = { deploy: c => c.g.rowOf(c.self).filter(u => u !== c.self).forEach(u => c.purify(u)) };
B['辛西亚'] = { deployRow: { m: noop } };
B['戴米恩·图尔'] = { order: c => { if (c.self.row !== 'm') return; const h = c.leader(); if (h) { h.charges = h.def.charges != null ? h.def.charges : 1; c.g.log('重置领袖', { name: h.name }); } } };
B['恩希尔·恩瑞斯'] = {
  deploy: noop,
  abilities: [
    { on: 'unitPlayed', when: (c, d) => foePlays(c, d), run: (c, d) => c.status(d.unit, 'spying', true) },
    { on: 'turnEnd', when: (c, d) => d.side === c.side && c.devotion(), run: c => { c.self.orderUsed = 0; } },
  ],
  order: c => { const t = T(c, '恩希尔：抓捕', c.enemies().filter(u => u.power === 1 && u.status.spying)); if (t) c.seize(t); },
};
B['冒牌希里'] = {
  deploy: c => { const n = fromDeck(c, '冒牌希里：从墓场打出的谋略'); if (n) c.g.play(c.self.owner || c.foe, n, c.self.row, null, { fromGrave: true, keepSide: true }); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => c.boost(c.self, 1) }],
  bless: [{ at: 8, run: c => { const to = c.foe; const row = c.g.rowOf(c.self); row.splice(row.indexOf(c.self), 1); c.g._place(c.self, to, c.self.row, null); c.purify(c.self); c.g.log('移到对面', { name: c.self.name }); } }],
};
B['费卡特'] = { deploy: noop, abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.special, run: c => { const t = R(c, '费卡特：随机潜伏', c.enemies().filter(u => !u.status.spying)); if (t) c.status(t, 'spying', true); } }] };
B['佛古斯·瓦·恩瑞斯'] = { deploy: c => c.g.choose({ prompt: '佛古斯：潜伏', from: c.targets(c.enemies()), n: c.devotion() ? 3 : 1, upTo: true, source: c.self.name }).forEach(u => c.status(u, 'spying', true)) };
B['费恩·瓦·盖内尔'] = { deploy: c => c.spawnPlay('战前准备') };
B['芙琳吉拉·薇歌'] = { deploy: c => { const n = 1 + c.adjacent().filter(u => has(u, '法师') || has(u, '构造体')).length;
  c.g.choose({ prompt: '芙琳吉拉：' + n + ' 个敌军各 2', from: c.targets(c.enemies()), n, upTo: true, source: c.self.name }).forEach(u => c.damage(u, 2)); } };
B['格莱尼丝·爱普·洛纳克'] = {};
B['劳恩法尔的吉劳米'] = {
  deploy: c => { const k = c.g.rowOf(c.self).filter(u => u !== c.self && has(u, '骑士')).length; if (k) c.boost(c.self, k);
    const t = T(c, '吉劳米：敌军', c.enemies()); if (!t) return; const h = Math.floor((c.self.power + t.power) / 2); c.boost(c.self, h); boostEnemy(c, t, h); },
  order: c => { if (c.self.power < 14) return; const t = T(c, '吉劳米：转移状态', c.enemies()); if (!t) return; for (const [k, v] of Object.entries(t.status)) if (v && k !== 'immune') { c.self.status[k] = v; t.status[k] = k === 'vitality' || k === 'bleed' || k === 'poison' ? 0 : false; } },
};
B['重弩海尔格'] = {
  order: c => { const t = T(c, '海尔格：2 伤害', c.g.units()); if (t) c.damage(t, 2); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && (d.def.tags || []).includes('谋略'), run: c => { c.self.bonusCharges++; } }],
};
B['亨利·凡·亚特里'] = { deploy: noop };
B['帝国魔像'] = { deploy: noop };   // 按对方牌组顶端单位战力自伤：靠落地战力
B['哈吉的伊斯贝尔'] = { order: noop };
B['伊瓦‧邪眼'] = { deploy: c => { const t = T(c, '伊瓦：交换战力', c.enemies()); if (!t) return; const a = c.self.power, b = t.power; c.setPower(c.self, b); c.setPower(t, a); } };
B['约翰·卡尔维特'] = { deploy: noop };
B['约阿希姆·德·维特'] = { deploy: c => { const n = fromDeck(c, '约阿希姆：打出的己方牌组顶端单位'); if (!n) return; const pl = c.self.owner || c.foe; const u = c.g.play(pl, n, 'm', null, { fromDeck: true, player: pl, keepSide: true }); if (u) c.g.boost(u, 8, c.self); } };
B['寇格林姆'] = {};
B['雷欧·邦纳特'] = { deployRow: {
  m: c => { const t = T(c, '雷欧：摧毁 ≥9', c.enemies().filter(u => u.power >= 9)); if (t) c.destroy(t); },
  r: c => { const t = T(c, '雷欧：摧毁猎魔人', c.enemies().filter(u => has(u, '猎魔人'))); if (t) c.destroy(t); },
} };
B['古雷特的雷索'] = { deploy: noop };   // 取决于手牌：用记录
B['雷索：弑王者'] = { deploy: c => { const t = T(c, '雷索：变成的单位', c.g.units().filter(u => u !== c.self)); if (t) c.transform(c.self, t.name, { keepPower: true }); } };
B['莉迪亚·凡·布雷德沃特'] = { deploy: c => { const n = fromDeck(c, '莉迪亚：打出的对方特殊牌'); if (n) c.spawnPlay(n); } };
B['仪式祭司'] = {};
B['门诺·库霍恩'] = { deployRow: { r: c => { const n = fromDeck(c, '门诺：从牌组打出的谋略'); if (n) c.playFromDeck(n, c.self.row); } } };
B['米尔顿·德·佩拉克-佩兰'] = {
  deploy: c => { const t = T(c, '米尔顿：敌军 +3', c.enemies()); if (t) boostEnemy(c, t, 3); c.boost(c.self, 3); },
  order: c => { const n = c.g.s.sides[c.side].vars.lastEnemyBoost || 0; if (n) c.boost(c.self, n); },
};
B['帕尔梅林·德·郎佛尔'] = { deploy: c => {
  const t = T(c, '帕尔梅林：不带增益的敌军', c.enemies().filter(u => !c.g.isBoosted(u)));
  const n = fromDeck(c, '帕尔梅林：打出的牌组顶端的牌'); if (!n) return; const d = c.g.def(n);
  if (d.type === 'special') c.playFromDeck(n); else c.playFromDeck(n, c.self.row, posRight(c));
  if (t) boostEnemy(c, t, d.prov || 0);
} };
B['彼得·萨尔格温利'] = { deploy: c => { const t = T(c, '彼得：重置', c.g.units().filter(u => u !== c.self)); if (t) c.reset(t); } };
B['菲利普·凡·莫拉汉姆'] = {
  deploy: c => { if (c.allies().some(u => u !== c.self && has(u, '吸血鬼'))) c.self.zeal = true; },
  order: c => { const t = T(c, '菲利普：敌军', c.enemies()); if (!t) return; const k = statusN(t);
    if (k > 1) c.status(t, 'poison'); else if (k === 1) c.lock(t); else c.status(t, 'doomed', true); },
};
B['先知（Prophet）'] = { deploy: c => c.damage(c.self, 2) };
B['亚特里的林法恩'] = { deploy: c => { const n = c.adjacent().reduce((a, u) => a + u.power, 0); const t = T(c, '林法恩：增益的友军', c.allies().filter(u => u !== c.self)); if (t && n) c.boost(t, n); } };
B['拉蒙·蒂尔康奈尔'] = { deploy: c => { const n = fromDeck(c, '拉蒙：手牌里的铜色士兵'); if (!n) return; const u = c.spawnPlay(n, c.self.row, posRight(c)); if (u) c.armor(u, 2); } };
B['里恩斯'] = {
  deploy: c => { const t = T(c, '里恩斯：摧毁的敌军（战力与牌组里那张相同）', c.enemies()); if (t) c.destroy(t); },
  order: c => { const t = T(c, '里恩斯：设为牌组张数', c.g.units()); void t; },   // 牌组张数未知：靠改战力
};
B['唐泰恩的罗德烈克'] = { deploy: c => { const n = fromDeck(c, '罗德烈克：打出的金色牌'); if (!n) return; const pl = c.self.owner || c.foe; c.g.play(pl, n, 'm', null, { fromDeck: true, player: pl, keepSide: true }); } };
B['罗莎·亚特里和埃德娜·亚特里'] = {
  deploy: c => { const n = fromDeck(c, '罗莎和埃德娜：创造的对方铜色单位'); if (!n) return; const u = c.g.spawn(n, c.foe, c.self.row, null, c.self); if (u) c.status(u, 'spying', true); },
  order: c => { const t = T(c, '罗莎和埃德娜：伤害', c.enemies()); void t; },   // 伤害 = 起始牌组望族种类：靠改战力
};
B['巴卡拉的桑铎'] = { deploy: noop, order: noop };
B['瑟瑞特'] = { deploy: c => { const t = T(c, '瑟瑞特：伤害', c.enemies()); if (t) c.damage(t, 2); } };   // 手牌里有奥克斯时 4：用改战力
B['希拉德·费兹奥耶斯泰兰'] = { deploy: noop };
B['史提芬·史凯伦'] = { deploy: noop };   // 生成并打出袖中王牌：按记录
B['袖中王牌'] = { onPlay: c => { const t = T(c, '袖中王牌：2 伤害', c.enemies()); if (t) c.damage(t, 2); } };
B['斯维尔'] = { deployRow: { m: c => { const t = T(c, '斯维尔：抓捕', c.enemies().filter(u => u.power <= 3)); if (t) c.seize(t); } } };
B['卡特利欧纳号'] = {
  order: c => { const t = T(c, '卡特利欧纳号：中毒', c.g.units().filter(u => hasStatus(u) && !u.status.poison)); if (t) c.status(t, 'poison'); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { c.self.bonusCharges++; } }],
};
B['蒂博尔·艾格布拉杰'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => {
  const t = R(c, '蒂博尔：随机灌注', c.enemies()); if (t) c.infuse(t, { name: '蒂博尔', on: 'statusGained', when: (cc, e) => e.unit === cc.self, run: cc => cc.g.damage(cc.self, 1, { name: '蒂博尔' }) });
} }] };
B['托雷斯·恩瑞斯：奠基者'] = { deploy: noop, order: noop };
B['比武会沙尔玛'] = { deployRow: {
  m: c => { const t = T(c, '沙尔玛：7 伤害', c.enemies().filter(u => u.def.fac === 'NG')); if (t) c.damage(t, 7); },
  r: c => { const n = c.allies().filter(u => !neutral(u) && u.def.fac !== 'NG').length; if (n) c.boost(c.self, 2 * n); },
} };
B['特拉席恩·维迪法'] = { deploy: noop };
B['伊伦瓦尔德的乌奇翁'] = {
  order: c => { if (c.self.row === 'm') c.transform(c.self, '多尼'); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { const t = R(c, '乌奇翁：随机友军 +1', c.allies()); if (t) c.boost(t, 1); } }],
};
B['多尼'] = { deploy: c => { const n = c.enemies().filter(u => u.status.spying).length; if (n) c.boost(c.self, n); },
  abilities: [{ on: 'unitEnter', when: (c, d) => d.unit === c.self && !d.played, run: c => { const n = c.enemies().filter(u => u.status.spying).length; if (n) c.boost(c.self, n); } }] };
function usurper(c, rows) { rows.forEach(r => { const u = c.g.spawn('特工', c.foe, r, null, c.self); if (u) c.status(u, 'spying', true); }); }
const seizeOps = c => c.enemies().filter(u => u.name === '特工' && u.status.spying).forEach(u => c.seize(u));
B['篡位者 - 军官'] = { deploy: c => usurper(c, ['m']), order: seizeOps };   // 放哪排按记录
B['篡位者 - 将军'] = { deploy: c => usurper(c, ['m', 'r']), order: seizeOps };
B['莫拉汉姆家斟酒侍者'] = { deployRow: {
  m: c => { const t = T(c, '斟酒侍者：中毒', c.g.units().filter(u => u !== c.self)); if (t) c.status(t, 'poison'); },
  r: c => { const t = T(c, '斟酒侍者：净化', c.g.units().filter(u => u !== c.self)); if (t) c.purify(t); },
} };
B['凡赫玛'] = { deployRow: { r: c => { const t = T(c, '凡赫玛：摧毁被锁定的敌军', c.enemies().filter(u => u.status.lock)); if (t) c.destroy(t); } } };
B['瓦提尔·德·李道克斯'] = { order: c => { const t = T(c, '瓦提尔：锁定/抓捕', c.enemies()); if (!t) return; if (conspire(c, t)) c.seize(t); else c.lock(t); } };
B['威戈佛特兹'] = { deployRow: {
  m: c => { const t = T(c, '威戈佛特兹：摧毁敌军', c.enemies()); if (t) c.destroy(t); },   // 对方召唤：靠记录
  r: c => { const t = T(c, '威戈佛特兹：摧毁友军', c.allies().filter(u => u !== c.self)); if (t) c.destroy(t); },
} };
B['威戈佛特兹：变节法师'] = { deploy: noop };
B['文森特·凡·莫拉汉姆'] = { deploy: c => { const t = T(c, '文森特：摧毁带状态的敌军', c.enemies().filter(hasStatus)); if (t) c.destroy(t); } };
B['薇薇恩·塔布里司'] = { deploy: c => { const t = T(c, '薇薇恩：设为人口', c.g.units().filter(u => u !== c.self)); if (t) c.setPower(t, t.def.prov || 0); } };
B['弗林姆德'] = { deploy: c => { const t = T(c, '弗林姆德：士兵', c.allies().filter(u => u !== c.self && has(u, '士兵'))); if (t) c.allies().filter(u => u.name === t.name).forEach(u => c.boost(u, 2)); } };
B['维尔海夫'] = { order: c => c.g.choose({ prompt: '维尔海夫：触发回合结束的 2 个铜色士兵', from: c.targets(c.allies().filter(u => bronze(u) && has(u, '士兵'))), n: 2, upTo: true, source: c.self.name }).forEach(u => runTurnEnd(c, u)) };
B['沼蛇'] = {};
B['全知者沃里特'] = { deploy: noop };
B['沙斯希乌斯'] = { deploy: noop };   // 按揭示结果：用记录

// 铜色单位
B['阿尔巴师装甲骑兵'] = { deployRow: { m: c => { const t = T(c, '装甲骑兵：锁定', c.enemies()); if (t) c.lock(t); } } };
B['阿尔巴师枪兵'] = {
  charges: 0,
  order: c => { const t = T(c, '枪兵：重伤 1', c.enemies()); if (t) c.status(t, 'bleed', 1); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { const left = c.self.bonusCharges - c.self.orderUsed; if (left >= 3) c.armor(c.self, 1); else c.self.bonusCharges++; } }],
};
B['阿尔巴师矛兵'] = { deploy: c => c.g.choose({ prompt: '矛兵：2 个敌军', from: c.targets(c.enemies()), n: 2, upTo: true, source: c.self.name })
  .map(t => [t, c.adjacent(t).reduce((a, u) => a + statusN(u), 0)]).forEach(([t, n]) => { if (n) c.damage(t, n); }) };
B['炼金术士'] = { deployRow: { r: c => { const ts = c.g.choose({ prompt: '炼金术士：互换战力的 2 个友军', from: c.targets(c.allies().filter(u => u !== c.self)), n: 2, source: c.self.name }); if (ts.length === 2) { const a = ts[0].power, b = ts[1].power; c.setPower(ts[0], b); c.setPower(ts[1], a); } } } };
B['愤怒的暴民'] = { deploy: c => { const t = T(c, '暴民：2 伤害', c.enemies()); if (!t) return; const sp = conspire(c, t); c.damage(t, 2); if (sp) c.boost(c.self, 2); } };
B['日轮之师十字弩手'] = {
  deploy: c => { const t = T(c, '十字弩手：1 伤害', c.enemies()); if (t) c.damage(t, 1); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0 && c.self.vars.soldierTurn === c.g.s.turn, run: c => { const t = R(c, '十字弩手：随机 1 伤害', c.enemies()); if (t) c.damage(t, 1); } },
    { on: 'unitPlayed', when: (c, d) => own(c, d) && has(d.unit, '士兵'), run: c => { c.self.vars.soldierTurn = c.g.s.turn; } }],
};
B['日轮之师重骑兵'] = { abilities: [
  { on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { c.armor(c.self, 1); if (c.self.row === 'r' && c.self.armor >= 5) c.move(c.self, 'm'); } },
  { on: 'unitPlayed', when: (c, d) => foePlays(c, d) && c.self.row === 'm' && c.self.armor > 0, run: (c, d) => { const a = c.self.armor; c.self.armor = 0; c.damage(d.unit, a); c.lock(c.self); } },
] };
B['日轮之师轻骑兵'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0, run: c => { const t = c.g.s.sides[c.foe].vars.lastUnit; if (t && c.g.find(t.uid)) c.damage(t, 1); } }] };
B['日轮之师龟甲盾卫'] = { abilities: [{ on: 'armorBroken', when: (c, d) => d.unit === c.self, run: c => { const t = highestOf(c, c.enemies(), '龟甲盾卫：最高敌军并列'); if (t) c.boost(t, 3); } }] };
B['瘟疫制造者'] = { deploy: noop };   // 生成魔像守卫/牛尸：按记录
B['牛尸'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { c.adjacent().forEach(u => c.status(u, 'poison')); c.destroy(c.self); } }] };
B['作战工程师'] = { deploy: c => c.allies().filter(u => has(u, '机械') && u.def.order).forEach(u => { u.bonusCharges++; }) };
B['投污者'] = { deploy: c => { const t = T(c, '投污者：放逐', c.enemies().filter(u => u.power <= 3)); if (t) c.banish(t); } };
B['迪尔兰士兵'] = {};
B['戴斯文强弩手'] = { abilities: [{ on: 'statusGained', when: (c, d) => d.unit.side === c.foe && c.g.s.active === c.side && (c.self.vars.cnt == null || c.self.vars.cnt > 0), run: (c, d) => { c.self.vars.cnt = (c.self.vars.cnt == null ? 6 : c.self.vars.cnt) - 1; c.damage(d.unit, 1); } }] };
B['公爵守卫'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.g.s.sides[c.side].vars.leaderTurn === c.g.s.turn, run: c => c.boost(c.self, 1) }] };
B['女爵的告密者'] = { deploy: c => { const n = fromDeck(c, '告密者：生成并打出的敌军铜色单位'); if (n) c.g.spawn(n, c.self.owner || c.foe, 'm', null, c.self, { andPlay: true }); } };
B['特使'] = { deploy: c => { const t = T(c, '特使：7 增益', c.allies().filter(u => u !== c.self)); if (t) c.boost(t, 7); } };
B['永夜之蚀助祭'] = { deploy: noop, order: noop };
B['永夜之蚀教徒'] = { order: c => { const t = T(c, '教徒：灌注', c.enemies().filter(bronze)); if (t) c.infuse(t, { name: '永夜之蚀', on: 'unitPlayed', when: (cc, e) => (e.by || e.unit.side) === cc.foe && has(e.unit, '呓语'), run: cc => cc.g.damage(cc.self, 1, { name: '永夜之蚀' }) }); } };
B['帝国毒牙'] = { deploy: c => { const t = T(c, '帝国毒牙：中毒', c.enemies()); if (t) c.status(t, 'poison'); } };
B['火蝎攻城弩'] = {
  order: c => { const t = T(c, '火蝎攻城弩：1 伤害', c.g.units()); if (t) c.damage(t, 1); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && (d.def.tags || []).includes('谋略'), run: c => { c.self.bonusCharges++; } }],
};
B['狩猎恶犬'] = {};
B['幻术师'] = { deploy: c => { const n = fromDeck(c, '幻术师：对方墓场的铜色单位'); if (!n) return; const u = c.g.spawn(n, c.side, c.self.row, posRight(c), c.self); if (u && !c.g.cohort(c.self)) u.power = 1; } };
B['近卫军'] = { deploy: c => c.g.s.sides[c.foe].rows[c.self.row].filter(u => u.status.spying).forEach(u => c.damage(u, 1)) };
B['近卫军铁卫'] = {
  order: c => { const t = T(c, '铁卫：1 伤害', c.enemies()); if (t) c.damage(t, 1); },
  deathblow: c => c.armor(c.self, 1),
  abilities: [{ on: 'statusGained', when: (c, d) => d.key === 'spying' && d.val && d.unit.side === c.foe, run: c => { c.self.bonusCharges++; } }],
};
B['帝国占卜师'] = { deploy: c => { const t = T(c, '占卜师：净化', c.g.units().filter(u => u !== c.self)); if (t) c.purify(t); } };
B['帝国舰队'] = { order: c => { const t = T(c, '帝国舰队：灌注', c.enemies()); const me = c.side;
  if (t) c.infuse(t, { name: '帝国舰队', on: 'turnEnd', when: (cc, d) => d.side === cc.side, run: cc => { const n = cc.g.s.sides[me].rows[cc.self.row].filter(u => cc.g.flankActive(u)).length; if (n) cc.g.damage(cc.self, n, { name: '帝国舰队' }); } }); } };
B['帝国海军士兵'] = { order: noop };
B['帝国医师'] = { order: noop };
B['渗透者'] = {};
B['弑王者'] = { deploy: noop };
B['骑士挑战者'] = {
  deploy: c => { const t = T(c, '骑士挑战者：参考的敌军', c.enemies().filter(u => c.g.isBoosted(u))); if (t) c.status(c.self, 'vitality', t.power - t.base); },
  bless: [{ at: 8, run: c => c.g.units().forEach(u => c.boost(u, 1)) }],
};
B['法师刺客'] = { deploy: c => { const t = T(c, '法师刺客：2 伤害', c.enemies()); if (t) c.damage(t, 2); } };
B['法师渗透者'] = {
  deploy: c => c.adjacent().forEach(u => c.damage(u, 3)),
  deathblow: c => { const to = c.foe; const row = c.g.rowOf(c.self); row.splice(row.indexOf(c.self), 1); c.g._place(c.self, to, c.self.row, null); c.self.status.spying = false; c.g.log('移到对面', { name: c.self.name }); },
};
B['法师折磨者'] = { deploy: c => { const t = T(c, '折磨者：潜伏', c.enemies()); if (t) c.status(t, 'spying', true); } };
B['马格尼师'] = { deploy: noop };
B['射石机'] = { order: c => { const t = T(c, '射石机：伤害', c.enemies()); if (t) c.damage(t, 1 + c.adjacent(t).filter(u => u.status.spying).length); } };
B['伪装大师'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.enemies().some(u => u.status.lock), run: c => c.boost(c.self, 1) }] };
B['傀儡大师'] = { order: c => { const t = T(c, '傀儡大师：抓捕铜色敌军', c.enemies().filter(bronze)); if (!t) return; const row = t.row; c.seize(t);
  const r = c.g.rowOf(c.self); r.splice(r.indexOf(c.self), 1); c.g._place(c.self, c.foe, row, null); c.g.log('移到对面', { name: c.self.name }); } };
B['异兽园看管'] = { deploy: c => { const t = T(c, '异兽园看管：2 伤害', c.enemies()); if (t) c.damage(t, 2); } };   // 手牌有谋略时重伤 2：用改战力
B['那乌西卡旅'] = {};
B['那乌西卡旅中士'] = { deploy: c => { if (c.g.s.sides[c.foe].wins > 0 || c.g.s.results.some(r => (c.side === 'me' ? r.res === 'L' : r.res === 'W'))) c.spawnPlay('战前准备'); } };
B['尼弗迦德骑士'] = { deploy: c => { const t = T(c, '尼弗迦德骑士：敌军 +2', c.enemies()); if (t) boostEnemy(c, t, 2); } };
B['新兵'] = { order: c => { const n = fromDeck(c, '新兵：从牌组打出的铜色士兵'); if (n) c.playFromDeck(n, c.self.row, posRight(c)); c.shuffleBack(c.self); } };
B['帝国投石机'] = { order: c => c.spawnPlay('牛尸', c.self.row) };
B['煽动的贵族'] = {
  deploy: c => { const n = c.enemies().filter(u => u.status.spying).length; if (n) c.boost(c.self, n); },
  abilities: [{ on: 'statusGained', when: (c, d) => d.key === 'spying' && d.val && d.unit.side === c.foe, run: c => c.boost(c.self, 1) }],
};
B['奴隶贩子'] = { deploy: c => { const t = T(c, '奴隶贩子：铜色友军', c.allies().filter(u => u !== c.self && bronze(u))); if (!t) return; c.damage(t, 1);
  const u = has(t, '士兵') ? c.spawnPlay(t.name, c.self.row, posRight(c)) : c.g.spawn(t.name, c.side, c.self.row, posRight(c), c.self); if (u) c.setPower(u, 1); } };
B['奴隶猎人'] = { deploy: c => { const t = T(c, '奴隶猎人：伤害', c.enemies()); if (!t) return; c.damage(t, 1 + c.adjacent().filter(u => has(u, '士兵')).length);
  if (c.g.find(t.uid) && t.power === 1) { const u = c.g.spawn(t.name, c.side, c.self.row, posRight(c), c.self); if (u) { u.power = 1; c.lock(u); } } } };
B['奴隶步兵'] = { deploy: c => { const t = T(c, '奴隶步兵：转变', c.allies().filter(u => u !== c.self)); if (t) c.transform(t, '奴隶步兵'); } };
B['侦察员'] = { deploy: noop, order: noop };
B['军旗手'] = { deploy: c => { const n = c.enemies().filter(u => c.g.isBoosted(u)).length; if (n) c.boost(c.self, n); } };
B['仙尼德变节者'] = {
  deploy: c => { const t = T(c, '变节者：潜伏', c.enemies()); if (t) c.status(t, 'spying', true); },
  order: c => { const t = T(c, '变节者：1 伤害', c.enemies().filter(u => u.status.spying)); if (t) c.damage(t, 1); },
  abilities: [{ on: 'statusGained', when: (c, d) => d.key === 'spying' && d.val && d.unit.side === c.foe, run: c => c.reduceCd(c.self, 1) }],
};
B['口渴的夫人'] = { abilities: [{ on: 'statusGained', when: (c, d) => d.unit.side === c.foe && d.val, run: c => c.boost(c.self, 1) }] };
B['陶森特游侠骑士'] = { deploy: c => { const t = T(c, '游侠骑士：伤害', c.enemies()); if (t) c.damage(t, t.power >= 6 ? 4 : 2); } };
B['毒理学家'] = { deploy: noop };
B['莫拉汉姆家猎手'] = { deployRow: {
  m: c => { const t = T(c, '莫拉汉姆家猎手：重伤 2', c.enemies()); if (t) c.status(t, 'bleed', 2); },
  r: c => { const t = T(c, '莫拉汉姆家猎手：锁定', c.g.units().filter(u => u !== c.self)); if (t) c.lock(t); },
} };
B['莫拉汉姆家仆从'] = { deploy: c => { const ts = c.g.choose({ prompt: '仆从：从哪个复制到哪个', from: c.targets(c.enemies()), n: 2, source: c.self.name }); if (ts.length < 2) return;
  let k = 0; for (const [key, v] of Object.entries(ts[0].status)) if (v && key !== 'immune') { c.status(ts[1], key, v); k++; } if (k) c.boost(c.self, k); } };
B['文登达尔精锐'] = { deploy: noop };
B['维可瓦罗见习法师'] = { deployRow: { r: noop } };
B['毒蛇学派猎魔人'] = { deploy: c => { const t = T(c, '毒蛇学派猎魔人：重伤 2', c.enemies()); if (t) c.status(t, 'bleed', 2); } };
B['毒蛇学派猎魔人学徒'] = {};
B['毒蛇学派猎魔人炼金师'] = { deployRow: { m: noop } };
B['毒蛇学派猎魔人导师'] = { deploy: noop };


// ================= 斯凯利格 · 批量补全 =================
const SIREN = '尖啸女海妖', BEAR = '异变巨熊', CROW = '乌鸦';
const bt = (c, n) => c.g.bloodthirst(c.side, n);                                        // 战狂 N
const raid = (c, t, n) => c.damage(t, n + (c.g.s.sides[c.side].vars.raidBonus || 0));   // 征战牌伤害（高地领主 +1）
const isDamaged = u => u.power < u.base;
// 狂暴 X：战力降到 X 或以下时触发一次
const berserk = (x, run) => ({ on: 'damaged', when: (c, d) => d.unit === c.self && c.self.power <= x && !c.self.vars.bz, run: c => { c.self.vars.bz = true; run(c); } });
const berserkDeploy = (x, run) => c => { if (c.self.power <= x && !c.self.vars.bz) { c.self.vars.bz = true; run(c); } };
const healN = (c, u, n) => { if (!u || u.power >= u.base) return 0; const k = Math.min(n, u.base - u.power); u.power += k; c.g.log('治疗', { name: u.name, n: k }); c.g.emit('healed', { unit: u, n: k, src: c.self }); return k; };

// 领袖
B['战斗狂热'] = { order: c => c.spawnPlay('致幻菌菇'),
  abilities: [] };
B['荣耀圣焰'] = { order: c => { const n = fromDeck(c, '荣耀圣焰：移到墓场的单位'); const t = T(c, '荣耀圣焰：伤害', c.enemies()); if (n) c.g.s.sides[c.side].grave.push(n); if (n && t) c.damage(t, c.g.def(n).base || 0); } };
B['野猪冲锋'] = { charges: 2, order: c => { const t = T(c, '野猪冲锋：3 伤害', c.enemies()); if (t) c.damage(t, 3); } };
B['鸣镝动怒'] = { charges: 3, order: (c, o) => {
  const u = c.g.spawn(SIREN, c.foe, (o && o.row) || 'm', null, c.self); if (u) c.damage(u, 1);
  if (c.self.charges === 0 && !c.self.vars.done) { c.self.vars.done = true; c.spawnPlay('背亲者恩约夫', 'm'); }
} };
B['怒海汹涛'] = HZ2('雨', 2, { charges: 2, order: (c, o) => c.g.spawn(SIREN, c.side, (o && o.row) || 'm', null, c.self) });
B['鲁莽乱舞'] = { charges: 2, order: c => c.g.choose({ kind: 'random', prompt: '鲁莽乱舞：4 点随机分摊', from: c.enemies(), n: 4, source: c.self.name }).slice(0, 4).forEach(u => c.damage(u, 1, { ignoreArmor: true })) };
B['巨熊仪式'] = { charges: 5, order: (c, o) => {
  const t = T(c, '巨熊仪式：1 伤害', c.allies()); if (t) c.damage(t, 1);
  if (c.self.charges === 0 && !c.self.vars.done) { c.self.vars.done = true; c.g.spawn(BEAR, c.side, (o && o.row) || 'm', null, c.self); }
} };
B['背亲者恩约夫'] = { deploy: c => { const u = c.g.spawn(SIREN, c.foe, c.self.row, null, c.self); if (u) c.damage(u, 1); } };

// 神器
B['无尽航行'] = {
  deploy: c => { c.self.chapter = 0; c.g.spawn('比约恩的战船', c.side, c.self.row, posRight(c), c.self); },
  abilities: [
    { on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '水手') && c.self.chapter < 2, run: c => {
      c.self.chapter++; c.g.log('剧情推进', { name: c.self.name, chapter: c.self.chapter });
      if (c.self.chapter === 2) { const b = c.allies().find(u => u.name === '比约恩的战船');
        if (b) { c.purify(b); c.heal(b); c.g.strengthen(b, 5, c.self); b.bonusCharges++; } else c.g.spawn('比约恩的战船', c.side, c.self.row, posRight(c), c.self); }
    } },
  ],
};
B['海恩卡维赫'] = { deploy: c => { const n = fromDeck(c, '海恩卡维赫：生成并打出的熊学派'); if (n) c.spawnPlay(n, c.self.row, posRight(c)); }, order: c => c.adjacent().forEach(u => healN(c, u, 2)) };
B['盖迪尼斯的阴影下'] = {
  deploy: c => { c.self.chapter = 0; c.g.spawn('鸦母布道者', c.side, c.self.row, posRight(c), c.self); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit !== c.self && (d.def.tags || []).includes('德鲁伊') && c.self.chapter < 2, run: c => {
    c.self.chapter++; c.g.log('剧情推进', { name: c.self.name, chapter: c.self.chapter }); c.spawnPlay(c.self.chapter === 1 ? '乌鸦眼块茎' : '致幻菌菇', c.self.row);
  } }],
};
B['凯尔卓'] = {
  deploy: c => { const n = fromDeck(c, '凯尔卓：创造并打出的奎特家族'); if (n) c.spawnPlay(n, c.self.row, posRight(c)); },
  order: c => { const a = T(c, '凯尔卓：6 护甲的友军', c.allies()); if (!a) return; c.armor(a, 6); const e = T(c, '凯尔卓：交锋的敌军', c.enemies()); if (e) c.g.clash(a, e); },
};
B['斯瓦勃洛图腾'] = {
  deploy: c => { const row = c.g.rowOf(c.self); c.g.spawn('斯瓦勃洛狂信者', c.side, c.self.row, row.indexOf(c.self), c.self); c.g.spawn('斯瓦勃洛狂信者', c.side, c.self.row, c.g.rowOf(c.self).indexOf(c.self) + 1, c.self); },
  order: c => { const t = T(c, '图腾：2 伤害友军', c.allies()); if (t) c.damage(t, 2); },
};

// 特殊牌
B['血鹰'] = { onPlay: (c, o) => { const t = T(c, '血鹰：2 伤害', c.enemies()); if (t) raid(c, t, 2); const n = fromDeck(c, '血鹰：从牌组打出的战士'); if (n) c.playFromDeck(n, (o && o.row) || 'm', o && o.pos); } };
B['冠军的冲锋'] = { onPlay: c => { const t = T(c, '冠军的冲锋：目标', c.g.units()); if (!t) return; if (bt(c, 3)) c.destroy(t); else raid(c, t, 5); } };
B['幻觉'] = { onPlay: (c, o) => { const n = fromDeck(c, '幻觉：生成并打出'); if (n) c.spawnPlay(n, (o && o.row) || 'm', o && o.pos); } };
B['巨蝎煎药'] = { onPlay: c => { const t = T(c, '巨蝎煎药：1×6 的单位', c.g.units()); if (t) for (let i = 0; i < 6; i++) c.damage(t, 1); } };   // 另一选项“随机分摊”用改战力
B['魔法罗盘'] = { onPlay: (c, o) => { const n = fromDeck(c, '魔法罗盘：打出的牌'); if (n) c.playFromDeck(n, (o && o.row) || 'm', o && o.pos); } };
B['海军霸权'] = { onPlay: (c, o) => { const n = fromDeck(c, '海军霸权：创造并打出的船只'); if (n) c.spawnPlay(n, (o && o.row) || 'm', o && o.pos); } };
B['海之祭礼'] = { onPlay: (c, o) => { const k = c.allies().length; c.g.units().slice().forEach(u => c.damage(u, 1)); const u = c.g.spawn(SIREN, c.side, (o && o.row) || 'm', null, c); if (u && k) c.boost(u, k); } };
B['突袭船队'] = { onPlay: (c, o) => { const t = T(c, '突袭船队：重伤 4', c.enemies()); if (t) c.status(t, 'bleed', 4); const n = fromDeck(c, '突袭船队：打出的船只'); if (n) c.playFromDeck(n, (o && o.row) || 'm', o && o.pos); } };
B['回复'] = { onPlay: c => { const t = T(c, '回复：治愈的友军', c.allies()); if (!t) return; const n = Math.max(0, t.base - t.power); c.heal(t); if (n) c.boost(t, n); } };
B['茜格德莉法的仪式'] = { onPlay: (c, o) => { const n = fromDeck(c, '仪式：从墓场召唤的单位'); if (!n) return; const u = c.summon(n, c.side, (o && o.row) || 'm'); if (u) c.status(u, 'doomed', true); } };
B['史璀伯格符文石'] = { onPlay: (c, o) => { const n = fromDeck(c, '史璀伯格符文石：创造并打出'); if (n) c.spawnPlay(n, o && o.row, o && o.pos); } };
B['衔尾蛇面具'] = { order: c => { c.g.spawn(CROW, c.side, 'm', null, c.self); c.g.spawn(CROW, c.side, 'm', null, c.self); } };
B['登舰作战'] = { onPlay: c => { const t = T(c, '登舰作战：2 伤害', c.enemies()); if (t) raid(c, t, 2); } };   // 战狂 2 时从手牌打出水手：按记录
B['披盔贯甲'] = { onPlay: (c, o) => { const t = T(c, '披盔贯甲：2 伤害', c.enemies()); if (t) raid(c, t, 2);
  for (let i = 0; i < 3; i++) { const u = c.g.spawn('猎魔人学徒', c.side, (o && o.row) || 'm', null, c); if (u) { c.damage(u, 1); c.armor(u, 1); } } } };
B['乌鸦眼块茎'] = { onPlay: (c, o) => { const k = c.allies().some(u => has(u, '德鲁伊')) ? 3 : 2; for (let i = 0; i < k; i++) c.g.spawn(CROW, c.side, (o && o.row) || 'm', null, c); } };
B['狂野搭档'] = { onPlay: c => { const u = c.g.spawn('史凯利格野狼', c.foe, 'm', null, c); if (u) c.damage(u, 1); } };
B['弗蕾雅的祝福'] = { onPlay: (c, o) => { const n = fromDeck(c, '弗蕾雅的祝福：从墓场打出'); if (!n) return; const u = c.g.play(c.side, n, (o && o.row) || 'm', o && o.pos, { fromGrave: true }); if (u) c.status(u, 'doomed', true); } };
B['巨斧挥击'] = { onPlay: c => { const t = T(c, '巨斧挥击：目标', c.g.units()); if (t) raid(c, t, bt(c, 2) ? 6 : 4); } };
B['致幻菌菇'] = { onPlay: c => { const t = T(c, '致幻菌菇：目标', c.g.units()); if (!t) return; c.damage(t, 3); if (c.g.find(t.uid)) c.boost(t, 9); } };
B['原始野性'] = { onPlay: c => { const t = T(c, '原始野性：2 伤害', c.enemies()); if (t) raid(c, t, 2); }, deathblow: c => c.g.spawn(BEAR, c.side, 'm', null, c) };
B['震骇猛击'] = { onPlay: c => { const t = T(c, '震骇猛击：目标', c.g.units()); if (t) raid(c, t, t.armor > 0 ? 7 : 5); } };
B['女海妖之泪'] = HZ2('雨', 2, { onPlay: (c, o) => c.g.spawn(SIREN, c.side, (o && o.row) || 'm', null, c) });
B['群岛战争'] = { onPlay: c => { const t = T(c, '群岛战争：2 伤害', c.enemies()); if (t) raid(c, t, 2); } };   // 致死从墓场打出战士：按记录

// 金色单位
B['阿纳哈德'] = { deploy: c => { const n = c.g.units().filter(isDamaged).length; if (n) c.armor(c.self, n); } };
B['亚恩瓦德'] = { deploy: c => { const t = T(c, '亚恩瓦德：变成巨熊', c.allies().filter(u => u !== c.self && isDamaged(u))); if (t) c.transform(t, BEAR); } };
B['亚提斯'] = {
  deploy: c => { const n = fromDeck(c, '亚提斯：打出的 4 人口呓语'); if (n) c.playFromDeck(n, c.self.row, posRight(c)); },
  abilities: [{ on: 'unitPlayed', when: (c, d) => c.self.row === 'r' && d.unit !== c.self, run: (c, d) => { const n = Math.floor(d.unit.power / 2); if (n) c.damage(d.unit, n); } }],
};
B['“三目者”艾克索'] = { deployRow: {
  m: c => c.spawnPlay('乌鸦眼块茎', c.self.row),
  r: c => c.adjacent().filter(u => u.name === CROW).forEach(u => c.transform(u, '信鸦')),
} };
B['碧尔娜·布兰'] = { deploy: noop };
B['“风暴之子”比约恩'] = { deploy: c => { const t = T(c, '比约恩：交锋', c.enemies()); if (t) c.clash(t); }, order: c => { if (bt(c, 2)) c.shuffleBack(c.self); } };
B['“阿蓝”卢戈'] = { abilities: [{ on: 'damaged', when: (c, d) => d.unit === c.self && d.dealt > 0, run: c => { const t = R(c, '阿蓝卢戈：随机 2 伤害', c.enemies()); if (t) c.damage(t, 2); } }] };
B['海之新娘'] = { deploy: c => { const n = fromDeck(c, '海之新娘：从墓场打出的炼金'); if (n) c.g.play(c.side, n, c.self.row, null, { fromGrave: true }); } };
B['凯瑞丝·奎特'] = { deployRow: {
  m: c => c.g.spawn('德拉蒙家族持盾女卫', c.side, c.self.row, posRight(c), c.self),
  r: c => c.g.spawn('德拉蒙家族女王卫队', c.side, c.self.row, posRight(c), c.self),
} };
B['凯瑞丝：无所畏惧'] = { order: c => { const a = T(c, '凯瑞丝：完全治愈', c.allies().filter(isDamaged)); if (!a) return; const n = a.base - a.power; c.heal(a);
  const b = T(c, '凯瑞丝：造成治愈量伤害的友军', c.allies().filter(u => u !== a)); if (b && n) c.damage(b, n); } };
B['珊瑚'] = { order: noop };   // 丢弃触发的随机伤害：按记录
B['腐化的佛兰明妮卡'] = { deploy: c => { const n = new Set(c.g.s.sides[c.side].grave.filter(x => (c.g.def(x).tags || []).includes('野兽'))).size; if (n) c.boost(c.self, 2 * n); } };
B['刀剑盟约'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.power <= 6, run: c => c.armor(c.self, 1) }] };
B['克拉茨·奎特'] = {
  deploy: noop,
  order: c => { const t = T(c, '克拉茨：1 伤害', c.g.units()); if (t) c.damage(t, 1); },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && c.adjacent().includes(d.unit) && (has(d.unit, '水手') || has(d.unit, '船只')), run: (c, d) => { const t = lowestOf(c, c.enemies(), '克拉茨：最低敌军并列'); if (t) c.g.clash(d.unit, t); } }],
};
B['乌鸦之母'] = { deploy: c => { c.g.spawn(CROW, c.side, c.self.row, posRight(c), c.self); c.g.spawn(CROW, c.side, c.self.row, posRight(c), c.self); } };
B['“双刃”达葛'] = { abilities: [{ on: 'damaged', when: (c, d) => d.unit.side === c.foe && c.self.row === 'm' && d.dealt > 0, run: c => c.boost(c.self, 1) }] };
B['迪兰'] = { deployRow: { r: c => c.damage(c.self, 3) } };
B['巨熊'] = {};   // “同排无法获得增益”：ASSUME 未实现
B['邓戈·费特'] = { deploy: c => { if (!bt(c, 1)) return; const t = T(c, '邓戈：锁定', c.enemies()); if (t) c.lock(t); } };
B['多纳·印达'] = { deploy: c => { const t = T(c, '多纳：伤害', c.enemies()); if (t) c.damage(t, bt(c, 2) ? 4 : 2); } };
B['龙龟'] = { abilities: [
  { on: 'damaged', when: (c, d) => d.unit === c.self, run: (c, d) => { const lost = (c.self.vars.ar == null ? c.self.def.armor : c.self.vars.ar) - c.self.armor; c.self.vars.ar = c.self.armor; if (lost > 0) c.boost(c.self, lost); } },
  { on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0, run: c => { c.armor(c.self, 1); c.self.vars.ar = c.self.armor; } },
] };
B['德莱格·波·德乌'] = { deploy: noop, order: noop };
B['埃斯特·图尔赛克'] = { deploy: noop };
B['莫斯萨克'] = { deployRow: { r: c => { const n = fromDeck(c, '莫斯萨克：从牌组打出的炼金'); if (n) c.playFromDeck(n, c.self.row); } } };
B['佛卡夏'] = { deploy: c => { const n = fromDeck(c, '佛卡夏：从墓场打出的单位'); if (!n) return; const u = c.g.play(c.side, n, c.self.row, posRight(c), { fromGrave: true }); if (u) c.status(u, 'doomed', true); } };   // 雨：用“整排效果”记
B['富马尔'] = { deploy: c => c.spawnPlay('女海妖之泪'), order: c => { for (const r of ['m', 'r']) { const h = c.g.s.hazards[c.foe][r]; if (h && h.kind === '雨') { c.g.addHazard(c.foe, r, '风暴', h.turns, c.self); break; } } } };
B['格德'] = { deploy: c => { const u = c.g.spawn(SIREN, c.foe, c.self.row, null, c.self); c.g.s.sides[c.foe].rows[c.self.row].slice().forEach(x => c.damage(x, 1)); void u; } };
B['大野猪'] = { deployRow: {
  m: c => { const n = c.g.units().filter(isDamaged).length; if (n) c.boost(c.self, n); },
  r: c => { const t = T(c, '大野猪：参考的受伤单位', c.g.units().filter(u => u !== c.self && isDamaged(u))); if (t) c.boost(c.self, t.base - t.power); },
} };
B['格雷密斯特'] = { order: c => { if (c.self.row !== 'r') return; const t = T(c, '格雷密斯特：净化', c.g.units()); if (t) c.purify(t); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && (d.def.tags || []).includes('炼金'), run: c => { c.self.orderUsed = 0; } }] };
B['哈罗德·霍兹诺特'] = {
  deploy: c => { for (let i = 0; i < 3; i++) c.g.spawn('哈罗德的伙伴', c.side, otherRow(c.self.row), null, c.self); },
  order: c => { const t = T(c, '霍兹诺特：1 伤害友军', c.allies()); if (t) c.damage(t, 1); },
};
B['哈罗德的伙伴'] = { deathwish: c => { const t = R(c, '哈罗德的伙伴：随机 2 伤害', c.enemies()); if (t) c.damage(t, 2); } };
B['哈罗德·奎特'] = { deploy: c => { const n = fromDeck(c, '哈罗德：从墓场打出的铜色战士'); c.damage(c.self, 2); if (!n) return; const u = c.g.play(c.side, n, c.self.row, posRight(c), { fromGrave: true }); if (u) c.status(u, 'doomed', true); } };
B['好战者哈罗德'] = { deploy: c => { const n = fromDeck(c, '哈罗德：从墓场打出的铜色战士'); if (!n) return; const u = c.g.play(c.side, n, c.self.row, posRight(c), { fromGrave: true }); if (u) c.status(u, 'doomed', true); } };
B['汉姆多尔'] = { deploy: c => { const p = T(c, '汉姆多尔：选对方一排（点该排的单位）', c.enemies()); if (!p) return; const row = c.g.rowOf(p); const n = row.length;
  c.g.choose({ kind: 'random', prompt: '汉姆多尔：' + n + ' 点随机分摊', from: row.slice(), n, source: c.self.name }).slice(0, n).forEach(u => c.damage(u, 1)); } };
B['海科亚·德拉蒙'] = {
  order: c => { if (c.self.row !== 'm') return; const p = T(c, '海科亚：选对方一排（点该排的单位）', c.enemies()); if (!p) return;
    c.g.choose({ kind: 'random', prompt: '海科亚：3 点随机分摊', from: c.g.rowOf(p).slice(), n: 3, source: c.self.name }).slice(0, 3).forEach(u => c.damage(u, 1)); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.orderUsed === 0, run: c => { const t = R(c, '海科亚：随机 1 伤害', c.enemies()); if (t) c.damage(t, 1); } }],
};
B['海琳'] = { deploy: c => c.allies().filter(u => has(u, '人类')).forEach(u => c.boost(u, 1)) };
B['佛兰明妮卡'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => c.g.rowOf(c.self).filter(u => u !== c.self).forEach(u => healN(c, u, 1)) }] };
B['哈尔玛·奎特'] = { deployRow: { m: c => { const n = fromDeck(c, '哈尔玛：放逐的墓场单位'); const t = T(c, '哈尔玛：伤害', c.enemies()); if (!n) return; const gr = c.g.s.sides[c.side].grave, i = gr.indexOf(n); if (i >= 0) { gr.splice(i, 1); c.g.s.sides[c.side].banished.push(n); } if (t) c.damage(t, c.g.def(n).base || 0); } } };
B['哈尔玛：海上恶狼'] = {
  deployRow: { m: c => { const t = T(c, '哈尔玛：交锋', c.enemies()); if (t) c.clash(t); } },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && (d.def.tags || []).includes('征战'), run: c => {
    [c.self, ...c.adjacent().filter(u => has(u, '水手') || has(u, '船只'))].forEach(u => { const a = u.armor; if (a) { u.armor = 0; c.boost(u, a); } });
  } }],
};
B['“黑手”霍格'] = {
  deploy: c => { const t = T(c, '霍格：2 伤害', c.g.units().filter(u => u !== c.self)); if (t) c.damage(t, 2); },
  abilities: [
    { on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '船只'), run: (c, d) => c.boost(d.unit, 1) },
    { on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '水手'), run: c => { const t = R(c, '霍格：随机 1 伤害', c.enemies()); if (t) c.damage(t, 1); } },
  ],
};
B['希姆'] = { deploy: c => { const t = T(c, '希姆：交换战力的受伤单位', c.g.units().filter(u => u !== c.self && isDamaged(u))); if (!t) return; const a = c.self.power, b = t.power; c.setPower(c.self, b); c.setPower(t, a); } };
B['贝哈文的朱诺德'] = { deploy: c => { const t = T(c, '朱诺德：摧毁受伤敌军', c.enemies().filter(isDamaged)); if (t) c.destroy(t); } };
B['茱塔·迪门'] = { deploy: c => { if (c.g.units().every(u => u === c.self || u.power < c.self.power)) c.damage(c.self, 6); } };
B['坎比'] = { deploy: noop };
B['凯尔派'] = HZ2('雨', 0, { abilities: [{ on: 'damaged', when: (c, d) => d.unit.side === c.foe && d.src && (d.src.name === '雨' || d.src.name === '风暴'), run: c => { const t = R(c, '凯尔派：随机野兽 +1', c.allies().filter(u => has(u, '野兽') && !c.g.isBoosted(u))); if (t) c.boost(t, 1); } }] });
B['布兰王'] = { deploy: noop };   // 溢出伤害加成：用改战力
B['“无情者”克努特'] = {
  order: c => { const a = T(c, '克努特：伤害的友军', c.allies()); if (!a) return; const n = Math.floor(a.power / 2); c.damage(a, n); const e = T(c, '克努特：伤害的敌军', c.enemies()); if (e && n) c.damage(e, n); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.power <= 5, run: c => { c.self.orderUsed = 0; } }],
};
B['克拉肯'] = HZ2('风暴', 3, { deploy: c => c.g.choose({ prompt: '克拉肯：移到同排的 3 个敌军', from: c.targets(c.enemies()), n: 3, upTo: true, source: c.self.name })
  .forEach(t => { if (t.row !== c.self.row) c.move(t, c.self.row); c.damage(t, 2); }) });
B['“快嘴”古德蒙'] = { deployRow: { r: c => { const S = c.g.s.sides[c.side]; const g0 = S.grave; S.grave = S.deck; S.deck = g0; c.g.log('交换墓场与牌组', {}); } } };
B['“疯子”卢戈'] = { deployRow: { m: c => { const n = 2 * c.enemies().filter(isDamaged).length; const t = T(c, '疯子卢戈：伤害', c.enemies()); if (t && n) c.damage(t, n); } } };
B['梅路辛'] = HZ2('雨', 2, {
  deploy: c => c.status(c.self, 'veil', true),
  order: c => c.damage(c.self, 2),
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { const adj = c.adjacent(); adj.forEach(u => c.damage(u, 1)); if (adj.length) c.g.strengthen(c.self, adj.length, c.self); if (adj.some(u => has(u, '呓语'))) c.self.orderUsed = 0; } }],
});
B['莫克瓦格'] = {};
B['莫克瓦格：恐惧之心'] = { deploy: c => { const t = T(c, '莫克瓦格：伤害', c.enemies()); if (!t) return; for (let i = 0; i < 20 && c.g.find(t.uid) && !isDamaged(t); i++) c.damage(t, 1); } };
B['奥拉夫'] = { order: c => { const n = 2 * Math.max(0, c.self.base - c.self.power); if (n) c.boost(c.self, n); } };
B['欧特克尔'] = { deployRow: { r: c => { if (c.self.power > 1) c.damage(c.self, c.self.power - 1, { ignoreArmor: true }); } } };
B['永生的里奥根'] = { deploy: c => { for (const r of ['m', 'r']) { const h = c.g.s.hazards[c.foe][r]; if (h && (h.kind === '雨' || h.kind === '风暴')) for (let k = h.turns; k > 0 && k !== Infinity; k--) c.g.runHazardOnce(c.foe, r); } } };
B['西格瓦尔德'] = { order: c => { const n = c.self.status.bleed || 0; const t = T(c, '西格瓦尔德：伤害', c.g.units().filter(u => u !== c.self)); if (!t) return; c.damage(t, n); c.purify(c.self);
  if (t.side === c.side) c.boost(c.self, n); else c.damage(c.self, n); } };
B['史凯裘'] = { abilities: [berserk(5, c => c.destroy(c.self))] };
B['史裘达尔·德拉蒙'] = { deploy: c => { const t = T(c, '史裘达尔：伤害', c.enemies()); if (t) c.damage(t, c.self.base); } };
B['索佛'] = { deployRow: { m: c => { c.enemies().filter(isDamaged).forEach(u => c.damage(u, 1)); c.status(c.self, 'immune', true); } } };   // 召唤野兽到对面：按记录
function svalblod(c) { c.g.units().filter(u => u !== c.self).forEach(u => c.damage(u, 1)); }
B['斯瓦勃洛'] = { deploy: svalblod, abilities: [{ on: 'unitEnter', when: (c, d) => d.unit.side === c.side && d.unit.name === BEAR, run: svalblod }] };
B['斯凡瑞吉·图尔赛克'] = { deploy: noop };
B['海上恶魔'] = {
  order: c => { const a = c.self.armor; c.self.armor = 0; const t = T(c, '海上恶魔：伤害', c.enemies()); if (t && a) c.damage(t, a); },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '水手'), run: c => c.armor(c.self, 1) }],
};
B['提尔：英格瓦屠戮者'] = { deploy: c => { const t = T(c, '提尔：伤害', c.enemies()); if (t) { const n = Math.abs(t.base - t.power); if (n) c.damage(t, n); } }, deathblow: c => c.status(c.self, 'resilience', true) };
B['泰格威·图尔赛克'] = { deploy: c => { const t = T(c, '泰格威：破裂', c.enemies()); if (t) c.status(t, 'rupture', true); } };
B['乌达瑞克'] = { order: c => { if (c.self.power > 7) return; const t = T(c, '乌达瑞克：设为自身战力', c.enemies()); if (t) c.setPower(t, c.self.power); } };
B['乌弗海登'] = { deploy: c => { const t = T(c, '乌弗海登：目标', c.enemies()); if (!t) return; const ts = bt(c, 3) ? [t, ...c.adjacent(t)] : [t]; ts.map(u => [u, Math.floor(u.power / 2)]).forEach(([u, n]) => { if (n) c.damage(u, n); }); } };
B['乌鲁拉'] = {
  order: c => { const t = T(c, '乌鲁拉：2 伤害', c.g.units()); if (t) c.damage(t, 2); },
  abilities: [{ on: 'damaged', when: (c, d) => d.unit.side === c.foe && d.src && d.src.side === c.side && has(d.src, '战士') && !(d.src && d.src.name === '乌鲁拉追加'), run: (c, d) => c.g.damage(d.unit, 1, { name: '乌鲁拉追加', side: c.side, tags: [] }, { ignoreArmor: true }) }],
};
B['维伯约恩'] = { deployRow: { m: c => { const n = fromDeck(c, '维伯约恩：从牌组打出的征战'); if (n) c.playFromDeck(n, c.self.row); } } };
B['维尔卡战士'] = { abilities: [berserk(2, c => c.transform(c.self, '斯瓦勃洛勇士'))] };
B['斯瓦勃洛勇士'] = { order: c => { const t = T(c, '斯瓦勃洛勇士：摧毁友军', c.allies().filter(u => u !== c.self)); if (t) c.destroy(t); c.heal(c.self); } };
B['海上野猪'] = { deployRow: { m: c => { c.enemies().filter(isDamaged).forEach(u => c.damage(u, 1)); c.enemies().forEach(u => c.damage(u, 1)); } } };
B['尤娜'] = {
  order: c => { const t = T(c, '尤娜：治愈 2', c.allies().filter(isDamaged)); if (t) healN(c, t, 2); },
  abilities: [{ on: 'damaged', when: (c, d) => c.adjacent().includes(d.unit), run: c => { c.self.bonusCharges++; } }],
};
B['尤斯提雅那·奎特'] = { deploy: c => { const n = c.self.base; c.damage(c.self, n); c.g.choose({ kind: 'random', prompt: '尤斯提雅那：' + n + ' 点随机分摊', from: c.enemies(), n, source: c.self.name }).slice(0, n).forEach(u => c.damage(u, 1)); } };

// 铜色单位
B['奎特家族盔甲匠'] = { deploy: noop };
B['奎特家族盾牌匠'] = {
  order: c => { const t = T(c, '盾牌匠：1 增益', c.allies()); if (t) c.boost(t, 1); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit !== c.self && (d.def.tags || []).includes('战士'), run: c => { c.self.bonusCharges++; } }],
};
B['奎特家族巨剑士'] = { deploy: c => c.damage(c.self, 6), abilities: [{ on: 'damaged', when: (c, d) => d.unit.side === c.foe && d.dealt > 0, run: c => healN(c, c.self, 1) }] };
B['奎特家族作战长船'] = { abilities: [{ on: 'unitPlayed', when: (c, d) => foePlays(c, d) && c.self.row === 'm', run: (c, d) => c.damage(d.unit, 1) }] };
B['奎特家族勇士'] = { deployRow: { m: c => c.g.choose({ kind: 'random', prompt: '奎特家族勇士：3 点随机分摊', from: c.enemies(), n: 3, source: c.self.name }).slice(0, 3).forEach(u => c.damage(u, 1)) } };
B['奎特家族突袭者'] = { deploy: c => { if (bt(c, 3)) c.self.zeal = true; }, order: c => { const t = T(c, '突袭者：2 伤害', c.g.units()); if (t) c.damage(t, 2); } };
B['奎特家族战吼者'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && bt(c, 1), run: c => c.boost(c.self, 1) }] };
B['奎特家族战士'] = { deploy: (c, o) => { const t = T(c, '奎特家族战士：目标', c.enemies()); if (!t) return; if (o && o.fromGrave) c.damage(t, 3); else c.status(t, 'bleed', 3); } };
B['鮟鱇鱼'] = {};
B['装甲战舰'] = { abilities: [
  { on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor === 0, run: c => c.armor(c.self, 2) },
  { on: 'armorBroken', when: (c, d) => d.unit === c.self, run: c => c.boost(c.self, bt(c, 2) ? 2 : 1) },
] };
B['熊学派猎魔人'] = { deploy: c => c.damage(c.self, 3) };
B['熊学派猎魔人学徒'] = { deploy: c => c.damage(c.self, 4), abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { if (isDamaged(c.self)) healN(c, c.self, 1); else c.armor(c.self, 1); } }] };
B['熊学派猎魔人导师'] = { deploy: c => { const n = c.allies().filter(u => u !== c.self && isDamaged(u)).length; if (n) c.boost(c.self, n); } };
B['熊学派猎魔人军需官'] = { order: c => { const t = T(c, '军需官：1 伤害友军', c.allies()); if (t) c.damage(t, 1); c.g.spawn('猎魔人学徒', c.side, c.self.row, posRight(c), c.self); } };
B['造船工'] = {
  deploy: c => { const t = T(c, '造船工：2 护甲', c.allies().filter(u => u !== c.self)); if (t) c.armor(t, 2); if (c.allies().some(u => has(u, '船只'))) c.self.zeal = true; },
  order: c => { const t = T(c, '造船工：1 护甲', c.allies()); if (t) c.armor(t, 1); },
};
B['布洛克瓦尔家族弓箭手'] = { deployRow: { r: c => { const n = c.enemies().filter(isDamaged).length; const t = T(c, '弓箭手：伤害', c.enemies()); if (t && n) c.damage(t, n); } } };
B['布洛克瓦尔家族猎人'] = {
  order: c => { if (c.self.row !== 'r') return; const t = T(c, '猎人：1 伤害', c.g.units()); if (t) c.damage(t, 1); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit !== c.self && (d.def.tags || []).includes('野兽'), run: c => c.reduceCd(c.self, 1) }],
};
B['布洛克瓦尔家族战士'] = { deploy: c => { const hit = []; let n = 3;
  for (let i = 0; i < 5 && n > 0; i++) { const t = T(c, '布洛克瓦尔战士：' + n + ' 伤害', c.enemies().filter(u => !hit.includes(u))); if (!t) break; const was = isDamaged(t); hit.push(t); c.damage(t, n); if (!was) break; n--; } } };
B['鸦母德鲁伊'] = { order: c => { const cr = T(c, '鸦母德鲁伊：放逐的乌鸦', c.allies().filter(u => u.name === CROW)); if (cr) c.banish(cr); const n = fromDeck(c, '鸦母德鲁伊：从墓场打出的炼金'); if (n) c.g.play(c.side, n, c.self.row, null, { fromGrave: true }); } };
B['鸦母布道者'] = { abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && (d.def.tags || []).includes('炼金'), run: c => c.boost(c.self, c.g.cohort(c.self) ? 2 : 1) }] };
B['信鸦'] = {};
B['疯癫水手'] = HZ2('灾厄', 1, { deploy: noop });   // 灌注的“遗愿：灾厄”：死亡时用“整排效果”记
B['迪门家族水手（Dimun Corsair）'] = {
  order: c => { const t = T(c, '迪门水手：移除护甲', c.allies().filter(u => u.armor > 0)); if (!t) return; const n = Math.min(2, t.armor); t.armor -= n; c.boost(c.self, n); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && (d.def.tags || []).includes('船只'), run: c => c.reduceCd(c.self, 1) }],
};
B['迪门家族轻型长船'] = { order: c => { if (c.self.row !== 'r') return; c.damage(c.self, 1); const t = T(c, '轻型长船：1 伤害', c.enemies()); if (t) c.damage(t, 1); } };
B['迪门家族水手（Dimun Pirate）'] = { deploy: noop };
B['迪门家族船长'] = { deploy: c => { if (bt(c, 2)) c.self.zeal = true; }, order: c => { const t = T(c, '船长：1 伤害', c.g.units()); if (t) c.damage(t, 1); } };
B['迪门家族走私贩'] = {
  deploy: c => { if (c.adjacent().some(u => has(u, '船只'))) c.g.spawn(c.self.name, c.side, c.self.row, posRight(c), c.self); },
  order: c => { const t = T(c, '走私贩：1 伤害', c.g.units()); if (t) c.damage(t, 1); },
};
B['迪门家族战船'] = { abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '水手'), run: c => { c.damage(c.self, 1); const t = R(c, '战船：随机 1 伤害', c.enemies()); if (t) c.damage(t, 1); } }], deathwish: noop };
B['不光彩的争斗者'] = { deploy: c => { if (bt(c, 1)) c.lock(c.self); }, abilities: [berserk(3, c => c.destroy(c.self))] };
B['德拉蒙家族狂战士'] = { abilities: [
  { on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { c.damage(c.self, 1); const t = R(c, '狂战士：随机 1 伤害', c.enemies()); if (t) c.damage(t, 1); } },
  berserk(3, c => c.transform(c.self, BEAR)),
] };
B['德拉蒙家族女王卫队'] = { order: c => { if (c.self.power <= 3) c.g.spawn(c.self.name, c.side, c.self.row, posRight(c), c.self); } };
B['德拉蒙家族持盾女卫'] = {};   // 受伤时召唤同名：按记录
B['德拉蒙家族村民'] = { deploy: c => { const r = rightOf(c); if (r) c.status(r, 'bleed', 4); const t = T(c, '村民：重伤 4', c.enemies()); if (t) c.status(t, 'bleed', 4); } };
B['德拉蒙家族好战分子'] = { deploy: c => {
  const t = T(c, bt(c, 5) ? '好战分子：选一排（点该排的单位）' : '好战分子：中间的敌军', c.enemies()); if (!t) return;
  const ts = bt(c, 5) ? c.g.rowOf(t).slice() : [t, ...c.adjacent(t)]; ts.forEach(u => c.damage(u, 1));
} };
B['船葬'] = {};
B['海之歌者'] = {
  deploy: c => { const t = T(c, '海之歌者：治愈 2', c.allies().filter(u => u !== c.self && isDamaged(u))); if (t) healN(c, t, 2); },
  abilities: [{ on: 'healed', when: (c, d) => d.unit.side === c.side && c.g.s.active === c.side && c.self.vars.t !== c.g.s.turn, run: c => { c.self.vars.t = c.g.s.turn; c.g.spawn(SIREN, c.side, c.self.row, posRight(c), c.self); } }],
};
B['隐士'] = { deploy: c => c.damage(c.self, 4), abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.power <= 6, run: c => { const r = rightOf(c); if (r) c.damage(r, 1); healN(c, c.self, 2); } }] };
B['海玫家族草药医生'] = { deployRow: { r: c => { const t = T(c, '草药医生：治疗 3 并 +3', c.allies().filter(u => u !== c.self)); if (t) { healN(c, t, 3); c.boost(t, 3); } } } };
B['海玫家族保卫者'] = { abilities: [{ on: 'damaged', when: (c, d) => c.adjacent().includes(d.unit) && d.unit.side === c.side, run: c => c.boost(c.self, 1) }] };
B['海玫家族诗人'] = { deployRow: { r: noop } };
B['海玫家族女矛手'] = { deploy: c => { const t = T(c, '女矛手：2 伤害', c.enemies()); if (t) c.damage(t, 2); c.damage(c.self, 2); } };
B['高地领主'] = { deploy: c => { c.g.s.sides[c.side].vars.raidBonus = (c.g.s.sides[c.side].vars.raidBonus || 0) + 1; } };
B['小女海妖'] = HZ2('雨', 2, { deploy: c => { if (c.g.cohort(c.self)) c.g.strengthen(c.self, 2, c.self); }, order: c => c.damage(c.self, 4) });
B['梅路辛教徒'] = HZ2('雨', 2, { order: noop, abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => {
  const h = c.g.s.hazards[c.foe][c.self.row]; if (!h) return;
  if (h.kind === '风暴') c.adjacent().forEach(u => c.boost(u, 1)); else if (h.kind === '雨') { const r = rightOf(c); if (r) c.boost(r, 1); }
} }] });
B['海之信使'] = { abilities: [{ on: 'damaged', when: (c, d) => d.unit.side === c.foe && d.src && (d.src.name === '雨' || d.src.name === '风暴') && d.dealt > 0, run: (c, d) => c.boost(c.self, d.dealt) }] };
B['暴怒的熊'] = { deploy: c => { const t = T(c, '暴怒的熊：2 伤害友军', c.allies().filter(u => u !== c.self)); if (t) c.damage(t, 2); } };
B['恶熊'] = { deploy: c => { c.self.bonusCharges += c.g.s.sides[c.side].grave.filter(n => n === '恶熊').length; }, order: c => { const t = T(c, '恶熊：重伤 2', c.enemies()); if (t) c.status(t, 'bleed', 2); } };
B['海巨蟒'] = { deploy: c => { const t = T(c, '海巨蟒：3 伤害', c.enemies()); if (t) c.damage(t, 3); } };   // 增益按雨/风暴触发次数：用改战力
B['海鸥'] = { deploy: c => c.g.choose({ prompt: '海鸥：3 个单位各 1', from: c.targets(c.g.units().filter(u => u !== c.self)), n: 3, upTo: true, source: c.self.name }).forEach(u => c.damage(u, 1)) };
B['斯瓦勃洛屠夫'] = { deploy: c => { const a = T(c, '屠夫：2 伤害友军', c.allies().filter(u => u !== c.self)); if (a) c.damage(a, 2); const t = T(c, '屠夫：重伤 3', c.enemies()); if (t) c.status(t, 'bleed', 3); } };
B['斯瓦勃洛邪教徒'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { const row = c.g.rowOf(c.self), i = row.indexOf(c.self); if (row[i - 1]) healN(c, row[i - 1], 1); if (row[i + 1]) c.damage(row[i + 1], 1); } }] };
B['斯瓦勃洛狂信者'] = { abilities: [berserk(2, c => c.transform(c.self, BEAR))] };
B['斯瓦勃洛牧师'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { const r = rightOf(c); if (r) c.damage(r, 1); c.boost(c.self, 2); } }] };
B['斯瓦勃洛破坏者'] = { deployRow: { m: c => { const t = T(c, '破坏者：2 伤害', c.enemies()); if (!t) return; c.damage(t, 2); if (bt(c, 2) && c.g.find(t.uid)) c.status(t, 'bleed', 2); } } };
B['“恐怖海狼”持斧者'] = { deploy: c => { const t = T(c, '持斧者：2 伤害', c.enemies()); if (t) c.damage(t, 2); }, abilities: [{ on: 'armorBroken', when: (c, d) => d.unit === c.self, run: c => { const t = R(c, '持斧者：随机 2 伤害', c.enemies()); if (t) c.damage(t, 2); } }] };
B['恐狼勇士'] = { deploy: c => { const t = T(c, '恐狼勇士：2 伤害', c.g.units().filter(u => u !== c.self)); if (!t) return; c.damage(t, 2); if (t.side === c.side) c.boost(c.self, 4); } };
B['图尔赛克家族斧兵'] = { deployRow: { m: c => { const t = T(c, '斧兵：目标', c.g.units().filter(u => u !== c.self && isDamaged(u))); if (t) c.damage(t, t.base - t.power); } } };
B['图尔赛克家族驯兽师'] = {
  deploy: c => { const n = new Set(c.allies().filter(u => has(u, '野兽')).map(u => u.name)).size; if (n) c.boost(c.self, n); },
  order: c => { const n = Math.max(0, c.self.power - c.self.base); if (!n) return; c.damage(c.self, n);
    c.g.choose({ prompt: '驯兽师：' + n + ' 个敌军各 1', from: c.targets(c.enemies()), n, upTo: true, source: c.self.name }).forEach(u => c.damage(u, 1)); },
};
B['图尔赛克家族好斗分子'] = {};
B['图尔赛克家族老兵'] = { deploy: c => c.damage(c.self, 3), abilities: [berserk(3, c => c.heal(c.self))] };
B['捕鲸枪'] = { deploy: c => { const t = T(c, '捕鲸枪：移排', c.enemies()); if (!t) return; c.move(t, otherRow(t.row)); c.damage(t, c.g.rowOf(t).length); } };

// ================= 北方王国 · 对手用过的 =================
B['工程解决方案'] = { charges: 1, order: c => { const t = T(c, '工程解决方案目标', c.g.units(c.side)); if (t) { c.boost(t, 4); c.status(t, 'shield', true); } } };
B['安娜·斯特伦格'] = {
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => {
    const row = c.g.rowOf(c.self), i = row.indexOf(c.self);
    const ts = c.g.inspired(c.self) ? c.adjacent() : (row[i + 1] ? [row[i + 1]] : []);
    ts.forEach(u => c.boost(u, 1));
  } }],
};
B['崔丹姆步兵'] = {
  abilities: [{ on: 'boosted', when: (c, d) => d.unit === c.self, run: c => {
    const t = c.pick({ kind: 'random', prompt: '崔丹姆步兵随机伤害', from: c.enemies() });
    if (t) c.damage(t, 1);
  } }],
};
B['阿德莉亚女王'] = {
  deploy: c => {
    const name = c.pick({ prompt: '阿德莉亚：生成并打出的铜色单位', kind: 'deck', from: ['?'] });
    if (!name) return;
    const row = c.g.rowOf(c.self);
    const u = c.g.spawn(name, c.side, c.self.row, row.indexOf(c.self) + 1, c.self, { andPlay: true });
    if (u) c.status(u, 'shield', true);
  },
};
B['辛特拉工匠'] = { formation: true, order: c => { const t = T(c, '辛特拉工匠：护盾', c.allies()); if (t) c.status(t, 'shield', true); } };
B['褐旗营'] = {};   // 受到增益时从牌组召唤同名牌：牌组未知，靠记录里的召唤
B['古雷特的赛尔奇克'] = { order: c => { if (c.self.row !== 'm') return; const t = T(c, '赛尔奇克：对决', c.enemies()); if (t) c.duel(t); } };


// ================= 松鼠党 · 批量补全 =================
const DEADEYE = '精灵暗箭手', ROWDY = '喧闹的矮人', YDRYAD = '年轻的树精';
const isTrap = u => has(u, '陷阱');
const spawnN = (c, name, k, row, pos) => { const out = []; for (let i = 0; i < k; i++) { const u = c.g.spawn(name, c.side, row || (c.self.row || 'm'), pos, c.self); if (u) out.push(u); } return out; };
const otherRow = r => (r === 'm' ? 'r' : 'm');
// 陷阱：打出时背面朝上（伏击）；条件满足时自动翻开并结算；“翻开”（手动）在对局簿里按指令记录
function trap(o) {
  return {
    order: c => { if (!c.self.status.ambush) return; c.flip(); if (o.spring) o.spring(c); },
    zeal: true,
    abilities: (o.trigger ? [{ on: o.trigger.on, when: (c, d) => c.self.status.ambush && o.trigger.when(c, d), run: (c, d) => { c.flip(); o.trigger.run(c, d); } }] : []),
    timer: o.timer ? { n: o.timer.n, run: c => { if (!c.self.status.ambush) return; c.flip(); o.timer.run(c); } } : undefined,
  };
}
// 对手打出单位（落在对手自己半场）
const foePlays = (c, d) => (d.by || d.unit.side) === c.foe && d.unit.side === c.foe;

// 领袖
B['和谐之唤'] = { order: (c, o) => c.spawnPlay('达娜梅碧', (o && o.row) || 'm', o && o.pos) };
B['十面埋伏'] = { charges: 3, order: (c, o) => c.g.spawn(DEADEYE, c.side, (o && o.row) || 'r', o && o.pos, c.self) };
B['游击战术'] = { charges: 3, order: c => { const t = T(c, '游击战术：移排', c.g.units()); if (!t) return; c.move(t, otherRow(t.row)); if (t.side === c.side) c.boost(t, 3); else c.damage(t, 1); } };
B['百炼精刚'] = { order: c => c.spawnPlay('淬火') };
B['自然馈赠'] = { symbiosis: true, charges: 3, order: c => { const t = T(c, '自然馈赠：活力 2', c.allies()); if (t) c.status(t, 'vitality', 2); } };
B['精准之击'] = { charges: 3, order: (c, o) => {
  const t = T(c, '精准之击：1 伤害', c.g.units()); if (t) c.damage(t, 1);
  if (c.self.charges === 0 && !c.self.vars.done) { c.self.vars.done = true; c.spawnPlay('布洛克莱昂哨兵', (o && o.row) || 'm', o && o.pos); }
} };
B['艾恩·希德战刀'] = { order: (c, o) => c.spawnPlay('松鼠党新兵', (o && o.row) || 'm', o && o.pos) };

// 神器、陷阱
B['欺骗'] = trap({ timer: { n: 3, run: c => spawnN(c, DEADEYE, 3) }, spring: c => spawnN(c, DEADEYE, 2) });
B['假死'] = {
  deploy: c => { c.self.chapter = 0; c.g.spawn('弗妮希尔的突击队', c.side, c.self.row, posRight(c), c.self); },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '精灵') && c.self.chapter < 2, run: c => {
    c.self.chapter++; c.g.log('剧情推进', { name: c.self.name, chapter: c.self.chapter });
    if (c.self.chapter === 1) spawnN(c, DEADEYE, 2); else c.spawnPlay('伏击');
  } }],
};
B['玛哈坎号角'] = trap({ trigger: { on: 'passed', when: (c, d) => d.side === c.foe, run: c => c.adjacent().forEach(u => c.boost(u, 4)) }, spring: c => c.adjacent().forEach(u => c.boost(u, 3)) });
B['玛哈坎山口'] = { deploy: noop, order: c => c.spawnPlay('淬火') };
B['圣日湖之秘'] = {
  deploy: c => { c.self.chapter = 0; c.g.spawn('湖之守卫：黎明', c.side, c.self.row, posRight(c), c.self); },   // 战力按起始牌组算：靠落地战力
  abilities: [
    { on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && d.unit.def.harmony && c.self.chapter < 2, run: c => {
      c.self.chapter++; c.g.log('剧情推进', { name: c.self.name, chapter: c.self.chapter });
      if (c.self.chapter === 2) c.spawnPlay('圣日湖：融合');
    } },
    { on: 'unitPlayed', when: (c, d) => own(c, d) && c.self.chapter >= 1 && !neutral(d.unit), run: (c, d) => c.boost(d.unit, (d.unit.tags || []).filter(t => t !== '衍生物').length) },
  ],
};
B['陷坑陷阱'] = trap({
  trigger: { on: 'cardPlayed', when: (c, d) => d.side === c.foe && !(d.unit && d.unit.status.ambush), run: (c, d) => { const n = d.def.prov || 0; c.g.choose({ kind: 'random', prompt: '陷坑陷阱：' + n + ' 点随机分摊', from: c.enemies(), n, source: c.self.name }).slice(0, n).forEach(u => c.damage(u, 1)); } },
  spring: c => c.g.choose({ kind: 'random', prompt: '陷坑陷阱：6 点随机分摊', from: c.enemies(), n: 6, source: c.self.name }).slice(0, 6).forEach(u => c.damage(u, 1)),
});
B['毒蛇陷阱'] = trap({
  trigger: { on: 'cardPlayed', when: (c, d) => d.side === c.foe && d.special, run: c => { const t = highestOf(c, c.enemies(), '毒蛇陷阱：最高敌军并列'); if (t) c.destroy(t); } },
  spring: c => { const t = lowestOf(c, c.enemies(), '毒蛇陷阱：最低敌军并列'); if (t) c.destroy(t); },
});
B['斯提嘉城堡'] = {
  deploy: c => { const n = fromDeck(c, '斯提嘉城堡：生成并打出的猫学派'); if (n) c.spawnPlay(n, c.self.row, posRight(c)); },
  order: c => c.g.choose({ prompt: '斯提嘉城堡：移排的 3 个友军', from: c.targets(c.allies()), n: 3, upTo: true, source: c.self.name }).forEach(u => c.move(u, otherRow(u.row))),
};
B['树人螳螂：拟态'] = trap({
  trigger: { on: 'unitPlayed', when: (c, d) => foePlays(c, d), run: (c, d) => { c.status(d.unit, 'poison'); c.transform(c.self, '树人螳螂：出击'); } },
  spring: c => c.transform(c.self, '树人螳螂：出击'),
});
B['碎骨陷阱'] = trap({
  timer: { n: 2, run: c => { const rows = c.g.s.sides[c.foe].rows; const r = rows.m.length >= rows.r.length ? 'm' : 'r'; rows[r].slice().forEach(u => c.damage(u, 2)); } },
  spring: c => { const t = T(c, '碎骨陷阱：选一排（点该排的单位）', c.g.units()); if (t) c.g.rowOf(t).slice().forEach(u => c.damage(u, 1)); },
});
B['焚烧陷阱'] = trap({
  trigger: { on: 'unitPlayed', when: (c, d) => foePlays(c, d), run: (c, d) => c.damage(d.unit, 5) },
  spring: c => { const t = T(c, '焚烧陷阱：3 伤害', c.g.units()); if (t) c.damage(t, 3); },
});

// 特殊牌
B['森林的召唤'] = { onPlay: (c, o) => { const n = fromDeck(c, '森林的召唤：从牌组打出的单位'); if (!n) return; const u = c.playFromDeck(n, (o && o.row) || 'm', o && o.pos); if (u) c.boost(u, 1); } };
B['蛙群繁殖季'] = { onPlay: c => {
  const ts = c.g.choose({ prompt: '蛙群繁殖季：2 个友军', from: c.targets(c.allies()), n: 2, upTo: true, source: '蛙群繁殖季' });
  ts.forEach(t => { c.status(t, 'vitality', 4); const row = c.g.rowOf(t); c.g.spawn('青蛙', c.side, t.row, row.indexOf(t), c.self); c.g.spawn('青蛙', c.side, t.row, c.g.rowOf(t).indexOf(t) + 1, c.self); });
} };
B['伊欧菲斯的赌局'] = { onPlay: (c, o) => { for (let i = 0; i < 2; i++) { const n = fromDeck(c, '伊欧菲斯的赌局：打出的陷阱'); if (n) c.playFromDeck(n, (o && o.row) || 'm'); } } };
B['伊森格林的劝告'] = { onPlay: (c, o) => { const n = fromDeck(c, '伊森格林的劝告：打出的牌'); if (!n) return; const u = c.playFromDeck(n, (o && o.row) || 'm', o && o.pos); if (u) c.boost(u, 2); } };
B['莫拉纳符文石'] = { onPlay: (c, o) => { const n = fromDeck(c, '莫拉纳符文石：创造并打出'); if (n) c.spawnPlay(n, o && o.row, o && o.pos); } };
B['鹿灵'] = { onPlay: c => { const t = T(c, '鹿灵：5 增益', c.allies()); if (t) c.boost(t, 5); } };
B['自然法则'] = { onPlay: c => {
  // 择一：+7 并遮蔽 / +9 / +6 并活力 6。ASSUME：没记录选项时按 +9，其他选项用改战力修正
  const t = T(c, '自然法则：友军', c.allies()); if (t) c.boost(t, 9);
} };
B['窃夺'] = { onPlay: (c, o) => spawnN(c, '货物', 3, (o && o.row) || 'm') };
B['布洛克莱昂之水'] = { onPlay: (c, o) => spawnN(c, '新生树精', 2, (o && o.row) || 'm') };
B['卓尔坦的伙伴'] = { onPlay: (c, o) => spawnN(c, ROWDY, 2, (o && o.row) || 'm') };   // 起始牌组每有卓尔坦多 1 个：靠记录里的生成补上
B['备用计划'] = { onPlay: c => { const t = c.g.s.sides[c.foe].vars.lastUnit; if (t && c.g.find(t.uid)) c.damage(t, 2); } };
B['丰收'] = { onPlay: (c, o) => { const n = fromDeck(c, '丰收：创造并打出的精灵'); if (n) c.spawnPlay(n, (o && o.row) || 'm', o && o.pos); } };
B['生命循环'] = { onPlay: c => { const t = T(c, '生命循环：3 伤害', c.enemies()); if (t) c.damage(t, 3); } };
B['树精的呵护'] = { onPlay: c => { const t = T(c, '树精的呵护：友军', c.allies()); if (!t) return; c.purify(t); c.boost(t, 3); if (c.allies().some(u => has(u, '树精'))) c.status(t, 'vitality', 3); } };
B['做炸弹'] = { onPlay: c => {
  const t = T(c, '做炸弹：敌军', c.enemies()); if (!t) return;
  c.move(t, otherRow(t.row));
  if (c.g.rowOf(t).length === 1) c.damage(t, 4); else c.status(t, 'bleed', 4);
} };
B['大自然的报复'] = { onPlay: c => { const t = T(c, '大自然的报复：5 伤害', c.enemies()); if (t) c.damage(t, 5); },
  deathblow: c => { const t = R(c, '大自然的报复：随机树人', c.allies().filter(u => has(u, '树人'))); if (t) c.boost(t, 2); } };
B['淬火'] = { onPlay: c => { const t = T(c, '淬火：5 增益', c.allies()); if (!t) return; c.boost(t, 5); if (has(t, '矮人')) c.armor(t, 2); } };
B['伏击'] = { onPlay: c => { const t = T(c, '伏击：3 伤害', c.enemies()); if (t) c.damage(t, 3); c.g.spawn(DEADEYE, c.side, 'r', null, c.self); } };

// 金色单位
B['艾格莱丝'] = { deploy: c => { c.self.vars.turn = c.g.s.turn; },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.vars.turn === c.g.s.turn, run: c => { const n = c.self.power - c.self.base; if (n > 0) c.boost(c.self, n); } }] };
B['安格斯·布里·克里'] = { deploy: c => {
  const side = c.side;
  c.g.on('unitEnter', (d, g) => { if (d.unit.side === side && d.unit.name === DEADEYE) g.boost(d.unit, 1, { name: '安格斯' }); });
} };
B['奥克温'] = { abilities: [{ on: 'unitSpawned', when: (c, d) => d.unit.side === c.side && d.unit.name === '游荡的树人', run: (c, d) => { const n = c.allies().filter(u => has(u, '树精')).length; if (n) c.status(d.unit, 'vitality', n); } }] };
B['巴克莱·艾尔斯'] = { deploy: c => c.allies().filter(u => u !== c.self && has(u, '矮人')).forEach(u => { if (u.armor > 0) c.boost(u, 1); else c.armor(u, 1); }) };
B['巴纳巴斯·贝肯鲍尔'] = { deploy: c => ['精灵', '矮人', '树精'].forEach(t => { const u = T(c, '巴纳巴斯：' + t, c.allies().filter(v => has(v, t))); if (u) c.boost(u, 3); }) };
B['布蕾恩'] = {
  deploy: c => { if (c.allies().filter(u => u !== c.self && has(u, '树精')).length >= 2) c.self.zeal = true; },
  order: c => { const t = T(c, '布蕾恩：1 伤害', c.enemies()); if (t) c.damage(t, 1); },
};
B['布雷恩'] = { deploy: c => {
  const rows = ['m', 'r'].map(r => c.g.s.sides[c.foe].rows[r]).filter(r => r.length >= 5);   // 亢奋（手牌数）无法推算，按 5 个
  const ends = rows.map(r => r[r.length - 1]);
  const t = ends.length > 1 ? T(c, '布雷恩：摧毁哪排最右', ends) : ends[0];
  if (t) c.destroy(t);
} };
B['布罗瓦尔·霍格'] = { deploy: noop, abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0, run: c => {
  c.g.rowOf(c.self).filter(u => has(u, '矮人') && u.armor > 0).forEach(u => c.boost(u, 1)); c.self.armor = Math.max(0, c.self.armor - 1);
} }] };
B['达娜梅碧：馈赠者'] = {};
B['丹尼斯·克莱默'] = { deploy: c => c.adjacent().forEach(u => { if (u.armor) c.boost(u, u.armor); }) };
B['邓卡'] = { order: c => { if (c.self.row !== 'm') return; const t = T(c, '邓卡：3 伤害', c.enemies()); if (t) c.damage(t, 3); } };
B['新王艾思娜'] = { deploy: c => c.g.spawn(YDRYAD, c.side, c.self.row, posRight(c), c.self) };
B['慈母艾思娜'] = { deploy: c => { c.g.spawn(YDRYAD, c.side, c.self.row, posRight(c), c.self); c.g.spawn(YDRYAD, c.side, c.self.row, posRight(c), c.self); } };
B['艾尔丹恩'] = { deploy: c => c.g.allUnits(c.side).filter(u => u.def.type === 'artifact' && ((isTrap(u) && !u.status.ambush) || (c.devotion() && !isTrap(u)))).forEach(u => c.transform(u, DEADEYE)) };
B['艾雷亚斯'] = { deploy: c => { const t = T(c, '艾雷亚斯：摧毁的友军', c.allies().filter(u => u !== c.self)); if (t) c.destroy(t); spawnN(c, DEADEYE, 2, c.self.row); } };
B['爱特丽尔'] = { deploy: c => { const t = T(c, '爱特丽尔：伤害', c.enemies()); if (t) c.damage(t, c.allies().some(u => u.name === '摩尔雷加') ? 7 : 3); } };
B['尤多拉·布雷肯里奇斯'] = {};
B['法芙'] = { deploy: c => { const n = fromDeck(c, '法芙：从牌组打出的自然牌'); if (n) c.playFromDeck(n, c.self.row, posRight(c)); } };
B['菲吉斯·梅鲁佐'] = { order: c => c.move(c.self, otherRow(c.self.row)) };
B['菲拉凡德芮·艾恩·菲达尔'] = { deploy: c => { const n = fromDeck(c, '菲拉凡德芮：创造并打出的特殊牌'); if (n) c.spawnPlay(n); } };
B['森林保护者'] = { deploy: c => { const n = fromDeck(c, '森林保护者：从墓场打出的自然牌'); if (n) c.g.play(c.side, n, c.self.row, posRight(c), { fromGrave: true }); } };
B['法兰茜丝卡·芬达贝'] = { abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.special && !c.self.vars.busy, run: (c, d) => {
  c.self.vars.last = d.name; c.self.vars.cnt = (c.self.vars.cnt == null ? 2 : c.self.vars.cnt) - 1;
  if (c.self.vars.cnt === 0) { c.self.vars.cnt = null; c.self.vars.busy = true; c.spawnPlay(c.self.vars.last); c.self.vars.busy = false; }   // ASSUME：倒数只数一轮后重新开始
} }] };
B['菲斯奈特'] = {
  order: c => { if (c.self.row === 'r') c.g.spawn(YDRYAD, c.side, 'r', posRight(c), c.self); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.devotion() && c.self.status.vitality > 0, run: c => c.reduceCd(c.self, c.self.status.vitality) }],
};
B['加博·齐格林'] = {
  deployRow: { m: c => c.status(c.self, 'resilience', true), r: c => c.status(c.self, 'immune', true) },
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '矮人'), run: c => c.boost(c.self, 1) }],
};
B['盖坦'] = { deploy: c => {
  const others = c.g.rowOf(c.self).filter(u => u !== c.self); const to = otherRow(c.self.row);
  others.forEach(u => c.move(u, to));
  for (let i = 0; i < others.length; i++) { const t = R(c, '盖坦：随机 1 伤害', c.enemies()); if (t) c.damage(t, 1); }
} };
B['雷达的吉兹拉斯'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => {
  if (c.self.row === 'm') { c.move(c.self, 'r'); const t = R(c, '吉兹拉斯：随机友军 +1', c.allies().filter(u => u.row === 'r' && u !== c.self)); if (t) c.boost(t, 1); }
  else { c.move(c.self, 'm'); const t = R(c, '吉兹拉斯：对面近战随机 1 伤害', c.enemies().filter(u => u.row === 'm')); if (t) c.damage(t, 1); }
} }] };
B['伊欧菲斯'] = { deploy: c => {
  const t = T(c, '伊欧菲斯：收回的陷阱', c.g.allUnits(c.side).filter(isTrap)); if (t) c.shuffleBack(t);
  const n = fromDeck(c, '伊欧菲斯：打出的陷阱'); if (n) c.g.play(c.side, n, c.self.row, posRight(c));
} };
B['伊森格林'] = {
  deploy: c => c.allies().filter(u => has(u, '精灵')).forEach(u => c.boost(u, 1)),
  abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '精灵'), run: c => c.boost(c.self, 1) }],
};
B['湖之守卫：暮色'] = {};
B['玛丽娜'] = { order: c => { const t = T(c, '玛丽娜：移排', c.g.units()); if (t) c.move(t, otherRow(t.row)); } };
B['米尔瓦'] = { abilities: [{ on: 'moved', when: (c, d) => d.unit.side === c.side && d.unit !== c.self, run: c => c.boost(c.self, 1) }] };
B['米尔瓦：神射手'] = { order: c => { const t = T(c, '米尔瓦：1 伤害', c.enemies()); if (t) c.damage(t, 1); }, deathblow: c => c.shuffleBack(c.self) };
B['莫丽恩'] = { deployRow: {
  m: c => { const t = T(c, '莫丽恩：2 伤害', c.enemies()); if (t) c.damage(t, 2); },
  r: c => { const t = T(c, '莫丽恩：锁定', c.g.units().filter(u => u !== c.self)); if (t) c.lock(t); },
} };
B['摩尔雷加'] = { deploy: c => { const t = T(c, '摩尔雷加：3 伤害', c.enemies()); if (!t) return; const adj = c.adjacent(t); c.damage(t, 3); if (c.allies().some(u => u.name === '爱特丽尔')) adj.forEach(u => c.damage(u, 3)); } };
B['穆罗·布鲁伊斯'] = { order: c => {
  const t = T(c, '穆罗：变成矮人狂战士', c.allies().filter(u => u.name === ROWDY)); if (t) c.transform(t, '矮人狂战士');
  if (c.self.armor > 0) c.self.cd = 1;   // 壁垒
} };
B['保利·达尔伯格'] = {
  deploy: c => { const t = T(c, '保利：移排', c.g.units().filter(u => u !== c.self)); if (t) c.move(t, otherRow(t.row)); },
  order: c => { const t = T(c, '保利：2 护甲', c.allies()); if (t) c.armor(t, 2); },
};
B['帕扶科“舅舅”盖尔'] = { order: c => { if (c.self.row !== 'r') return; const t = T(c, '盖尔：伤害', c.g.units()); if (t) c.damage(t, c.allies().every(u => !neutral(u)) ? 2 : 1); } };
B['帕西瓦尔·舒滕巴赫'] = {};
B['夸里西斯'] = { abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '残物'), run: c => c.spawnPlay('圣日湖：融合') }] };
B['李欧丹恩'] = { deploy: c => {
  const adj = c.adjacent(); if (!adj.some(u => isTrap(u) || has(u, '精灵'))) return;
  const n = fromDeck(c, '李欧丹恩：从牌组打出'); if (n) c.playFromDeck(n, c.self.row, posRight(c));
} };
B['刃齿虎'] = { order: c => c.transform(c.self, '刃齿虎：潜行', { keepPower: true }) };
B['萨琪亚萨司'] = {
  order: c => { c.self.status.immune = false; c.self.vars.back = true; },
  abilities: [{ on: 'turnStart', when: (c, d) => d.side === c.side && c.self.vars.back, run: c => { c.self.status.immune = true; c.self.vars.back = false; } }],
};
B['萨琪亚'] = {
  deploy: c => { const n = fromDeck(c, '萨琪亚：生成的单位'); if (!n) return; c.g.spawn(n, c.side, c.self.row, posRight(c), c.self); c.self.vars.kind = n; },
  order: c => { const m = { [DEADEYE]: '伏击', [ROWDY]: '淬火', [YDRYAD]: '树精的呵护' }[c.self.vars.kind]; if (m) c.spawnPlay(m); },
};
B['萨琪亚：指挥官'] = { timer: { n: 3, run: noop } };   // 召唤的单位靠记录
B['希鲁'] = { order: c => { const p = c.self.power; c.g.units().filter(u => u !== c.self && u.power === p).forEach(u => c.destroy(u)); } };
B['谢尔顿·斯卡格斯'] = { deployRow: { m: c => { const n = c.self.power - c.self.base; const t = T(c, '谢尔顿：伤害', c.enemies()); if (t && n > 0) c.damage(t, n); } } };
B['希姆莱斯·芬达贝'] = { deploy: c => { for (let i = 0; i < 3; i++) { const n = fromDeck(c, '希姆莱斯：从牌组打出的特殊牌'); if (!n) break; c.playFromDeck(n, c.self.row); } } };
B['茜尔莎'] = { deploy: c => { const t = T(c, '茜尔莎：2 伤害', c.enemies()); if (t) c.damage(t, 2); } };
B['特利安尼·科伦'] = {
  deploy: c => {
    const t = T(c, '特利安尼：洗回的友军', c.allies().filter(u => u !== c.self && (u.def.prov || 0) <= 9)); if (t) c.shuffleBack(t);
    const n = fromDeck(c, '特利安尼：打出的精灵'); if (n) c.playFromDeck(n, c.self.row, posRight(c));
  },
  order: c => {
    if (c.self.status.doomed) { const k = c.allies().filter(u => c.g.isDoomed(u)).length; const t = T(c, '特利安尼：伤害', c.enemies()); if (t) c.damage(t, k); }
    else c.spawnPlay('备用计划');
  },
};
B['巨橡'] = { deploy: c => {
  const row = c.g.rowOf(c.self), i = row.indexOf(c.self);
  const t = T(c, '巨橡：伤害', c.enemies()); if (t && i) c.damage(t, i);
  if (row.length - 1 - i > 0) c.boost(c.self, row.length - 1 - i);
} };
B['托克'] = {};
B['托露薇尔'] = { deploy: c => {
  const both = c.allies().some(u => u.name === DEADEYE);
  const pick = T(c, '托露薇尔：选对方一排（点该排的单位）', c.enemies()); if (!pick) return;
  const row = c.g.rowOf(pick);
  if (c.self.row === 'm' || both) { const ends = [row[0], row[row.length - 1]].filter((u, i, a) => u && a.indexOf(u) === i); ends.forEach(u => c.damage(u, 2)); }
  if (c.self.row === 'r' || both) c.g.rowOf(pick).slice().forEach(u => c.damage(u, 1));
} };
B['树人野猪'] = {
  deploy: c => { if (c.allies().some(u => has(u, '树精'))) c.self.zeal = true; },
  order: c => {
    if (c.self.row === 'm') { c.move(c.self, 'r'); c.heal(c.self); }
    else { c.move(c.self, 'm'); const t = T(c, '树人野猪：2 伤害', c.enemies()); if (t) c.damage(t, 2); }
  },
};
B['万纳丁'] = { deploy: noop, abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.name === '伏击', run: c => c.g.spawn(DEADEYE, c.side, c.self.row, posRight(c), c.self) }] };
B['弗妮希尔'] = { deployRow: {
  m: c => c.allies().filter(u => u.name === DEADEYE).forEach(() => { const t = R(c, '弗妮希尔：暗箭手随机 2 伤害', c.enemies()); if (t) c.damage(t, 2); }),
  r: c => spawnN(c, DEADEYE, 2, c.self.row),
} };
B['嚎哭之柳'] = {
  order: c => { if (c.self.row !== 'm') return; const n = new Set(c.allies().map(u => (u.tags || [])[0]).filter(Boolean)).size; c.boost(c.self, n); },
  deployRow: { r: c => { const t = T(c, '嚎哭之柳：中毒', c.enemies()); if (t) c.status(t, 'poison'); } },
};
B['泽维尔·莫兰'] = { abilities: [
  { on: 'unitPlayed', when: (c, d) => own(c, d) && c.self.row === 'm' && d.unit !== c.self && has(d.unit, '矮人'), run: c => c.armor(c.self, 1) },
  { on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0, run: c => c.boost(c.self, 1) },
] };
B['亚伊文'] = { deploy: c => { const n = c.g.rowOf(c.self).filter(u => has(u, '精灵')).length; const t = T(c, '亚伊文：伤害', c.enemies()); if (t) c.damage(t, n); } };
B['亚尔潘·齐格林'] = {
  deploy: c => { const t = T(c, '亚尔潘：3 伤害', c.enemies()); if (t) c.damage(t, 3); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0, run: c => { const a = c.self.armor; c.self.armor = 0; c.boost(c.self, a); } }],
};
B['卓尔坦·齐瓦'] = { deploy: c => c.adjacent().filter(u => has(u, '矮人')).forEach(u => c.boost(u, 2)) };
B['卓尔坦：矮人战士'] = {
  deploy: c => { const ts = c.g.choose({ prompt: '卓尔坦：2 个敌军各 3', from: c.targets(c.enemies()), n: 2, upTo: true, source: c.self.name });
    ts.forEach(t => { c.damage(t, 3); if (c.g.find(t.uid)) c.g.spawn(ROWDY, c.side, c.self.row, posRight(c), c.self); }); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0, run: c => { const t = R(c, '卓尔坦：随机 1 伤害', c.enemies()); if (t) c.damage(t, 1); } }],
};
B['哈托利'] = { abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.def.type === 'artifact', run: c => { const t = lowestOf(c, c.allies(), '哈托利：最低友军并列'); if (t) c.boost(t, 3); } }] };

// 铜色单位
B['弃女'] = { order: c => { c.transform(c.self, YDRYAD, { keepPower: true }); const n = c.g.rowOf(c.self).filter(u => has(u, '树精')).length; if (n) c.status(c.self, 'vitality', n); } };
B['幻形兽'] = { order: c => { const t = T(c, '幻形兽：灌注和谐', c.allies().filter(u => u !== c.self)); if (t) c.infuse(t, { name: '和谐', on: 'unitPlayed', when: (cc, e) => (e.by || e.unit.side) === cc.side && !neutral(e.unit) && cc.g.uniquePrimary(e.unit), run: cc => cc.boost(cc.self, 1) }); } };
B['蓝山精锐'] = { deployRow: { r: c => { const t = T(c, '蓝山精锐：3 伤害', c.enemies().filter(u => c.g.rowOf(u).length === 1)); if (t) c.damage(t, 3); } } };
B['布洛克莱昂哨兵'] = { deploy: c => { const t = T(c, '布洛克莱昂哨兵：2 伤害', c.enemies()); if (t) c.damage(t, 2); } };
B['猫学派猎魔人'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => {
  c.move(c.self, otherRow(c.self.row));
  const t = R(c, '猫学派猎魔人：对面排随机 1 伤害', c.enemies().filter(u => u.row === c.self.row)); if (t) c.damage(t, 1);   // 亢奋（手牌数）无法推算
} }] };
B['猫学派猎魔人学徒'] = { deployRow: {
  m: c => { const t = T(c, '猫学派学徒：重伤', c.enemies()); if (t) c.status(t, 'bleed', c.g.rowOf(t).length); },
  r: c => { const t = T(c, '猫学派学徒：活力', c.allies()); if (t) c.status(t, 'vitality', c.g.rowOf(t).length); },
} };
B['猫学派猎魔人导师'] = { deploy: c => c.boost(c.self, c.g.rowOf(c.self).length - 1) };
B['猫学派猎魔人恶徒'] = { deploy: c => { const t = T(c, '猫学派恶徒：敌军', c.enemies()); if (!t) return; const i = c.g.rowOf(t).indexOf(t); c.move(t, t.row, 0); c.damage(t, 1 + i); } };
B['变色龙'] = { deploy: noop, order: c => {
  c.self.base = Math.max(0, c.self.base - 1); c.self.power = c.self.base; c.g.log('重新打出', { name: c.self.name, base: c.self.base });
  c.g.emit('unitPlayed', { unit: c.self, by: c.side });
} };
B['多尔·布雷坦纳爆破手'] = { deploy: c => c.g.choose({ kind: 'random', prompt: '爆破手：2 个随机敌军', from: c.enemies(), n: 2, upTo: true, source: c.self.name }).forEach(u => c.damage(u, 2)) };
B['多尔·布雷坦纳射手'] = { deploy: c => { const t = T(c, '射手：伤害', c.enemies()); if (!t) return; const n = (c.self.row === 'r' ? 1 : 0) + (t.row === 'r' ? 1 : 0); if (n) c.damage(t, n); } };
B['多尔·布雷坦纳哨兵'] = { abilities: [{ on: 'moved', when: (c, d) => d.unit !== c.self && ((c.self.row === 'm' && d.unit.side === c.foe) || (c.self.row === 'r' && d.unit.side === c.side)), run: (c, d) => { if (d.unit.side === c.foe) c.damage(d.unit, 1); else c.boost(d.unit, 1); } }] };
B['树精附魔师'] = { deployRow: {
  m: c => { const t = T(c, '树精附魔师：4 护甲', c.allies().filter(u => u !== c.self)); if (t) c.armor(t, 4); },
  r: c => { const t = T(c, '树精附魔师：活力 4', c.allies().filter(u => u !== c.self)); if (t) c.status(t, 'vitality', 4); },
} };
B['树精林卫'] = { deploy: c => c.status(c.self, 'vitality', c.g.cohort(c.self) ? 4 : 2) };
B['树精族母'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side, run: c => { c.move(c.self, c.self.row, null); const row = c.g.rowOf(c.self); const l = row[row.indexOf(c.self) - 1]; if (l) c.boost(l, 1); } }] };
B['树精游侠'] = { deployRow: {
  m: c => { const t = T(c, '树精游侠：2 伤害', c.enemies()); if (t) c.damage(t, 2); },
  r: c => { const t = T(c, '树精游侠：中毒', c.enemies()); if (t) c.status(t, 'poison'); },
} };
B['橡树之地护卫'] = { order: c => { const t = T(c, '橡树之地护卫：2 伤害', c.enemies()); if (t) c.damage(t, 2); } };
B['矮人狂战士'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0, run: c => { c.damage(c.self, 1); const t = R(c, '矮人狂战士：随机 1 伤害', c.enemies()); if (t) c.damage(t, 1); } }] };
B['矮人煽动分子'] = { deploy: noop, abilities: [{ on: 'unitPlayed', when: (c, d) => own(c, d) && d.unit !== c.self && has(d.unit, '矮人'), run: (c, d) => c.armor(d.unit, 1) }] };
B['矮人战车'] = {
  deployRow: { m: c => { c.boost(c.self, 4); c.armor(c.self, 2); }, r: c => spawnN(c, ROWDY, 2, 'm') },
  order: c => { const t = T(c, '矮人战车：1 护甲', c.allies()); if (t) c.armor(t, 1); },
};
B['矮人佣兵'] = { deploy: noop };   // 按手牌里非矮人数量自伤：靠落地战力
B['矮人好斗分子'] = {
  deployRow: { m: c => { const t = T(c, '好斗分子：3 伤害', c.enemies()); if (!t) return; c.damage(t, 3); if (c.g.find(t.uid)) c.armor(c.self, 1); } },
  order: c => { if (c.self.armor <= 0) return; const t = T(c, '好斗分子：3 伤害', c.enemies()); if (t) c.damage(t, 3); },
};
B['精灵斥候'] = { abilities: [{ on: 'flipped', when: (c, d) => d.unit.side === c.side && isTrap(d.unit), run: c => c.boost(c.self, 2) }] };
B['精灵文官'] = { abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.special && !c.self.vars.done, run: c => {
  c.self.vars.cnt = (c.self.vars.cnt == null ? 3 : c.self.vars.cnt) - 1; if (c.self.vars.cnt === 0) { c.self.vars.done = true; c.boost(c.self, 6); }
} }] };
B['精灵战舞者'] = { deploy: c => { const t = T(c, '精灵战舞者：伤害', c.enemies()); if (t) c.damage(t, c.g.isBoosted(c.self) ? 3 : 1); } };
B['先知（Farseer）'] = { deploy: noop };
B['林语者'] = {
  deployRow: { m: c => { const t = T(c, '林语者：中毒', c.enemies()); if (t) c.status(t, 'poison'); } },
  order: c => { if (c.self.row !== 'r') return; const t = T(c, '林语者：活力 3', c.allies()); if (t) c.status(t, 'vitality', 3); },
};
B['巨人杀手'] = {
  deploy: c => { const t = T(c, '巨人杀手：选择的敌军', c.enemies()); if (!t) return; c.self.vars.t = t; if (t.base > c.self.base) c.armor(c.self, 3); },
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0 && c.self.vars.t && c.g.find(c.self.vars.t.uid), run: c => c.damage(c.self.vars.t, 1) }],
  deathblow: c => c.status(c.self, 'resilience', true),
};
B['半精灵猎人'] = { deploy: c => c.g.spawn(DEADEYE, c.side, c.self.row, posRight(c), c.self) };
B['林中之女'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.status.vitality > 0, run: c => c.boost(c.self, 1) }] };
B['私枭治疗者'] = { deployRow: {
  m: c => { const t = T(c, '私枭治疗者：2 增益', c.allies().filter(u => u !== c.self)); if (t) c.boost(t, 2); },
  r: c => { const t = T(c, '私枭治疗者：治疗 4', c.allies().filter(u => u !== c.self && u.power < u.base)); if (t) { const n = Math.min(4, t.base - t.power); t.power += n; c.g.log('治疗', { name: t.name, n }); } },
} };
B['私枭走私者'] = {};
B['私枭后援者'] = { deploy: noop };
B['人质劫持者'] = { deploy: c => {
  const lim = c.g.s.sides[c.side].vars.trapsRound || 0;
  const t = T(c, '人质劫持者：抓捕', c.enemies().filter(u => u.power <= lim)); if (!t) return;
  c.seize(t); c.transform(t, DEADEYE, { keepPower: true });
} };
B['玛哈坎捍卫者'] = { abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && c.self.armor > 0, run: c => c.boost(c.self, 1) }] };
B['玛哈坎守卫'] = { deploy: c => c.boost(c.self, c.g.rowOf(c.self).filter(u => u !== c.self && has(u, '矮人')).length) };
B['玛哈坎勇士'] = { deploy: c => { const t = T(c, '玛哈坎勇士：参考护甲的友军', c.allies().filter(u => u !== c.self && u.armor > 0)); if (!t) return; if (c.self.armor > 0) c.boost(c.self, t.armor); else c.status(c.self, 'vitality', t.armor); } };
B['玛哈坎志愿军'] = {};
B['矿工'] = { order: c => { const t = T(c, '矿工：2 增益', c.allies()); if (!t) return; c.boost(t, 2); if (has(t, '矮人')) c.armor(t, 4); } };
B['新生水精'] = {
  abilities: [{ on: 'symbiosis', when: (c, d) => d.side === c.side, run: c => { const row = c.g.rowOf(c.self); const l = row[row.indexOf(c.self) - 1]; if (l) c.status(l, 'vitality', 2); } }],
  order: c => { const t = T(c, '新生水精：移除活力', c.allies().filter(u => u.status.vitality > 0)); if (!t) return; const n = t.status.vitality; t.status.vitality = 0; c.boost(c.self, n); },
};
B['水精守池者'] = { deployRow: {
  m: c => { const tr = c.allies().find(u => u.name === '游荡的树人'); const t = T(c, '水精守池者：伤害', c.enemies()); if (tr && t) { c.damage(t, tr.power); c.reset(tr); } },
  r: c => { const t = T(c, '水精守池者：灌注共生', c.allies().filter(u => u !== c.self && !u.def.symbiosis)); if (t) { t.symbiosis = true; c.g.log('灌注', { name: t.name, what: '共生' }); } },
} };
B['橡树之灵'] = { deployRow: {
  m: c => { const t = T(c, '橡树之灵：重伤 4', c.enemies()); if (t) c.status(t, 'bleed', 4); if (c.devotion()) c.g.spawn('橡树之灵', c.side, c.self.row, posRight(c), c.self); },
  r: c => { c.g.spawn('橡树之灵', c.side, c.self.row, posRight(c), c.self); if (c.devotion()) { const t = T(c, '橡树之灵：重伤 4', c.enemies()); if (t) c.status(t, 'bleed', 4); } },
} };
B['黑豹'] = { deployRow: {
  m: c => { const t = T(c, '黑豹：2 伤害', c.enemies()); if (t) c.damage(t, 2); },
  r: c => { const t = T(c, '黑豹：重伤 4', c.enemies()); if (t) c.status(t, 'bleed', 4); },
} };
B['烟火技师'] = { order: c => { const t = R(c, '烟火技师：随机 4 伤害', c.enemies()); if (t) c.damage(t, 4); c.damage(c.self, 4); } };
B['松鼠党新兵'] = {
  deploy: c => c.g.spawn('松鼠党新兵', c.side, otherRow(c.self.row), null, c.self),
  order: c => { const t = T(c, '新兵：变成暗箭手的精灵', c.allies().filter(u => has(u, '精灵'))); if (t) c.transform(t, DEADEYE); },
};
B['多尔·布雷坦纳女术士'] = { order: c => { const n = fromDeck(c, '女术士：创造并打出的特殊牌'); if (n) c.spawnPlay(n); } };
B['驾鹰'] = { deployRow: {
  m: c => { const t = T(c, '驾鹰：2 伤害', c.enemies()); if (t) c.damage(t, 2); },
  r: c => { const t = T(c, '驾鹰：移排', c.g.units().filter(u => u !== c.self)); if (t) c.move(t, otherRow(t.row)); },
} };
B['陷阱制造者'] = { deploy: c => c.boost(c.self, 3 * c.g.allUnits(c.side).filter(u => isTrap(u) && u.status.ambush).length) };
B['诈骗师'] = { deploy: c => {
  const t = c.g.s.sides[c.foe].vars.lastUnit; if (!t || !c.g.find(t.uid)) return;
  c.move(t, otherRow(t.row));
  c.infuse(t, { name: '诈骗师灌注', on: 'unitPlayed', when: (cc, e) => (e.by || e.unit.side) === cc.foe && has(e.unit, '精灵'), run: cc => cc.g.damage(cc.self, 1, { name: '诈骗师' }) });
} };
B['维里赫德旅'] = {
  deploy: c => { const t = T(c, '维里赫德旅：2 伤害', c.enemies()); if (t) c.damage(t, 2); },
  abilities: [{ on: 'moved', when: (c, d) => d.unit === c.self, run: c => { const t = R(c, '维里赫德旅：移动时随机 2 伤害', c.enemies()); if (t) c.damage(t, 2); } }],
};
B['维里赫德旅军官'] = { deploy: c => {
  const both = c.g.cohort(c.self);
  if (c.self.row === 'm' || both) { const t = T(c, '军官：2 伤害', c.enemies()); if (t) c.damage(t, 2); }
  if (c.self.row === 'r' || both) { const t = T(c, '军官：2 增益', c.allies().filter(u => u !== c.self)); if (t) c.boost(t, 2); }
} };
B['维里赫德旅破坏者'] = { deploy: c => { if (c.g.allUnits(c.side).some(u => u.def.type === 'artifact')) c.g.spawn(DEADEYE, c.side, c.self.row, posRight(c), c.self); } };
B['维里赫德旅工兵'] = { deploy: c => { const any = c.allies().some(u => u !== c.self && has(u, '精灵')); const t = T(c, '工兵：净化', any ? c.g.units() : c.allies()); if (t) c.purify(t); } };
B['山谷看守者'] = { deploy: c => { const n = c.self.power - c.self.base; const t = T(c, '山谷看守者：敌军', c.enemies()); if (!t || n <= 0) return; if (c.g.cohort(c.self)) c.damage(t, n); else c.status(t, 'bleed', n); } };
B['多尔·布雷坦纳低语者'] = { abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.special && !c.self.vars.done, run: c => { c.self.vars.done = true; c.g.spawn('多尔·布雷坦纳低语者', c.side, c.self.row, posRight(c), c.self); } }] };

// ================= 松鼠党 · 目前对局里出现过的 =================
B['活力回春'] = { charges: 3, order: c => c.g.log('手牌增益（隐藏）', { side: c.side }) };
B['伊斯琳妮'] = { deploy: c => c.g.log('手牌增益（隐藏）', { side: c.side }) };
B['维里赫德旅先锋'] = {
  // 近战：按手牌精灵数（隐藏），靠录入战力；远程：同排友军精灵数（ASSUME：不算自己）
  deployRow: { r: c => c.boost(c.self, c.g.rowOf(c.self).filter(u => u !== c.self && isElf(u)).length) },
};
B['麦莉'] = {
  deployRow: {
    m: c => { const t = T(c, '麦莉：4 伤害', c.enemies()); if (t) c.damage(t, 4); },
    r: c => c.g.choose({ prompt: '麦莉：4 个敌军各 1', from: c.targets(c.enemies()), n: 4, upTo: true }).forEach(u => c.damage(u, 1)),
  },
};
B['多尔·布雷坦纳弓箭手'] = {
  deployRow: {
    m: c => { const t = T(c, '弓箭手：3 伤害', c.enemies()); if (t) c.damage(t, 3); },
    r: c => c.g.choose({ prompt: '弓箭手：2 个单位各 1', from: c.targets(c.g.units()), n: 2 }).forEach(u => c.damage(u, 1)),
  },
  deathblow: c => c.spawn('精灵暗箭手', c.side, c.self.row),
};
B['精灵暗箭手'] = { status: { doomed: true } };
B['精灵剑术大师'] = {
  cooldown: 2,
  order: c => { if (c.self.row !== 'm') return; const t = T(c, '剑术大师：1 伤害', c.enemies()); if (t) c.damage(t, 1); },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && d.unit !== c.self && (d.def.tags || []).includes('精灵'), run: c => { if (c.self.cd > 0) c.self.cd--; } }],
};
B['爱黎瑞恩'] = {};   // 回合结束从牌组召唤自身：由记录的“召唤”步骤触发
B['弗妮希尔的突击队'] = {
  abilities: [{ on: 'turnEnd', when: (c, d) => d.side === c.side && (c.allies().every(isElf) || c.allies().some(u => u.name === '弗妮希尔')), run: c => c.boost(c.self, 1) }],
};
B['维里赫德旅骑兵'] = {
  deploy: c => {
    const t = T(c, '骑兵：移动目标', c.g.units());
    if (!t) return;
    c.move(t, t.row === 'm' ? 'r' : 'm');
    if (t.side === c.side) c.boost(t, 2); else c.damage(t, 1);
  },
};
B['艾达·艾敏'] = {
  deployRow: {
    m: c => { const t = T(c, '艾达：净化', c.g.units()); if (t) c.purify(t); },
    r: c => { const t = T(c, '艾达：活力 3', c.allies()); if (t) c.status(t, 'vitality', 3); },
  },
};
B['席朗·依斯尼兰'] = {
  deploy: c => { const t = T(c, '席朗：锁定并移排', c.g.units()); if (t) { c.lock(t); c.move(t, t.row === 'm' ? 'r' : 'm'); } },
};

// ================= 中立 · 整排效果牌 =================
// 放在哪排由对局簿的“整排效果”记录决定（打出这些牌后界面会直接进入整排效果）
const HZ = (kind, turns) => ({ hazardCard: { kind, turns }, onPlay: () => {} });
B['刺骨冰霜'] = HZ('霜', 3);
B['倾盆大雨'] = HZ('雨', 3);
B['蔽日浓雾'] = HZ('雾', 3);
B['史凯利格风暴'] = HZ('风暴', 2);
B['龙之梦'] = HZ('龙之梦', 3);
B['晴空'] = { onPlay: (c, o) => { const row = (o && o.row) || 'm'; c.g.units(c.side).filter(u => u.row === row).forEach(u => c.boost(u, 1)); } };

// ================= 辛迪加 · 金币系统示例 =================
B['坑道钻机'] = {
  fee: { n: 2, run: c => { const t = T(c, '坑道钻机：3 伤害', c.enemies()); if (t) c.damage(t, 3); } },
  abilities: [{ on: 'cardPlayed', when: (c, d) => d.side === c.side && (d.def.tags || []).includes('罪行'), run: c => { if (c.self.cd > 0) c.self.cd--; } }],
};
B['大审讯官赫韦德'] = {
  fee: { n: 2, run: c => { const row = c.g.rowOf(c.self); c.spawn('火誓狂热者', c.side, c.self.row, row.indexOf(c.self) + 1); } },
};

const API = { behaviors: B };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.GwentCards = API;
})(this);
