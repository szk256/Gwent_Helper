// 卡牌效果测试（真实卡牌数据 + 行为）：node gwent_cards_test.js
const E = require('./src/engine.js');
const B = require('./src/cards.js').behaviors;
eval(require('fs').readFileSync('./src/data.js', 'utf8').replace('const RAW', 'global.RAW'));
require('./src/patches.js').applyAll(RAW);
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('✗', m); } else console.log('✓', m); };
// picks：按顺序给出的选择（单位、牌名、true/false）
function game(picks = []) {
  const g = new E.Game({ first: 'me' }); g.loadData(RAW); g.loadBehaviors(B);
  g.chooser = req => { if (!picks.length) return null; const p = picks.shift(); return typeof p === 'function' ? p(req) : p; };
  g.startRound(); g.s.sides.me.vars.devotion = true; return g;
}
const P = (g, side, name, row, pos) => g.play(side, name, row, pos, { player: side });

{ // 战地医师：相邻 +2
  const g = game(); const a = P(g, 'me', '科德温骑士', 'm'), c = P(g, 'me', '科德温骑士', 'm');
  const m = P(g, 'me', '战地医师', 'm', 1);
  ok(a.power === 7 && c.power === 7 && m.power === 2, '战地医师：相邻单位 +2');
}
{ // 耐性：回合结束指令没用 +1；班阿德的学生造成耐性值的伤害
  const g = game(); const s = P(g, 'me', '班阿德的学生', 'm'); const e = P(g, 'op', '亚甸槌击者', 'm');
  g.endTurn(); g.endTurn(); g.endTurn(); g.endTurn();
  ok(s.pat === 2, '耐性：两个己方回合结束 → 2');
  const g2picks = [[e]]; g.chooser = () => g2picks.shift() || null; g.order(s.uid); ok(e.power === 3, '班阿德的学生：造成 2 点伤害');
}
{ // 操控：两侧都是士兵
  const g = game(); P(g, 'me', '亚甸槌击者', 'm'); const el = P(g, 'me', '战象', 'm'); P(g, 'me', '亚甸槌击者', 'm');
  g.endTurn(); g.endTurn(); g.order(el.uid);
  ok(el.power === 16, '战象：操控时自身 +8（相邻各受 4 伤害）');
}
{ // 增兵：打出战争牌冷却 -1
  const g = game(); P(g, 'me', '亚甸槌击者', 'm'); const pr = P(g, 'me', '弗尔泰斯特之傲', 'm'); P(g, 'op', '亚甸槌击者', 'm');
  const foe = g.units('op')[0];
  g.chooser = () => [foe]; g.order(pr.uid, { force: true }); const cd0 = pr.cd;
  g.chooser = () => [pr]; g.play('me', '绞盘'); ok(cd0 === 4 && pr.cd === 0, '增兵：绞盘 -3，再因战争牌 -1');
}
{ // 异婴 ↔ 家事妖精：变形保留战力
  const g = game(); const u = P(g, 'me', '异婴', 'm'); g.boost(u, 2); g.order(u.uid, { force: true });
  ok(u.name === '家事妖精' && u.power === 7, '异婴变形为家事妖精，战力不变');
}
{ // 染血连枷：每个士兵把 1 回合重伤换成 1 点伤害
  const g = game(); P(g, 'me', '亚甸槌击者', 'm'); P(g, 'me', '科德温骑士', 'm'); const t = P(g, 'op', '战地医师', 'r');
  g.chooser = () => [t]; g.boost(t, 8); g.play('me', '染血连枷');
  ok(t.power === 8 && t.status.bleed === 6, '染血连枷：2 名士兵 → 2 点伤害 + 重伤 6');
}
{ // 可怜的步兵：两侧生成杂兵；辛特拉皇家护卫：每个同名 +3
  const g = game(); const p = P(g, 'me', '可怜的步兵', 'm');
  ok(g.s.sides.me.rows.m.map(u => u.name).join() === '左侧翼杂兵,可怜的步兵,右侧翼杂兵', '可怜的步兵：左右生成杂兵');
  P(g, 'me', '辛特拉皇家护卫', 'r'); const c2 = P(g, 'me', '辛特拉皇家护卫', 'r'); ok(c2.power === 8, '辛特拉皇家护卫：已有 1 张同名 +3');
}
{ // 凯拉克海军：赤诚时 +4
  const g = game(); const t = P(g, 'me', '科德温骑士', 'm'); const n = P(g, 'me', '凯拉克海军', 'r');
  g.chooser = () => [t]; g.order(n.uid); ok(t.power === 9, '凯拉克海军：赤诚 +4（狂热当回合可用）');
}
{ // 炮击：4 + 攻城器械数，随机分摊
  const g = game(); P(g, 'me', '弩炮', 'r'); const a = P(g, 'op', '亚甸槌击者', 'm'), b = P(g, 'op', '科德温骑士', 'm');
  g.chooser = () => [a, a, b, a, b]; g.play('me', '炮击');
  ok(a.power === 2 && b.power === 3, '炮击：1 台攻城器械 → 5 点分摊');
}
{ // 投石车：己方每用 1 次指令，随机敌军 1 伤害
  const g = game(); P(g, 'me', '投石车', 'r'); const s = P(g, 'me', '亚甸槌击者', 'm'); const e = P(g, 'op', '科德温骑士', 'm');
  g.endTurn(); g.endTurn(); g.chooser = () => [e]; g.order(s.uid);
  ok(e.power === 2, '投石车：槌击者 2 伤害 + 投石车 1 伤害');
}
{ // 维索戈塔：任意方打出牌充能 +1
  const g = game(); const v = P(g, 'me', '科沃的维索戈塔', 'r'); P(g, 'op', '科德温骑士', 'm'); P(g, 'me', '科德温骑士', 'm');
  ok(g.counters(v).charges === 3, '维索戈塔：打出 2 张牌后充能 3');
}
{ // 围攻：序章生成投石机；打出攻城器械推进
  const g = game(); P(g, 'me', '围攻', 'r'); ok(g.units('me').some(u => u.name === '加强型投石机'), '围攻序章：生成加强型投石机');
  P(g, 'me', '弩炮', 'r'); ok(g.units('me').some(u => u.name === '攻城槌'), '围攻第一章：生成攻城槌');
}

// ---------- 松鼠党 ----------
{ // 和谐：打出主类别不同的非中立单位 +1
  const g = game(); const h = P(g, 'op', '新生树精', 'm');
  P(g, 'op', '矿工', 'm'); P(g, 'op', '伊森格林', 'r'); P(g, 'op', '矿工', 'r');
  ok(h.power === 5 + 1 + 1 + 1, '和谐：自身（树精）、矮人、精灵各 +1，第二个矮人不加');
}
{ // 共生：打出自然牌生成游荡的树人，战力 = 共生数量
  const g = game(); P(g, 'op', '橡树之地护卫', 'm'); P(g, 'op', '树精附魔师', 'r');
  const t = P(g, 'op', '科德温骑士', 'm'); g.chooser = () => [t]; g.play('op', '淬火', null, null, { player: 'op' });
  const tr = g.units('op').find(u => u.name === '游荡的树人');
  ok(tr && tr.power === 2, '共生：2 个共生单位 → 树人 2');
}
{ // 陷阱：焚烧陷阱背面朝上，对手打出单位时翻开并造成 5 点伤害
  const g = game(); const tp = P(g, 'op', '焚烧陷阱', 'r'); ok(tp.status.ambush, '陷阱打出时背面朝上');
  const u = P(g, 'me', '亚甸槌击者', 'm'); ok(u.power === 0 || !g.find(u.uid), '焚烧陷阱：对手打出单位 → 5 伤害');
  ok(!tp.status.ambush, '陷阱触发后翻开');
}
{ // 做炸弹：唯一单位时改为 4 伤害
  const g = game(); const e = P(g, 'me', '科德温骑士', 'm'); g.chooser = () => [e]; g.play('op', '做炸弹', null, null, { player: 'op' });
  ok(e.row === 'r' && e.power === 1 && !e.status.bleed, '做炸弹：移到空排 → 4 伤害');
}
{ // 游击战术（领袖）：移动敌军并 1 伤害；维里赫德旅被移动 → 随机 2 伤害
  const g = game(); const v = P(g, 'op', '维里赫德旅', 'm'); const e = P(g, 'me', '科德温骑士', 'm');
  g.chooser = req => [req.kind === 'random' ? e : v]; g.useAbility('op', '游击战术');
  ok(v.row === 'r' && v.power === 7 && e.power === 3, '游击战术移动友军 +3；维里赫德旅被移动 → 2 伤害');
}
{ // 备用计划：对手上一个打出的单位 2 伤害
  const g = game(); P(g, 'me', '科德温骑士', 'm'); const last = P(g, 'me', '亚甸槌击者', 'm'); g.play('op', '备用计划', null, null, { player: 'op' });
  ok(last.power === 3, '备用计划：打对手上一个打出的单位');
}

// ---------- 怪兽 ----------
{ // 成长：打出战力更高的单位 +1；齐齐摩女王成长时同排类虫 +1
  const g = game(); const s1 = P(g, 'op', '尖啸女妖', 'm'); P(g, 'op', '寒冰巨人', 'm');
  ok(s1.power === 4, '成长：打出更高战力单位 +1（3→4）');
  const q = P(g, 'op', '齐齐摩女王', 'r'); const d = P(g, 'op', '安德莱格幼虫', 'r');
  g.play('op', '可怖盛宴', null, null, { player: 'op' });
  ok(q.power === 5 && d.power >= 3, '齐齐摩女王：打出生物牌触发成长，同排类虫 +1');
}
{ // 吞噬：获得被吞噬单位的战力
  const g = game(); const t = P(g, 'op', '寒冰巨人', 'm'); const k = P(g, 'op', '奇美拉', 'm');
  ok(k.power === 13 && !g.find(t.uid), '奇美拉吞噬寒冰巨人：6+7');
}
{ // 触发遗愿：无骨者触发安德莱格虫卵
  const g = game(); P(g, 'op', '安德莱格虫卵', 'm'); P(g, 'op', '无骨者', 'm');
  ok(g.units('op').filter(u => u.name === '雄蛛').length === 3, '无骨者：触发虫卵遗愿，生成 3 只雄蛛');
}
{ // 汲食
  const g = game(); const e = P(g, 'me', '科德温骑士', 'm'); const r = P(g, 'op', '雷吉斯：重生', 'm');
  ok(e.power === 2 && r.power === 4, '雷吉斯：汲食 3');
}
{ // 呢喃婆：己方每打出过 1 张老巫妪，伤害 +2
  const g = game(); P(g, 'op', '织婆', 'r'); const e = P(g, 'me', '寒冰巨人', 'm'); P(g, 'op', '呢喃婆', 'm');
  ok(e.power === 3, '呢喃婆：打出过 1 张老巫妪 → 4 伤害');
}
{ // 蝠翼魔：敌军获得重伤时 +回合数
  const g = game(); const b = P(g, 'op', '蝠翼魔', 'r'); P(g, 'me', '科德温骑士', 'm'); P(g, 'op', '吸血鬼女', 'm');
  ok(b.power === 7, '蝠翼魔：敌军重伤 3 → +3');
}

// ---------- 尼弗迦德 ----------
{ // 翼守：远程排只与 1 张牌相邻时回合结束 +1 护甲
  const g = game(); const f = P(g, 'op', '公爵守卫', 'r'); P(g, 'op', '帝国毒牙', 'r');
  g.s.active = 'op'; g.endTurn(); ok(f.armor === 1, '翼守（远程）：回合结束 +1 护甲');
}
{ // 同化：打出生成出来的牌 +1
  const g = game(); const a = P(g, 'op', '帝国占卜师', 'm'); g.chooser = () => null;
  g.useAbility('op', '战术决策'); ok(a.power === 6, '同化：生成并打出莫尔凡 → +1');
}
{ // 共谋：致命一击对潜伏单位总会触发致死（生成并打出同名牌）
  const g = game(); const t = P(g, 'me', '寒冰巨人', 'm'); g.addStatus(t, 'spying'); g.chooser = () => [t];
  g.play('op', '致命一击', null, null, { player: 'op' });
  ok(t.power === 4 && g.units('op').some(u => u.name === '寒冰巨人'), '致命一击：共谋 → 生成并打出同名牌');
}
{ // 口渴的夫人：敌军获得状态 +1；帝国毒牙：中毒
  const g = game(); const d = P(g, 'op', '口渴的夫人', 'r'); const e = P(g, 'me', '寒冰巨人', 'm'); g.chooser = () => [e];
  P(g, 'op', '帝国毒牙', 'm'); ok(e.status.poison === 1 && d.power === 5, '口渴的夫人：敌军中毒 +1');
}
{ // 牛尸：不忠，回合结束使相邻中毒并摧毁自身
  const g = game(); const a = P(g, 'me', '寒冰巨人', 'm'); g.chooser = () => null; g.useAbility('op', '战术决策');
  const cow = g.play('op', '牛尸', 'm', 1, { player: 'op' });
  ok(cow.side === 'me' && cow.status.spying, '牛尸：落到对面并获得潜伏');
  g.s.active = 'me'; g.endTurn(); ok(a.status.poison === 1 && !g.find(cow.uid), '牛尸：回合结束相邻中毒、摧毁自身');
}

// ---------- 斯凯利格 ----------
{ // 狂暴：斯瓦勃洛狂信者战力 ≤2 时变成异变巨熊
  const g = game(); const f = P(g, 'op', '斯瓦勃洛狂信者', 'm'); g.damage(f, 1); ok(f.name === '斯瓦勃洛狂信者', '狂暴：3 时不触发');
  g.damage(f, 1); ok(f.name === '异变巨熊', '狂暴 2：变成异变巨熊');
}
{ // 战狂 + 征战：巨斧挥击在 2 个受伤敌军时 6 伤害；高地领主让征战 +1
  const g = game(); const a = P(g, 'me', '寒冰巨人', 'm'), b = P(g, 'me', '科德温骑士', 'm'); g.damage(a, 1); g.damage(b, 1);
  P(g, 'op', '高地领主', 'r'); const t = P(g, 'me', '老矛头', 'r'); g.chooser = () => [t]; g.play('op', '巨斧挥击', null, null, { player: 'op' });
  ok(t.power === 5, '巨斧挥击：战狂 2 → 6，高地领主 +1 → 7 伤害');
}
{ // 致幻菌菇：3 伤害后 +9
  const g = game(); const t = P(g, 'op', '寒冰巨人', 'm'); g.chooser = () => [t]; g.play('op', '致幻菌菇', null, null, { player: 'op' });
  ok(t.power === 13, '致幻菌菇：7-3+9');
}
{ // 乌鸦眼块茎：控制德鲁伊时 3 只乌鸦
  const g = game(); P(g, 'op', '莫斯萨克', 'm'); g.play('op', '乌鸦眼块茎', null, null, { player: 'op', row: 'r' });
  ok(g.units('op').filter(u => u.name === '乌鸦').length === 3, '乌鸦眼块茎：有德鲁伊 → 3 只乌鸦');
}

// ---------- 中立 ----------
{ // 烧灼：摧毁最强单位；先机时摧毁所有最强
  const g = game(); const a = P(g, 'me', '老矛头', 'm'), b = P(g, 'op', '老矛头', 'm'); g.chooser = () => [a];
  g.play('op', '烧灼', null, null, { player: 'op' }); ok(!g.find(a.uid) && !g.find(b.uid), '烧灼：本回合没用指令（先机）→ 摧毁所有最高');
}
{ // 指挥号角：5 个相邻 +2，铜色每邻 1 金色额外 +1
  const g = game(); const us = ['科德温骑士', '雷纳德·奥多', '科德温骑士', '科德温骑士', '科德温骑士'].map(n => P(g, 'me', n, 'm'));
  const mid = us[2]; g.chooser = () => [mid]; g.play('me', '指挥号角');
  ok(us[0].power === 8 && us[2].power === 9 && us[3].power === 8 && us[1].power === 11, '指挥号角：挨着金卡雷纳德的铜卡 +3，其余 +2');
}
{ // 温格堡的叶奈法（近战）：所有其他单位 2 伤害
  const g = game(); const a = P(g, 'me', '老矛头', 'm'), b = P(g, 'op', '寒冰巨人', 'r'); P(g, 'op', '温格堡的叶奈法', 'm');
  ok(a.power === 10 && b.power === 5, '温格堡的叶奈法：近战 → 其他单位各 2');
}
{ // 维伦特瑞坦梅斯：计时 3 摧毁最高（己方巨龙除外）
  const g = game(); const v = P(g, 'op', '维伦特瑞坦梅斯', 'r'); const big = P(g, 'me', '老矛头', 'm');
  g.s.active = 'op'; g.endTurn(); g.endTurn(); g.endTurn(); g.endTurn(); g.endTurn();
  ok(!g.find(big.uid) && g.find(v.uid), '维伦特瑞坦梅斯：计时归零摧毁最高');
}

// ---------- 辛迪加 ----------
{ // 献金“改为”：锡皮小子付了献金 8 → 所有敌军 2 伤害
  const g = game(); const a = P(g, 'me', '寒冰巨人', 'm'), b = P(g, 'me', '老矛头', 'r'); g.s.sides.op.coins = 9;
  P(g, 'op', '锡皮小子', 'm'); ok(a.power === 5 && b.power === 10 && g.s.sides.op.coins === 1, '锡皮小子：献金 8 → 所有敌军 2 伤害');
}
{ // 没付献金：只打一排
  const g = game(); const a = P(g, 'me', '寒冰巨人', 'm'), b = P(g, 'me', '老矛头', 'r'); g.s.sides.op.coins = 3; g.chooser = req => req.kind === 'tribute' ? null : [a];
  P(g, 'op', '锡皮小子', 'm'); ok(a.power === 5 && b.power === 12, '锡皮小子：金币不够 → 只打选中的一排');
}
{ // 费用：海狼；囤积 7 时 +3
  const g = game(); const w = P(g, 'op', '海狼', 'm'); g.s.sides.op.coins = 9; g.order(w.uid, { force: true });
  ok(w.power === 7 && g.s.sides.op.coins === 7, '海狼：费用 2，囤积 7 → +3');
}
{ // 赏金：女巫猎人设赏金；“义警”对设赏金的敌军 2 伤害；被摧毁时对手拿金币
  const g = game(); P(g, 'op', '“义警”', 'r'); const t = P(g, 'me', '寒冰巨人', 'm'); g.chooser = () => [t];
  P(g, 'op', '女巫猎人', 'm'); ok(t.status.bounty && t.power === 5, '女巫猎人：赏金；义警 2 伤害');
  const c0 = g.s.sides.op.coins; g.destroy(t); ok(g.s.sides.op.coins === c0 + 7, '赏金单位被摧毁：对手获得基础战力的金币');
}
{ // 败德：伊克索拉累计花 8 金币时摧毁最低敌军
  const g = game(); P(g, 'op', '伊克索拉', 'r'); const low = P(g, 'me', '科德温骑士', 'm'); P(g, 'me', '寒冰巨人', 'm');
  g.s.sides.op.coins = 9; g.spendCoins('op', 5); ok(g.find(low.uid), '败德：花 5 不触发'); g.spendCoins('op', 3); ok(!g.find(low.uid), '败德 8：累计花 8 → 摧毁最低敌军');
}

// ---------- 最后补齐的 6 张 ----------
{ // 洞察之球：+2 活力 2；进墓场后己方打出 3 张特殊牌 → 从墓场打出自己并佚亡
  const g = game(); const a = P(g, 'me', '科德温骑士', 'm');
  g.chooser = () => [a]; g.play('me', 'Orb of Insight');
  ok(a.power === 7 && a.status.vitality === 2 && g.s.sides.me.graveWatch.length === 1, '洞察之球：+2、活力 2，墓场里开始计数');
  g.play('me', '绞盘'); g.play('me', '绞盘'); ok(g.s.sides.me.graveWatch[0].vars.count === 1 && a.power === 17, '洞察之球：2 张特殊牌后计数 1');
  g.play('op', '绞盘'); ok(g.s.sides.me.graveWatch[0].vars.count === 1, '洞察之球：对方的特殊牌不算');
  g.play('me', '绞盘');
  ok(a.power === 24 && a.status.vitality === 4 && g.s.sides.me.banished.includes('Orb of Insight') && !g.s.sides.me.grave.includes('Orb of Insight') && !g.s.sides.me.graveWatch.length,
     '洞察之球：计数归零从墓场打出自己（+2、活力 +2），随后放逐');
}
{ // 棱镜吊坠：特殊牌指定友军 → 活力 = 人口；指定敌军 → 重伤
  const g = game(); P(g, 'me', '棱镜吊坠', 'r'); const a = P(g, 'me', '科德温骑士', 'm'), e = P(g, 'op', '寒冰巨人', 'm');
  g.chooser = () => [a]; g.play('me', '绞盘'); ok(a.status.vitality === 4, '棱镜吊坠：绞盘（4 人口）指定友军 → 活力 4');
  g.chooser = () => [e]; g.play('op', '绞盘'); ok(!e.status.bleed && !e.status.vitality, '棱镜吊坠：对方的特殊牌不触发');
  g.chooser = req => /点该排/.test(req.prompt) ? [e] : null; g.play('me', '撕裂'); ok(!e.status.bleed, '棱镜吊坠：选排的特殊牌不算指定单位');
}
{ // 精灵先知：被铜色特殊牌指定 → 生成并打出同名牌一次
  const g = game(); const s = P(g, 'me', '精灵先知', 'm');
  g.chooser = () => [s]; g.play('me', '绞盘');
  ok(s.power === 4 + 10 && s.vars.count === 0, '精灵先知：绞盘复制一次（+5 ×2）');
  g.play("me", "绞盘"); ok(s.power === 19, '精灵先知：倒数用完不再复制');
}
{ // 棘手困境：对方打出 ≤4 战力单位翻开 → 锁定；正面朝上时回合结束相邻 +2，对方停牌 -1 并锁定
  const g = game(); const x = P(g, 'me', '科德温骑士', 'm'); const st = P(g, 'me', '棘手困境', 'm'); const y = P(g, 'me', '科德温骑士', 'm');
  ok(st.status.ambush, '棘手困境：伏击背面朝上');
  P(g, 'op', '寒冰巨人', 'm'); ok(st.status.ambush, '棘手困境：对方打出高战力单位不翻');
  P(g, 'op', '班阿德的学生', 'm'); ok(!st.status.ambush && st.status.lock, '棘手困境：对方打出 ≤4 → 翻开并锁定');
  const g2 = game(); const a = P(g2, 'me', '科德温骑士', 'm'); const t2 = P(g2, 'me', '棘手困境', 'm');
  g2.flip(t2); g2.endTurn(); ok(a.power === 7, '棘手困境：正面朝上，己方回合结束相邻 +2');
  g2.pass('op'); ok(t2.status.lock && t2.vars.dec === 1, '棘手困境：对方停牌 → 数值 -1、锁定自身');
}
{ // 校友会：最大耐性 ≥4 狂热；近战伤害 = 最大耐性
  const g = game(); const s = P(g, 'me', '班阿德的学生', 'm'); const e = P(g, 'op', '寒冰巨人', 'm');
  for (let i = 0; i < 8; i++) g.endTurn();
  ok(g.s.sides.me.vars.maxPat['班阿德的学生'] === 4, '校友会：记录班阿德的学生最大耐性 4');
  g.destroy(s); const al = P(g, 'me', '校友会', 'm'); ok(al.zeal, '校友会：最大耐性 ≥4 → 狂热（学生离场后仍保留）');
  g.chooser = () => [e]; g.order(al.uid); ok(e.power === 3, '校友会（近战）：造成 4 点伤害');
  const g2 = game(); const al2 = P(g2, 'me', '校友会', 'm'); ok(!al2.zeal, '校友会：没有耐性单位 → 不狂热');
}
{ // 拉尔维克的埃兰：牌组单位 +1，之后上场带增益；指令转移牌组里剩下的增益；亢奋 3 免疫
  const g = game(); let deck = ['科德温骑士', '科德温骑士', '寒冰巨人', '绞盘'];
  g.deckInfo = sd => sd === 'me' ? deck.slice() : null;
  g.chooser = req => req.kind === 'frenzy' ? true : null;
  const er = P(g, 'me', '拉尔维克的埃兰', 'm'); ok(er.status.immune, '埃兰：亢奋 3 成立 → 免疫');
  deck = ['科德温骑士', '科德温骑士', '绞盘']; const k = g.play('me', '寒冰巨人', 'm', null, { fromDeck: true });
  ok(k.power === k.base + 1, '埃兰：牌组里的单位之后上场带 +1');
  g.order(er.uid, { force: true }); ok(er.power === er.base + 2, '埃兰指令：转移牌组里剩下 2 个单位的增益');
  const g2 = game(); g2.chooser = req => req.kind === 'deckCount' ? 5 : req.kind === 'frenzy' ? false : null;
  const er2 = P(g2, 'op', '拉尔维克的埃兰', 'm'); g2.order(er2.uid, { force: true });
  ok(!er2.status.immune && er2.power === er2.base + 5, '埃兰（对方）：按记录的牌组单位数转移；亢奋不成立不免疫');
}

// ---------- 手牌张数 ----------
{ // 塔勒：双方各抽 1；对方手牌满则不抽。坎比：双方各丢 1。玛塔·乌莉（远程）
  const g = game(); g.s.sides.me.handCount = 5; g.s.sides.op.handCount = 6;
  const t = P(g, 'me', '塔勒', 'm'); g.order(t.uid, { force: true });
  ok(g.s.sides.me.handCount === 4 + 1 && g.s.sides.op.handCount === 7, '塔勒：双方各抽 1 张（打出塔勒本身 -1）');
  g.s.sides.op.handCount = 10; t.orderUsed = 0; g.order(t.uid, { force: true }); ok(g.s.sides.op.handCount === 10 && g.s.sides.me.handCount === 5, '塔勒：对方手牌满 → 不抽');
  g.s.sides.op.handCount = 3; P(g, 'me', '坎比', 'm'); ok(g.s.sides.me.handCount === 3 && g.s.sides.op.handCount === 2, '坎比：双方各丢 1 张');
  P(g, 'me', '玛塔·乌莉', 'r'); ok(g.s.sides.me.handCount === 3 && g.s.sides.op.handCount === 3, '玛塔·乌莉（远程）：双方各抽 1 张');
}
{ // 阿达尔：把 ≤2 战力敌军送回对方手牌，己方抽 1
  const g = game(); g.s.sides.me.handCount = 5; g.s.sides.op.handCount = 5; const e = P(g, 'op', '班阿德的学生', 'm'); g.damage(e, 2);
  g.chooser = () => [e]; P(g, 'me', '阿达尔·爱普·达西', 'r');
  ok(!g.find(e.uid) && g.s.sides.op.handCount === 5 && g.s.sides.me.handCount === 5, '阿达尔：敌军回手（对方 +1），己方抽 1（打出 -1）');
}
{ // 蒂博尔：进场时对方抽 1；对方已停牌 → 自伤 12
  const g = game(); g.s.sides.op.handCount = 4; P(g, 'me', '蒂博尔·艾格布拉杰', 'm'); ok(g.s.sides.op.handCount === 5, '蒂博尔：进场对方抽 1 张');
  const g2 = game(); g2.s.sides.op.passed = true; const b = P(g2, 'me', '蒂博尔·艾格布拉杰', 'm'); ok(b.power === Math.max(0, b.base - 12) || !g2.find(b.uid), '蒂博尔：对方已停牌 → 自伤 12');
}

// ---------- 亢奋（按推算手牌数） ----------
{ const g = game(); g.s.sides.me.handKnown = true; g.s.sides.me.handCount = 3; const e = P(g, 'op', '寒冰巨人', 'm'); g.chooser = req => req.kind === 'frenzy' ? null : [e];
  P(g, 'me', '伊瓦‧邪眼', 'm'); ok(e.power === e.base - 4, '伊瓦：亢奋 2（打出后手牌 2）→ 改为 4 点伤害');
  g.s.sides.me.handCount = 6; const e2 = P(g, 'op', '班阿德的学生', 'm'); g.chooser = req => req.kind === 'frenzy' ? null : [e2]; const y = P(g, 'me', '伊瓦‧邪眼', 'm');
  ok(y.power === e2.base && e2.power === y.base, '伊瓦：手牌多 → 交换战力'); }
{ const g = game(); g.s.sides.me.handKnown = true; g.s.sides.me.handCount = 3; const a = P(g, 'op', '寒冰巨人', 'm');
  P(g, 'me', '格德', 'm'); ok(a.power === a.base, '格德：亢奋 3 → 只伤女海妖');
  const g2 = game(); g2.s.sides.me.handKnown = true; g2.s.sides.me.handCount = 8; const b = P(g2, 'op', '寒冰巨人', 'm'); P(g2, 'me', '格德', 'm'); ok(b.power === b.base - 1, '格德：手牌多 → 整排 1 伤害'); }
{ const g = game(); g.s.sides.me.handKnown = true; g.s.sides.me.handCount = 2; const k = P(g, 'me', '凯尔达', 'm'); g.endTurn();
  ok(g.units('me').filter(u => u.name === '猎魔人学徒').length === 1, '凯尔达：亢奋 4 → 回合结束生成学徒'); }
{ // 拉多维德皇家护卫：激励时护甲给被增益的单位
  const g = game(); const rg = P(g, 'me', '拉多维德皇家护卫', 'm'); const a = P(g, 'me', '科德温骑士', 'm'); g.boost(rg, 1);
  g.chooser = () => [a]; g.order(rg.uid, { force: true }); ok(a.armor === 2 && !rg.armor, '皇家护卫：激励 → 目标 +2 护甲');
}
{ // 神殿守卫：选中间的友军，它和两边 +1
  const g = game(); const a = P(g, 'me', '科德温骑士', 'r'), b = P(g, 'me', '科德温骑士', 'r'), d = P(g, 'me', '科德温骑士', 'r'), e = P(g, 'me', '科德温骑士', 'r');
  g.chooser = () => [b]; P(g, 'me', '神殿守卫', 'm');
  ok(a.power === 6 && b.power === 6 && d.power === 6 && e.power === 5, '神殿守卫：中间 + 两边各 +1');
}
{ // 月度补丁新增的牌：套用后出现在数据里、引擎当作未建模；补丁日期之前的对局看不到它
  const P = require('./src/patches.js'); const R = RAW.map(r => r.slice());
  P.PATCHES.push({ date: '2099-01-01', ver: '99.1.0', cards: [{ n: '测试新牌', id: 999999, add: ['测试新牌', 'NR', '铜', '单位', '5', '6', '普通', '士兵', '部署：对 1 个敌军单位造成 2 点伤害。', 'Test', 'Deploy: Damage an enemy unit by 2.', 'test', '9999', '-'] }] });
  P.applyAll(R); const g = new E.Game({ first: 'me' }); g.loadData(R); g.loadBehaviors(B); g.startRound();
  const u = g.play('me', '测试新牌', 'm');
  ok(R.some(r => r[0] === '测试新牌') && u.power === 5 && u.unmodeled, '补丁新牌：加进数据，战力 5，未建模');
  ok(!P.rawAt(R, '2098-12-31').some(r => r[0] === '测试新牌') && P.rawAt(R, '2099-02-01').some(r => r[0] === '测试新牌'), '补丁新牌：补丁之前的对局看不到');
  P.applyAll(R); ok(R.filter(r => r[0] === '测试新牌').length === 1, '补丁新牌：重复套用不会加两次');
  P.PATCHES.pop();
}
// ---- 词条多语言核对后的修正（2026-10）----
{ // 汲食无视护甲：雷吉斯：重生 汲食瑞达尼亚骑士（护甲 2）3 点
  const g = game(); const k = P(g, 'op', '瑞达尼亚骑士', 'm'); g.chooser = () => [k]; const r = P(g, 'me', '雷吉斯：重生', 'm');
  ok(k.armor === 2 && k.power === 0 || !g.find(k.uid), '汲食：无视护甲，护甲不掉'); ok(r.power === r.base + 2, '汲食：自身增益 = 实际扣掉的战力');
}
{ // 翻开：打在神器旁边的陷阱自动翻开（玛哈坎号角翻开：相邻 +3）
  const g = game(); const a = P(g, 'me', '科德温骑士', 'm'); P(g, 'me', '欺骗', 'm'); const h = P(g, 'me', '玛哈坎号角', 'm');
  ok(!h.status.ambush, '陷阱靠神器：自动翻开'); ok(a.power === 5, '陷阱靠神器：只加相邻（科德温不相邻，不变）');
  const g2 = game(); const b = P(g2, 'me', '科德温骑士', 'm'); const h2 = P(g2, 'me', '玛哈坎号角', 'm');
  ok(h2.status.ambush && b.power === 5, '陷阱不靠神器：背面朝上');
}
{ // 癫狂：有护盾挡住伤害时费用能力不触发
  const g = game(); const u = P(g, 'me', '变异兄弟', 'm'); g.endTurn(); g.endTurn(); u.status.shield = true;
  ok(!g.canFee(u), '癫狂：有护盾时不能用'); g.order(u.uid, { force: true });
  ok(u.armor === 5 && !u.status.shield && g.trace.some(t => t.type === '癫狂没造成伤害，费用能力不触发'), '癫狂：强行记录时护盾挡掉，不加护甲');
}
{ // 每排最多 9 张
  const g = game(); for (let i = 0; i < 10; i++) P(g, 'me', '科德温骑士', 'm');
  ok(g.s.sides.me.rows.m.length === 9 && g.trace.some(t => t.type === '排满'), '每排最多 9 张');
}
{ // 佚亡的单位洗回牌组 → 放逐
  const g = game(); const u = P(g, 'me', '科德温骑士', 'm'); u.status.doomed = true; g.shuffleBack(u);
  ok(!g.s.sides.me.deck.includes('科德温骑士') && g.s.sides.me.banished.includes('科德温骑士'), '佚亡：洗回牌组时改为放逐');
}
{ // 停牌后停牌方回合照常推进：活力照样 +1、整排效果照样结算（NamuWiki）
  const g = game(); g.rules.passedTurnsTick = true; const v = P(g, 'op', '科德温骑士', 'm'); g.addStatus(v, 'vitality', 3); g.addHazard('op', 'm', '风暴', 5);
  g.endTurn(); g.pass('op');                                   // 我方回合结束 → 对方停牌（停牌那一下不结算回合结束）
  const p0 = v.power; g.endTurn();                              // 我方再出一回合 → 对方跳过行动的回合：风暴 -1，活力 +1
  ok(v.power === p0 && g.s.active === 'me', '停牌方回合：风暴 -1、活力 +1 都结算，随后回到我方');
  const g2 = game({});  g2.rules.passedTurnsTick = false; const w2 = P(g2, 'op', '科德温骑士', 'm'); g2.addStatus(w2, 'vitality', 3);
  g2.endTurn(); g2.pass('op'); const q0 = w2.power; g2.endTurn(); ok(w2.power === q0, 'passedTurnsTick=false：停牌方不再结算');
}
{ // 整排效果在单位的回合开始效果之后结算，几排按放置先后
  const g = game(); const seen = []; g.on('turnStart', e => e.side === 'me' && seen.push('单位')); g.on('damaged', d => seen.push('整排:' + d.unit.row));
  P(g, 'me', '科德温骑士', 'r'); P(g, 'me', '科德温骑士', 'm'); g.addHazard('me', 'r', '风暴', 3); g.addHazard('me', 'm', '风暴', 3);
  g.endTurn(); g.endTurn(); ok(seen.join(',') === '单位,整排:r,整排:m', '整排效果：先单位回合开始，再按放置先后（远程先放）');
}
{ // 锁定不影响状态：被锁定的卫士照样挡
  const g = game(); const d = P(g, 'op', '科德温骑士', 'm'); d.status.defender = true; g.lock(d); const o = P(g, 'op', '科德温骑士', 'm');
  ok(g.targetable([d, o], 'me').length === 1 && g.targetable([d, o], 'me')[0] === d, '锁定的卫士：仍然只能选卫士');
}
{ // 坚韧留场：护甲（含卡面自带的）清零
  const g = game(); const k = P(g, 'me', '瑞达尼亚骑士', 'm'); k.status.resilience = true; g.addArmor(k, 3);
  const g2 = game(); const v = g2.carryIn(k, 'me', 'm');
  ok(k.def.armor > 0 && v.armor === 0, '坚韧留场：护甲清零（resilienceKeepsArmor=false）');
}
{ // 用户实测（2026-10-01）：坚韧留场“全部还原”，但指令和神赐不恢复；战力不变的变形保留基础战力
  const g = game(); const v = P(g, 'me', '范德格里夫特', 'm'); g.boost(v, 6);
  ok(v.blessFired[12], '范德格里夫特：第一局加到 12 触发神赐');
  const g2 = game(); const v2 = g2.carryIn(v, 'me', 'm'); g2.boost(v2, 6);
  ok(v2.power === 12 && v2.base === 6 && v2.status.shield && !v2.status.resilience, '范德格里夫特留场：战力回到 6、护盾恢复成卡面默认；再到 12 不再获得坚韧');
  const g3 = game(); const m1 = P(g3, 'me', '冥想的法师', 'm'); P(g3, 'me', '冥想的法师', 'm'); g3.endTurn(); g3.endTurn(); g3.order(m1.uid);
  const g4 = game(); const m2 = g4.carryIn(m1, 'me', 'm'); g4.endTurn(); g4.endTurn();
  ok(m2.power === m2.base && !m2.status.vitality && m2.orderUsed === 1 && !g4.canOrder(m2), '冥想的法师留场：战力、活力还原，指令不恢复');
  const g5 = game(); const w5 = P(g5, 'me', '亚特里的温德哈姆', 'm'); g5.boost(w5, 2); g5.chooser = () => [w5]; P(g5, 'me', '被诅咒的骑士', 'm');
  ok(w5.name === '被诅咒的骑士' && w5.power === 6 && w5.base === 4 && g5.isBoosted(w5), '被诅咒的骑士：温德哈姆变成 6 战力、基础 4（显示为增益）');
}
{ // 老兵（用户实测）：第二局从手牌打出的图尔赛克家族入侵者基础战力 6，第三局 7；场上留场的只加小局开始那一次
  const g = game(); g.s.round = 1; const a = P(g, 'me', '图尔赛克家族入侵者', 'm'); ok(a.base === 6 && a.power === 6, '老兵：第二局从手牌打出 5 → 6');
  const g2 = game(); g2.s.round = 2; const b = P(g2, 'me', '图尔赛克家族入侵者', 'm'); ok(b.base === 7, '老兵：第三局从手牌打出 → 7');
  const g3 = game(); const c1 = P(g3, 'me', '图尔赛克家族入侵者', 'm'); g3.s.round = 1; g3.startRound(); ok(c1.base === 6, '老兵：场上的单位第二局开始 +1（不重复加）');
}
{ // 杜度（2026-10-01 录像）：变成瑞达尼亚骑士的基础同名牌，带卡面 2 点护甲，远程壁垒每个己方回合结束 +1
  const g = game(); const rk = P(g, 'me', '瑞达尼亚骑士', 'r'); g.endTurn();
  g.chooser = () => [rk]; const d = P(g, 'op', '杜度', 'r');
  ok(d.name === '瑞达尼亚骑士' && d.power === 2 && d.armor === 2, '杜度：变成瑞达尼亚骑士 2 战力 2 护甲');
  g.endTurn(); ok(d.power === 3, '杜度变成的瑞达尼亚骑士：壁垒回合结束 +1');
}
console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
