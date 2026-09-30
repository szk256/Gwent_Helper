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
};

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
             banished: [], passed: false, wins: 0, leaderCharges: 0, vars: {} };
  }

  // ---------- 卡牌定义 ----------
  registerCard(def) { this.cards[def.name] = def; }
  // 数据（来自对局簿 RAW）+ 行为（卡牌脚本）合并；没有行为的牌标为未建模
  def(name) {
    if (this.cards[name]) return this.cards[name];
    const data = this.data && this.data[name];
    const beh = this.behaviors && this.behaviors[name];
    const d = Object.assign({ name, base: 0, abilities: [] }, data || {}, beh || {});
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
      this.data[r[0]] = {
        name: r[0], fac: r[1], color: r[2], type: TYPE[r[3]] || r[3], base: n(r[4]), prov: n(r[5]),
        tags: (r[7] || '').split(/[,、]\s*/).filter(Boolean), text, en: r[9], textEn: r[10], set: r[11], armor: n(r[13]),
        vanilla: r[3] === '单位' && text.trim() === '',
      };
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
      if (u.status.lock || !u.def.abilities) continue;
      for (const ab of u.def.abilities) {
        if (ab.on === evt && (!ab.when || ab.when(this.ctx(u), data))) ab.run(this.ctx(u), data);
      }
      for (const inf of u.infused) {
        if (inf.on === evt && (!inf.when || inf.when(this.ctx(u), data))) inf.run(this.ctx(u), data);
      }
    }
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
    for (const r of ROWS) rows[r] = this.s.sides[side].rows[r].reduce((a, u) => a + u.power, 0);
    return { m: rows.m, r: rows.r, total: rows.m + rows.r };
  }

  // ---------- 选择：目标、随机结果、隐藏信息都走这里 ----------
  choose(req) {
    // req: {kind, prompt, from:[候选], n, source}
    if (!req.from || req.from.length === 0) return [];
    if (req.all || (req.n && req.upTo && req.from.length <= req.n)) return req.from.slice();
    let pick = this.chooser ? this.chooser(req, this) : null;
    if (pick == null) {
      this.log('待选', { prompt: req.prompt, from: req.from.map(u => u.uid || u) }, true);
      return [];
    }
    return Array.isArray(pick) ? pick : [pick];
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
      playFromDeck: (name, row, pos, o) => g.play(u.side, name, row, pos, Object.assign({ fromDeck: true, by: u }, o)),
      pick: (req) => g.choose(Object.assign({ source: u && u.name }, req))[0] || null,
      adjacent: t => g.adjacent(t || u), vars: g.s.sides[u.side].vars,
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
      zeal: !!d.zeal, unmodeled: !!d.unmodeled, origin: null,
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
  play(side, name, row, pos, opts = {}) {
    const d = this.def(name);
    if (!opts.fromDeck && !opts.spawned) this.s.sides[side].handCount = Math.max(0, this.s.sides[side].handCount - 1);
    if (d.type === 'special') {
      const pseudo = { side, name, def: d, uid: null };
      this.log('打出', { side, name, special: true, unmodeled: !!d.unmodeled });
      if (d.onPlay) d.onPlay(this.ctx(pseudo), opts);
      this.s.sides[side].grave.push(name);
      this.emit('cardPlayed', { side, name, special: true, def: d });
      return null;
    }
    const u = this.makeUnit(name, side);
    u.origin = opts.fromDeck ? 'deck' : 'hand';
    if (!this._place(u, side, row, pos)) return null;
    this.log('打出', { side, name, uid: u.uid, row, power: u.power, unmodeled: u.unmodeled });
    this._enter(u, true, opts);
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
    return u;
  }

  _enter(u, played, opts) {
    const c = this.ctx(u), d = u.def;
    // 列阵：近战狂热，远程自身 +1
    if (d.formation) { if (u.row === 'm') u.zeal = true; else this.boost(u, 1, u); }
    if (played && d.deploy) d.deploy(c, opts);
    if (played && d.deployRow && d.deployRow[u.row]) d.deployRow[u.row](c, opts);
    this.checkBless(u);
    this.emit('unitEnter', { unit: u, played });
    if (played) {
      this.emit('cardPlayed', { side: u.side, name: u.name, unit: u, def: d });
      if (d.type !== 'artifact') this.emit('unitPlayed', { unit: u });
    }
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
    } else u.status[key] = val;
    this.log('状态', { uid: u.uid, name: u.name, key, val: u.status[key], by: src && src.name });
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
    const doomed = u.status.doomed || u.origin === 'spawn';
    (doomed ? this.s.sides[u.side].banished : this.s.sides[u.side].grave).push(u.name);
    this.log('摧毁', { uid: u.uid, name: u.name, by: src && src.name });
    if (u.def.deathwish && !u.status.lock) u.def.deathwish(this.ctx(u));
    this.emit('destroyed', { unit: u, src });
    if (src && src.def) {
      if (src.def.deathblow && (!src.uid || this.find(src.uid)) && !(src.status && src.status.lock)) src.def.deathblow(this.ctx(src), u);
      this.emit('deathblow', { unit: src, victim: u });
    }
  }

  purify(u, src) {
    for (const k of Object.keys(u.status)) if (k !== 'shield' && k !== 'immune') u.status[k] = k === 'vitality' || k === 'bleed' || k === 'poison' ? 0 : false;
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
    this.log('能力', { side, name, left: h.charges, unmodeled: !!h.def.unmodeled });
    if (h.def.order) h.def.order(this.ctx(h), opts);
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
    else if (u.orderUsed >= (u.def.charges != null ? u.def.charges : 1)) return false;
    // 进场当回合不能用；狂热例外
    return u.zeal || this.s.turn > u.enteredTurn;
  }
  order(uid, opts = {}) {
    const u = this.find(uid);
    if (!u) return;
    if (!this.canOrder(u) && !opts.force) this.log('指令不可用', { uid, name: u.name }, true);
    u.orderUsed++;
    if (u.def.cooldown != null) u.cd = u.def.cooldown;
    this.log('指令', { uid, name: u.name });
    u.def.order(this.ctx(u), opts);
  }

  // ---------- 回合 ----------
  startTurn() {
    const side = this.s.active;
    // 整排效果：拥有者回合开始时生效
    for (const r of ROWS) {
      const h = this.s.hazards[side][r];
      if (h && h.run) { h.run(this, side, r); if (--h.turns <= 0) this.s.hazards[side][r] = null; }
    }
    for (const u of this.allUnits(side)) if (u.cd > 0) u.cd--;
    this.emit('turnStart', { side });
  }

  endTurn() {
    const side = this.s.active;
    this.emit('turnEnd', { side });
    // 活力 / 重伤：单位拥有者回合结束
    for (const u of this.allUnits(side).slice()) {
      if (u.status.vitality > 0) { u.status.vitality--; this.boost(u, 1, { name: '活力' }); }
      else if (u.status.bleed > 0) { u.status.bleed--; this.damage(u, 1, { name: '重伤' }, { ignoreArmor: true, bleed: true }); }
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
    this.endTurn();
  }

  // ---------- 小局 ----------
  startRound() {
    const s = this.s;
    s.sides.me.passed = s.sides.op.passed = false;
    // 老兵：第二、三小局开始时基础战力 +1
    if (s.round > 0) for (const u of this.allUnits()) if (u.def.veteran) this.strengthen(u, u.def.veteran, { name: '老兵' });
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
          u.status.resilience = false; u.power = u.base; u.armor = u.def.armor || 0; keep.push(u);
        } else {
          (u.status.doomed || u.origin === 'spawn' ? s.sides[sd].banished : s.sides[sd].grave).push(u.name);
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

  // ---------- 快照（给界面和校准用） ----------
  snapshot() {
    const view = sd => ({
      rows: Object.fromEntries(ROWS.map(r => [r, this.s.sides[sd].rows[r].map(u => ({
        uid: u.uid, name: u.name, base: u.base, power: u.power, armor: u.armor,
        status: Object.fromEntries(Object.entries(u.status).filter(([, v]) => v)),
        unmodeled: u.unmodeled, canOrder: this.canOrder(u) }))])),
      score: this.score(sd), passed: this.s.sides[sd].passed, handCount: this.s.sides[sd].handCount,
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

const API = { Game, DEFAULT_RULES, calibrate, OTHER, ROWS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.GwentEngine = API;
})(this);
