// 数值一致性检查：cards.js 里每张牌代码用到的数字（2~30），卡面效果文字里必须也有。
// 月度补丁改了效果数值（例如伤害 3→4）而代码没跟着改时，这里会报出来。
// 已知的正常情况（“一半”=2、章节序号等）记在 numbers_baseline.json；`node gwent_numbers_check.js --update` 重写基线。
// 补丁里改了效果文字的牌必须写 code: '已同步' 或 '无需改'，否则也报错。
const fs = require('fs');
eval(fs.readFileSync('./src/data.js', 'utf8').replace('const RAW', 'global.RAW'));
const P = require('./src/patches.js'); P.applyAll(RAW);
const src = fs.readFileSync('./src/cards.js', 'utf8');
const seg = {}; const hits = []; const re = /^B\['([^']+)'\]\s*=/mg; let m;
while ((m = re.exec(src))) hits.push([m[1], m.index]);
hits.forEach(([n, i], k) => { seg[n] = (seg[n] || '') + src.slice(i, k + 1 < hits.length ? hits[k + 1][1] : src.length); });
const found = {};
for (const r of RAW) {
  const n = r[0]; if (!seg[n] || r[11] === 'token') continue;
  const text = (r[8] || '') + ' ' + (r[10] || '');
  const tn = new Set((text.replace(/“[^”]*”/g, '').match(/\d+/g) || []).map(Number));
  const code = seg[n].replace(/\/\/[^\n]*/g, '').replace(/'[^']*'/g, '');
  const cn = [...new Set((code.match(/(?<![\w.])\d+(?![\w.])/g) || []).map(Number))].filter(x => x >= 2 && x <= 30).sort((a, b) => a - b);
  const miss = cn.filter(x => !tn.has(x)); if (miss.length) found[n] = miss;
}
const BASE = './numbers_baseline.json';
if (process.argv.includes('--update')) { fs.writeFileSync(BASE, JSON.stringify(found, null, 1) + '\n'); console.log('已更新基线：' + Object.keys(found).length + ' 张'); process.exit(0); }
const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : {};
let fails = 0;
for (const [n, ms] of Object.entries(found)) {
  const extra = ms.filter(x => !(base[n] || []).includes(x));
  if (extra.length) { fails++; console.log(`✗ ${n}：代码里的 ${extra.join('、')} 卡面上没有（卡面可能被补丁改了，代码没跟上）`); }
}
for (const p of P.PATCHES) for (const c of p.cards) if ((c.tx || c.txe) && !c.code) { fails++; console.log(`✗ ${p.date} ${c.n}：效果文字改了，补丁条目要写 code: '已同步' 或 '无需改'`); }
console.log(fails ? `\n${fails} 项需要处理` : `\n数值一致（基线 ${Object.keys(base).length} 张）`);
process.exit(fails ? 1 : 0);
