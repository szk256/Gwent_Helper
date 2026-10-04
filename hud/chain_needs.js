// 把 v2 对局代码喂给对局簿推算引擎，列出引擎里由别的牌连带触发、却没有输入的目标选择
// （落难的少女翻章后的疯狂的冲锋给谁……），export.py 按卡面数值和画面上的战力变化补成连带效果记录（effect，chain=1）。
// 用法：node hud/chain_needs.js game_v2.txt  → JSON [{id: 触发它的那条记录, src: 来源牌名, prompt}]，以及落地战力和推算不同的 [{id, pw, calc}]
// TRACKER=其他 gwent_tracker.html 换引擎；载入失败输出 []。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let out = [];
const done = () => { process.stdout.write(JSON.stringify(out) + '\n'); process.exit(0); };
try {
  const { JSDOM } = require('jsdom');
  const html = fs.readFileSync(process.env.TRACKER || path.join(root, 'dist', 'gwent_tracker.html'), 'utf8');
  const code = fs.readFileSync(process.argv[2], 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  w.scrollTo = () => {}; w.alert = () => {}; w.confirm = () => true;
  setTimeout(() => {
    try {
      const g = w.GwentCodec.decodeGame(code).game;
      g.id = 1;
      w.eval(`db.live=${JSON.stringify(g)}`);
      const G = w.eval('db.live');
      const n = Math.max(G.rounds.length, 1 + Math.max(...G.log.map(x => x.r)));
      for (let r = 0; r < n; r++) {
        const S = w.sim(G, r);
        for (const wv of (S && S.warns) || []) {
          if (wv && wv.id && wv.src && wv.prompt && /没有指定目标/.test(wv.m || '')) out.push({ id: wv.id, src: wv.src, prompt: wv.prompt });
          // 落地战力和推算不同（可能漏记了指令，例如骑士随从“己方下一个打出的单位 +2”）
          const m = wv && wv.id && /落地战力记 (-?\d+)，推算 (-?\d+)/.exec(wv.m || '');
          if (m) out.push({ id: wv.id, pw: +m[1], calc: +m[2] });
        }
      }
    } catch (e) { out = []; }
    done();
  }, 300);
} catch (e) { done(); }
