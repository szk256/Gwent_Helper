// 生成 src/cardids.js：我们的牌名 → gwent 官方卡牌编号（导出代码用，语言、补丁、改名都不影响编号）。
// 用法：node tools/gen_cardids.js [版本，默认 latest]   （用 curl 读 api.gwent.one，需要网络允许 api.gwent.one）
// 对应规则：同中文名且同类型 → 同中文名同卡图 → 同卡图 → 英文名（去掉首尾空格）。对不上的牌导出时用牌名（N: 前缀）。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const ver = process.argv[2] || 'latest';
const get = lang => Object.values(JSON.parse(execFileSync('curl', ['-sSL', '-m', '120', '--fail',
  `https://api.gwent.one/?key=data&version=${ver}&language=${lang}`], { encoding: 'utf8', maxBuffer: 64 << 20 })).response);
const cn = get('cn'), en = get('en');
const enName = {}; en.forEach(c => { enName[c.id.card] = c.name.trim(); });
const TYPE = { '单位': 'Unit', '特殊': 'Special', '神器': 'Artifact', '领袖能力': 'Ability', '战术': 'Stratagem' };
const byName = {}, byArt = {}, byEn = {};
cn.forEach(c => { (byName[c.name.trim()] = byName[c.name.trim()] || []).push(c); (byArt[c.id.art] = byArt[c.id.art] || []).push(c); (byEn[enName[c.id.card]] = byEn[enName[c.id.card]] || []).push(c); });
eval(fs.readFileSync(path.join(ROOT, 'src', 'data.js'), 'utf8').replace('const RAW', 'global.RAW'));
const ids = {}, miss = [], used = new Set();
const pick = (cs, r) => {
  if (!cs || !cs.length) return null;
  const t = cs.filter(c => c.attributes.type === TYPE[r[3]]);
  const a = (t.length ? t : cs).filter(c => String(c.id.art) === String(r[12]));
  const list = a.length ? a : t.length ? t : cs;
  return list.slice().sort((x, y) => x.id.card - y.id.card)[0];
};
for (const r of RAW) {
  const c = pick(byName[r[0]], r) || pick(byArt[r[12]], r) || pick(byEn[(r[9] || r[0]).trim()], r);
  if (!c) { miss.push(r[0]); continue; }
  if (used.has(c.id.card)) { miss.push(r[0] + '（编号重复）'); continue; }
  used.add(c.id.card); ids[r[0]] = c.id.card;
}
const js = '// 由 tools/gen_cardids.js 从 api.gwent.one 生成（版本 ' + ver + '），不要手改。牌名 → gwent 官方卡牌编号\n' +
  '(function (root) { const M = ' + JSON.stringify(ids) + ';\n' +
  "if (typeof module !== 'undefined' && module.exports) module.exports = M; else root.GwentCardIds = M; })(this);\n";
fs.writeFileSync(path.join(ROOT, 'src', 'cardids.js'), js);
console.log(`对上 ${Object.keys(ids).length} / ${RAW.length}` + (miss.length ? `，没对上：${miss.join('、')}` : ''));
