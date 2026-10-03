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
    ok(!w.document.querySelector('[data-act="tactic"]'), '战术牌：第二局起不列“战术”按钮');
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
      { id: 'e6', who: 'me', a: 'pass' }], { rounds: [{ res: 'D', me: '10', op: '11' }] });   // 停牌那一下安娜 +1（passTurnEnd），之后不再推进 → 11
    const rep2 = w.document.querySelector('details.sheet'); const ro = rep2 && rep2.textContent;
    ok(/规则对比/.test(ro) && /「停牌方回合照常推进」改成关：核对点一致 1\/1.*（更准）/.test(ro), '偏差报告：规则对比标出更准的写法');
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
    // 回放回归：2026-10-01 对松鼠党（游击战术）真人对局，用户记录的 v2 代码；录像核对的真实比分 13:0、85:66
    // （千里镜只生成一次、神器不受伤害、猫学派回合结束不重复、杜度变成的瑞达尼亚骑士带护甲）
    const REC1001 = "#GWLOG v2 ids=gwent\nG date=2026-10-01 me=NR ld=202116 op=ST old=200167 coin=1 res=W tac=1 hand=1 diff=-1 build=72966ce data=v14.9.0 deck=%E5%8C%97%E5%A2%83%E8%B5%A4%E8%AF%9A%E9%AA%91%E5%A3%AB%E5%B0%91%E5%A5%B3%E6%94%B9\nD f=NR ld=202116 tac=202140 203075x1 202646x1 202151x1 202251x1 122101x1 203076x1 202262x1 202112x1 202647x1 202506x1 202254x1 201648x1 202509x1 203078x2 202511x1 202420x1 201622x2 202421x1 203079x1 202259x1 202372x1 122308x2\nM %E6%9C%89bug\nR1 res=W me=13 op=0 hm=9 ho=10 sec=342\n1 A D cards=202646,202151,203078,203075,203079,203076,202420,122308,202254,202511 x.set=true\n2 A P c=202646\n3 A P c=201622 row=m pos=1 via=202646\n4 A Z\n5 B -\nR2 res=W me=85 op=66 hm=0 ho=0 sec=4576\n6 A D cards=203078,203075,203079,203076,202420,122308,202254,202511,202251,202646 x.set=true\n7 A P c=202646\n8 A P c=202112 row=r pos=0 via=202646\n9 A Z\n10 B P c=202806 row=r pos=0\n11 B E c=202806 uid=10\n12 B Z\n13 A P c=203075 row=m pos=0\n14 A P c=201622 row=m pos=1 via=203075\n15 A L c=202116 tg=8\n16 A Z\n17 B P c=200039 row=r pos=1\n18 B Z\n19 A J c=201622 side=A v=7 uid=14\n20 A N c=%E5%A4%9A%E4%B8%80%E4%B8%AA%E5%8D%A1%E7%89%8C%E7%8C%AB%E5%AD%A6%E6%B4%BE%E5%B0%B1%E6%B2%A1%E6%9C%89%E7%A7%BB%E5%8A%A8%E4%BC%A4%E5%AE%B3%E4%BA%86%EF%BC%9F\n21 A P c=202511 tg=10\n22 A Z\n23 B P c=200020\n24 B P c=202806 row=m pos=0 via=200020\n25 B Z\n26 A N c=%E8%BF%99%E6%AC%A1%E5%8F%88%E6%89%93%E5%88%B0%E4%BA%86\n27 A P c=202251 row=m pos=2\n28 A O c=202251 tg=24 uid=27\n29 A Z\n30 B P c=202806 row=r pos=1\n31 B Z\n32 A J c=202251 side=A v=4 uid=27\n33 A N c=%E4%B8%8D%E8%A1%8C%E4%BA%86%E5%8F%88\n34 A P c=122308 row=r pos=1\n35 A E c=202420 tg=34 x.chain=1\n36 A Z\n37 B P c=202931 row=r pos=0 tg=30\n38 B Z\n39 A P c=203078 row=r pos=1\n40 A Z\n41 B P c=202780 row=r pos=0\n42 B Z\n43 A J c=201622 side=A v=4 uid=14\n44 A P c=203076 row=m pos=3\n45 B J c=203078 side=A v=6 uid=39\n46 B J c=122308 side=A v=13 uid=34\n47 B J c=203076 side=A v=6 uid=44\n48 A L c=202116 tg=44\n49 A L c=202116 tg=44\n50 A Z\n51 B P c=112201 row=r pos=0 tg=34\n52 B Z\n53 A J c=202112 side=A v=12 uid=8\n54 A J c=203078 side=A v=7 uid=39\n55 A P c=203079 row=r pos=3\n56 A Z\n57 B P c=200225 tg=55\n58 B Z\n59 A P c=202254 row=r pos=3\n60 A Z\n61 B J c=203079 side=B v=5 uid=55\n62 B P c=142210 row=r pos=5\n63 B O c=142210 tg=55 uid=62\n64 B Z\n65 A P c=202420 tg=44\n66 A E c=203077 tg=44 x.chain=1\n67 A J c=201622 side=A v=2 uid=14\n68 A J c=202251 side=A v=6 uid=27\n69 A J c=203077 side=A v=7 uid=48/0\n70 B K c=202806 side=B uid=58/0\n71 B N c=%E4%B8%8D%E5%AD%98%E5%9C%A8\n72 B J c=122308 side=A v=-~sh uid=34\n73 B J c=122308 side=A v=20 uid=34\n74 B J c=202254 side=A v=-~sh uid=59\n75 B J c=202254 side=A v=7 uid=59\n76 B J c=203076 side=A v=20 uid=44\n77 B J c=122308 side=B v=5 uid=51\n78 B C v=87:49\n79 B P c=200023 tg=14\n80 A N c=%E5%B0%91%E5%A5%B3%E4%B9%9F%E6%B6%88%E5%A4%B1%E4%BA%86\n81 A N c=bug\n82 B O c=142210 tg=41 uid=62\n83 B L c=200167 tg=42/0\n84 B L c=200167 tg=30\n85 B L c=200167 tg=42/1\n86 B Z\n87 A J c=202112 side=A v=-~sh uid=8\n88 A J c=202112 side=A v=16 uid=8\n89 A J c=203078 side=A v=11 uid=39\n90 A J c=202254 side=A v=5 uid=59";
    w.__rec = REC1001; w.eval('window.__g=GwentCodec.decodeGame(__rec).game;__g.id=1001');
    const sc = r => w.eval(`(()=>{const s=sim(__g,${r}).score;return s.me.total+":"+s.op.total})()`);
    ok(sc(0) === '13:0' && sc(1) === '85:66', '回放 2026-10-01 对松鼠党：13:0、85:66（推算 ' + sc(0) + '、' + sc(1) + '）');
    // 2026-10-02 对尼弗迦德（录像核对）：第一局 27:6（雷纳德神赐 12 不给科德温骑士 +1）、第二局 99:57（侦察员指令失去护甲）
    const REC1002 = "#GWLOG v2 ids=gwent\nG date=2026-10-02 me=NR ld=202116 op=NG old=200164 coin=1 res=W tac=1 hand=1 build=3be69ca data=v14.10.0 deck=%E5%8C%97%E5%A2%83%E8%B5%A4%E8%AF%9A%E9%AA%91%E5%A3%AB%E5%B0%91%E5%A5%B3%E6%94%B9\nD f=NR ld=202116 tac=202140 203075x1 202646x1 202151x1 202251x1 122101x1 203076x1 202262x1 202112x1 202647x1 202506x1 202254x1 201648x1 202509x1 203078x2 202511x1 202420x1 201622x2 202421x1 203079x1 202259x1 202372x1 122308x2\nR1 res=W hm=8 sec=925\n1 A D cards=203075,202646,202262,202112,202254,201648,203079,202420,122308,202506 x.set=true\n2 A P c=202646\n3 A P c=201622 row=m pos=1 via=202646\n4 A Z\n5 B P c=200044 row=r pos=0\n6 B P c=162315\n7 B P c=202920 row=m pos=0 via=162315\n8 B Z\n9 A P c=202112 row=r pos=0\n10 A T c=202140 tg=9\n11 A Z\n12 B -\n13 A -\nR2 res=W hm=0 sec=2348\n14 A D cards=203075,202262,202254,201648,203079,202420,122308,202646,203076,202509 x.set=true\n15 A P c=202509 row=m pos=0\n16 A Z\n17 B P c=162102 row=r pos=0\n18 B P c=202454 via=162102 tg=17\n19 B Z\n20 A P c=203075 row=m pos=0\n21 A P c=201622 row=m pos=3 via=203075\n22 A Z\n23 B P c=200044 row=r pos=1\n24 B E c=200044 uid=23\n25 B P c=163201 side=B\n26 B P c=202151 row=m pos=0 side=B via=163201\n27 B Z\n28 A P c=201648 row=m pos=4 tg=26\n29 A Z\n30 B P c=201639 row=m pos=0\n31 B P c=162303 row=r pos=2 via=201639\n32 B N c=%E5%BD%93%E6%97%B6%E6%9C%896%E7%82%B9%E6%8A%A4%E7%94%B2\n33 B Z\n34 A P c=203079 row=r pos=0\n35 A Z\n36 B P c=202454 tg=23\n37 B O c=162303 tg=31 uid=31\n38 B J c=162303 side=B v=~vi5 uid=31\n39 B Z\n40 A P c=202254 row=r pos=1\n41 A E c=202420 tg=40 x.chain=1\n42 A Z\n43 B P c=202447 row=m pos=1\n44 B P c=162303 row=r pos=3 via=202447\n45 B J c=162303 side=B v=~ar6 uid=44\n46 B Z\n47 A P c=122308 row=r pos=2 pw=4\n48 A J c=122308 side=A v=4 uid=47\n49 A Z\n50 A J c=122308 side=A v=6 uid=47\n51 B O c=162303 uid=44\n52 B J c=162303 side=B v=~vi4 uid=44\n53 B P c=112204 row=m pos=2 pw=4\n54 B P c=112203 row=m pos=3 via=112204 pw=4\n55 B P c=112202 row=m pos=4 via=112203 pw=4\n56 B Z\n57 A P c=202646\n58 A P c=203078 row=r pos=2 via=202646\n59 A Z\n60 B J c=122308 side=A v=8 uid=47\n61 B N c=11%2015%206%206\n62 A N c=11%2017%208%208\n63 A N c=11%2017%209%208\n64 A N c=11%2017%209%2010\n65 A N c=11%2019%2011%2010\n66 A J c=122308 side=A v=10 uid=47\n67 B O c=201639 tg=31,44 uid=30\n68 B P c=202666 row=m pos=2 side=A\n69 A P c=203076 row=r pos=4\n70 A L c=202116 tg=69\n71 A L c=202116 tg=69\n72 A Z\n73 B J c=122308 side=A v=14 uid=47\n74 B P c=202666 row=r pos=5 side=A\n75 A P c=202262\n76 A P c=203078 row=r pos=3 via=202262\n77 A Z\n78 B J c=122308 side=A v=18 uid=47\n79 B L c=200164\n80 B Y c=202707 row=m pos=6 via=200164\n81 B Z\n82 B P c=202454 tg=44\n83 A J c=162303 side=B v=14 uid=44\n84 A J c=162303 side=B v=13 uid=44\n85 A J c=162303 side=B v=~ar3 uid=44\n86 A J c=162303 side=B v=~vi1 uid=44\n87 B P c=200226 tg=47\n88 B Z\n89 A P c=202420 tg=47\n90 A Z\n91 B J c=122308 side=A v=9 uid=47\n92 B P c=163101 tg=40,34";
    w.__rec2 = REC1002; w.eval('window.__g2=GwentCodec.decodeGame(__rec2).game;__g2.id=1002');
    const sc2 = r => w.eval(`(()=>{const s=sim(__g2,${r}).score;return s.me.total+":"+s.op.total})()`);
    ok(sc2(0) === '27:6' && sc2(1) === '99:57', '回放 2026-10-02 对尼弗迦德：27:6、99:57（推算 ' + sc2(0) + '、' + sc2(1) + '）');
    ok(w.eval('sim(__g2,1).warns.some(x=>x.id==="e47"&&/落地战力记 4，推算 2/.test(x.m))'), '落地战力和推算不同（已建模的牌）：提示可能漏记了指令');
    // 按录像补上漏记的骑士随从指令（第 41 步后）：瑞达尼亚骑士不用手动改，落地 4、每个己方回合结束 +2
    w.eval(`(()=>{const g=JSON.parse(JSON.stringify(__g2));g.id=10021;g.log=g.log.filter(x=>!(x.a==="adj"&&x.c==="瑞达尼亚骑士"));delete g.log.find(x=>x.id==="e47").pw;
      const i=g.log.findIndex(x=>x.id==="e41");g.log.splice(i+1,0,{id:"e201",r:1,who:"me",a:"order",c:"骑士随从",uid:"e34"});window.__g3=g;})()`);
    const rk = id => w.eval(`(()=>{const g=__g3;const i=g.log.findIndex(x=>x.id==="${id}");const S=sim(Object.assign({},g,{id:"c${id}",log:g.log.slice(0,i),rounds:g.rounds.slice(0,1)}),1);const u=S.key2u.e47;return u?u.power:null;})()`);
    const rks = ['e49', 'e51', 'e74', 'e79'].map(rk).join('/');
    ok(rks === '4/6/14/18', '补上骑士随从指令：瑞达尼亚骑士不用手动改，4 → 6 → … → 14 → 18（推算 ' + rks + '）');
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
    ok(/^#GWMIG v2 ids=gwent build=[0-9a-f]{7} data=v14\.10\.0\n/.test(w.eval('migText()')), '版本：迁移导出带构建号');
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
    // 侦察员：打出后问部署护甲，指令后问活力（取决于牌组，记成改战力）
    live([]); w.eval('ui.who="op";startCard("侦察员","play","op")'); w.document.querySelector('[data-slot^="op|r|"]').click();
    guard = 0; while (w.eval('ui.flow&&ui.flow[0]&&ui.flow[0].t') && w.eval('ui.flow[0].t') !== 'ask' && guard++ < 5) w.document.querySelector('[data-do="flowSkip"]').click();
    ok(w.eval('ui.flow&&ui.flow[0].t') === 'ask' && /护甲/.test(w.document.querySelector('.sheet.flow').textContent) && !(w.eval('ui.flow') || []).some(x => x.t === 'pw'), '侦察员：打出后问部署获得的护甲（不问落地战力）');
    w.document.querySelector('[data-askv="甲6"]').click();
    ok(w.eval('db.live.log[db.live.log.length-1].v') === '甲6' && w.eval('sim(db.live,0).E.allUnits("op")[0].armor') === 6, '侦察员：护甲记成改战力 甲6');
    w.eval('ui.flow=null;ui.who="op";ui.act="order";rMatch()'); [...w.document.querySelectorAll('.board [data-u]')].find(b => b.title === '侦察员').click();
    guard = 0; while (w.eval('ui.flow&&ui.flow[0]&&ui.flow[0].t') && w.eval('ui.flow[0].t') !== 'ask' && guard++ < 5) w.document.querySelector('[data-do="flowSkip"]').click();
    ok(w.eval('ui.flow&&ui.flow[0].t') === 'ask' && /活力/.test(w.document.querySelector('.sheet.flow').textContent), '侦察员：指令后问获得的活力');
    w.document.querySelector('#askIn').value = '5'; w.document.querySelector('[data-askv="?活"]').click();
    { const u = w.eval('(()=>{const u=sim(db.live,0).E.allUnits("op")[0];return {a:u.armor,v:u.status.vitality}})()');
      ok(u.a === 0 && u.v === 5, '侦察员：指令失去护甲，活力 5 记成改战力（推算 甲' + u.a + ' 活' + u.v + '）'); }
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
    // 改战力：还有没结算的回合结束效果时先问“看到的是回合结束之后的数值吗”
    live([{ id: 'e1', who: 'me', a: 'play', c: '瑞达尼亚骑士', row: 'r', side: 'me' }]);
    w.eval('ui.act="adj";ui.endAsked=null;rMatch()'); ub('瑞达尼亚骑士').click();
    ok(/瑞达尼亚骑士 \+1/.test(Q('.askend')?.textContent || ''), '改战力：提示回合结束会让瑞达尼亚骑士 +1');
    Q('[data-do="adjNotEnd"]').click(); ok(fl() === 'adj' && !Q('.askend'), '改战力：答“还没结束”后这一回合不再问');
    w.eval('ui.endAsked=null;rMatch()'); Q('[data-do="adjEnd"]').click();
    ok(w.eval('db.live.log.some(x=>x.a==="end"&&x.who==="me")') && !Q('.askend'), '改战力：答“是”记一条结束回合');
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
    // 猫学派猎魔人：对面排有 2 个单位时随机伤害打到谁，结束回合后接着问；记在后面的目标用在回合结束里
    live([{ id: 'e1', who: 'me', a: 'play', c: '科德温骑士', row: 'r', side: 'me' }, { id: 'e2', who: 'me', a: 'play', c: '赤红男爵', row: 'm', side: 'me' }, { id: 'e3', who: 'me', a: 'play', c: '安赛斯王子', row: 'm', side: 'me' },
      { id: 'e4', who: 'op', a: 'play', c: '猫学派猎魔人', row: 'r', side: 'op' }]);
    Q('[data-do="endTurn"]').click();
    ok(fl() === 'target' && /猫学派猎魔人/.test(Q('.sheet.flow h2').textContent), '猫学派猎魔人：结束回合后问随机伤害打到谁');
    const pw0 = w.eval('sim(db.live,0).E.allUnits("me").find(u=>u.name==="安赛斯王子").power');
    ub('安赛斯王子').click(); Q('[data-do="tgtDone"]').click();
    ok(w.eval('sim(db.live,0).E.allUnits("me").find(u=>u.name==="安赛斯王子").power') === pw0 - 1 && w.eval('sim(db.live,0).E.s.sides.op.rows.m.length') === 1, '猫学派猎魔人：移到近战排，打到选的单位');
    // 三张猫学派猎魔人都打同一个单位（2026-10-01 对局第 42 步，科德温骑士连中三下）：同一单位可以点多次，“撤销一个”去掉最后一次
    live([{ id: 'e1', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }, { id: 'e2', who: 'me', a: 'play', c: '赤红男爵', row: 'm', side: 'me' },
      { id: 'e3', who: 'op', a: 'play', c: '猫学派猎魔人', row: 'r', side: 'op' }, { id: 'e4', who: 'op', a: 'spawn', c: '猫学派猎魔人', row: 'r', side: 'op' }, { id: 'e5', who: 'op', a: 'spawn', c: '猫学派猎魔人', row: 'r', side: 'op' }]);
    const kp0 = w.eval('sim(db.live,0).E.allUnits("me").find(u=>u.name==="科德温骑士").power');
    Q('[data-do="endTurn"]').click();
    ok(fl() === 'target' && /共 3 次/.test(Q('.sheet.flow').textContent), '三张猫学派猎魔人：一次问 3 个目标');
    ub('科德温骑士').click(); ub('科德温骑士').click(); ub('赤红男爵').click(); Q('[data-do="tgtUndo"]').click(); ub('科德温骑士').click();
    ok(/×3/.test(ub('科德温骑士').textContent), '同一单位选了 3 次：格子上显示 ×3');
    Q('[data-do="tgtDone"]').click();
    ok(w.eval('sim(db.live,0).E.allUnits("me").find(u=>u.name==="科德温骑士").power') === kp0 - 3, '三张猫学派猎魔人都打科德温骑士：-3');
    // “三目者”艾克索（2026-10-01 对斯凯利格第 74–79 步）：部署“生成并打出”乌鸦眼块茎，拉牌步骤有推荐；块茎记在远程 → 乌鸦生成在远程，不重复打出、不再问生成了什么
    live([{ id: 'e1', who: 'me', a: 'play', c: '科德温骑士', row: 'm', side: 'me' }]);
    w.eval('ui.who="op";startCard("“三目者”艾克索","play","op")'); Q('[data-slot="op|m|0"]').click();
    ok(fl() === 'pull' && !!Q('.sheet.flow [data-nm="乌鸦眼块茎"]'), '艾克索：拉出了哪张，推荐乌鸦眼块茎');
    Q('.sheet.flow [data-nm="乌鸦眼块茎"]').click(); Q('[data-slot="op|r|0"]').click();
    S = w.eval('sim(db.live,0)');
    ok(fl() !== 'spawn' && w.eval('db.live.log.filter(x=>x.c==="乌鸦").length') === 0, '艾克索：引擎已经生成乌鸦，不再问生成了什么');
    ok(S.E.s.sides.op.rows.r.filter(u => u.name === '乌鸦').length === 3 && !S.E.allUnits().some(u => u.name === '乌鸦' && (u.side === 'me' || u.row === 'm'))
      && S.E.trace.filter(t => t.type === '打出' && t.data.name === '乌鸦眼块茎').length === 1, '艾克索：块茎只打出一次，3 只乌鸦在对方远程');
    // 海之新娘从墓场打出玛哈坎麦酒：麦酒那条记录的目标交给引擎自动打出的那张
    live([{ id: 'e1', who: 'op', a: 'play', c: '海之新娘', row: 'r', side: 'op' }, { id: 'e2', who: 'op', a: 'play', c: '玛哈坎麦酒', via: '海之新娘', tgts: [{ uid: 'e1', label: '海之新娘' }] }]);
    S = w.eval('sim(db.live,0)');
    ok(S.key2u.e1.power === S.key2u.e1.base + 5 && !S.warns.some(x => /麦酒/.test(x.m)) && S.E.trace.filter(t => t.type === '打出' && t.data.name === '玛哈坎麦酒').length === 1, '海之新娘：麦酒 +5 给记的目标，只打出一次');
    // 先记“触发效果”（回合已结束）再记“结束回合”：不重复结算（以前猫会移回去）
    live([{ id: 'e1', who: 'op', a: 'play', c: '猫学派猎魔人', row: 'r', side: 'op' }, { id: 'e2', who: 'op', a: 'effect', c: '猫学派猎魔人', uid: 'e1' }, { id: 'e3', who: 'op', a: 'end' }]);
    ok(w.eval('sim(db.live,0).E.s.sides.op.rows.m.length') === 1, '触发效果结束回合后再记结束回合：不重复结算');
    // 停牌也结算回合结束效果（rules.passTurnEnd，用户 2026-10-01 确认）：鼓手相邻 +1
    live([{ id: 'e1', who: 'op', a: 'play', c: '泰莫利亚鼓手', row: 'm', side: 'op' }, { id: 'e2', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }, { id: 'e3', who: 'op', a: 'pass' }]);
    ok(us('op') === '泰莫利亚鼓手5 寒冰巨人8', '停牌：结算回合结束效果');
    // 手里没牌被迫停牌：没有这个回合，不结算
    live([{ id: 'e1', who: 'op', a: 'play', c: '泰莫利亚鼓手', row: 'm', side: 'op' }, { id: 'e2', who: 'op', a: 'play', c: '寒冰巨人', row: 'm', side: 'op' }, { id: 'e3', who: 'op', a: 'hand', side: 'op', v: '0' }, { id: 'e4', who: 'op', a: 'pass' }]);
    ok(us('op') === '泰莫利亚鼓手5 寒冰巨人7', '停牌：手里没牌被迫停牌不结算回合结束');
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
    // 牌库：衍生牌默认不列，筛选“衍生牌：只看/包含”能找到乌鸦（2026-10-01 对斯凯利格第 62 步），点开是详情、不登记张数
    w.eval('ui.tab="coll";ui.collF="SK";ui.collTok="";render()');
    const collNames = () => QA('#collList .tile .nm').map(e => e.textContent);
    ok(!collNames().includes('乌鸦'), '牌库：默认不含衍生牌');
    Q('[data-ctok="only"]').click();
    ok(collNames().includes('乌鸦') && !collNames().includes('乌鸦之母') && !!Q('#collList .tile[data-cardb]') && !Q('#collList .tile[data-own]'), '牌库：只看衍生牌，有乌鸦，点开看详情');
    Q('[data-ctok="with"]').click(); ok(collNames().includes('乌鸦') && collNames().includes('乌鸦之母'), '牌库：包含衍生牌');
    w.eval('ui.collTok="";ui.collF="NR";ui.tab="match";render()');
    // 备份提醒
    ok(w.eval('backupAge()') === null, '备份：没备份过');
  } catch (e) { fails++; console.log('✗ 出错', e.stack); }
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  process.exit(fails ? 1 : 0);
}, 300);
