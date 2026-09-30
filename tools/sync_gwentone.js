// 从 gwent.one 的版本改动页同步月度平衡补丁到 src/patches.js。
// 用法：node tools/sync_gwentone.js 14.10.0            预览这一版改了什么、和我们的数据对不对得上
//       node tools/sync_gwentone.js 14.10.0 --write    写进 src/patches.js（之后跑 npm test，效果改了的牌要同步 cards.js 并注明 code）
// 数据来源：https://gwent.one/{en,cn}/cards/changelog/<版本>（页面上每张牌有新旧两份：data-power / data-provision / 效果文字）。
// 用 curl 下载（走环境的代理设置）。按卡图编号（RAW[12]）对应我们的牌，对不上再按中文名。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const ver = process.argv[2];
if (!ver || !/^\d+\.\d+\.\d+/.test(ver)) { console.log('用法：node tools/sync_gwentone.js <版本，例如 14.10.0> [--write]'); process.exit(1); }
const write = process.argv.includes('--write');

const get = url => execFileSync('curl', ['-sSL', '-m', '60', '--fail', url], { encoding: 'utf8', maxBuffer: 64 << 20 });
const unesc = s => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const lines = s => unesc(s.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
function parse(html) {
  const re = /<div class="card-wrap card-data"([^>]*)>\s*<div class="card-info-wrap">([\s\S]*?)<div class="card-footer">v([\d.]+)<\/div>/g;
  const out = []; let m;
  while ((m = re.exec(html))) {
    const a = {}; m[1].replace(/data-([\w-]+)="([^"]*)"/g, (_, k, v) => { a[k] = v; });
    const name = unesc((m[2].match(/class="card-name"><a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
    const ab = (m[2].match(/class="card-body-ability">([\s\S]*?)<\/div>/) || [])[1] || '';
    out.push({ id: a.id, art: (a.artid || '').replace(/\D/g, ''), change: a.change, type: a.type, name, ver: m[3], power: +a.power, prov: +a.provision, armor: +a.armor, text: lines(ab) });
  }
  const pairs = [];
  for (let i = 0; i + 1 < out.length; i += 2) {
    const n = out[i], o = out[i + 1];
    if (n.id !== o.id) throw new Error('改动页结构变了：新旧两份对不上 ' + n.name);
    pairs.push({ id: n.id, art: n.art, type: n.type, change: n.change, name: n.name, new: n, old: o });
  }
  return pairs;
}

const en = get(`https://gwent.one/en/cards/changelog/${ver}`);
const cnHtml = get(`https://gwent.one/cn/cards/changelog/${ver}`);
const date = (en.match(new RegExp('(\\d{4}-\\d{2}-\\d{2})\\s+v' + ver.replace(/\./g, '\\.') + '\\b')) || [])[1];
if (!date) { console.log('改动页上找不到 v' + ver + ' 的发布日期，版本号对吗？'); process.exit(1); }
const pe = parse(en), pc = parse(cnHtml);
const cnById = {}; pc.forEach(p => { cnById[p.id] = p; });

eval(fs.readFileSync(path.join(ROOT, 'src', 'data.js'), 'utf8').replace('const RAW', 'global.RAW'));
const P = require(path.join(ROOT, 'src', 'patches.js'));
P.applyAll(RAW);
const byArt = {}, byName = {};
RAW.forEach(r => { if (r[11] === 'token') return; if (r[12]) (byArt[r[12]] = byArt[r[12]] || []).push(r); byName[r[0]] = r; });
const TYPE = { unit: '单位', special: '特殊', artifact: '神器', leader: '领袖能力', stratagem: '战术' };

const cards = [], report = [];
for (const p of pe) {
  const c = cnById[p.id];
  const cands = byArt[p.art] || [];
  const r = cands.find(x => c && x[0] === c.name) || (cands.length === 1 ? cands[0] : null) || (c && byName[c.name]);
  if (!r) { report.push(`？ ${p.name}${c ? '（' + c.name + '）' : ''}：我们的数据里找不到，可能是新牌，需要手动加`); continue; }
  const e = { n: r[0] }; const note = [];
  const isUnit = r[3] === '单位';
  const curPw = r[4] === '-' ? 0 : +r[4], curPv = +r[5] || 0;
  if (isUnit && p.old.power !== p.new.power) { e.pw = [p.old.power, p.new.power]; if (curPw !== p.new.power && curPw !== p.old.power) note.push(`我们的战力是 ${curPw}`); }
  if (p.old.prov !== p.new.prov) { e.pv = [p.old.prov, p.new.prov]; if (curPv !== p.new.prov && curPv !== p.old.prov) note.push(`我们的粮草是 ${curPv}`); }
  const txeNew = p.new.text.join(' / '), txeOld = p.old.text.join(' / ');
  if (txeNew !== txeOld) e.txe = [r[10] || txeOld, txeNew];
  if (c) { const tNew = c.new.text.join(' / '), tOld = c.old.text.join(' / '); if (tNew !== tOld) e.tx = [r[8] || tOld, tNew]; }
  // 只改了领袖卡面上的人口上限那句（粮草已经记在 pv）：代码不用动
  const noProv = t => t.filter(x => !/provision|人口上限/.test(x)).join(' / ');
  if ((e.tx || e.txe) && noProv(p.new.text) === noProv(p.old.text) && (!c || noProv(c.new.text) === noProv(c.old.text))) e.code = '无需改';
  if ((e.tx || e.txe) && !e.code) note.push('效果文字改了：检查 cards.js，补丁条目写 code');
  const already = (!e.pw || curPw === e.pw[1]) && (!e.pv || curPv === e.pv[1]);
  if (!e.pw && !e.pv && !e.tx && !e.txe) { report.push(`· ${r[0]}（${p.name}）：${p.change}，数值和文字都没变（可能只改了关联的衍生牌）`); continue; }
  cards.push(e);
  const parts = [e.pw && '战力 ' + e.pw.join('→'), e.pv && '粮草 ' + e.pv.join('→'), (e.tx || e.txe) && '效果'].filter(Boolean).join('，');
  report.push(`${already ? '=' : '+'} ${r[0]}（${p.name}，${TYPE[p.type] || p.type}）：${p.change} ${parts}${note.length ? '  ⚠ ' + note.join('；') : ''}`);
}
console.log(`v${ver}（${date}）共 ${pe.length} 张改动；“=” 表示我们的数据已经是新值，“+” 表示要更新`);
console.log(report.join('\n'));
if (P.PATCHES.some(p => p.ver === ver)) { console.log(`\npatches.js 里已经有 v${ver}，没有写入`); process.exit(0); }
if (!write) { console.log('\n预览完毕；加 --write 写进 src/patches.js'); process.exit(0); }
const entry = { date, ver, title: `v${ver} 平衡委员会`, src: `https://gwent.one/en/cards/changelog/${ver}`, cards };
const file = path.join(ROOT, 'src', 'patches.js');
const s = fs.readFileSync(file, 'utf8'); const MARK = '    // @@SYNC@@';
if (!s.includes(MARK)) throw new Error('patches.js 里找不到 @@SYNC@@ 标记');
const js = '    ' + JSON.stringify(entry, null, 1).replace(/\n\s*/g, ' ').replace(/\[ /g, '[').replace(/ \]/g, ']') + ',\n';
fs.writeFileSync(file, s.replace(MARK, js + MARK));
console.log(`\n已写入 src/patches.js（${cards.length} 张）。接下来：node build.js && npm test && npm run smoke`);
