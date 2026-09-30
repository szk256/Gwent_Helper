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
    ok(/^#GWMIG v1 .*构建 [0-9a-f]{7}/.test(w.eval('migText()')), '版本：迁移导出带构建号');
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
    // 备份提醒
    ok(w.eval('backupAge()') === null, '备份：没备份过');
  } catch (e) { fails++; console.log('✗ 出错', e.stack); }
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  process.exit(fails ? 1 : 0);
}, 300);
