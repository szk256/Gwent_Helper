// 把 src/index.html 引用的 style.css 和各个 JS 内嵌，打包成单文件 dist/gwent_tracker.html（手机用）。
// 用法：node build.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'dist', 'gwent_tracker.html');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

function inline(tag, file, text) {
  // 内容里出现结束标签会提前截断，打包前拒绝
  if (new RegExp('</' + tag, 'i').test(text)) throw new Error(`${file} 里含有 </${tag}，无法内嵌`);
  return `<${tag}>\n${text}${text.endsWith('\n') ? '' : '\n'}</${tag}>`;
}

let html = read('index.html');
const used = [];
// 用函数做替换，避免 JS 内容里的 $& $1 之类被当成替换模式
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, f) => (used.push(f), inline('style', f, read(f))));
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, f) => (used.push(f), inline('script', f, read(f) + '\n')));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`已打包 ${used.join(' ')} → ${path.relative(__dirname, OUT)}（${(Buffer.byteLength(html) / 1024).toFixed(0)} KB）`);
