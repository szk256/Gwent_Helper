// 把 hud 整理出来的对局 JSON 编码成对局簿的 v2 对局代码（用 src/codec.js，格式和对局簿完全一致），并检查能解回来。
// 用法：node hud/to_v2.js 对局.json  → 输出 v2 代码
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
global.window = {};
global.GwentCardIds = require(path.join(root, 'src/cardids.js'));
eval(fs.readFileSync(path.join(root, 'src/codec.js'), 'utf8'));
const C = window.GwentCodec;
const g = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const code = C.encodeGame(g);
const back = C.decodeGame(code);
if (!back || back.game.log.length !== g.log.length) {
  console.error('解码核对失败', back && back.game.log.length, g.log.length);
  process.exit(1);
}
process.stdout.write(code + '\n');
