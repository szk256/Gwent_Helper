/* 昆特牌规则引擎 · 底层系统 v0.1
 * 只含底层：状态模型、基础动作（积木）、事件、回合与小局流程、通用关键词机制。
 * 卡牌定义以后单独导入（registerCard），本文件不含任何具体卡牌。
 * 浏览器与 Node 通用：浏览器里是 window.GwentEngine，Node 里 require。
 */
(function (root) {
'use strict';

// ---------- 可调规则参数（尚未确认的规则都放这里，靠比分校准） ----------
const DEFAULT_RULES = {
  handLimit: 10,
  draws: [10, 3, 3],          // 各小局开始抽牌数
  mulligans: [2, 2, 2],       // 各小局换牌数
  firstMulliganBonus: 1,      // 先手第一局额外换牌
  rowLimit: Infinity,         // 单排单位上限（未确认）
  shieldBeforeArmor: true,    // 护盾先于护甲抵挡
  bleedIgnoresShield: false,  // 重伤是否无视护盾（未确认）
  roundWinnerGoesFirst: true, // 上一局胜者先手
  reynardSelf: false,         // 雷纳德神赐/指令“所有受到增益的友军”是否包括他自己（已确认：不包括）
  spawnBanished: false,       // 生成的牌离场时一律放逐（未确认；衍生牌卡面都写了“佚亡”，按状态放逐）
  purifyKeepsDoomed: false,   // 净化会移除佚亡，之后离场进墓场（用户查证）
  resilienceKeepsDamage: false,// 坚韧留场时回到基础战力（资料有分歧，暂按 NamuWiki：伤害也恢复）
  knightSummonSelf: false,    // 骑士册封“己方每控制 1 名骑士”不算被拉出的骑士自己（已确认）
  timerRepeats: true,         // 计时归零触发后重新计时（未确认）
  dragonDreamOnLast: true,    // 龙之梦在最后一个回合开始时爆炸（未确认）
  coinLimit: 9,               // 金币上限（词条辞典）
  autoTribute: true,          // 献金：没有记录时，金币够就当作付了（未确认，对局簿可逐次记录）
  feeSameTurn: true,          // 费用能力进场当回合就能用（未确认）
  ambushCounts: true,         // 伏击（背面朝上）的单位战力是否计入总分（未确认）
  harmonySelf: true,          // 和谐：打出的正是这张和谐牌时是否也算（未确认）
  frenzyDefault: false,       // 亢奋：没有记录、也推算不出手牌数时按不成立（未确认）
  specialTargetEach: true,    // 特殊牌一次指定多个单位时，每个都算“以其为目标”（棱镜吊坠、精灵先知；未确认）
  stickyUsesBase: false,      // 棘手困境“战力不高于 4”看落地战力（true = 看卡面基础战力；未确认）
  graveSelfPlayCounts: true,  // 洞察之球从墓场打出自己时算“己方打出特殊牌”（未确认）
};

// ---------- 整排效果（灾厄）：拥有者回合开始时结算，见词条辞典 ----------
// turns：卡面给的持续回合数；每次结算后 -1，归零移除
const HAZARDS = {
  '霜':   { turns: 3, run: (g, us, h) => { const t = g._pickExtreme(us, 1, h); if (t) g.damage(t, 2, h); } },
  '雨':   { turns: 3, run: (g, us, h) => g.choose({ kind: 'random', prompt: '雨：2 个随机单位', from: us, n: 2, upTo: true, source: h.name }).forEach(u => g.damage(u, 1, h)) },
  '雾':   { turns: 3, run: (g, us, h) => { const t = g._pickExtreme(us, -1, h); if (t) g.damage(t, 2, h); } },
  '风暴': { turns: 2, run: (g, us, h) => us.forEach(u => g.damage(u, 1, h)) },
  '龙之梦': { turns: 3, run: (g, us, h) => { if (h.turns === 1 || !g.rules.dragonDreamOnLast) us.forEach(u => g.damage(u, 3, h)); } },
  '血月': { turns: 2, run: (g, us, h) => {
    const t = us.length === 1 ? us[0] : g.choose({ kind: 'random', prompt: '血月：随机单位', from: us, source: h.name })[0];
    if (!t) return;
    if (t.status.bleed > 0) g.damage(t, 2, h); else g.addStatus(t, 'bleed', 2, h);
  } },
  '灾厄': { turns: 2, run: (g, us, h) => {
    // 3 点伤害随机分摊：逐点结算（每点单独过护盾、护甲）
    const hits = us.length === 1 ? [us[0], us[0], us[0]] : g.choose({ kind: 'random', prompt: '灾厄：3 点随机分摊（可重复）', from: us, n: 3, source: h.name });
    hits.slice(0, 3).forEach(u => g.damage(u, 1, h));
  } },
};
// 卡面只写关键词的段落（“护盾。”“佚亡。”），读数据时直接变成状态/属性
const KW_STATUS = { '护盾': 'shield', '佚亡': 'doomed', '免疫': 'immune', '坚韧': 'resilience', '遮蔽': 'veil', '卫士': 'defender' };
const KW_FLAG = { '列阵': 'formation', '狂热': 'zeal' };

const OTHER = { me: 'op', op: 'me' };
const ROWS = ['m', 'r'];

// ---------- 工具 ----------
function clone(o) { return JSON.parse(JSON.stringify(o)); }

class Game {
  constructor(opts = {}) {
    this.rules = Object.assign({}, DEFAULT_RULES, opts.rules || {});
    this.cards = opts.cards || {};          // 卡牌定义表 name -> def
    this.chooser = opts.chooser || null;
    this.manualRounds = !!opts.manualRounds;   // 对局簿里每局单独推算，不自动进入下一局    // 选择回调 (req) => 选择结果
    this.handlers = {};                     // 事件监听
    this.trace = [];                        // 每个动作的记录，用于校准
    this.nextUid = 1;
    this.depth = 0;
    this.s = {
      round: 0, turn: 0, active: opts.first || 'me', first: opts.first || 'me',
      over: false,
      sides: { me: this._side(), op: this._side() },
      hazards: { me: { m: null, r: null }, op: { m: null, r: null } },
      results: [],
    };
  }
  _side() {
    return { rows: { m: [], r: [] }, hand: [], handCount: 0, deck: [], grave: [],
             banished: [], passed: false, wins: 0, leaderCharges: 0, coins: 0, vars: {}, graveWatch: [], deckBuff: {} };
  }

  // ---------- 卡牌定义 ----------
  registerCard(def) { this.cards[def.name] = def; }
  // 数据（来自对局簿 RAW）+ 行为（卡牌脚本）合并；没有行为的牌标为未建模
  def(name) {
    if (this.cards[name]) return this.cards[name];
    const data = this.data && this.data[name];
    const beh = this.behaviors && this.behaviors[name];
    const d = Object.assign({ name, base: 0, abilities: [] }, data || {}, beh || {});
    d.status = Object.assign({}, data && data.status, beh && beh.status);
    d.abilities = (d.abilities || []).slice();
    // 恐吓：己方打出“罪行”牌时自身增益
    if (d.intimidate) d.abilities.push({ on: 'cardPlayed', when: (c, e) => e.side === c.side && e.unit !== c.self && (e.def.tags || []).includes('罪行'), run: c => c.boost(c.self, d.intimidate) });
    // 和谐：己方打出非中立单位，且其主类别（第一个类别）与己方其他单位都不同时，自身增益
    if (d.harmony) d.abilities.push({ on: 'unitPlayed', when: (c, e) => (e.by || e.unit.side) === c.side && e.unit.def.fac !== 'NE' && (e.unit !== c.self || c.g.rules.harmonySelf) && c.g.uniquePrimary(e.unit), run: c => c.boost(c.self, d.harmony) });
    // 成长：己方每打出 1 个战力更高的单位，自身增益（事件 growth 给“成长触发时”的能力用）
    if (d.growth) d.abilities.push({ on: 'unitPlayed', when: (c, e) => (e.by || e.unit.side) === c.side && e.unit !== c.self && e.unit.power > c.self.power, run: c => { c.boost(c.self, d.growth); c.g.emit('growth', { unit: c.self }); } });
    // 同化：己方打出不是来自起始牌组的牌（生成/创造出来的）时自身增益
    if (d.assimilate) d.abilities.push({ on: 'cardPlayed', when: (c, e) => e.side === c.side && e.unit !== c.self && (e.spawned || (e.unit && e.unit.origin === 'spawn')), run: c => c.boost(c.self, d.assimilate) });
    // 增兵：己方打出“战争”牌时冷却 -1
    if (d.reinforce) d.abilities.push({ on: 'cardPlayed', when: (c, e) => e.side === c.side && e.unit !== c.self && (e.def.tags || []).includes('战争'), run: c => c.g.reduceCd(c.self, 1, { name: '增兵' }) });
    if (!beh && !(data && data.vanilla)) d.unmodeled = true;
    if (!data) d.unknown = true;
    this.cards[name] = d;
    return d;
  }
  loadData(RAW) {
    const TYPE = { '单位': 'unit', '特殊': 'special', '神器': 'artifact', '领袖能力': 'leader', '战术': 'tactic' };
    this.data = this.data || {};
    for (const r of RAW) {
      const n = v => (v === '-' || v === '' ? 0 : +v);
      const text = r[8] || '';
      const d = this.data[r[0]] = {
        name: r[0], fac: r[1], color: r[2], type: TYPE[r[3]] || r[3], base: n(r[4]), prov: n(r[5]),
        tags: (r[7] || '').split(/[,、]\s*/).filter(Boolean), text, en: r[9], textEn: r[10], set: r[11], armor: n(r[13]),
        status: {},
      };
      // 通用关键词：整段只有关键词的直接读出来；全部读完的牌视为已建模（白板）
      let rest = 0;
      const kw = (seg, apply) => {
        let m;
        if (KW_STATUS[seg]) { if (apply) d.status[KW_STATUS[seg]] = true; }
        else if (KW_FLAG[seg]) { if (apply) d[KW_FLAG[seg]] = true; }
        else if ((m = seg.match(/^老兵\s*(\d*)$/))) { if (apply) d.veteran = +(m[1] || 1); }
        else if ((m = seg.match(/^冷却[：:]\s*(\d+)$/))) { if (apply) d.cooldown = +m[1]; }
        else if ((m = seg.match(/^充能[：:]\s*(\d+)$/))) { if (apply) d.charges = +m[1]; }
        else if ((m = seg.match(/^利润\s*[：:]?\s*(\d+)$/))) { if (apply) d.profit = +m[1]; }
        else if ((m = seg.match(/^恐吓\s*(\d*)$/))) { if (apply) d.intimidate = +(m[1] || 1); }
        else if (seg === '不忠') { if (apply) d.disloyal = true; }
        else if (seg === '伏击') { if (apply) d.ambush = true; }
        else if (seg === '回响') { if (apply) d.echo = true; }
        else if (seg === '癫狂') { if (apply) d.insanity = true; }
        else if (seg === '增兵') { if (apply) d.reinforce = true; }
        else if ((m = seg.match(/^和谐\s*(\d*)$/))) { if (apply) d.harmony = +(m[1] || 1); }
        else if (seg === '共生') { if (apply) d.symbiosis = true; }
        else if ((m = seg.match(/^成长\s*(\d*)$/))) { if (apply) d.growth = +(m[1] || 1); }
        else if (seg === '翼守') { if (apply) d.flanking = true; }
        else if ((m = seg.match(/^同化\s*(\d*)$/))) { if (apply) d.assimilate = +(m[1] || 1); }
        else if ((m = seg.match(/^耐性\s*(?:[（(](近战|远程)[）)])?$/))) { if (apply) d.patience = m[1] === '近战' ? 'm' : m[1] === '远程' ? 'r' : true; }
        else return false;
        return true;
      };
      for (const seg of text.split(/\s*\/\s*/).map(x => x.replace(/[。.．\s]+$/, '').trim()).filter(Boolean)) {
        const tm = seg.match(/^计时\s*(\d+)\s*[：:]/);   // “计时 3：……”：先记下回合数，效果靠卡牌行为
        if (tm) d.timerN = +tm[1];
        // 金币能力：先记下数额（付款由引擎处理），效果靠卡牌行为
        let mm;
        if ((mm = seg.match(/(?:^|、)\s*献金\s*(\d+)\s*[：:]/))) d.tributeN = +mm[1];
        if ((mm = seg.match(/(?:^|、)\s*费用\s*(\d+)\s*[：:]/))) d.feeN = +mm[1];
        if ((mm = seg.match(/^囤积\s*(\d+)/))) d.hoardN = +mm[1];
        if (/^伏击/.test(seg)) d.ambush = true;
        const parts = seg.split(/\s*[、，,]\s*/);          // “坚韧、护盾.”
        if (seg === '无特殊能力') continue;
        if (parts.every(x => kw(x, false))) parts.forEach(x => kw(x, true)); else rest++;
      }
      d.vanilla = r[3] === '单位' && rest === 0;
      if (d.patience) { const pm = text.match(/\[(\d+)\]/); d.patInit = pm ? +pm[1] : 0; }
    }
  }
  loadBehaviors(map) { this.behaviors = Object.assign(this.behaviors || {}, map); this.cards = {}; }
  hasTag(u, t) { return (u.tags || []).includes(t); }

  // ---------- 事件 ----------
  on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); }
  emit(evt, data) {
    (this.handlers[evt] || []).forEach(fn => fn(data, this));
    // 场上单位自带的监听（卡牌能力），锁定的单位不响应
    for (const u of this.allUnits()) {
      if (u.status.lock) continue;
      for (const ab of u.def.abilities || []) {
        if (ab.on === evt && (!ab.when || ab.when(this.ctx(u), data))) ab.run(this.ctx(u), data);
      }
      for (const inf of u.infused) {
        if (inf.on === evt && (!inf.when || inf.when(this.ctx(u), data))) inf.run(this.ctx(u), data);
      }
    }
    // 墓场里的牌的能力（graveAbilities）：牌离开墓场后自动失效
    for (const sd of ['me', 'op']) {
      const S = this.s.sides[sd];
      if (!S.graveWatch || !S.graveWatch.length) continue;
      const cnt = {};
      S.graveWatch = S.graveWatch.filter(w => { cnt[w.name] = (cnt[w.name] || 0) + 1; return S.grave.filter(n => n === w.name).length >= cnt[w.name]; });
      for (const w of S.graveWatch.slice()) {
        if (!S.graveWatch.includes(w)) continue;
        const d = this.def(w.name), c = this.graveCtx(w);
        for (const ab of d.graveAbilities || []) if (ab.on === evt && (!ab.when || ab.when(c, data))) ab.run(c, data);
      }
    }
  }
  // 墓场里的牌用的上下文：self 是一个伪单位，vars 保存计数
  graveCtx(w) {
    const pseudo = { side: w.side, name: w.name, def: this.def(w.name), uid: null, vars: w.vars, status: {} };
    const c = this.ctx(pseudo);
    c.leaveGrave = () => { const S = this.s.sides[w.side], i = S.graveWatch.indexOf(w); if (i >= 0) S.graveWatch.splice(i, 1); };
    return c;
  }

  // ---------- 查询 ----------
  allUnits(side) {
    const sides = side ? [side] : ['me', 'op'];
    const out = [];
    for (const sd of sides) for (const r of ROWS) out.push(...this.s.sides[sd].rows[r]);
    return out;
  }
  units(side) { return this.allUnits(side).filter(u => u.def.type !== 'artifact'); }
  find(uid) { return this.allUnits().find(u => u.uid === uid) || null; }
  rowOf(u) { return this.s.sides[u.side].rows[u.row]; }
  adjacent(u) {
    const row = this.rowOf(u), i = row.indexOf(u);
    return [row[i - 1], row[i + 1]].filter(Boolean);
  }
  // 手动指定目标：免疫的不能选；对方排上有卫士时只能选卫士
  targetable(us, bySide) {
    return us.filter(u => {
      if (u.status.immune) return false;
      if (!bySide || u.side === bySide || u.status.defender) return true;
      return !this.rowOf(u).some(v => v !== u && v.status.defender && !v.status.lock);
    });
  }
  // ---------- 条件词条（见词条辞典） ----------
  // 统御：己方控制战场上战力最高的单位（ASSUME：并列最高也算）
  dominance(side) {
    const all = this.units(); if (!all.length) return false;
    const m = Math.max(...all.map(u => u.power));
    return this.units(side).some(u => u.power === m);
  }
  // 威势：己方各排均控制战力不低于 10 的单位
  might(side) { return ROWS.every(r => this.s.sides[side].rows[r].some(u => u.def.type !== 'artifact' && u.power >= 10)); }
  // 夜宴：己方至少一排总战力不低于 25
  feast(side) { const sc = this.score(side); return ROWS.some(r => sc[r] >= 25); }
  // 壁垒：自身有护甲
  bulwark(u) { return u.armor > 0; }
  // 狂暴 X：自身战力不高于 X
  berserk(u, x) { return u.power <= x; }
  // 会师：己方控制此牌的同名牌（场上另一张）
  cohort(u) { return this.allUnits(u.side).some(v => v !== u && v.name === u.name); }
  // 操控：相邻两侧均为“士兵”
  harmonyFlank(u) { const row = this.rowOf(u), i = row.indexOf(u); return [row[i - 1], row[i + 1]].every(v => v && this.hasTag(v, '士兵')); }
  // 操控（卡牌里用）：两侧都是士兵（def.operateMages 时法师也算）；“欧德林”一人即可
  operate(u) {
    const row = this.rowOf(u), i = row.indexOf(u), nb = [row[i - 1], row[i + 1]];
    if (nb.some(v => v && v.name === '欧德林')) return true;
    return nb.every(v => v && (this.hasTag(v, '士兵') || (u.def.operateMages && this.hasTag(v, '法师'))));
  }
  // 主类别：类别里的第一个；和谐判断“与己方其他单位的主类别都不同”
  uniquePrimary(u) {
    const p = (u.tags || [])[0]; if (!p) return false;
    return !this.units(u.side).some(v => v !== u && (v.tags || [])[0] === p);
  }
  // 共生：己方控制的共生数量（场上单位、被灌注共生的单位、带共生的领袖）
  symbiosisCount(side) {
    const n = this.units(side).filter(u => !u.status.lock && (u.def.symbiosis || u.symbiosis)).length;
    const lead = Object.values(this.s.sides[side].abilities || {}).filter(h => h.def.symbiosis).length;
    return n + lead;
  }
  // 本局己方打出过的各类别张数（“己方每打出 1 张老巫妪牌”之类）：side.vars.played[类别]
  _countTags(side, d) { const P = this.s.sides[side].vars.played = this.s.sides[side].vars.played || {}; for (const t of d.tags || []) P[t] = (P[t] || 0) + 1; if (d.type === 'special') P.__special = (P.__special || 0) + 1; }
  _symbiosis(side, d) {
    if (!(d.tags || []).includes('自然')) return;
    const n = this.symbiosisCount(side); if (!n) return;
    // 随机一排：先放近战，对局簿按记录里的位置摆
    const t = this.spawn('游荡的树人', side, 'm', null, { name: '共生' });
    if (t) { t.base = n; t.power = n; this.log('共生', { side, power: n }); }
    this.emit('symbiosis', { side, unit: t });
  }
  // 翼守激活：只与 1 张牌相邻
  flankActive(u) { return !!u.def.flanking && this.adjacent(u).length === 1; }
  // 交换位置（同一方）
  swap(a, b) {
    if (!a || !b || a.side !== b.side) return;
    const ra = this.rowOf(a), rb = this.rowOf(b), ia = ra.indexOf(a), ib = rb.indexOf(b);
    ra[ia] = b; rb[ib] = a; const t = a.row; a.row = b.row; b.row = t;
    this.log('互换位置', { a: a.name, b: b.name });
    this.emit('moved', { unit: a }); this.emit('moved', { unit: b });
  }
  // 翼守：仅与 1 张牌相邻
  flanked1(u) { return this.adjacent(u).length === 1; }
  // 战狂 N：受伤的敌军单位数量达到 N
  bloodthirst(side, n) { return this.units(OTHER[side]).filter(u => u.power < u.base).length >= n; }
  // 先机：本回合己方没有用过指令/费用/现身（记录在 side.vars.usedOrderTurn）
  initiative(side) { return this.s.sides[side].vars.usedOrderTurn !== this.s.turn; }
  // 掠食：只能以战力低于自身的单位为目标
  prey(u, us) { return us.filter(v => v.power < u.power); }
  // 囤积 X：己方金币不少于 X
  hoard(side, x) { return this.s.sides[side].coins >= x; }
  // 共谋：目标有潜伏
  conspiring(u) { return !!(u && u.status.spying); }
  // 赤诚：起始牌组没有中立牌（对局簿里由卡组决定，存在 vars.devotion）
  devotion(side) { return this.s.sides[side].vars.devotion !== false; }
  isBoosted(u) { return u.power > u.base; }               // 已确认：当前战力高于基础战力
  isDamaged(u) { return u.power < u.base; }
  inspired(u) { return u.power > u.base; }                // 激励
  highest(side) {
    const us = this.units(side);
    const m = Math.max(...us.map(u => u.power));
    return us.filter(u => u.power === m);
  }
  score(side) {
    const rows = {};
    const counts = u => this.rules.ambushCounts || !u.status.ambush;
    for (const r of ROWS) rows[r] = this.s.sides[side].rows[r].reduce((a, u) => a + (counts(u) ? u.power : 0), 0);
    return { m: rows.m, r: rows.r, total: rows.m + rows.r };
  }

  // ---------- 选择：目标、随机结果、隐藏信息都走这里 ----------
  choose(req) {
    // req: {kind, prompt, from:[候选], n, source}
    if (!req.from || req.from.length === 0) return [];
    if (req.all || (req.n && req.upTo && req.from.length <= req.n)) return req.from.slice();
    let pick = this.chooser ? this.chooser(req, this) : null;
    // 只有 1 个候选时不用问（牌组里拉的牌除外）
    if (pick == null && req.kind !== 'deck' && req.from.length === 1 && !req.optional) pick = req.from[0];
    if (pick == null) {
      this.log('待选', { prompt: req.prompt, from: req.from.map(u => u.uid || u) }, true);
      return [];
    }
    const out = Array.isArray(pick) ? pick : [pick];
    // 正在结算的特殊牌手动指定的单位（随机结果、牌组里的牌不算）：结算完发 specialTargeted
    const fr = this._specStack && this._specStack[this._specStack.length - 1];
    if (fr && req.source === fr.name && req.kind !== 'random' && req.kind !== 'deck' && !/点该排/.test(req.prompt || ''))   // 点单位代表选排的不算指定单位
      for (const u of this.rules.specialTargetEach ? out : out.slice(0, 1)) if (u && u.uid && !fr.picked.includes(u)) fr.picked.push(u);
    return out;
  }

  // ---------- 记录 ----------
  log(type, data, warn) {
    this.trace.push({ turn: this.s.turn, round: this.s.round, type, data, warn: !!warn,
                      score: { me: this.score('me').total, op: this.score('op').total } });
  }

  // 给卡牌能力使用的上下文：卡牌只调用这些积木
  ctx(u) {
    const g = this;
    return {
      g, self: u, side: u ? u.side : null, foe: u ? OTHER[u.side] : null,
      boost: (t, n) => g.boost(t, n, u), damage: (t, n, o) => g.damage(t, n, u, o),
      armor: (t, n) => g.addArmor(t, n, u), status: (t, k, v) => g.addStatus(t, k, v, u),
      spawn: (name, side, row, pos) => g.spawn(name, side, row, pos, u),
      summon: (name, side, row, pos) => g.summon(name, side, row, pos, u),
      destroy: t => g.destroy(t, u), reset: t => g.reset(t, u), move: (t, row, pos) => g.move(t, row, pos, u),
      choose: req => g.choose(Object.assign({ source: u && u.name }, req)),
      enemies: () => g.units(OTHER[u.side]), allies: () => g.units(u.side),
      lock: t => g.lock(t, u), infuse: (t, ab) => g.infuse(t, ab, u), purify: t => g.purify(t, u),
      duel: t => g.duel(u, t), setPower: (t, p) => g.setPower(t, p, u),
      // 从牌组打出：单位没给排时放在来源所在排（特殊牌不需要排）
      playFromDeck: (name, row, pos, o) => g.play(u.side, name, row || (g.def(name).type === 'special' ? null : (u.row || 'm')), pos, Object.assign({ fromDeck: true, by: u }, o)),
      pick: (req) => g.choose(Object.assign({ source: u && u.name }, req))[0] || null,
      adjacent: t => g.adjacent(t || u), vars: g.s.sides[u.side].vars,
      targets: us => g.targetable(us, u.side),
      dominance: () => g.dominance(u.side), might: () => g.might(u.side), feast: () => g.feast(u.side),
      frenzy: n => g.frenzy(u.side, n, u), deckUnits: () => g.deckUnits(u.side),
      bloodthirst: n => g.bloodthirst(u.side, n), initiative: () => g.initiative(u.side), devotion: () => g.devotion(u.side), heal: t => g.heal(t, u), banish: t => g.banish(t, u),
      clash: t => g.clash(u, t), consume: t => g.consume(u, t), hazard: (side, row, kind, turns) => g.addHazard(side, row, kind, turns, u),
      coins: () => g.s.sides[u.side].coins, gainCoins: n => g.gainCoins(u.side, n, u), spendCoins: n => g.spendCoins(u.side, n, u),
      hoard: x => g.hoard(u.side, x), seize: t => g.seize(t, u.side, u), flip: t => g.flip(t || u, u),
      transform: (t, name, o) => g.transform(t, name, u, o), shuffleBack: t => g.shuffleBack(t, u),
      reduceCd: (t, n) => g.reduceCd(t, n, u), operate: t => g.operate(t || u),
      deathwishOf: t => g.triggerDeathwish(t, u), drain: (t, n) => g.drain(u, t, n), swap: (a, b) => g.swap(a, b),
      frost: (side, row) => { const h = g.s.hazards[side][row]; return h && h.kind === '霜' ? h : null; },
      // 生成并打出：单位走“生成（算打出）”，特殊牌直接结算
      spawnPlay: (name, row, pos) => g.def(name).type === 'special' ? g.play(u.side, name, null, null, { spawned: true, row }) : g.spawn(name, u.side, row || (u.row || 'm'), pos, u, { andPlay: true }),
      leader: () => Object.values(g.s.sides[u.side].abilities || {}).find(h => h.def.type === 'leader') || null,
    };
  }

  // ---------- 单位 ----------
  makeUnit(name, side) {
    const d = this.def(name);
    return {
      uid: 'u' + (this.nextUid++), name, side, row: null, def: d,
      base: d.base || 0, power: d.base || 0, armor: d.armor || 0,
      tags: d.tags || [], status: Object.assign({}, d.status || {}),
      infused: [], blessFired: {}, enteredTurn: this.s.turn, orderUsed: 0,
      zeal: !!d.zeal, unmodeled: !!d.unmodeled, origin: null, timer: d.timer ? d.timer.n : (d.timerN || null),
      pat: d.patience ? (d.patInit || 0) : null, bonusCharges: 0, vars: {},
    };
  }

  // ---------- 基础动作（积木） ----------
  _place(u, side, row, pos) {
    const arr = this.s.sides[side].rows[row];
    if (arr.length >= this.rules.rowLimit) { this.log('排满', { name: u.name, row }, true); return false; }
    u.side = side; u.row = row; u.enteredTurn = this.s.turn;
    if (pos == null || pos > arr.length) pos = arr.length;
    arr.splice(pos, 0, u);
    return true;
  }

  // 打出：从手牌打出（触发部署、己方“打出单位”事件）
  // side = 放在哪一方半场；opts.player = 打出这张牌的玩家（默认同 side）。
  // 不忠：放到出牌方的对面半场并获得潜伏；调用方没换边时自动换。
  play(side, name, row, pos, opts = {}) {
    const d = this.def(name);
    const player = opts.player || side;
    if (!opts.fromDeck && !opts.spawned && !opts.fromGrave) this.s.sides[player].handCount = Math.max(0, this.s.sides[player].handCount - 1);
    if (opts.fromGrave) { const gr = this.s.sides[player].grave, i = gr.lastIndexOf(name); if (i >= 0) gr.splice(i, 1); }
    if (d.type === 'special') {
      const pseudo = { side: player, name, def: d, uid: null };
      this.log('打出', { side: player, name, special: true, unmodeled: !!d.unmodeled });
      if (d.profit) this.gainCoins(player, d.profit, pseudo);
      const fr = { name, picked: [] };
      (this._specStack = this._specStack || []).push(fr);
      try { if (d.onPlay) d.onPlay(this.ctx(pseudo), opts); } finally { this._specStack.pop(); }
      // 佚亡的特殊牌（洞察之球从墓场打出自己）结算后放逐
      (opts.doomed ? this.s.sides[player].banished : this.s.sides[player].grave).push(name);
      this._countTags(player, d);
      if (!(opts.fromGrave && d.graveAbilities && !this.rules.graveSelfPlayCounts))
        this.emit('cardPlayed', { side: player, name, special: true, def: d, spawned: !!opts.spawned, fromGrave: !!opts.fromGrave });
      for (const t of fr.picked) if (this.find(t.uid)) this.emit('specialTargeted', { unit: t, side: player, name, def: d, spawned: !!opts.spawned });
      // 墓场里的能力（洞察之球）：进墓场后才开始监听，所以不响应打出它自己的这一次
      if (!opts.doomed && d.graveAbilities) this.s.sides[player].graveWatch.push({ name, side: player, vars: {} });
      this._symbiosis(player, d);
      return null;
    }
    if (d.disloyal && side === player && !opts.keepSide) side = OTHER[player];
    const u = this.makeUnit(name, side);
    u.origin = opts.fromDeck ? 'deck' : 'hand';
    u.owner = player;
    // 回响回到牌组的牌：再打出时带佚亡
    const ech = this.s.sides[player].echoed;
    if (opts.fromDeck && ech && ech.includes(name)) { ech.splice(ech.indexOf(name), 1); u.status.doomed = true; }
    if (!this._place(u, side, row, pos)) return null;
    if (!opts.spawned) this._deckBuff(u, player);
    this.log('打出', { side, name, uid: u.uid, row, power: u.power, unmodeled: u.unmodeled, player });
    this._enter(u, true, Object.assign({}, opts, { player }));
    if (opts.power != null && this.find(u.uid) && opts.power !== u.power) {
      this.log('录入战力', { uid: u.uid, name: u.name, from: u.power, to: opts.power });
      u.power = opts.power;                 // 对面手牌里的隐藏增益：以落地时看到的战力为准
    }
    return u;
  }

  // 召唤：从牌组/墓场直接上场，不算“打出”，不触发部署
  summon(name, side, row, pos, src) {
    const u = this.makeUnit(name, side); u.origin = 'summon';
    if (!this._place(u, side, row, pos)) return null;
    this._deckBuff(u, side);
    this.log('召唤', { side, name, uid: u.uid, row, by: src && src.name });
    this._enter(u, false, {});
    return u;
  }

  // 生成：凭空产生一张牌放上场（衍生牌），不算“打出”
  spawn(name, side, row, pos, src, opts = {}) {
    const u = this.makeUnit(name, side); u.origin = 'spawn';
    if (!this._place(u, side, row, pos)) return null;
    this.log('生成', { side, name, uid: u.uid, row, by: src && src.name });
    this._enter(u, !!opts.andPlay, opts);
    this.emit('unitSpawned', { unit: u, src });
    return u;
  }

  // 牌组里的单位受到的增益（拉尔维克的埃兰）：这张牌之后上场时带上（按同名牌里增益最高的一张算）
  _deckBuff(u, side) {
    const L = this.s.sides[side].deckBuff[u.name];
    if (!L || !L.length) return;
    L.sort((a, b) => b - a);
    const b = L.shift();
    if (b > 0) { u.power += b; this.log('牌组里的增益', { uid: u.uid, name: u.name, n: b }); }
  }
  // 牌组里的单位（对局簿提供 deckInfo(side) → 牌名数组；不知道时为 null）
  deckUnits(side) {
    const L = this.deckInfo ? this.deckInfo(side, this) : null;
    return L ? L.filter(n => this.def(n).type === 'unit') : null;
  }
  // 亢奋 N：手牌不多于 N。记录（chooser kind 'frenzy'）或对局簿推算的手牌数；都没有时按 frenzyDefault
  frenzy(side, n, src) {
    const v = this.chooser ? this.chooser({ kind: 'frenzy', n, side, source: src && src.name }, this) : null;
    if (v != null) return !!v;
    // 对局簿推算的手牌数（side.handKnown）：打出到场上之后的手牌数（用户确认）
    if (this.s.sides[side].handKnown) return this.s.sides[side].handCount <= n;
    this.log('亢奋未知', { name: src && src.name, n, side });
    return !!this.rules.frenzyDefault;
  }
  // 己方各耐性单位达到过的最大耐性（校友会），单位离场后仍保留
  _notePat(u) {
    if (u.pat == null) return;
    const M = this.s.sides[u.side].vars.maxPat = this.s.sides[u.side].vars.maxPat || {};
    M[u.name] = Math.max(M[u.name] || 0, u.pat);
  }

  _enter(u, played, opts) {
    const c = this.ctx(u), d = u.def;
    const player = (opts && opts.player) || u.side;
    // 伏击：打出时背面朝上，能力等条件触发（翻开）时才生效
    if (played && d.ambush) { u.status.ambush = true; this.log('伏击', { uid: u.uid, name: u.name }); }
    // 列阵：近战狂热，远程自身 +1
    if (d.formation) { if (u.row === 'm') u.zeal = true; else this.boost(u, 1, u); }
    this._notePat(u);
    if (played && d.profit) this.gainCoins(player, d.profit, u);        // 利润：打出时获得金币
    // 献金：先决定付不付（u.tributePaid），部署里“献金：改为……”据此分支，付了再结算献金效果
    if (played && (d.tributeN || d.tribute)) u.tributePaid = this.decideTribute(u, player);
    if (played && !u.status.ambush && d.deploy) d.deploy(c, opts);
    if (played && !u.status.ambush && d.deployRow && d.deployRow[u.row]) d.deployRow[u.row](c, opts);
    if (played && u.tributePaid && this.find(u.uid)) this.runTribute(u);
    if (played && d.disloyal && u.side !== player) this.addStatus(u, 'spying', true, u);
    this.checkBless(u);
    this.emit('unitEnter', { unit: u, played });
    if (played) {
      // by = 打出这张牌的玩家（不忠牌落在对面半场，但算打出者“打出”）
      if (d.type !== 'artifact') this.s.sides[player].vars.lastUnit = u;
      if ((d.tags || []).includes('陷阱')) this.s.sides[player].vars.trapsRound = (this.s.sides[player].vars.trapsRound || 0) + 1;
      this._countTags(player, d);
      this.emit('cardPlayed', { side: player, name: u.name, unit: u, def: d });
      if (d.type !== 'artifact') this.emit('unitPlayed', { unit: u, by: player, landing: opts && opts.power != null ? opts.power : null });
      this._symbiosis(player, d);
    }
  }

  // ---------- 金币（辛迪加） ----------
  gainCoins(side, n, src) {
    if (!n || n <= 0) return 0;
    const sd = this.s.sides[side], before = sd.coins, lim = this.rules.coinLimit;
    sd.coins = Math.min(lim, before + n);
    const gained = sd.coins - before, overflow = Math.max(0, before + n - lim);
    this.log('金币', { side, n: gained, coins: sd.coins, overflow, by: src && src.name });
    this.emit('coinsGained', { side, n: gained, overflow, src });
    return gained;
  }
  spendCoins(side, n, src) {
    const sd = this.s.sides[side];
    if (sd.coins < n) return false;
    sd.coins -= n;
    this.log('花费金币', { side, n, coins: sd.coins, by: src && src.name });
    this.emit('coinsSpent', { side, n, src });
    return true;
  }
  // 献金：部署后可选择付金币触发。是否付款走 chooser（kind 'tribute'），没有输入时按 autoTribute
  decideTribute(u, side) {
    const d = u.def, n = d.tribute ? d.tribute.n : d.tributeN, sd = this.s.sides[side];
    const afford = sd.coins >= n;
    const ans = this.chooser ? this.chooser({ kind: 'tribute', source: u.name, n, afford }, this) : null;
    const pay = ans == null ? (afford && this.rules.autoTribute) : !!ans;
    if (!pay) { this.log('献金未付', { name: u.name, n }); return false; }
    if (!this.spendCoins(side, n, u)) { this.log('金币不足', { side, name: u.name, need: n, coins: sd.coins }, true); sd.coins = 0; }
    return true;
  }
  runTribute(u) {
    const d = u.def, n = d.tribute ? d.tribute.n : d.tributeN, run = d.tribute && d.tribute.run;
    this.log('献金', { uid: u.uid, name: u.name, n, unmodeled: !run }, !run);
    if (run) run(this.ctx(u));
    this.emit('tributePaid', { unit: u, side: u.side, n });
  }
  // 费用：花金币触发的能力（对局簿里和指令一样点单位记录）。癫狂：金币不够时改为对自身造成等量伤害（无视护甲），会致死则不能用
  canFee(u) {
    const n = u.def.fee ? u.def.fee.n : u.def.feeN;
    if (n == null || u.status.lock) return false;
    if (u.def.cooldown != null && (u.cd || 0) > 0) return false;
    if (!(this.rules.feeSameTurn || u.zeal || this.s.turn > u.enteredTurn)) return false;
    return this.s.sides[u.side].coins >= n || (u.def.insanity && u.power > n);
  }
  fee(u, opts = {}) {
    const d = u.def, n = d.fee ? d.fee.n : d.feeN, sd = this.s.sides[u.side];
    if (!this.canFee(u) && !opts.force) this.log('费用不可用', { uid: u.uid, name: u.name }, true);
    if (!this.spendCoins(u.side, n, u)) {
      if (d.insanity && u.power > n) { this.log('癫狂', { uid: u.uid, name: u.name, n }); this.damage(u, n, { name: '癫狂' }, { ignoreArmor: true }); }
      else { this.log('金币不足', { side: u.side, name: u.name, need: n, coins: sd.coins }, true); sd.coins = 0; }
    }
    if (d.cooldown != null) u.cd = d.cooldown;
    sd.vars.usedOrderTurn = this.s.turn;                                 // 先机：费用也算
    const run = d.fee && d.fee.run;
    this.log('费用', { uid: u.uid, name: u.name, n, unmodeled: !run }, !run);
    if (run && this.find(u.uid)) run(this.ctx(u), opts);
  }
  // 抓捕：把敌军单位移到己方同排并使其获得潜伏；已有潜伏则改为移除潜伏
  seize(u, side, src) {
    if (!u || !this.find(u.uid)) return;
    const from = this.rowOf(u); from.splice(from.indexOf(u), 1);
    this._place(u, side, u.row, null);
    this.log('抓捕', { uid: u.uid, name: u.name, side, by: src && src.name });
    if (u.status.spying) { u.status.spying = false; this.log('状态', { uid: u.uid, name: u.name, key: 'spying', val: false }); }
    else this.addStatus(u, 'spying', true, src);
    this.emit('moved', { unit: u, src, seized: true });
  }
  // 变形：变成另一张牌（默认按新牌的基础战力；keepPower 保留当前战力）
  transform(u, name, src, o = {}) {
    if (!u || !this.find(u.uid)) return;
    const d = this.def(name), p = u.power;
    Object.assign(u, { name, def: d, base: d.base || 0, tags: d.tags || [], unmodeled: !!d.unmodeled,
      status: Object.assign({}, d.status || {}), infused: [], blessFired: {}, orderUsed: 0, cd: 0, zeal: !!d.zeal,
      timer: d.timer ? d.timer.n : (d.timerN || null), pat: d.patience ? (d.patInit || 0) : null });
    u.power = o.keepPower ? p : u.base;
    this.log('变形', { uid: u.uid, to: name, power: u.power, by: src && src.name, unmodeled: u.unmodeled });
    this.checkBless(u);
  }
  // 洗回牌组：离场，不算摧毁
  shuffleBack(u, src) {
    if (!u || !this.find(u.uid)) return;
    const row = this.rowOf(u); row.splice(row.indexOf(u), 1);
    if (u.origin !== 'spawn' || !this.isDoomed(u)) this.s.sides[u.side].deck.push(u.name);
    this.log('洗回牌组', { uid: u.uid, name: u.name, by: src && src.name });
    this.emit('returned', { unit: u, src });
  }
  // 触发遗愿（“触发 1 个友军单位的遗愿能力”）：单位还在场上
  triggerDeathwish(u, src) {
    if (!u || !u.def.deathwish || u.status.lock) return;
    this.log('触发遗愿', { uid: u.uid, name: u.name, by: src && src.name });
    u.def.deathwish(this.ctx(u));
  }
  // 汲食：造成伤害，自身获得等量增益（按实际扣掉的战力）
  drain(a, b, n) {
    if (!a || !b) return;
    const dealt = this.damage(b, n, a);
    this.log('汲食', { a: a.name, b: b.name, n: dealt });
    if (dealt > 0) this.boost(a, dealt, a);
  }
  // 冷却减少（事件 cdReduced，给“相邻单位冷却减少”之类的能力用）
  reduceCd(u, n, src) {
    if (!u || !(u.cd > 0) || n <= 0) return;
    const k = Math.min(u.cd, n); u.cd -= k;
    this.log('冷却减少', { uid: u.uid, name: u.name, n: k, cd: u.cd, by: src && src.name });
    this.emit('cdReduced', { unit: u, n: k, src });
  }
  // 翻开：伏击的牌翻到正面
  flip(u, src) {
    if (!u || !u.status.ambush) return;
    u.status.ambush = false;
    this.log('翻开', { uid: u.uid, name: u.name, by: src && src.name });
    this.emit('flipped', { unit: u, src });
  }

  boost(u, n, src) {
    if (!u || n <= 0 || !this.find(u.uid)) return;
    u.power += n;
    this.log('增益', { uid: u.uid, name: u.name, n, by: src && src.name, power: u.power });
    this.emit('boosted', { unit: u, n, src });
    this.checkBless(u);
  }

  // 伤害：护盾 → 护甲 → 战力；返回实际扣除的战力
  damage(u, n, src, o = {}) {
    if (!u || n <= 0 || !this.find(u.uid)) return 0;
    const shieldApplies = !(o.bleed && this.rules.bleedIgnoresShield);
    if (u.status.shield && shieldApplies && !o.ignoreShield) {
      u.status.shield = false;
      this.log('护盾抵挡', { uid: u.uid, name: u.name, n, by: src && src.name });
      this.emit('shieldLost', { unit: u, src });
      return 0;
    }
    let left = n;
    if (u.armor > 0 && !o.ignoreArmor) {
      const a = Math.min(u.armor, left); u.armor -= a; left -= a;
      if (u.armor === 0) this.emit('armorBroken', { unit: u, src });
    }
    u.power -= left;
    this.log('伤害', { uid: u.uid, name: u.name, n, toPower: left, armor: u.armor, power: u.power, by: src && src.name });
    this.emit('damaged', { unit: u, n, dealt: left, src });
    if (u.power <= 0) this.destroy(u, src, { deathblow: true });
    return left;
  }

  addArmor(u, n, src) {
    if (!u || n <= 0) return; u.armor += n;
    this.log('护甲', { uid: u.uid, name: u.name, n, armor: u.armor, by: src && src.name });
  }

  addStatus(u, key, val = true, src) {
    if (!u) return;
    if (u.status.veil && key !== 'veil') { this.log('遮蔽阻挡', { uid: u.uid, key }); return; }
    if (key === 'vitality' || key === 'bleed') {
      // 活力与重伤互相抵消
      const opp = key === 'vitality' ? 'bleed' : 'vitality';
      let v = val, cancel = Math.min(v, u.status[opp] || 0);
      u.status[opp] = (u.status[opp] || 0) - cancel; v -= cancel;
      u.status[key] = (u.status[key] || 0) + v;
    } else if (key === 'poison') {
      u.status.poison = (u.status.poison || 0) + 1;
      if (u.status.poison >= 2) { this.log('中毒摧毁', { uid: u.uid }); this.destroy(u, src); return; }
    } else {
      // 赏金：每一方同时只能有 1 个单位带赏金
      if (key === 'bounty' && val) for (const v of this.allUnits(u.side)) if (v !== u) v.status.bounty = false;
      u.status[key] = val;
    }
    this.log('状态', { uid: u.uid, name: u.name, key, val: u.status[key], by: src && src.name });
    this.emit('statusGained', { unit: u, key, val, src });
    if (key === 'lock' && val && u.status.ambush) this.flip(u, src);   // 伏击被锁定：失去能力并翻开
    if (key === 'shield') this.emit('shieldGained', { unit: u });
  }

  reset(u, src) {
    if (!u) return 0;
    const lost = u.power - u.base;
    u.power = u.base;
    this.log('重置', { uid: u.uid, name: u.name, lost, by: src && src.name });
    return lost; // 正数 = 失去的增益
  }

  setPower(u, p, src) {
    const diff = p - u.power;
    if (diff > 0) this.boost(u, diff, src); else if (diff < 0) this.damage(u, -diff, src, { ignoreArmor: true, ignoreShield: true });
  }

  // 治愈：当前战力低于基础战力时恢复到基础战力
  heal(u, src) { if (!u || u.power >= u.base) return; const n = u.base - u.power; u.power = u.base; this.log('治愈', { uid: u.uid, name: u.name, n, by: src && src.name }); this.emit('healed', { unit: u, n, src }); }
  // 交锋：双方同时以自身战力伤害对方
  clash(a, b) {
    if (!a || !b) return;
    const pa = a.power, pb = b.power;
    this.log('交锋', { a: a.name, b: b.name });
    this.damage(b, pa, a); this.damage(a, pb, b);
  }
  // 吞噬：摧毁目标（在墓场则放逐），自身获得其战力
  consume(a, b) {
    if (!a || !b) return;
    const p = b.power;
    this.log('吞噬', { a: a.name, b: b.name, n: p });
    this.destroy(b, a);
    this.boost(a, p, a);
  }
  // 放逐：离场但不算被摧毁，不触发遗愿
  banish(u, src) {
    if (!u || !this.find(u.uid)) return;
    const row = this.rowOf(u); row.splice(row.indexOf(u), 1);
    this.s.sides[u.side].banished.push(u.name);
    this.log('放逐', { uid: u.uid, name: u.name, by: src && src.name });
    if (u.status.bounty) this.gainCoins(OTHER[u.side], u.base, { name: '赏金' });
    this.emit('banished', { unit: u, src });
  }
  // 整排效果：同一排只留一个，新的替换旧的
  addHazard(side, row, kind, turns, src) {
    const rows = row === 'all' ? ROWS : [row];
    const H = HAZARDS[kind];
    for (const r of rows) {
      this.s.hazards[side][r] = { name: kind, kind, turns: turns != null ? turns : (H ? H.turns : Infinity), unknown: !H };
      this.log('整排效果', { side, row: r, kind, turns: this.s.hazards[side][r].turns, by: src && src.name, unmodeled: !H });
    }
  }
  // 立即结算一次整排效果（不减回合），“触发所有剩余雨和风暴”用
  runHazardOnce(side, r) {
    const h = this.s.hazards[side][r]; if (!h) return; const H = HAZARDS[h.kind];
    if (H) H.run(this, this.s.sides[side].rows[r].filter(u => u.def.type !== 'artifact'), h);
  }
  _pickExtreme(us, dir, h) {
    if (!us.length) return null;
    const v = dir > 0 ? Math.max(...us.map(u => u.power)) : Math.min(...us.map(u => u.power));
    const c = us.filter(u => u.power === v);
    return c.length === 1 ? c[0] : this.choose({ kind: 'random', prompt: h.name + '：并列时随机', from: c, source: h.name })[0] || null;
  }
  strengthen(u, n, src) { u.base += n; u.power += n; this.log('强化', { uid: u.uid, n, by: src && src.name }); this.checkBless(u); }

  move(u, row, pos, src) {
    const from = this.rowOf(u); from.splice(from.indexOf(u), 1);
    this._place(u, u.side, row, pos);
    this.log('移位', { uid: u.uid, name: u.name, row, by: src && src.name });
    this.emit('moved', { unit: u, src });
  }

  destroy(u, src, o = {}) {
    if (!this.find(u.uid)) return;
    u.adjBefore = this.adjacent(u);
    const row = this.rowOf(u); row.splice(row.indexOf(u), 1);
    const doomed = this.isDoomed(u);
    (doomed ? this.s.sides[u.side].banished : this.s.sides[u.side].grave).push(u.name);
    this.log('摧毁', { uid: u.uid, name: u.name, by: src && src.name });
    this.s.lastDestroyTurn = this.s.turn;
    if (u.status.bounty) this.gainCoins(OTHER[u.side], u.base, { name: '赏金' });
    // 遗愿：被摧毁并进入墓场时触发；佚亡（放逐）的不触发
    if (u.def.deathwish && !u.status.lock && !doomed) u.def.deathwish(this.ctx(u));
    this.emit('destroyed', { unit: u, src });
    if (src && src.def) {
      if (src.def.deathblow && (!src.uid || this.find(src.uid)) && !(src.status && src.status.lock)) src.def.deathblow(this.ctx(src), u);
      this.emit('deathblow', { unit: src, victim: u });
    }
  }

  isDoomed(u) { return !!(u.status.doomed || (u.origin === 'spawn' && this.rules.spawnBanished)); }
  // 净化：移除所有状态（含护盾、灌注）；免疫是卡牌自带属性，保留
  purify(u, src) {
    if (!u) return;
    for (const k of Object.keys(u.status)) {
      if (k === 'immune' || (k === 'doomed' && this.rules.purifyKeepsDoomed)) continue;
      u.status[k] = k === 'vitality' || k === 'bleed' || k === 'poison' ? 0 : false;
    }
    u.infused = [];
    this.log('净化', { uid: u.uid, name: u.name, by: src && src.name });
  }
  // 对决：发起者先出手，轮流造成等同自身战力的伤害，直到一方被摧毁
  duel(a, b) {
    this.log('对决', { a: a.name, b: b.name });
    let atk = a, def = b, guard = 0;
    while (this.find(a.uid) && this.find(b.uid) && guard++ < 50) {
      if (atk.power <= 0) break;
      this.damage(def, atk.power, atk);
      [atk, def] = [def, atk];
    }
  }
  // 领袖能力、战术：不在排上的能力持有者
  addAbility(side, name, charges) {
    const d = this.def(name);
    const h = { uid: 'a:' + side + ':' + name, name, side, def: d, tags: [], status: {}, infused: [],
                charges: charges != null ? charges : (d.charges != null ? d.charges : 1), vars: {} };
    this.s.sides[side].abilities = this.s.sides[side].abilities || {};
    this.s.sides[side].abilities[name] = h;
    return h;
  }
  useAbility(side, name, opts = {}) {
    const h = (this.s.sides[side].abilities || {})[name] || this.addAbility(side, name);
    if (h.charges <= 0 && !opts.force) this.log('能力已用完', { side, name }, true);
    h.charges--;
    this.s.sides[side].vars.usedOrderTurn = this.s.turn;   // 领袖、战术也是指令（先机）
    if (h.def.type === 'leader') this.s.sides[side].vars.leaderUses = (this.s.sides[side].vars.leaderUses || 0) + 1;
    if (h.def.type === 'leader') this.s.sides[side].vars.leaderTurn = this.s.turn;
    this.log('能力', { side, name, left: h.charges, unmodeled: !!h.def.unmodeled });
    if (h.def.order) h.def.order(this.ctx(h), opts);
    this.emit('ordered', { unit: h, side, ability: true });
    return h;
  }
  lock(u, src) { this.addStatus(u, 'lock', true, src); }
  infuse(u, ability, src) { u.infused.push(ability); this.log('灌注', { uid: u.uid, name: u.name, by: src && src.name }); }

  // ---------- 神赐 ----------
  checkBless(u) {
    if (!u.def.bless || u.status.lock || !this.find(u.uid)) return;
    for (const b of u.def.bless) {
      if (!u.blessFired[b.at] && u.power >= b.at) {
        u.blessFired[b.at] = true;
        this.blessCount = (this.blessCount || 0) + 1;
        this.log('神赐', { uid: u.uid, name: u.name, at: b.at });
        b.run(this.ctx(u));
        this.emit('blessed', { unit: u, at: b.at });
      }
    }
  }

  // ---------- 指令 ----------
  canOrder(u) {
    if (!u.def.order || u.status.lock) return false;
    if (u.def.cooldown != null) { if ((u.cd || 0) > 0) return false; }
    else if (u.orderUsed >= (u.def.charges != null ? u.def.charges : 1) + (u.bonusCharges || 0)) return false;
    // 进场当回合不能用；狂热例外
    return u.zeal || this.s.turn > u.enteredTurn;
  }
  order(uid, opts = {}) {
    const u = this.find(uid);
    if (!u) return;
    if ((!u.def.order || opts.fee) && (u.def.fee || u.def.feeN != null)) return this.fee(u, opts);
    if (!u.def.order) { this.log('没有指令', { uid, name: u.name, unmodeled: true }, true); return; }
    if (!this.canOrder(u) && !opts.force) this.log('指令不可用', { uid, name: u.name }, true);
    u.orderUsed++;
    this.s.sides[u.side].vars.usedOrderTurn = this.s.turn;
    if (u.def.cooldown != null) u.cd = u.def.cooldown;
    u.orderTurn = this.s.turn;
    this.log('指令', { uid, name: u.name });
    u.def.order(this.ctx(u), opts);
    this.emit('ordered', { unit: u, side: u.side });
  }

  // ---------- 回合 ----------
  startTurn() {
    const side = this.s.active;
    // 整排效果：拥有者回合开始时生效
    for (const r of ROWS) {
      const h = this.s.hazards[side][r];
      if (!h) continue;
      const H = HAZARDS[h.kind];
      if (H) H.run(this, this.s.sides[side].rows[r].filter(u => u.def.type !== 'artifact'), h);
      if (--h.turns <= 0) { this.s.hazards[side][r] = null; this.log('整排效果结束', { side, row: r, kind: h.kind }); }
    }
    for (const u of this.allUnits(side)) if (u.cd > 0) u.cd--;
    this.emit('turnStart', { side });
  }

  endTurn() {
    const side = this.s.active;
    // 计时：己方回合结束前 -1，归零触发
    for (const u of this.allUnits(side).slice()) {
      if (u.timer == null || u.status.lock || !this.find(u.uid)) continue;
      if (--u.timer <= 0) {
        const run = u.def.timer && u.def.timer.run;
        this.log('计时触发', { uid: u.uid, name: u.name, unmodeled: !run }, !run);
        if (run) run(this.ctx(u));
        const n = u.def.timer ? u.def.timer.n : u.def.timerN;
        u.timer = this.rules.timerRepeats ? n : null;
      }
    }
    // 耐性：己方回合结束时指令还没用过，则数值永久 +1（带“近战/远程”的只在那一排）
    for (const u of this.allUnits(side)) {
      const pt = u.def.patience;
      if (u.pat == null || u.status.lock || u.orderUsed > 0 || (pt !== true && pt !== u.row)) continue;
      u.pat++; this._notePat(u); this.log('耐性', { uid: u.uid, name: u.name, pat: u.pat });
      this.emit('patience', { unit: u });
    }
    this.emit('turnEnd', { side });
    // 翼守：只与 1 张牌相邻时——近战排“回合结束”能力再触发一次，远程排获得 1 点护甲
    for (const u of this.allUnits(side).slice()) {
      if (!u.def.flanking || u.status.lock || !this.find(u.uid) || this.adjacent(u).length !== 1) continue;
      if (u.row === 'r') this.addArmor(u, 1, { name: '翼守' });
      else for (const ab of u.def.abilities || []) if (ab.on === 'turnEnd' && (!ab.when || ab.when(this.ctx(u), { side }))) { this.log('翼守', { name: u.name }); ab.run(this.ctx(u), { side }); }
    }
    // 活力 / 重伤：单位拥有者回合结束
    for (const u of this.allUnits(side).slice()) {
      if (u.status.vitality > 0) { u.status.vitality--; this.boost(u, 1, { name: '活力' }); }
      else if (u.status.bleed > 0) { u.status.bleed--; this.damage(u, 1, { name: '重伤' }, { ignoreArmor: true, bleed: true }); }
      // 破裂：受到等同基础战力的伤害，随后移除
      if (u.status.rupture && this.find(u.uid)) { u.status.rupture = false; this.damage(u, u.base, { name: '破裂' }); }
    }
    this.s.turn++;
    const nxt = OTHER[side];
    if (this.s.sides.me.passed && this.s.sides.op.passed) return this.manualRounds ? undefined : this.endRound();
    if (!this.s.sides[nxt].passed) this.s.active = nxt;
    this.startTurn();
  }

  pass(side) {
    side = side || this.s.active;
    this.s.sides[side].passed = true;
    this.log('停牌', { side });
    this.emit('passed', { side });
    this.endTurn();
  }

  // ---------- 小局 ----------
  startRound() {
    const s = this.s;
    s.sides.me.passed = s.sides.op.passed = false;
    // 老兵：第二、三小局开始时基础战力 +1
    if (s.round > 0) for (const u of this.allUnits()) if (u.def.veteran) this.strengthen(u, u.def.veteran, { name: '老兵' });
    if (s.round > 0) for (const sd of ['me', 'op']) {
      const S = s.sides[sd];
      // 金币：进入下一小局减半（向下取整）
      if (S.coins) { S.coins = Math.floor(S.coins / 2); this.log('金币减半', { side: sd, coins: S.coins }); }
      // 回响：小局开始时从墓场移到牌组顶端，并获得佚亡
      for (let i = S.grave.length - 1; i >= 0; i--) {
        const n = S.grave[i];
        if (this.def(n).echo) { S.grave.splice(i, 1); S.deck.unshift(n); (S.echoed = S.echoed || []).push(n); this.log('回响', { side: sd, name: n }); }
      }
    }
    for (const sd of ['me', 'op']) s.sides[sd].vars.trapsRound = 0;
    this.log('小局开始', { round: s.round + 1, first: s.active });
    this.emit('roundStart', { round: s.round });
    this.startTurn();
  }

  endRound() {
    const s = this.s, me = this.score('me').total, op = this.score('op').total;
    const res = me > op ? 'W' : me < op ? 'L' : 'D';
    s.results.push({ res, me, op });
    if (res !== 'L') s.sides.me.wins++;
    if (res !== 'W') s.sides.op.wins++;
    this.log('小局结束', { round: s.round + 1, me, op, res });
    this.emit('roundEnd', { round: s.round, res });
    // 清场：坚韧留场（坚韧随后消失；增益与额外护甲不带入）
    for (const sd of ['me', 'op']) for (const r of ROWS) {
      const keep = [];
      for (const u of s.sides[sd].rows[r]) {
        if (u.status.resilience) {
          u.status.resilience = false; u.armor = u.def.armor || 0; keep.push(u);
          u.power = this.rules.resilienceKeepsDamage ? Math.min(u.power, u.base) : u.base;
        } else {
          (this.isDoomed(u) ? s.sides[sd].banished : s.sides[sd].grave).push(u.name);
        }
      }
      s.sides[sd].rows[r] = keep;
    }
    s.hazards = { me: { m: null, r: null }, op: { m: null, r: null } };
    if (s.sides.me.wins >= 2 || s.sides.op.wins >= 2 || s.round >= 2) { s.over = true; this.log('对局结束', { results: s.results }); return; }
    s.round++;
    if (this.rules.roundWinnerGoesFirst && res !== 'D') s.active = res === 'W' ? 'me' : 'op';
    this.startRound();
  }

  // 界面显示用：计时剩余、充能剩余、冷却剩余
  counters(u) {
    const o = {};
    if (u.timer != null) o.timer = u.timer;
    if (u.def.order && u.def.cooldown == null && (u.def.charges != null || u.bonusCharges)) o.charges = Math.max(0, (u.def.charges != null ? u.def.charges : 1) + (u.bonusCharges || 0) - u.orderUsed);
    if (u.pat != null) o.pat = u.pat;
    if (u.vars && u.vars.count != null) o.count = u.vars.count;
    if (u.def.cooldown != null) o.cd = u.cd || 0;
    const fn = u.def.fee ? u.def.fee.n : u.def.feeN;
    if (fn != null) o.fee = fn;
    return o;
  }
  // 上一局留场的单位（坚韧）带进这一局（对局簿逐局推算用）
  carryIn(u, side, row) {
    const v = this.makeUnit(u.name, side);
    Object.assign(v, { base: u.base, armor: u.def.armor || 0, origin: u.origin, enteredTurn: -1,
      power: this.rules.resilienceKeepsDamage ? Math.min(u.power, u.base) : u.base,
      status: Object.assign({}, u.status, { resilience: false }), infused: [] });
    v.row = row; this.s.sides[side].rows[row].push(v);
    this.log('留场', { side, name: v.name, uid: v.uid, row, power: v.power });
    return v;
  }

  // ---------- 快照（给界面和校准用） ----------
  snapshot() {
    const view = sd => ({
      rows: Object.fromEntries(ROWS.map(r => [r, this.s.sides[sd].rows[r].map(u => ({
        uid: u.uid, name: u.name, base: u.base, power: u.power, armor: u.armor,
        status: Object.fromEntries(Object.entries(u.status).filter(([, v]) => v)),
        unmodeled: u.unmodeled, canOrder: this.canOrder(u), ...this.counters(u) }))])),
      score: this.score(sd), passed: this.s.sides[sd].passed, handCount: this.s.sides[sd].handCount, coins: this.s.sides[sd].coins,
      hazards: Object.fromEntries(ROWS.map(r => [r, this.s.hazards[sd][r] && { kind: this.s.hazards[sd][r].kind, turns: this.s.hazards[sd][r].turns }])),
    });
    return { round: this.s.round + 1, turn: this.s.turn, active: this.s.active, me: view('me'), op: view('op'), results: this.s.results };
  }
}

// ---------- 校准：与真实比分对照 ----------
function calibrate(game, real) {
  // real: [{me, op}]，按小局
  return game.s.results.map((r, i) => ({
    round: i + 1, engine: r.me + ':' + r.op, real: real[i] ? real[i].me + ':' + real[i].op : '?',
    diffMe: real[i] ? r.me - real[i].me : null, diffOp: real[i] ? r.op - real[i].op : null,
  }));
}

const API = { Game, DEFAULT_RULES, HAZARDS, calibrate, OTHER, ROWS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.GwentEngine = API;
})(this);
