// 卡牌冒烟测试：每张已建模的牌都在一个小场面里打出、用指令、过几个回合，检查不报错。
// 选择一律取第一个候选；牌组里拉的牌给一个同阵营的铜色单位。node gwent_cards_smoke.js [牌名…]
const E = require('./src/engine.js');
const B = require('./src/cards.js').behaviors;
const fs = require('fs');
eval(fs.readFileSync('./src/data.js', 'utf8').replace('const RAW', 'global.RAW'));

const only = process.argv.slice(2);
const names = only.length ? only : Object.keys(B);
const byName = Object.fromEntries(RAW.map(r => [r[0], r]));
const filler = { me: ['科德温骑士', '瑞达尼亚骑士', '亚甸槌击者'], op: ['辛特拉骑士', '科德温骑兵', '弩炮'] };
let fails = 0, done = 0;

for (const name of names) {
  const r = byName[name];
  if (!r || r[3] === '领袖能力' && !B[name]) continue;
  const fac = r[1];
  const pullName = (RAW.find(x => x[1] === fac && x[2] === '铜' && x[3] === '单位' && x[11] !== 'token') || [])[0] || '科德温骑士';
  const g = new E.Game({ first: 'me', rules: { coinLimit: 9 } });
  g.loadData(RAW); g.loadBehaviors(B);
  g.chooser = req => {
    if (req.kind === 'deck') return pullName;
    if (req.kind === 'tribute') return true;
    if (!req.from || !req.from.length) return null;
    const n = req.n || 1;
    return req.from.slice(0, n);
  };
  try {
    g.startRound();
    g.s.sides.me.coins = 9; g.s.sides.op.coins = 9;
    for (const sd of ['me', 'op']) filler[sd].forEach((n, i) => { const u = g.play(sd, n, i % 2 ? 'r' : 'm', null, { player: sd }); if (u) g.boost(u, i); });
    g.useAbility('me', '战术优势', { force: true });
    const t = r[3];
    if (t === '领袖能力' || t === '战术') { g.useAbility('me', name, { force: true, row: 'm' }); g.useAbility('me', name, { force: true, row: 'r' }); }
    else if (t === '特殊') g.play('me', name, null, null, { row: 'm' });
    else {
      const u1 = g.play('me', name, 'm', 1, { player: 'me' });
      const u2 = g.play('me', name, 'r', null, { player: 'me' });
      for (let k = 0; k < 3; k++) {
        g.endTurn(); g.endTurn();
        for (const u of [u1, u2]) if (u && g.find(u.uid) && (u.def.order || u.def.fee || u.def.feeN != null)) g.order(u.uid, { force: true, row: u.row });
      }
      g.play('me', '战地医师', 'm', null, { player: 'me' });
      for (const u of g.units()) if (u.name === name) { g.damage(u, 50); break; }
    }
    g.endTurn(); g.endTurn();
    done++;
  } catch (e) {
    fails++;
    console.log('✗', name, '—', e.message.split('\n')[0]);
  }
}
console.log(`\n${done} 张通过${fails ? `，${fails} 张出错` : ''}`);
process.exit(fails ? 1 : 0);
