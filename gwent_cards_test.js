// 卡牌效果测试（真实卡牌数据 + 行为）：node gwent_cards_test.js
const E = require('./src/engine.js');
const B = require('./src/cards.js').behaviors;
eval(require('fs').readFileSync('./src/data.js', 'utf8').replace('const RAW', 'global.RAW'));
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
console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
