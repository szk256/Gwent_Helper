/* 卡牌行为 v0.1：只写“这张牌做什么”，数值（战力、护甲、粮草、标签）来自对局簿 RAW。
 * 每张牌由积木组合：boost / damage / armor / status / spawn / summon / reset / duel / infuse / pick ...
 * 标 ASSUME 的地方是卡面没写清、按推测建模的，靠比分校准。
 */
(function (root) {
'use strict';
const isKnight = u => (u.tags || []).includes('骑士');
const isElf = u => (u.tags || []).includes('精灵');
const own = (c, d) => d.unit.side === c.side;
// 手动指定目标：免疫的不能选，对方有卫士时只能选卫士（引擎 targetable）
const T = (c, prompt, from) => c.pick({ prompt, from: c.targets(from) });

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

const API = { behaviors: B };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.GwentCards = API;
})(this);
