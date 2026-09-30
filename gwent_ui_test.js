// 界面测试：用 jsdom 载入打包后的 dist/gwent_tracker.html，往 db.live 塞记录后检查推算、偏差报告、导出、快捷备注。
// 用法：node build.js && node gwent_ui_test.js（需要 npm install 装好 jsdom）
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'dist', 'gwent_tracker.html'), 'utf8');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('✗', m); } else console.log('✓', m); };
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window; w.scrollTo = () => {}; w.alert = () => {}; w.confirm = () => true;
const live = (log, extra) => w.eval(`db.live=Object.assign({id:1,date:"2026-09-30",deck:null,deckName:"测试",myF:"NR",leader:"皇家激励",fac:"ST",coin:"先",opLeader:null,cur:0,rounds:[],
  pend:{res:null,me:"",op:"",hm:null,ho:null},stuck:[],note:"",log:${JSON.stringify(log.map(x => Object.assign({ r: 0 }, x)))},nextE:${log.length + 1}},${JSON.stringify(extra || {})});ui.tab="match";ui.who="me";ui.act="play";ui.flow=null;render();`);
setTimeout(() => {
  try {
    // 推算 + 第几手 + 手牌
    live([
      { id: 'e1', who: 'me', a: 'play', c: '雷纳德·奥多', row: 'r', side: 'me', vt: '1:05' },
      { id: 'e2', who: 'op', a: 'play', c: '麦莉', row: 'r', side: 'op', tgts: [{ uid: 'e1', label: '雷纳德' }] },
      { id: 'e3', who: 'me', a: 'real', v: '8:6' },
      { id: 'e4', who: 'me', a: 'play', c: '拉多维德皇家护卫', row: 'm', side: 'me' },
      { id: 'e5', who: 'me', a: 'note', c: '失误' },
    ]);
    let S = w.eval('sim(db.live,0)');
    ok(S.score.me.total > 0 && S.steps.e4.who === 'me' && S.steps.e4.n === 2, '推算：比分和“我第 2 手”');
    ok(S.E.s.sides.me.handCount === 8 && S.E.s.sides.op.handCount === 9, '手牌推算：我方 8、对方 9');
    const eng = w.document.querySelector('.eng .score'); ok(eng && /\d+\s*:\s*\d+/.test(eng.textContent), '界面：比分显示');
    const rep = w.document.querySelector('details.sheet'); ok(rep && /偏差报告/.test(rep.textContent) && /对第1手/.test(rep.textContent), '偏差报告：定位到对第 1 手');
    ok([...w.document.querySelectorAll('.log .lmeta')].some(e => /录屏 1:05/.test(e.textContent)), '记录列表：显示录屏时间');
    const code = w.eval('gameCodeC(Object.assign({},db.live,{rounds:[{res:"W",me:"8",op:"6"}]}))');
    ok(/C 8:6/.test(code) && /~1:05/.test(code), '导出码：真实比分 C 和录屏时间 ~');
    // 快捷备注
    w.eval('ui.act="note";rMatch()'); w.document.querySelector('[data-qnote="关键回合"]').click();
    ok(w.eval('db.live.log[db.live.log.length-1].c') === '关键回合', '快捷备注：一点就记');
    // 战术只有先手方
    live([{ id: 'e1', who: 'op', a: 'tactic', c: '战术' }]);
    ok(w.eval('sim(db.live,0)').warns.some(x => /先手方/.test(x.m)), '战术：后手方用战术时提示');
    // 亢奋：对方打出埃兰时手牌 ≤3 → 免疫
    const L = []; for (let i = 0; i < 7; i++) { L.push({ id: 'm' + i, who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }, { id: 'o' + i, who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }); }
    L.push({ id: 'm9', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }, { id: 'er', who: 'op', a: 'play', c: '拉尔维克的埃兰', row: 'r', side: 'op', dn: 3 });
    live(L); S = w.eval('sim(db.live,0)');
    ok(S.key2u.er && S.key2u.er.status.immune, '亢奋：推算对方手牌 2 张 → 埃兰免疫');
    // 战术牌：第一局先手方近战排最左，占位置不计分；用掉离场；第二局没有
    live([{ id: 'e1', who: 'me', a: 'play', c: '科德温骑士', row: 'm', pos: 1, side: 'me' }], { tacCard: true });
    S = w.eval('sim(db.live,0)'); let m = S.E.s.sides.me.rows.m;
    ok(m.length === 2 && m[0].isTactic && S.E.units('me').length === 1 && S.score.me.total === 5, '战术牌：近战最左、不算单位不计分');
    ok(w.document.querySelectorAll('.brow.me [data-u]').length >= 2, '战术牌：棋盘上显示');
    live([{ id: 'e1', who: 'me', a: 'play', c: '科德温骑士', row: 'm', pos: 1, side: 'me' }, { id: 'e2', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' },
      { id: 'e3', who: 'me', a: 'tactic', c: '战术优势', tgts: [{ uid: 'e1', label: 'x' }] }], { tacCard: true });
    S = w.eval('sim(db.live,0)'); m = S.E.s.sides.me.rows.m;
    ok(m.length === 1 && !m[0].isTactic && m[0].power === 10, '战术牌：用掉 +5 并离场');
    live([{ id: 'e1', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }, { id: 'f1', r: 1, who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }],
      { tacCard: true, cur: 1, rounds: [{ res: 'W', me: '5', op: '0' }] });
    S = w.eval('sim(db.live,1)'); ok(!S.E.s.sides.me.rows.m.some(u => u.isTactic) && !S.E.s.sides.me.grave.includes('战术'), '战术牌：第二局没有，也不进墓场');
    live([{ id: 'e1', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }]);
    ok(!w.eval('sim(db.live,0)').E.s.sides.me.rows.m.some(u => u.isTactic), '战术牌：旧对局（没有 tacCard）不放');
    // 备份提醒
    ok(w.eval('backupAge()') === null, '备份：没备份过');
  } catch (e) { fails++; console.log('✗ 出错', e.stack); }
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  process.exit(fails ? 1 : 0);
}, 300);
