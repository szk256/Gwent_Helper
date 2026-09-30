// 把 src/index.html 引用的 style.css 和各个 JS 内嵌，打包成单文件 dist/gwent_tracker.html（手机用）。
// 用法：node build.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'dist', 'gwent_tracker.html');
// 统一成 LF：Windows 检出（autocrlf）也和 CI 打出一样的内容和构建号
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\r\n/g, '\n');

function inline(tag, file, text) {
  // 内容里出现结束标签会提前截断，打包前拒绝
  if (new RegExp('</' + tag, 'i').test(text)) throw new Error(`${file} 里含有 </${tag}，无法内嵌`);
  return `<${tag}>\n${text}${text.endsWith('\n') ? '' : '\n'}</${tag}>`;
}

// 先从 cards.js 的注释生成卡牌标记（偏差报告用）：ASSUME = 推测；用改战力 / 推算不了 / 按记录 = 需要手动
{
  const flags = {}; let cur = null;
  for (const line of read('cards.js').split('\n')) {
    const names = [...line.matchAll(/B\['([^']+)'\]\s*=/g)].map(m => m[1]);
    if (names.length) cur = names[names.length - 1];
    const kind = /ASSUME/.test(line) ? '推测' : /用改战力|推算不了|无法推算|按记录/.test(line) ? '需手动' : null;
    if (!kind) continue;
    for (const n of (names.length ? names : cur ? [cur] : [])) if (!flags[n] || kind === '推测') flags[n] = kind;
  }
  const js = '// 由 build.js 从 cards.js 注释生成，不要手改\n(function (root) { const F = ' + JSON.stringify(flags) + ';\n' +
    "if (typeof module !== 'undefined' && module.exports) module.exports = F; else root.GwentCardFlags = F; })(this);\n";
  fs.writeFileSync(path.join(SRC, 'cardflags.js'), js);
}

let html = read('index.html');
const used = [];
// 用函数做替换，避免 JS 内容里的 $& $1 之类被当成替换模式
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, f) => (used.push(f), inline('style', f, read(f))));
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, f) => (used.push(f), inline('script', f, read(f) + '\n')));
// 构建号：所有内嵌内容的哈希（内容不变就不变，CI 检查 dist 是否最新时不会误报），界面和导出里显示
const BUILD = require('crypto').createHash('sha256').update(html).digest('hex').slice(0, 7);
html = html.replace('<head>', `<head>\n<script>window.GWENT_BUILD=${JSON.stringify(BUILD)};</script>`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
// 可安装网页（PWA）用的文件：放在网址上（如 GitHub Pages）时生效，本地打开 html 不受影响
for (const f of ['manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon.svg']) fs.copyFileSync(path.join(SRC, f), path.join(path.dirname(OUT), f));
console.log(`构建 ${BUILD}：已打包 ${used.join(' ')} → ${path.relative(__dirname, OUT)}（${(Buffer.byteLength(html) / 1024).toFixed(0)} KB）`);
