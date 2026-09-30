const {Game, calibrate} = require('./src/engine.js');
let fails=0; const ok=(c,m)=>{ if(!c){fails++;console.log('✗',m)} else console.log('✓',m) };
// 测试用假卡，只验证底层机制
const cards = {
  甲: {name:'甲', base:5},
  盾兵: {name:'盾兵', base:4, status:{shield:true}},
  甲胄: {name:'甲胄', base:3, armor:2},
  神赐兵: {name:'神赐兵', base:4, bless:[{at:8, run:c=>c.boost(c.self,1)}]},
  指令兵: {name:'指令兵', base:4, order:(c,o)=>c.damage(o.target,3)},
  列阵兵: {name:'列阵兵', base:6, formation:true, order:(c,o)=>c.reset(o.target)},
  老兵: {name:'老兵', base:3, veteran:1, status:{resilience:true}},
  增益者: {name:'增益者', base:5, abilities:[{on:'unitPlayed', when:(c,d)=>d.unit.side===c.side&&d.unit!==c.self, run:(c,d)=>c.boost(d.unit,1)}]},
};
const g = new Game({cards, first:'me'});
g.startRound();
g.play('me','增益者','r'); g.endTurn();
const b = g.play('op','甲','m'); g.endTurn();
const s = g.play('me','盾兵','m');   ok(s.power===5,'打出触发友方被动：4+1=5');
g.damage(s,3,b);                      ok(s.power===5&&!s.status.shield,'护盾挡住整次伤害');
const ar = g.play('me','甲胄','m');  g.damage(ar,4,b); ok(ar.armor===0&&ar.power===2,'护甲吸收2，溢出2：4-2=2');
const bl = g.play('me','神赐兵','r'); g.boost(bl,2); ok(!bl.blessFired[8]&&bl.power===7,'7 未到神赐8');
g.boost(bl,1);                        ok(bl.blessFired[8]&&bl.power===9,'到8触发神赐，自身+1=9');
g.boost(bl,5);                        ok(bl.power===14,'神赐只触发一次');
const o = g.play('me','指令兵','m');  ok(!g.canOrder(o),'进场当回合不能用指令');
g.endTurn(); g.endTurn();             ok(g.canOrder(o),'下个己方回合可用');
g.order(o.uid,{target:b});            ok(b.power===2,'指令伤害3：5-3=2');
const f = g.play('me','列阵兵','m');  ok(f.zeal&&g.canOrder(f),'列阵近战：狂热，当回合可用指令');
g.boost(b,6); const lost = g.reset(b); ok(lost===3&&b.power===5,'重置：2+6=8，失去增益3，回到基础5');
const f2 = g.play('me','列阵兵','r'); ok(f2.power===6+1+1,'列阵远程+1，加被动+1=8');
g.addStatus(bl,'vitality',2); g.addStatus(bl,'bleed',3); ok(bl.status.vitality===0&&bl.status.bleed===1,'活力2与重伤3抵消，剩重伤1');
const before=bl.power; g.endTurn(); ok(bl.power===before-1,'己方回合结束重伤扣1，无视护甲');
g.damage(b,5,s);                      ok(!g.find(b.uid),'战力归零摧毁');
const v = g.play('op','老兵','m');
g.pass('op'); g.pass('me');
ok(g.s.results[0].res==='W','第一局结束，我方胜');
ok(g.find(v.uid)&&v.base===4&&!v.status.resilience,'坚韧留场、坚韧消失、老兵基础+1=4');
ok(g.score('me').total===0,'非坚韧单位清场');

// ---------- 词条一致性 ----------
{
  const cs = {
    甲: {name:'甲', base:5}, 乙: {name:'乙', base:3},
    盾兵: {name:'盾兵', base:4, status:{shield:true}},
    免疫兵: {name:'免疫兵', base:4, status:{immune:true}},
    卫士: {name:'卫士', base:4, status:{defender:true}},
    佚亡遗愿: {name:'佚亡遗愿', base:2, status:{doomed:true}, deathwish:c=>c.g.log('遗愿触发',{})},
    遗愿兵: {name:'遗愿兵', base:2, deathwish:c=>c.g.log('遗愿触发',{})},
    计时兵: {name:'计时兵', base:2, timer:{n:2, run:c=>c.boost(c.self,5)}},
    灌注兵: {name:'灌注兵', base:3},
  };
  const q = new Game({cards:cs, first:'me'}); q.startRound();
  const a = q.play('op','甲','m'), im = q.play('op','免疫兵','m'), df = q.play('op','卫士','m');
  const t = q.targetable(q.units('op'), 'me');
  ok(t.length===1&&t[0]===df, '卫士：同排其他单位不能被对方指定；免疫不能被指定');
  ok(q.targetable(q.units('op'),'op').length===2, '己方指定己方不受卫士限制（免疫仍排除）');
  const sh = q.play('me','盾兵','m'); sh.infused.push({on:'x',run:()=>{}}); q.addStatus(sh,'vitality',2);
  q.purify(sh); ok(!sh.status.shield&&!sh.status.vitality&&sh.infused.length===0, '净化：移除护盾、活力、灌注');
  const pd = q.play('me','佚亡遗愿','m'); q.purify(pd); q.destroy(pd); ok(q.s.sides.me.grave.includes('佚亡遗愿'), '净化去掉佚亡：离场进墓场，触发遗愿');
  const dw = q.play('me','佚亡遗愿','m'); const n0=q.trace.filter(x=>x.type==='遗愿触发').length;
  q.destroy(dw); ok(q.trace.filter(x=>x.type==='遗愿触发').length===n0 && q.s.sides.me.banished.includes('佚亡遗愿'), '佚亡：放逐，不触发遗愿');
  const dw2 = q.play('me','遗愿兵','m'); q.destroy(dw2); ok(q.trace.filter(x=>x.type==='遗愿触发').length===n0+1, '遗愿：被摧毁进墓场时触发');
  const hl = q.play('me','甲','r'); q.damage(hl,3); q.heal(hl); ok(hl.power===5, '治愈：回到基础战力');
  q.boost(hl,2); q.heal(hl); ok(hl.power===7, '治愈：不去掉增益');
  const c1 = q.play('me','乙','r'), c2 = q.play('op','乙','r'); q.boost(c1,3); q.clash(c1,c2);
  ok(!q.find(c2.uid)&&c1.power===3, '交锋：同时互伤 6 对 3');
  const cm = q.play('me','乙','r'); const vic = q.play('op','乙','r'); q.consume(cm,vic); ok(cm.power===6&&!q.find(vic.uid), '吞噬：摧毁目标并获得其战力');
  const tm = q.play('me','计时兵','r'); q.endTurn(); q.endTurn(); ok(tm.power===2, '计时 2：第一个己方回合结束 -1');
  q.endTurn(); q.endTurn(); ok(tm.power===7, '计时归零触发');
  q.lock(sh); sh.infused.push({on:'boosted', when:(c,d)=>d.unit===c.self&&d.src!=='inf', run:c=>c.g.boost(c.self,1,'inf')});
  q.boost(sh,1); ok(sh.power===5, '锁定：灌注效果不生效');
  const rp = q.play('me','甲','m'); q.addStatus(rp,'rupture'); q.boost(rp,3);
  while(q.s.active!=='me') q.endTurn(); q.endTurn(); ok(rp.power===3, '破裂：回合结束受到基础战力的伤害');
}
// ---------- 整排效果 ----------
{
  const cs = { 甲:{name:'甲',base:5}, 乙:{name:'乙',base:3}, 丙:{name:'丙',base:8} };
  const picks = [];
  const q = new Game({cards:cs, first:'me', chooser:req => picks.length ? picks.shift() : null}); q.startRound();
  const x1=q.play('op','甲','m'), x2=q.play('op','乙','m'), x3=q.play('op','丙','m');
  q.addHazard('op','m','霜',3); q.endTurn();
  ok(x3.power===6, '霜：拥有者回合开始，最高单位 -2');
  ok(q.s.hazards.op.m.turns===2, '霜：持续回合 -1');
  q.endTurn(); q.addHazard('op','m','雾',1); q.endTurn();
  ok(x2.power===1 && !q.s.hazards.op.m, '雾：最低单位 -2；回合用完移除，并替换原来的霜');
  q.endTurn(); picks.push([x1,x3]); q.addHazard('op','m','雨',2); q.endTurn();
  ok(x1.power===4&&x3.power===5, '雨：2 个随机单位（按记录）各 -1');
  q.endTurn(); q.addHazard('op','m','血月',2); picks.push([x1]); q.endTurn();
  ok(x1.status.bleed===2, '血月：未重伤的获得重伤 2');
  q.endTurn(); picks.push([x1]); const p1=x1.power; q.endTurn();
  ok(x1.power===p1-2, '血月：已重伤的改为 2 点伤害');
  const r2 = new Game({cards:cs, first:'me'}); r2.startRound();
  const y1=r2.play('op','丙','r'); r2.addHazard('op','r','龙之梦',2); r2.endTurn();
  ok(y1.power===8, '龙之梦：倒计时未完不爆炸'); r2.endTurn(); r2.endTurn();
  ok(y1.power===5, '龙之梦：最后一回合对全排 3 点');
  const r3 = new Game({cards:cs, first:'me'}); r3.startRound();
  const z=r3.play('op','丙','m'); r3.addHazard('op','m','灾厄',1); r3.endTurn();
  ok(z.power===5, '灾厄：只有 1 个单位时 3 点都打它');
}

// ---------- 条件词条、计时显示 ----------
{
  const cs = { 大:{name:'大',base:10}, 小:{name:'小',base:3}, 兵:{name:'兵',base:4,tags:['士兵']}, 夹:{name:'夹',base:2},
    计:{name:'计',base:1,timerN:2}, 充:{name:'充',base:1,charges:2,order:()=>{}} };
  const q = new Game({cards:cs, first:'me'}); q.startRound();
  q.play('me','大','m'); q.play('op','小','m');
  ok(q.dominance('me') && !q.dominance('op'), '统御：控制场上战力最高的单位');
  ok(!q.might('me'), '威势：远程排没有 10 战力单位时不成立');
  q.play('me','大','r'); ok(q.might('me'), '威势：两排都有 ≥10');
  const b1=q.play('me','大','r'); q.boost(b1,5); ok(q.feast('me'), '夜宴：远程排 10+15=25');
  q.play('op','兵','r'); const j=q.play('op','夹','r'); q.play('op','兵','r'); ok(q.harmonyFlank(j), '操控：两侧都是士兵');
  const sm=q.s.sides.op.rows.m[0]; q.damage(sm,1); ok(q.bloodthirst('me',1)&&!q.bloodthirst('me',2), '战狂：受伤敌军数');
  ok(q.initiative('me'), '先机：本回合没用指令');
  const t=q.play('me','计','m'); ok(q.counters(t).timer===2, '计时：显示剩余回合');
  q.endTurn(); ok(t.timer===1, '计时：己方回合结束 -1');
  const c=q.play('op','充','m'); ok(q.counters(c).charges===2, '充能：显示剩余次数');
}

// ---------- 金币、潜伏、伏击、回响 ----------
{
  const cs = {
    商人:{name:'商人',base:3,profit:4},
    献金兵:{name:'献金兵',base:2,tributeN:3,tribute:{n:3,run:c=>c.boost(c.self,5)}},
    费用兵:{name:'费用兵',base:4,fee:{n:2,run:c=>c.boost(c.self,1)}},
    疯子:{name:'疯子',base:6,insanity:true,fee:{n:3,run:c=>c.boost(c.self,1)}},
    恐吓兵:{name:'恐吓兵',base:3,intimidate:1,abilities:[]},
    罪行:{name:'罪行',type:'special',tags:['罪行'],profit:3},
    叛徒:{name:'叛徒',base:5,disloyal:true},
    伏兵:{name:'伏兵',base:4,ambush:true,deploy:c=>c.boost(c.self,9)},
    靶:{name:'靶',base:5}, 回:{name:'回',base:2,echo:true},
  };
  const G = new Game({cards:cs, first:'me'});
  // 恐吓是 def() 里合成的通用能力；测试用 registerCard 的假卡要手动走一遍
  cs.恐吓兵.abilities=[{on:'cardPlayed',when:(c,e)=>e.side===c.side&&(e.def.tags||[]).includes('罪行'),run:c=>c.boost(c.self,1)}];
  G.startRound();
  G.play('me','商人','m'); ok(G.s.sides.me.coins===4, '利润：打出时获得 4 金币');
  const tb=G.play('me','献金兵','m'); ok(G.s.sides.me.coins===1 && tb.power===7, '献金：金币够时付 3 并触发');
  const tb2=G.play('me','献金兵','m'); ok(G.s.sides.me.coins===1 && tb2.power===2, '献金：金币不够不触发');
  G.gainCoins('me',20); ok(G.s.sides.me.coins===9, '金币上限 9');
  const fe=G.play('me','费用兵','r'); G.order(fe.uid); ok(G.s.sides.me.coins===7 && fe.power===5, '费用：花 2 金币触发');
  G.s.sides.me.coins=1; const mad=G.play('me','疯子','r'); G.order(mad.uid); ok(mad.power===4 && G.s.sides.me.coins===1, '癫狂：金币不够改为自伤 3，再 +1');
  const it=G.play('me','恐吓兵','r'); G.play('me','罪行'); ok(it.power===4 && G.s.sides.me.coins===4, '恐吓：打出罪行牌 +1；罪行牌利润 3');
  const tr=G.play('me','叛徒','m'); ok(tr.side==='op' && tr.status.spying, '不忠：落到对面半场并获得潜伏');
  G.seize(tr,'me'); ok(tr.side==='me' && !tr.status.spying, '抓捕：已有潜伏的改为移除潜伏');
  const tg=G.play('op','靶','m'); G.seize(tg,'me'); ok(tg.side==='me' && tg.status.spying, '抓捕：移到己方同排并获得潜伏');
  const am=G.play('op','伏兵','r'); ok(am.status.ambush && am.power===4, '伏击：背面朝上，部署不触发');
  G.lock(am); ok(!am.status.ambush, '伏击被锁定：翻开');
  const bt=G.play('op','靶','r'); G.addStatus(bt,'bounty'); const c0=G.s.sides.me.coins; G.destroy(bt); ok(G.s.sides.me.coins===Math.min(9,c0+5), '赏金：被摧毁时对手获得其基础战力的金币');
  const rv=G.play('me','回','r'); G.destroy(rv);
  G.s.round=1; G.s.sides.me.coins=7; G.startRound();
  ok(G.s.sides.me.coins===3, '金币：下一小局减半（向下取整）');
  ok(G.s.sides.me.deck[0]==='回' && !G.s.sides.me.grave.includes('回'), '回响：小局开始从墓场回到牌组顶端');
  const rv2=G.play('me','回','r',null,{fromDeck:true}); ok(rv2.status.doomed, '回响回来的牌再打出带佚亡');
}
console.log('\n快照:', JSON.stringify(g.snapshot().op.rows));
console.log('校准:', calibrate(g,[{me:g.s.results[0].me, op:g.s.results[0].op}]));
console.log(fails? `\n${fails} 项失败`:'\n全部通过');
