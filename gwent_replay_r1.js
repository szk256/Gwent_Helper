const {Game, calibrate} = require('./src/engine.js');
const {behaviors} = require('./src/cards.js');
// 卡牌数值从 src/data.js 的 RAW 读取；设 TRACKER 则从打包后的 HTML 读取
const fs = require('fs');
const html = fs.readFileSync(process.env.TRACKER || require('path').join(__dirname, 'src', 'data.js'), 'utf8');
const s0 = html.indexOf('const RAW='), e0 = html.indexOf('];', s0);
const RAW = JSON.parse(html.slice(s0 + 10, e0 + 1));
require('./src/patches.js').applyAll(RAW);   // 套用月度补丁到最新

function run(script, first, real) {
  let queue = [];
  const g = new Game({ first, chooser: (req) => {
    if (!queue.length) return null;
    const p = queue.shift();
    if (p === '?') return null;
    if (req.kind === 'deck') return p;
    if (Array.isArray(p)) return p.map(n => req.from.find(u => u.name === n)).filter(Boolean);
    return req.from.find(u => u.name === p) || null;
  }});
  g.loadData(RAW); g.loadBehaviors(behaviors);
  g.startRound();
  const rows = [];
  const S = { A: 'me', B: 'op' };
  for (const st of script) {
    queue = (st.p || []).slice();
    const side = S[st.w];
    const t0 = g.trace.length;
    if (st.a === 'P') g.play(side, st.c, st.row, st.pos, { power: st.power });
    else if (st.a === 'O') { const u = g.allUnits(side).find(x => x.name === st.c); g.order(u.uid); }
    else if (st.a === 'L') g.useAbility(side, st.c);
    else if (st.a === 'S') g.summon(st.c, side, st.row, st.pos);
    else if (st.a === 'E') g.endTurn();
    else if (st.a === '-') g.pass(side);
    const warn = g.trace.slice(t0).filter(x => x.warn || x.data.unmodeled).map(x => x.type + ':' + (x.data.prompt || x.data.name));
    if (st.a !== 'E') rows.push({ n: st.n, step: `${st.w} ${st.a} ${st.c || ''}`, me: g.score('me').total, op: g.score('op').total, warn: warn.join(' ') });
  }
  return { g, rows };
}
module.exports = { run };

if (require.main === module) {
  const R1 = [
    {n:2,w:'A',a:'P',c:'雷纳德·奥多',row:'r',pos:0},
    {n:3,w:'A',a:'L',c:'战术优势',p:['雷纳德·奥多']},{w:'A',a:'E'},
    {n:4,w:'B',a:'L',c:'活力回春'},{n:5,w:'B',a:'L',c:'活力回春'},
    {n:6,w:'B',a:'P',c:'维里赫德旅先锋',row:'m',pos:0},{w:'B',a:'E'},
    {n:7,w:'A',a:'P',c:'亚特里的温德哈姆',row:'r',pos:1},{w:'A',a:'E'},
    {n:8,w:'B',a:'P',c:'麦莉',row:'r',pos:0},{w:'B',a:'E'},
    {n:10,w:'A',a:'P',c:'法利波',row:'r',pos:2,p:['麦莉']},{w:'A',a:'E'},
    {n:12,w:'B',a:'P',c:'伊斯琳妮',row:'r',pos:1},{w:'B',a:'E'},
    {n:13,w:'A',a:'P',c:'不朽者骑兵',row:'m',pos:0},{w:'A',a:'E'},
    {n:15,w:'B',a:'P',c:'多尔·布雷坦纳弓箭手',row:'m',pos:0,p:['亚特里的温德哈姆']},{w:'B',a:'E'},
    {n:16,w:'A',a:'P',c:'赤红男爵',row:'r',pos:3},{w:'A',a:'E'},
    {n:17,w:'B',a:'P',c:'精灵剑术大师',row:'m',pos:0},
    {n:18,w:'B',a:'S',c:'爱黎瑞恩',row:'m',pos:3},{w:'B',a:'E'},
    {n:19,w:'A',a:'P',c:'安赛斯王子',row:'m',pos:1},
    {n:20,w:'A',a:'O',c:'安赛斯王子',p:['精灵剑术大师']},
    {n:21,w:'A',a:'O',c:'雷纳德·奥多',p:['?']},
    {n:22,w:'A',a:'O',c:'赤红男爵',p:['维里赫德旅先锋']},{w:'A',a:'E'},
    {n:24,w:'B',a:'-'},{n:'A停',w:'A',a:'-'},
  ];
  const { g, rows } = run(R1, 'me');
  console.table(rows);
  console.log('我方结束时各单位：');
  for (const r of ['m','r']) console.log(r, g.s.sides.me.rows[r].map(u=>`${u.name}${u.power}`).join(' '));
  console.log('结果', g.s.results, '真实 46:24');
  console.log(g.trace.filter(t=>['增益','伤害','护盾抵挡','神赐','重置','状态','对决','摧毁','待选'].includes(t.type)).map(t=>`${t.type} ${JSON.stringify(t.data)}`).join('\n'));
}
