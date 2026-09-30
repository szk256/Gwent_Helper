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
console.log('\n快照:', JSON.stringify(g.snapshot().op.rows));
console.log('校准:', calibrate(g,[{me:g.s.results[0].me, op:g.s.results[0].op}]));
console.log(fails? `\n${fails} 项失败`:'\n全部通过');
