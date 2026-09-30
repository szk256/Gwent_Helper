// 把 src/data.js（套上最新补丁）导出成 hud/cache/cards.json，给 Python 用。
// 用法：node hud/export_cards.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
global.window = {};
eval(fs.readFileSync(path.join(root, 'src/data.js'), 'utf8').replace(/\r\n/g, '\n') + ';global.RAW=RAW');
require(path.join(root, 'src/patches.js')).applyAll(RAW);
const ids = require(path.join(root, 'src/cardids.js'));
const cards = RAW.map(r => ({
  name: r[0], fac: r[1], color: r[2], type: r[3], power: r[4], prov: r[5],
  rarity: r[6], tags: r[7], text: r[8], en: r[9], set: r[11], art: r[12], id: ids[r[0]] || null,
}));
const out = path.join(__dirname, 'cache');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'cards.json'), JSON.stringify(cards));
console.log(`cards.json: ${cards.length} 张`);
