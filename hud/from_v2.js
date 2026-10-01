// 把对局簿 v2 对局代码解码成对局 JSON（牌名是中文），给 check_record.py 和 hud 导出比较。
// 用法：node hud/from_v2.js 对局代码.txt  → 输出 JSON
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
global.window = {};
global.GwentCardIds = require(path.join(root, 'src/cardids.js'));
eval(fs.readFileSync(path.join(root, 'src/codec.js'), 'utf8'));
const dec = window.GwentCodec.decodeGame(fs.readFileSync(process.argv[2], 'utf8'));
if (!dec) { console.error('解码失败'); process.exit(1); }
process.stdout.write(JSON.stringify(dec.game));
