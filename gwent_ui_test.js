// 界面测试：用 jsdom 载入打包后的 dist/gwent_tracker.html，往 db.live 塞记录后检查推算、偏差报告、导出、快捷备注。
// 用法：node build.js && node gwent_ui_test.js（需要 npm install 装好 jsdom）
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'dist', 'gwent_tracker.html'), 'utf8');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('✗', m); } else console.log('✓', m); };
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window; w.scrollTo = () => {};
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; w.HTMLDialogElement.prototype.close = function () { this.open = false; }; w.alert = () => {}; w.confirm = () => true;
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
    const code = w.eval('GwentCodec.encodeGame(Object.assign({},db.live,{rounds:[{res:"W",me:"8",op:"6"}]}))');
    ok(/ C v=8:6/.test(code) && /vt=1:05/.test(code), '导出码：真实比分 C 和录屏时间 vt');
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
    // 对方先手：开局选对方战术牌，放到对方近战排最左边；旧记录只写“战术”的按它结算
    live([{ id: 'e1', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', pos: 1, side: 'op' }], { tacCard: true, coin: '后' });
    ok(!!w.document.querySelector('[data-optacset="战术优势"]'), '对方先手：提示选对方战术牌');
    w.document.querySelector('[data-optacset="战术优势"]').click();
    S = w.eval('sim(db.live,0)'); m = S.E.s.sides.op.rows.m;
    ok(w.eval('db.live.opTactic') === '战术优势' && m[0].isTactic && m[0].name === '战术优势' && !w.document.querySelector('[data-optacset]'), '对方先手：选好后放到对方近战排，不再提示');
    live([{ id: 'e1', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', pos: 1, side: 'op' }, { id: 'e2', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' },
      { id: 'e3', who: 'op', a: 'tactic', c: '战术', tgts: [{ uid: 'e1', label: 'x' }] }], { tacCard: true, coin: '后', opTactic: '战术优势' });
    S = w.eval('sim(db.live,0)'); ok(S.key2u.e1.power === w.eval('BY["寒冰巨人"].pw') * 1 + 5 && !S.unmod['战术'], '旧记录“战术”：按对方战术牌（战术优势 +5）结算');
    // 平局：下一局最后一个从手牌出牌的一方先手
    live([{ id: 'e1', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }, { id: 'e2', who: 'op', a: 'play', c: '科德温骑士', row: 'm', side: 'op' }], { pend: { res: 'D', me: '5', op: '5', hm: null, ho: null } });
    w.eval('ui.who="me";rMatch()'); w.document.querySelector('[data-do="endRound"]').click(); ok(w.eval('ui.who') === 'op', '平局：最后出牌的一方（对方）下一局先手');
    // 手牌格子按查看的那一局显示
    live([{ id: 'd1', who: 'me', a: 'draw', set: true, cards: ['科德温骑士', '赤红男爵', '安赛斯王子'] }, { id: 'e1', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' },
      { id: 'f1', r: 1, who: 'me', a: 'play', c: '赤红男爵', row: 'm', side: 'me' }], { hand: true, cur: 1, rounds: [{ res: 'W', me: '5', op: '0' }] });
    ok(w.eval('myHand(db.live,undefined,1).length') === 1 && w.eval('myHand(db.live,undefined,0).length') === 2 && html.includes('myHand(g,undefined,vr)'), '手牌格子：看第一局时显示第一局的手牌');
    // 同一批修正里先填过数值的单位，后面的修正触发神赐（瑞达尼亚骑士神赐 8：相邻 +1）不再改它
    live([{ id: 'e1', who: 'me', a: 'play', c: '法利波', row: 'r', side: 'me' }, { id: 'e2', who: 'me', a: 'play', c: '瑞达尼亚骑士', row: 'r', side: 'me' },
      { id: 'e3', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' },
      { id: 'e4', who: 'me', a: 'adj', c: '法利波', uid: 'e1', side: 'me', v: '4' }, { id: 'e5', who: 'me', a: 'adj', c: '瑞达尼亚骑士', uid: 'e2', side: 'me', v: '8' }]);
    S = w.eval('sim(db.live,0)');
    ok(S.key2u.e1.power === 4 && S.key2u.e2.power === 8 && S.key2u.e2.blessFired[8], '批量修正：先填的法利波 4 不被后面骑士神赐 +1 改掉');
    // 偏差报告的规则对比：对方停牌后安娜·斯特伦格（回合结束 +1）不再推进才对得上 → 标“更准”
    live([{ id: 'e1', who: 'op', a: 'play', c: '科德温骑士', row: 'm', side: 'op' }, { id: 'e2', who: 'op', a: 'play', c: '安娜·斯特伦格', row: 'm', pos: 0, side: 'op' },
      { id: 'e3', who: 'op', a: 'pass' }, { id: 'e4', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }, { id: 'e5', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' },
      { id: 'e6', who: 'me', a: 'pass' }], { rounds: [{ res: 'L', me: '10', op: '11' }] });
    const rep2 = w.document.querySelector('details.sheet'); const ro = rep2 && rep2.textContent;
    ok(/规则对比/.test(ro) && /「停牌方回合照常推进」改成开：核对点一致 1\/1.*（更准）/.test(ro), '偏差报告：规则对比标出更准的写法');
    // 指令指示器：进场当回合虚线“令”，下回合金色；列阵在近战排当回合就能用
    live([{ id: 'e1', who: 'me', a: 'play', c: '安赛斯王子', row: 'm', side: 'me' }, { id: 'e2', who: 'me', a: 'play', c: '赤红男爵', row: 'r', side: 'me' }]);
    const ord = () => [...w.document.querySelectorAll('.brow.me [data-u]')].map(e => e.title + ':' + (e.querySelector('.uord') ? e.querySelector('.uord').className : ''));
    let om = ord();
    ok(om.some(x => /安赛斯王子:uord$/.test(x)) && om.some(x => /赤红男爵:uord wait/.test(x)), '指令指示器：列阵近战当回合可用、其他单位虚线');
    live([{ id: 'e1', who: 'me', a: 'play', c: '赤红男爵', row: 'r', side: 'me' }, { id: 'e2', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }]);
    ok(ord().some(x => /赤红男爵:uord$/.test(x)), '指令指示器：下回合变为可用');
    // 对方停牌后，我方每从手牌打出一张就是新回合（进场当回合的限制、回合结束效果照常）
    live([{ id: 'e1', who: 'op', a: 'pass' }, { id: 'e2', who: 'me', a: 'play', c: '赤红男爵', row: 'r', side: 'me' },
      { id: 'e3', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }, { id: 'e4', who: 'me', a: 'order', c: '赤红男爵', uid: 'e2', tgts: [{ uid: 'e3' }] }]);
    S = w.eval('sim(db.live,0)');
    ok(S.E.s.turn >= 2 && !S.warns.some(x => /不能用指令/.test(x.m)), '对方停牌后连续出牌：分成两个回合，指令可用');
    live([{ id: 'e1', who: 'me', a: 'play', c: '赤红男爵', row: 'r', side: 'me' }, { id: 'e2', who: 'me', a: 'order', c: '赤红男爵', uid: 'e1' }]);
    ok(w.eval('sim(db.live,0)').warns.some(x => /进场当回合不能用指令/.test(x.m)), '进场当回合记了指令：提示');
    // 月度补丁：对局按日期用当时的版本
    w.eval(`GwentPatches.PATCHES.push({date:'2099-01-01',title:'测试补丁',cards:[{n:'科德温骑士',pw:[5,6]}]});GwentPatches.applyAll(RAW);`);
    live([{ id: 'e1', who: 'me', a: 'play', c: '寒冰巨人', row: 'm', side: 'me' }, { id: 'e2', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }], { date: '2098-12-31' });
    const kOld = w.eval('sim(db.live,0)').key2u.e2.power;
    live([{ id: 'e1', who: 'me', a: 'play', c: '寒冰巨人', row: 'm', side: 'me' }, { id: 'e2', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }], { date: '2099-01-02' });
    const kNew = w.eval('sim(db.live,0)').key2u.e2.power;
    ok(kNew === kOld + 1, '补丁：补丁后的对局用新战力，之前的对局用旧战力（' + kOld + ' → ' + kNew + '）');
    ok(/2099-01-01 战力 5→6/.test((w.eval('openCard(BY["科德温骑士"]),document.getElementById("cdEn").textContent'))), '补丁：卡牌详情显示改动历史');
    w.eval(`GwentPatches.PATCHES.pop();document.getElementById("cdlg").close&&document.getElementById("cdlg").close();`);
    // 版本号：侧边栏显示构建号和卡牌数据版本；迁移导出带上
    ok(/构建 [0-9a-f]{7} · 卡牌数据 v14\.9\.0/.test(w.document.getElementById('verInfo').textContent), '版本：侧边栏显示构建号和卡牌数据版本');
    ok(/^#GWMIG v2 ids=gwent build=[0-9a-f]{7} data=v14\.9\.0\n/.test(w.eval('migText()')), '版本：迁移导出带构建号');
    // 全部迁移 v2：纯 ASCII，牌名换成编号，导回和原来完全一致
    w.eval(`db.decks.push({id:901,name:'北境 赤诚',f:'NR',leader:'皇家激励',tactic:'战术优势',cards:{'雷纳德·奥多':1,'科德温骑士':2}});db.owned={'雷纳德·奥多':1,'科德温骑士':2};
      db.edits={'科德温骑士':{pw:6,tx:'改过的效果：增益 2',alias:'科骑',f2:['SY']}};db.tactics=['战术优势'];db.notePresets=['失误','该停牌'];
      db.games.push({id:902,date:'2026-09-30',deck:901,deckName:'北境 赤诚',leader:'皇家激励',opLeader:'活力回春',fac:'ST',coin:'先',res:'胜',stuck:['科德温骑士'],note:'备注 = 100%',
        rounds:[{res:'W',me:'10',op:'5'}],log:[{id:'e1',r:0,who:'me',a:'play',c:'雷纳德·奥多',row:'r',via:'墓场'},{id:'e2',r:0,who:'me',a:'note',c:'科德温骑士 失误'},
        {id:'e3',r:0,who:'op',a:'fx',c:'霜',side:'me',row:'m'},{id:'e4',r:0,who:'me',a:'draw',cards:['科德温骑士']},{id:'e5',r:0,who:'me',a:'mull',c:'科德温骑士',into:'赤红男爵'}]});`);
    const before = w.eval('JSON.stringify(db)'), mig = w.eval('migText()');
    ok(/^[\x20-\x7e\n]+$/.test(mig) && !/雷纳德/.test(mig) && /"#202112"/.test(mig), '全部迁移 v2：纯 ASCII，牌名换成编号');
    ok(w.eval(`JSON.stringify(parseAll(${JSON.stringify(mig)}))`) === before, '全部迁移 v2：导回和原来完全一致');
    ok(JSON.stringify(w.eval(`parseAll(${JSON.stringify('#GWMIG v1 旧版\n' + before)}).decks.length`)) === JSON.stringify(JSON.parse(before).decks.length), '全部迁移：旧版 v1 仍能导入');
    w.eval('db.decks=db.decks.filter(d=>d.id!==901);db.games=db.games.filter(g=>g.id!==902);db.owned={};db.edits={};delete db.tactics;delete db.notePresets;');
    // 纯代码导出 v2：纯 ASCII、导出再导入逐字段一致、推算比分一致；卡组、牌库也能往返
    {
      const G = { id: 77, date: '2026-09-30', deck: null, deckName: '北境 测试', myF: 'NR', leader: '皇家激励', fac: 'ST', coin: '先', opLeader: '活力回春', hand: true, tacCard: true, diff: -1,
        ver: { build: 'abc1234', data: 'v14.9.0' }, stuck: ['科德温骑士'], note: '第三局 该停牌 = 100%', res: '胜',
        rounds: [{ res: 'W', me: '46', op: '24', hm: 4, ho: 5, sec: 600 }, { res: 'L', me: '', op: '', hm: null, ho: null, sec: null }],
        log: [
          { id: 'e1', r: 0, who: 'me', a: 'draw', cards: ['科德温骑士', '雷纳德·奥多'] },
          { id: 'e2', r: 0, who: 'me', a: 'mull', c: '科德温骑士', into: '赤红男爵' },
          { id: 'e3', r: 0, who: 'me', a: 'play', c: '雷纳德·奥多', row: 'r', pos: 0, vt: '1:05', t: 30 },
          { id: 'e4', r: 0, who: 'me', a: 'tactic', c: '战术优势', tgts: [{ uid: 'e3', label: 'x' }] },
          { id: 'e5', r: 0, who: 'op', a: 'play', c: '维里赫德旅先锋', row: 'm', pos: 0, pw: 13 },
          { id: 'e6', r: 0, who: 'op', a: 'play', c: '麦莉', row: 'r', tgts: [{ uid: 'e3', label: 'x' }, { row: 'mem', label: 'y' }], pay: true, fz: false, dn: 3 },
          { id: 'e7', r: 0, who: 'op', a: 'fx', c: '霜', side: 'me', row: 'm', dur: 3 },
          { id: 'e8', r: 0, who: 'op', a: 'effect', c: '雨', row: 'm', tgts: [{ uid: 'e8/0', label: 'z' }] },
          { id: 'e9', r: 0, who: 'me', a: 'adj', c: '麦莉', uid: 'e6', side: 'op', v: '-盾，甲3,活2' },
          { id: 'e10', r: 0, who: 'me', a: 'play', c: '赤红男爵', row: 'r', via: '墓场', fix: true },
          { id: 'e11', r: 0, who: 'op', a: 'coin', side: 'op', v: '+2' },
          { id: 'e12', r: 0, who: 'me', a: 'hand', side: 'op', v: '-1' },
          { id: 'e13', r: 0, who: 'me', a: 'real', v: '8:6' },
          { id: 'e14', r: 0, who: 'me', a: 'note', c: '失误 = 没算到, 50%' },
          { id: 'e15', r: 0, who: 'me', a: 'move', c: '赤红男爵', uid: 'e10', side: 'me', row: 'm', pos: 1, custom: { a: 1 } },
          { id: 'e16', r: 0, who: 'op', a: 'pass' },
          { id: 'e17', r: 1, who: 'op', a: 'play', c: '寒冰巨人', row: 'm' },
        ] };
      w.eval(`db.games.push(${JSON.stringify(G)});`);
      const code = w.eval('GwentCodec.encodeGame(db.games[db.games.length-1])');
      ok(/^[\x20-\x7e\n]+$/.test(code), '纯代码导出：全部是 ASCII');
      ok(/^#GWLOG v2/.test(code) && /3 A P c=\d+ row=r pos=0/.test(code), '纯代码导出：牌用官方编号');
      const dec = w.eval(`JSON.stringify(GwentCodec.decodeGame(${JSON.stringify(code)}))`);
      const r = JSON.parse(dec), g2 = r.game;
      const strip = l => l.map(x => Object.assign({}, x, { tgts: x.tgts && x.tgts.map(t => { const o = Object.assign({}, t); delete o.label; return o; }) }));
      const diff = [];
      strip(G.log).forEach((x, i) => { const y = strip(g2.log)[i]; for (const k of new Set([...Object.keys(x), ...Object.keys(y || {})])) if (JSON.stringify(x[k]) !== JSON.stringify((y || {})[k])) diff.push(x.id + '.' + k + ' ' + JSON.stringify(x[k]) + ' → ' + JSON.stringify((y || {})[k])); });
      for (const k of ['date', 'deckName', 'myF', 'leader', 'fac', 'coin', 'opLeader', 'hand', 'tacCard', 'diff', 'ver', 'stuck', 'note', 'res', 'rounds']) if (JSON.stringify(G[k]) !== JSON.stringify(g2[k])) diff.push(k + ' ' + JSON.stringify(G[k]) + ' → ' + JSON.stringify(g2[k]));
      ok(!diff.length, '纯代码导出：导回后每条记录、每个字段一致' + (diff.length ? '（' + diff.slice(0, 4).join('；') + '）' : ''));
      ok(g2.log[3].tgts[0].label === '我方 雷纳德·奥多', '纯代码导出：导回后目标标签重建');
      const n0 = w.eval('db.games.length'); w.eval(`importGames(${JSON.stringify(code)})`);
      ok(w.eval('db.games.length') === n0 + 1, '纯代码导出：导入对局');
      const s1 = w.eval('JSON.stringify(sim(db.games[db.games.length-2],0).score)'), s2 = w.eval('JSON.stringify(sim(db.games[db.games.length-1],0).score)');
      ok(s1 === s2, '纯代码导出：导回的对局推算比分一致（' + s1 + '）');
      const dcode = w.eval('GwentCodec.encodeDeck({name:"北境 赤诚",f:"NR",leader:"皇家激励",tactic:"战术优势",cards:{"雷纳德·奥多":1,"科德温骑士":2}})');
      const d2 = JSON.parse(w.eval(`JSON.stringify(GwentCodec.decodeDeck(${JSON.stringify(dcode)}))`));
      ok(/^[\x20-\x7e\n]+$/.test(dcode) && d2.name === '北境 赤诚' && d2.leader === '皇家激励' && d2.tactic === '战术优势' && d2.cards['科德温骑士'] === 2, '纯代码导出：卡组往返');
      const c2 = JSON.parse(w.eval(`JSON.stringify(GwentCodec.decodeColl(GwentCodec.encodeColl({"科德温骑士":2,"雷纳德·奥多":1})))`));
      ok(c2['科德温骑士'] === 2 && c2['雷纳德·奥多'] === 1, '纯代码导出：牌库往返');
      w.eval('db.games=db.games.filter(g=>g.deckName!=="北境 测试")');
    }
    // 外观：切换主题和字号，存在本机（不进对局簿数据）
    { const sel = w.document.querySelector('[data-pref="theme"]'); sel.value = 'navy'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
      const zs = w.document.querySelector('[data-pref="zoom"]'); zs.value = '1.3'; zs.dispatchEvent(new w.Event('change', { bubbles: true }));
      ok(w.document.documentElement.getAttribute('data-theme') === 'navy' && w.document.documentElement.style.zoom === '1.3' && !('theme' in w.eval('db')), '外观：切换主题和字号，存本机');
      sel.value = 'classic'; sel.dispatchEvent(new w.Event('change', { bubbles: true })); zs.value = '1'; zs.dispatchEvent(new w.Event('change', { bubbles: true }));
      ok(!w.document.documentElement.hasAttribute('data-theme') && !w.document.documentElement.style.zoom, '外观：切回经典'); }
    // 需手动 / 未建模的单位：打出后多一步“落地战力”，推算值是主按钮
    live([]); w.eval('startCard("寇格林姆","play","me")');
    w.document.querySelector('[data-slot^="me|m|"]').click();
    let guard = 0; while (w.eval('ui.flow&&ui.flow[0]&&ui.flow[0].t') && w.eval('ui.flow[0].t') !== 'pw' && guard++ < 5) w.document.querySelector('[data-do="flowSkip"]').click();
    ok(w.eval('ui.flow&&ui.flow[0].t') === 'pw' && /落地战力/.test(w.document.querySelector('.sheet.flow').textContent), '落地战力：需手动的单位打出后多一步');
    w.document.querySelector('[data-pwset="4"]').click();
    ok(w.eval('db.live.log[db.live.log.length-1].pw') === 4 && w.eval('sim(db.live,0).score.me.total') === 4, '落地战力：选的数值写进记录并用于推算');
    live([]); w.eval('startCard("科德温骑士","play","me")'); w.document.querySelector('[data-slot^="me|m|"]').click();
    ok(!(w.eval('ui.flow') || []).some(x => x.t === 'pw'), '落地战力：已建模的牌不多问');
    // ---- 2026-09-30 用户反馈 ----
    const Q = s => w.document.querySelector(s), QA = s => [...w.document.querySelectorAll(s)];
    const ub = n => QA('.board [data-u]').filter(b => b.dataset.umode !== 'none').find(b => b.title === n);
    const us = sd => w.eval(`sim(db.live,db.live.cur).E.allUnits("${sd}").map(u=>u.name+u.power).join(" ")`);
    const fl = () => w.eval('ui.flow&&ui.flow[0]&&ui.flow[0].t');
    // 改战力：按钮面板，不用输入；设到神赐阈值以上时神赐照样触发（少女的盾牌生成布朗温）
    live([{ id: 'e1', who: 'me', a: 'play', c: '少女的盾牌', row: 'm', side: 'me' }, { id: 'e2', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }]);
    w.eval('ui.act="adj";rMatch()'); ub('少女的盾牌').click();
    ok(fl() === 'adj' && Q('#adjSet') && Q('#adjSet').value === '4' && !Q('dialog[open]'), '改战力：点单位进面板，数字框填好推算值');
    Q('#adjSet').value = '8'; Q('[data-adjbump="adjSet|1"]').click();
    ok(Q('#adjSet').value === '9' && fl() === 'adj', '改战力：+1 只改框里的数，不记录');
    Q('[data-adjv="?#adjSet:"]').click();
    ok(us('me') === '少女的盾牌9 “无畏者”布朗温2', '改战力：设成 9 触发神赐 8，自动生成布朗温');
    w.eval('ui.flow=null;ui.act="leader";rMatch()'); Q('[data-do="leader"]').click(); ub('少女的盾牌').click(); Q('[data-do="tgtDone"]').click();
    ok(/皇家激励 剩 1 次（下次 \+4）/.test(QA('.eng .coins').map(e => e.textContent).join(' ')), '皇家激励：触发神赐后刷新，下次 +4，比分下显示');
    // 可编辑数字：超过原来按钮范围的值、护甲，输入框回车记录
    live([{ id: 'e1', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }, { id: 'e2', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }]);
    w.eval('ui.act="adj";rMatch()'); ub('科德温骑士').click(); Q('#adjSet').value = '25';
    Q('#adjSet').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    ok(us('me') === '科德温骑士25', '改战力：数字框回车设为 25');
    ub('科德温骑士').click(); Q('#adjAr').value = '7'; Q('[data-adjv="?#adjAr:甲"]').click();
    ok(w.eval('sim(db.live,0).E.allUnits("me")[0].armor') === 7, '改战力：护甲设为 7');
    // 落难的少女第二章：连带打出的疯狂的冲锋接着问目标
    live([{ id: 'e1', who: 'me', a: 'play', c: '落难的少女', row: 'm', side: 'me' }, { id: 'e2', who: 'me', a: 'play', c: '科德温骑士', row: 'm', via: '落难的少女', side: 'me' },
      { id: 'e3', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }, { id: 'e4', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }, { id: 'e5', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }]);
    w.eval('startCard("亚特里的温德哈姆","play","me")'); QA('[data-slot^="me|r|"]').pop().click();
    ok(fl() === 'target' && /疯狂的冲锋/.test(Q('.sheet.flow h2').textContent), '落难的少女：第二章的疯狂的冲锋接着问目标');
    ub('亚特里的温德哈姆').click(); Q('[data-do="tgtDone"]').click();
    ok(/亚特里的温德哈姆9/.test(us('me')), '落难的少女：疯狂的冲锋 +5 给打出的骑士');
    // 不朽者骑兵：引擎自己复制，不再问生成了什么
    live([]); w.eval('startCard("不朽者骑兵","play","me")'); Q('[data-slot^="me|m|"]').click();
    ok(!fl() && us('me') === '不朽者骑兵4 不朽者骑兵4', '不朽者骑兵：自动复制，不再问');
    // 揭竿而起：同一目标连用 3 次，用完问镰刀手放哪
    live([{ id: 'e1', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }], { fac: 'NR' });
    w.eval('ui.who="op";ui.act="leader";rMatch()'); Q('[data-oplead="揭竿而起"]').click(); ub('寒冰巨人').click(); Q('[data-rep="3"]').click(); Q('[data-do="tgtDone"]').click();
    ok(w.eval('db.live.log.filter(x=>x.a==="leader").length') === 3 && fl() === 'place', '领袖：连用 3 次，充能用完问生成的镰刀手放哪');
    QA('[data-slot^="op|r|"]').pop().click();
    ok(us('op') === '寒冰巨人10 莱里亚镰刀手5' && /揭竿而起 已用完/.test(Q('.eng').textContent), '揭竿而起：+3、生成镰刀手、显示已用完');
    // 没完没了的朗维德：在墓场，己方打出士兵自动回场
    live([{ id: 'e1', who: 'op', a: 'play', c: '没完没了的朗维德', row: 'm', side: 'op' }, { id: 'e2', who: 'op', a: 'kill', c: '没完没了的朗维德', uid: 'e1', side: 'op' },
      { id: 'e3', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }, { id: 'e4', who: 'op', a: 'play', c: '崔丹姆步兵', row: 'm', side: 'op' }, { id: 'e5', who: 'op', a: 'summon', c: '没完没了的朗维德', row: 'r', side: 'op' }]);
    ok(us('op') === '崔丹姆步兵5 没完没了的朗维德1' && w.eval('sim(db.live,0).E.s.sides.op.rows.r.length') === 1, '朗维德：自动回场，后面手动记的召唤对应到它、不重复');
    // 结束回合：之后的改战力是回合结束后的值
    live([{ id: 'e1', who: 'op', a: 'play', c: '泰莫利亚鼓手', row: 'm', side: 'op' }, { id: 'e2', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }]);
    ok(/结束对方回合/.test(Q('[data-do="endTurn"]').textContent), '结束回合：按钮显示该结束哪一方');
    Q('[data-do="endTurn"]').click();
    ok(us('op') === '泰莫利亚鼓手5 寒冰巨人8' && !Q('[data-do="endTurn"]'), '结束回合：结算回合结束效果');
    w.eval('db.live.log.push({r:0,id:"e9",who:"op",a:"adj",c:"寒冰巨人",uid:"e2",side:"op",v:"8"},{r:0,id:"e10",who:"me",a:"play",c:"科德温骑士",row:"m",side:"me"})');
    ok(us('op') === '泰莫利亚鼓手5 寒冰巨人8', '结束回合：之后换人不再重复结算');
    // 停牌不结算回合结束效果（rules.passTurnEnd，未确认）
    live([{ id: 'e1', who: 'op', a: 'play', c: '泰莫利亚鼓手', row: 'm', side: 'op' }, { id: 'e2', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }, { id: 'e3', who: 'op', a: 'pass' }]);
    ok(us('op') === '泰莫利亚鼓手5 寒冰巨人7', '停牌：默认不结算回合结束效果');
    // 泰莫利亚步兵：领袖还没用过也按剩余充能算
    live([{ id: 'e1', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }, { id: 'e2', who: 'op', a: 'play', c: '泰莫利亚步兵', row: 'm', side: 'op' }, { id: 'e3', who: 'op', a: 'order', c: '泰莫利亚步兵', uid: 'e2', tgts: [{ uid: 'e1' }] }], { opLeader: '揭竿而起' });
    ok(/寒冰巨人13/.test(us('op')), '泰莫利亚步兵：领袖没用过按 3 层充能');
    // 对方战术：选具体的牌
    live([{ id: 'e1', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }], { coin: '后' });
    w.eval('ui.who="op";ui.act="tactic";rMatch()'); Q('[data-optac="战术优势"]').click(); ub('寒冰巨人').click(); Q('[data-do="tgtDone"]').click();
    ok(us('op') === '寒冰巨人12', '对方战术：选战术优势，+5');
    // 手牌：第二局起整手重选，上一局留下的先选上
    live([{ id: 'e1', who: 'me', a: 'draw', cards: ['少女的盾牌', '科德温骑士', '不朽者骑兵'] }, { id: 'e2', who: 'me', a: 'play', c: '不朽者骑兵', row: 'm', side: 'me' }], { hand: true, cur: 1, rounds: [{ res: 'W', me: '5', op: '0' }] });
    w.eval('db.decks.push({id:77,name:"测手牌",f:"NR",leader:"皇家激励",cards:{"少女的盾牌":1,"科德温骑士":2,"不朽者骑兵":2}});db.live.deck=77;rMatch()');
    Q('[data-do="handStart"]').click();
    ok(w.eval('JSON.stringify(myHand(db.live))') === '["少女的盾牌","科德温骑士"]' && QA('#resBox .tile.gone').map(b => b.dataset.nm).join() === '少女的盾牌', '手牌：整手重选，牌组剩余按已选算');
    w.eval('db.decks=db.decks.filter(d=>d.id!==77)');
    // 修改记录：原地展开，上下移后仍在修改这一条
    live([{ id: 'e1', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }, { id: 'e2', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }]);
    Q('[data-edit="e1"]').click(); Q('[data-do="eDown"]').click();
    ok(Q('.log .sheet.flow.inline') && w.eval('db.live.log.map(x=>x.id).join()') === 'e2,e1' && w.eval('ui.flow[0].id') === 'e1', '修改记录：原地展开，移动后仍聚焦在这一条');
    ok(/ Z$/.test(w.eval('GwentCodec.encodeGame(Object.assign({},db.live,{log:[{r:0,id:"e1",who:"op",a:"end"}]}))')), '导出码：结束回合 Z');
    // 备份提醒
    ok(w.eval('backupAge()') === null, '备份：没备份过');
  } catch (e) { fails++; console.log('✗ 出错', e.stack); }
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  process.exit(fails ? 1 : 0);
}, 300);
