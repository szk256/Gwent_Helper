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
