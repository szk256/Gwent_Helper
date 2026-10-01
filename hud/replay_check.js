// 把 hud 导出的 v2 对局代码喂给对局簿的推算引擎（jsdom 载入 dist/gwent_tracker.html），逐局出偏差报告：
// 核对点（真实比分）和推算比分对不对得上，从哪一步开始偏。
// 用法：node hud/replay_check.js 帧目录/game_v2.txt [对局簿备份.json（取卡组）] [--full]   （TRACKER=其他 gwent_tracker.html 换引擎）
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(process.env.TRACKER || path.join(root, 'dist', 'gwent_tracker.html'), 'utf8');  // TRACKER=别的打包产物
const code = fs.readFileSync(process.argv[2], 'utf8');
const backup = process.argv[3] && !process.argv[3].startsWith('--') ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
const full = process.argv.includes('--full');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
w.scrollTo = () => {};
w.alert = () => {};
w.confirm = () => true;
setTimeout(() => {
  try {
    const dec = w.GwentCodec.decodeGame(code);
    if (!dec) throw new Error('解码失败');
    const g = dec.game;
    g.id = 1;
    if (backup && backup.decks && backup.decks.length) {
      w.eval(`db.decks=${JSON.stringify(backup.decks)}`);
      g.deck = backup.decks[0].id;
      g.deckName = backup.decks[0].name;
      g.tacCard = true;
    }
    w.eval(`db.live=${JSON.stringify(g)}`);
    const G = w.eval('db.live');
    let tot = 0, ok = 0;
    for (let r = 0; r < Math.max(G.rounds.length, 1 + Math.max(...G.log.map(x => x.r))); r++) {
      const S = w.sim(G, r);
      const rep = w.devReport(G, r, S);
      const R = G.rounds[r] || {};
      console.log(`\n== 第 ${r + 1} 小局  读到 ${R.me}:${R.op}  推算 ${S ? S.score.me.total + ':' + S.score.op.total : '?'}`);
      if (!rep) continue;
      const lines = rep.text.split('\n');
      const chk = lines.filter(l => / 真实 /.test(l) && !l.startsWith('规则'));
      tot += chk.length;
      ok += chk.filter(l => l.endsWith('一致')).length;
      console.log(`  核对点一致 ${chk.filter(l => l.endsWith('一致')).length}/${chk.length}`);
      console.log(lines.filter(l => full || !/ 真实 /.test(l) || !l.endsWith('一致')).slice(0, full ? 999 : 25).map(l => '  ' + l).join('\n'));
    }
    console.log(`\n合计核对点一致 ${ok}/${tot}`);
  } catch (e) {
    console.error(e.stack || e);
  }
  process.exit(0);
}, 300);
