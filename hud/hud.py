"""昆特牌对局 HUD 原型：识别屏幕右侧展示的对方出牌，置顶小窗列出本局对方已出的牌，解牌标红。

用法：python hud/hud.py [--monitor N] [--interval 0.15] [--no-hide]
  --monitor  截整个显示器（mss 编号，1 起）；默认自动找游戏窗口（Gwent.exe）的画面区域，窗口模式也行
  --no-hide  不把 HUD 窗口从截屏里排除（默认排除：自己截屏看不到它，录屏也录不到它）
  --no-board 不扫对方场上的牌（默认每 2.5 秒扫一次，展示时漏掉的牌落地后补记，标“场上”）
只截屏幕上公开显示的画面，不读游戏内存、不抓网络包。
"""
import argparse
import ctypes
import json
import os
import queue
import sys
import threading
import time
import tkinter as tk
from tkinter import messagebox

import cv2
import mss

MSS = getattr(mss, 'MSS', None) or mss.mss
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detect  # noqa: E402
import gamewin  # noqa: E402
from matcher import FAC_CN, Matcher, removal_kind  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(HERE, 'cache', 'log')

BG, FG, DIM, RED, GOLD, ROWBG = '#1d2027', '#e6e1d6', '#9aa0ab', '#ff6b6b', '#e0b85a', '#262a33'


def pick_monitor(sct, n):
    mons = sct.monitors
    if n:
        return mons[n]
    return max(mons[1:], key=lambda m: m['width'] * m['height'])


def game_area(sct, args):
    """截哪块：指定了 --monitor 就用整个显示器，否则用游戏窗口的画面区域（窗口模式也对得上）。"""
    if args.monitor:
        return pick_monitor(sct, args.monitor)
    return gamewin.find()


def region(mon, box):
    x0, y0, x1, y1 = box
    return {'left': mon['left'] + int(x0 * mon['width']), 'top': mon['top'] + int(y0 * mon['height']),
            'width': int((x1 - x0) * mon['width']), 'height': int((y1 - y0) * mon['height'])}


def grab(sct, reg):
    return cv2.cvtColor(np.asarray(sct.grab(reg)), cv2.COLOR_BGRA2BGR)


class Watcher(threading.Thread):
    """后台线程：盯住右侧展示区，出现新牌时往队列里放事件。"""

    # 截取的区域：展示区的外包矩形；其中羊皮纸和卡图位置换算成相对坐标
    OUTER = (0.655, 0.125, 0.920, 0.410)

    def __init__(self, matcher, args, q):
        super().__init__(daemon=True)
        self.m, self.args, self.q = matcher, args, q
        self.paused = False
        self.stop = False

    @classmethod
    def rel(cls, box):
        ox0, oy0, ox1, oy1 = cls.OUTER
        w, h = ox1 - ox0, oy1 - oy0
        return ((box[0] - ox0) / w, (box[1] - oy0) / h, (box[2] - ox0) / w, (box[3] - oy0) / h)

    def reset(self):
        self.shown = None          # 当前展示中、已记下的卡图
        self.cand, self.cand_n = None, 0
        self.absent = 0
        self.tries = 0

    def step(self, img):
        """处理一帧（OUTER 区域的截图）。"""
        if detect.paper_ratio_rel(img, self.rel(detect.SHOW_PAPER)) < 0.5:
            self.absent += 1
            if self.absent >= 2:
                self.reset()
            return
        self.absent = 0
        crop = detect.crop(img, self.rel(detect.SHOW_CARD))
        res = self.m.match(crop)
        ok = Matcher.confident(res)
        art = res[0][1] if ok else None
        if ok and art != self.shown:
            if art == self.cand:
                self.cand_n += 1
            else:
                self.cand, self.cand_n = art, 1
            # 展示只停留不到 1 秒：特别有把握时一帧就算，否则连续两帧一致才算（避开放大动画）
            if self.cand_n >= 2 or Matcher.confident(res, min_votes=20, ratio=4):
                self.shown, self.tries = art, 0
                self.q.put(('card', res, crop))
        elif not ok and self.shown is None:
            self.tries += 1
            if self.tries == 6:  # 展示了约 2 秒还认不出
                self.q.put(('unknown', res, crop))

    def run(self):
        self.reset()
        with MSS() as sct:
            area, found_t, board_t = None, 0, 0
            while not self.stop:
                t0 = time.time()
                if self.paused:
                    time.sleep(0.3)
                    continue
                if t0 - found_t > 2:  # 每 2 秒重新找一次游戏窗口（窗口可能被移动、缩放）
                    found_t = t0
                    new = game_area(sct, self.args)
                    if new != area:
                        area = new
                        if area:
                            self.q.put(('status', f"游戏画面 {area['width']}×{area['height']}"
                                                  f"（{area['left']},{area['top']}），识别中"))
                        else:
                            self.q.put(('status', '没找到游戏窗口（Gwent.exe），等待中…'))
                if not area:
                    time.sleep(1)
                    continue
                reg = region(area, self.OUTER)
                try:
                    img = grab(sct, reg)
                except Exception as e:  # noqa: BLE001
                    self.q.put(('status', f'截屏失败：{e}'))
                    time.sleep(1)
                    continue
                self.step(img)
                # 每 2.5 秒扫一次对方半场（约 0.4 秒）；展示中不扫，免得错过展示
                if self.args.board and self.absent >= 2 and t0 - board_t > 2.5:
                    board_t = t0
                    try:
                        found = detect.board_opp(self.m, grab(sct, area))
                        self.q.put(('board', found))
                    except Exception as e:  # noqa: BLE001
                        self.q.put(('status', f'扫场面失败：{e}'))
                dt = time.time() - t0
                time.sleep(max(0.05, self.args.interval - dt))


class App:
    def __init__(self, root, args):
        self.root, self.args = root, args
        self.q = queue.Queue()
        self.rounds = [[]]  # 每小局一个列表：{name, card, votes, alts, crop_path, t}
        root.title('对方出牌')
        root.configure(bg=BG)
        root.attributes('-topmost', True)
        k = root.winfo_fpixels('1i') / 96  # 系统缩放（4K 下常见 150%~200%）
        self.k = k
        root.geometry(f'{int(380 * k)}x{int(620 * k)}+{int(40 * k)}+{int(80 * k)}')
        self.font = ('Microsoft YaHei UI', 11)
        self.small = ('Microsoft YaHei UI', 9)

        bar = tk.Frame(root, bg=BG)
        bar.pack(fill='x', padx=6, pady=(6, 2))
        for txt, cmd in (('下一小局', self.next_round), ('扫墓场', self.scan_grave), ('撤销', self.undo),
                         ('复制', self.copy), ('诊断', self.diagnose)):
            tk.Button(bar, text=txt, command=cmd, bg='#343a46', fg=FG, activebackground=GOLD, relief='flat',
                      font=self.small, padx=6).pack(side='left', padx=2)
        self.pause_btn = tk.Button(bar, text='暂停', command=self.toggle_pause, bg='#343a46', fg=FG,
                                   relief='flat', font=self.small, padx=6)
        self.pause_btn.pack(side='left', padx=2)

        self.head = tk.Label(root, text='', bg=BG, fg=GOLD, font=self.font, anchor='w')
        self.head.pack(fill='x', padx=8)
        self.lb = tk.Listbox(root, bg=ROWBG, fg=FG, font=self.font, activestyle='none', selectbackground='#4a5263',
                             highlightthickness=0, borderwidth=0)
        self.lb.pack(fill='both', expand=True, padx=6, pady=4)
        self.lb.bind('<<ListboxSelect>>', self.on_select)
        self.lb.bind('<Button-3>', self.on_right)
        self.detail = tk.Label(root, text='', bg=BG, fg=DIM, font=self.small, anchor='nw', justify='left',
                               wraplength=int(360 * self.k))
        self.detail.pack(fill='x', padx=8)
        self.status = tk.Label(root, text='载入特征库…', bg=BG, fg=DIM, font=self.small, anchor='w')
        self.status.pack(fill='x', padx=8, pady=(0, 4))
        self.rows = []  # 列表框每行对应 (小局序号, 条目序号) 或 None（标题行）
        root.after(50, self.start)

    # ---------- 启动 ----------
    def start(self):
        self.root.update_idletasks()
        if not self.args.no_hide:
            try:  # WDA_EXCLUDEFROMCAPTURE：自己截屏时看不到 HUD，不会挡住识别区域
                hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
                ctypes.windll.user32.SetWindowDisplayAffinity(hwnd, 0x11)
            except Exception:  # noqa: BLE001
                pass
        t0 = time.time()
        self.m = Matcher()
        self.set_status(f'特征库 {len(self.m.arts)} 张，载入 {time.time() - t0:.1f}s')
        self.w = Watcher(self.m, self.args, self.q)
        self.w.start()
        self.session = time.strftime('%Y%m%d-%H%M%S')
        os.makedirs(os.path.join(LOG_DIR, self.session), exist_ok=True)
        self.render()
        self.poll()

    def set_status(self, s):
        self.status.config(text=s)

    # ---------- 事件 ----------
    def poll(self):
        try:
            while True:
                ev = self.q.get_nowait()
                if ev[0] == 'status':
                    self.set_status(ev[1])
                elif ev[0] in ('card', 'unknown'):
                    self.add(ev[0], ev[1], ev[2])
                elif ev[0] == 'board':
                    self.on_board(ev[1])
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def add(self, kind, res, crop):
        n = sum(len(r) for r in self.rounds) + 1
        path = os.path.join(LOG_DIR, self.session, f'{n:03d}.png')
        cv2.imencode('.png', crop)[1].tofile(path)
        alts = [(v, a, [c['name'] for c in cs]) for v, a, cs in res]
        if kind == 'card':
            card = self.pick(res[0][2])
            item = {'name': card['name'], 'card': card, 'votes': res[0][0], 'alts': alts}
        else:
            item = {'name': '（未识别）', 'card': None, 'votes': res[0][0] if res else 0, 'alts': alts}
        item.update(crop=path, t=time.strftime('%H:%M:%S'), round=len(self.rounds))
        self.rounds[-1].append(item)
        self.save_log()
        self.render()
        v2 = alts[1][0] if len(alts) > 1 else 0
        self.set_status(f"{item['t']} {item['name']}  票数 {item['votes']:.0f}/{v2:.0f}")

    def on_board(self, found):
        """对方场上某张牌的张数比列表里多（展示时漏掉了，或是召唤/生成的），补进列表，标“场上”。
        连续两次扫到同样的张数才算，免得偶尔误检。"""
        cnt = {}
        for v, art, x, y in found:
            name = self.pick(self.m.by_art.get(art, []))['name'] if self.m.by_art.get(art) else None
            if name:
                cnt[name] = cnt.get(name, 0) + 1
        prev, self.board_prev = getattr(self, 'board_prev', {}), cnt
        cur = self.rounds[-1]
        added = []
        for name, n in cnt.items():
            n = min(n, prev.get(name, 0))
            have = sum(1 for it in cur if it['name'] == name)
            for _ in range(n - have):
                card = next(c for c in self.m.cards if c['name'] == name)
                cur.append({'name': name, 'card': card, 'votes': 0, 'alts': [], 'src': '场上', 'crop': None,
                            't': time.strftime('%H:%M:%S'), 'round': len(self.rounds)})
                added.append(name)
        self.board_now = cnt
        if added:
            self.save_log()
            self.render()
            self.set_status(f"场上补记：{'、'.join(added)}")

    def pick(self, cards):
        """同一张卡图对应多张牌时，优先对手阵营（已记下的非中立牌里最多的阵营）。"""
        fac = self.opp_fac()
        for c in cards:
            if c['fac'] == fac:
                return c
        return cards[0]

    def opp_fac(self):
        cnt = {}
        for r in self.rounds:
            for it in r:
                if it['card'] and it['card']['fac'] != 'NE':
                    cnt[it['card']['fac']] = cnt.get(it['card']['fac'], 0) + 1
        return max(cnt, key=cnt.get) if cnt else None

    # ---------- 显示 ----------
    def render(self):
        self.lb.delete(0, 'end')
        self.rows = []
        fac = self.opp_fac()
        total = sum(len(r) for r in self.rounds)
        self.head.config(text=f"对方：{FAC_CN.get(fac, '未知')}　第 {len(self.rounds)} 小局　共 {total} 张")
        for ri, r in enumerate(self.rounds):
            self.lb.insert('end', f'── 第 {ri + 1} 小局（{len(r)}）──')
            self.lb.itemconfig('end', fg=GOLD)
            self.rows.append(None)
            for ii, it in enumerate(r):
                c = it['card']
                if c:
                    rk = removal_kind(c)
                    pw = c['power'] if c['type'] == '单位' else c['type']
                    txt = f"  {c['name']}  {pw}" + (f"  【{rk}】" if rk else '') + \
                        ('  （场上）' if it.get('src') == '场上' else '')
                else:
                    txt = f"  {it['name']}"
                self.lb.insert('end', txt)
                self.lb.itemconfig('end', fg=RED if c and removal_kind(c) else (FG if c else DIM))
                self.rows.append((ri, ii))
        self.lb.see('end')

    def item_at(self, idx):
        if idx is None or idx >= len(self.rows) or self.rows[idx] is None:
            return None
        ri, ii = self.rows[idx]
        return self.rounds[ri][ii]

    def on_select(self, _e):
        sel = self.lb.curselection()
        it = self.item_at(sel[0] if sel else None)
        if not it:
            return
        c = it['card']
        alt = '；'.join(f"{'/'.join(n)} {v:.0f}" for v, _, n in it['alts'][:3])
        txt = (f"{c['name']}（{FAC_CN.get(c['fac'], c['fac'])} {c['color']} {c['type']} {c['prov']}费）\n{c['text']}"
               if c else '没认出来，截图已存在 cache/log。')
        self.detail.config(text=f"{txt}\n{it['t']}  候选：{alt}")

    def on_right(self, e):
        idx = self.lb.nearest(e.y)
        it = self.item_at(idx)
        if not it:
            return
        menu = tk.Menu(self.root, tearoff=0)
        seen = set()
        for v, art, names in it['alts'][:3]:
            for c in self.m.by_art.get(art, []):
                if c['name'] in seen:
                    continue
                seen.add(c['name'])
                menu.add_command(label=f"改成 {c['name']}（{v:.0f}）", command=lambda c=c: self.fix(it, c))
        menu.add_separator()
        menu.add_command(label='删除', command=lambda: self.delete(it))
        menu.tk_popup(e.x_root, e.y_root)

    def fix(self, it, card):
        it['card'], it['name'], it['fixed'] = card, card['name'], True
        self.save_log()
        self.render()

    def delete(self, it):
        for r in self.rounds:
            if it in r:
                r.remove(it)
        it['deleted'] = True
        self.save_log()
        self.render()

    # ---------- 按钮 ----------
    def next_round(self):
        if len(self.rounds) >= 3 and not messagebox.askyesno('新对局', '已经 3 个小局了，清空开始新对局？'):
            return
        if len(self.rounds) >= 3:
            self.rounds = [[]]
            self.session = time.strftime('%Y%m%d-%H%M%S')
            os.makedirs(os.path.join(LOG_DIR, self.session), exist_ok=True)
        else:
            self.rounds.append([])
        self.board_prev = {}
        self.render()

    def undo(self):
        for r in reversed(self.rounds):
            if r:
                self.delete(r[-1])
                return

    def toggle_pause(self):
        self.w.paused = not self.w.paused
        self.pause_btn.config(text='继续' if self.w.paused else '暂停')
        self.set_status('已暂停' if self.w.paused else '识别中')

    def copy(self):
        lines = []
        for ri, r in enumerate(self.rounds):
            lines.append(f'第 {ri + 1} 小局：' + '、'.join(it['name'] for it in r))
        self.root.clipboard_clear()
        self.root.clipboard_append('\n'.join(lines))
        self.set_status('已复制')

    def scan_grave(self):
        """打开墓场界面后点这个：截游戏画面，找出每张牌并识别。"""
        frame = self.grab_game()
        cards = detect.find_cards(frame)
        names = []
        for i, (*_, img) in enumerate(cards):
            res = self.m.match(img)
            names.append(res[0][2][0]['name'] if Matcher.confident(res, min_votes=6) else '？')
            cv2.imencode('.png', img)[1].tofile(os.path.join(LOG_DIR, self.session, f'grave_{i:02d}.png'))
        cnt = {}
        for n in names:
            cnt[n] = cnt.get(n, 0) + 1
        txt = '\n'.join(f'{n} ×{k}' if k > 1 else n for n, k in cnt.items()) or '没找到卡牌（先打开墓场界面）'
        messagebox.showinfo(f'墓场 {len(cards)} 张（只看得到当前一屏）', txt)

    def grab_game(self):
        with MSS() as sct:
            area = game_area(sct, self.args) or pick_monitor(sct, 0)
            return grab(sct, area)

    def diagnose(self):
        """存一张游戏画面，显示展示区检测值，识别不到时用。"""
        frame = self.grab_game()
        path = os.path.join(LOG_DIR, self.session, f"diag_{time.strftime('%H%M%S')}.png")
        cv2.imencode('.png', frame)[1].tofile(path)
        pr = detect.paper_ratio(frame)
        sc = detect.showcase(frame)
        res = self.m.match(sc) if sc is not None else []
        top = f"{res[0][2][0]['name']} {res[0][0]:.0f}票" if res and res[0][2] else '无'
        self.set_status(f"画面 {frame.shape[1]}×{frame.shape[0]} 羊皮纸 {pr:.2f} 展示区：{top}；已存 {os.path.basename(path)}")

    def save_log(self):
        path = os.path.join(LOG_DIR, self.session, 'log.json')
        data = [[{k: v for k, v in it.items() if k != 'card'} for it in r] for r in self.rounds]
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--monitor', type=int, default=0)
    ap.add_argument('--interval', type=float, default=0.15)
    ap.add_argument('--no-hide', action='store_true')
    ap.add_argument('--no-board', dest='board', action='store_false', help='不扫对方场上的牌')
    args = ap.parse_args()
    if not os.path.exists(os.path.join(HERE, 'cache', 'db.npz')):
        print('还没有特征库，先运行：python hud/build_db.py')
        return 1
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # 4K 缩放下截屏坐标用物理像素
    except Exception:  # noqa: BLE001
        pass
    root = tk.Tk()
    App(root, args)
    root.mainloop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
