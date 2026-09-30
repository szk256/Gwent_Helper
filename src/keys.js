// 电脑快捷键（对局页）。只模拟点击页面上已有的按钮，不直接改数据；在 app.js 之后载入。
// 动作字母和导出码一致：P 打出 O 指令 L 领袖 T 战术 E 效果 J 改战力 Y 生成 S 召唤 F 整排 V 移位 K 摧毁 X 换牌 D 抽牌 N 备注 - 停牌
// A / B 切换我方 / 对方，Tab 来回切；C 录入真实比分；R 录屏时间；/ 搜牌；Ctrl+Z 撤销上一步；? 显示帮助
// 搜牌框里：↑↓ 选牌，回车确认；放置步骤：1 近战排最右、2 远程排最右；回车 = 当前步骤的主按钮；Esc = 跳过 / 关闭
(function () {
  'use strict';
  const ACTKEY = { p: 'play', o: 'order', l: 'leader', t: 'tactic', e: 'effect', j: 'adj', y: 'spawn', s: 'summon', f: 'fx', v: 'move', k: 'kill', x: 'mull', d: 'draw', n: 'note', '-': 'pass' };
  const HELP = '快捷键：P 打出 · O 指令 · L 领袖 · T 战术 · E 效果 · J 改战力 · Y 生成 · S 召唤 · F 整排 · V 移位 · K 摧毁 · X 换牌 · D 抽牌 · N 备注 · - 停牌\n' +
    'A 我方 · B 对方 · Tab 切换 · Z 结束回合 · / 搜牌（↑↓ 选、回车确认）· 放牌时 1 近战 2 远程 · 回车 = 主按钮 · Esc 跳过/关闭 · Ctrl+Z 撤销 · C 真实比分 · R 录屏时间';
  const q = sel => document.querySelector(sel);
  const visible = el => el && el.offsetParent !== null;
  const click = sel => { const el = typeof sel === 'string' ? q(sel) : sel; if (el && !el.disabled) { el.click(); return true; } return false; };
  let kb = 0;   // 搜牌结果里当前选中的序号

  function results() { return [...document.querySelectorAll('#resBox [data-nm]')].filter(visible); }
  function mark() {
    const rs = results(); rs.forEach(b => b.classList.remove('kb'));
    if (!rs.length) return; kb = Math.max(0, Math.min(kb, rs.length - 1)); rs[kb].classList.add('kb'); rs[kb].scrollIntoView({ block: 'nearest' });
  }
  // 搜牌结果刷新后重新高亮第一个
  new MutationObserver(() => { const box = q('#resBox'); if (box && document.activeElement && document.activeElement.id === 'q') mark(); })
    .observe(document.body, { childList: true, subtree: true });

  document.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;              // 中文输入法组字中
    if (typeof ui === 'undefined' || ui.tab !== 'match' || !db.live) return;
    const dlg = q('dialog[open]');
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (dlg) { return; }                                          // 对话框自己处理回车 / Esc
    // 搜牌框
    if (e.target.id === 'q') {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); kb += e.key === 'ArrowDown' ? 1 : -1; mark(); return; }
      if (e.key === 'Enter') { const rs = results(); if (rs.length) { e.preventDefault(); const b = rs[Math.min(kb, rs.length - 1)]; kb = 0; b.click(); } return; }
      if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); return; }
      return;
    }
    if (e.target.id === 'vtIn' && (e.key === 'Enter' || e.key === 'Escape')) { e.target.dispatchEvent(new Event('change')); e.target.blur(); return; }
    if (e.target.id === 'pwIn' && e.key === 'Enter') { e.preventDefault(); click('[data-pwset="?"]'); return; }
    if (typing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); click('[data-do="undo"]'); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const step = ui.flow && ui.flow[0];
    if (k === 'Escape') { e.preventDefault(); if (step) click('[data-do="flowSkip"]') || click('[data-do="flowCancel"]') || (ui.flow = null, ui.q = '', rMatch()); else if (ui.insertBefore) click('[data-do="insertOff"]'); return; }
    if (k === 'Enter') { const b = q('.sheet.flow button.primary') || (!step && ui.act === 'pass' && q('[data-do="pass"]')); if (b) { e.preventDefault(); b.click(); } return; }
    if (step && step.t === 'place' && (k === '1' || k === '2')) {
      const row = k === '1' ? 'm' : 'r'; const slots = [...document.querySelectorAll(`[data-slot^="${step.side}|${row}|"]`)];
      if (slots.length) { e.preventDefault(); slots[slots.length - 1].click(); } return;
    }
    if (k === '?') { e.preventDefault(); alert(HELP); return; }
    if (k === '/') { const s = q('#q'); if (s) { e.preventDefault(); s.focus(); s.select(); kb = 0; mark(); } return; }
    if (k === 'r') { const s = q('#vtIn'); if (s) { e.preventDefault(); s.focus(); s.select(); } return; }
    if (k === 'c') { e.preventDefault(); click('[data-do="realScore"]'); return; }
    if (k === 'z') { e.preventDefault(); click('[data-do="endTurn"]') || click('[data-do="adjEnd"]'); return; }
    if (k === 'a' || k === 'b') { e.preventDefault(); click(`[data-who="${k === 'a' ? 'me' : 'op'}"]`); return; }
    if (k === 'Tab') { const other = ui.who === 'me' ? 'op' : 'me'; if (click(`[data-who="${other}"]`)) e.preventDefault(); return; }
    if (ACTKEY[k] && !step) {
      e.preventDefault();
      if (click(`[data-act="${ACTKEY[k]}"]`)) {
        // 打出 / 生成 / 召唤 / 抽牌 / 换牌：直接进入搜牌框
        if (['play', 'spawn', 'summon', 'draw', 'mull'].includes(ACTKEY[k])) setTimeout(() => { const s = q('#q'); if (s) { s.focus(); kb = 0; } }, 0);
        if (ACTKEY[k] === 'note') setTimeout(() => { const s = q('#noteIn'); if (s) s.focus(); }, 0);
      }
    }
  });
  window.GwentKeysHelp = HELP;
})();
