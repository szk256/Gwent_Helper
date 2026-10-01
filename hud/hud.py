"""昆特牌对局 HUD：实时扫描整个场面，记录双方出牌、离场、比分，置顶小窗显示；一键导出对局簿 v2 对局代码。

用法：python hud/hud.py [--monitor N] [--no-hide] [--save-frames] [--deck=卡组代码或对局簿备份路径] [--no-sync]
  导出默认把画面读到的每个单位战力写成改战力记录（对局簿里复盘时场面就是实际场面）；--no-sync 关掉，用来核查推算引擎
  默认自动找游戏窗口（Gwent.exe）的画面区域，窗口模式也行；--monitor N 改为截整个显示器
  --no-hide      不把小窗从截屏里排除（默认排除：自己截屏看不到它，录屏也录不到它）
  --save-frames  把扫描过的画面存到 cache/log/<时间>/frames/（给离线分析、调参数用，一局几百 MB）

两个后台线程：
  - 展示线程：每 0.15 秒看右侧展示框（对方刚打出的牌，停留不到 1 秒），用来区分对方“打出”和“召唤/生成”，
    也是对方特殊牌唯一的来源
  - 场面线程：每 1–2 秒扫一次整个场面（双方四排 + 我方手牌）和双方总分，交给 timeline.Tracker 推出进场 / 离场 / 移动
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
import numpy as np

MSS = getattr(mss, 'MSS', None) or mss.mss

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deck  # noqa: E402
import detect  # noqa: E402
import export  # noqa: E402
import gamewin  # noqa: E402
import layout  # noqa: E402
import timeline  # noqa: E402
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
    """截哪块：指定了 --monitor 就用整个显示器，否则用游戏窗口的画面区域。"""
    if args.monitor:
        return pick_monitor(sct, args.monitor)
    return gamewin.find()


def region(mon, box):
    x0, y0, x1, y1 = box
    return {'left': mon['left'] + int(x0 * mon['width']), 'top': mon['top'] + int(y0 * mon['height']),
            'width': int((x1 - x0) * mon['width']), 'height': int((y1 - y0) * mon['height'])}


def grab(sct, reg):
    return cv2.cvtColor(np.asarray(sct.grab(reg)), cv2.COLOR_BGRA2BGR)


class ShowWatcher(threading.Thread):
    """盯住右侧展示区，出现新牌时放进 shows（给场面线程）和界面队列。"""

    OUTER = (0.655, 0.125, 0.920, 0.410)  # 展示区外包矩形（16:9）

    def __init__(self, matcher, args, q, shows):
        super().__init__(daemon=True)
        self.m, self.args, self.q, self.shows = matcher, args, q, shows
        self.paused = False
        self.stop = False
        self.area = None
        self.reset()

    def reset(self):
        self.shown, self.cand, self.cand_n, self.absent = None, None, 0, 0

    @classmethod
    def rel(cls, box):
        ox0, oy0, ox1, oy1 = cls.OUTER
        w, h = ox1 - ox0, oy1 - oy0
        return ((box[0] - ox0) / w, (box[1] - oy0) / h, (box[2] - ox0) / w, (box[3] - oy0) / h)

    def step(self, img, t):
        L = layout.PROFILES['16:9']
        if detect.paper_ratio_rel(img, self.rel(L['show_paper'])) < 0.5:
            self.absent += 1
            if self.absent >= 2:
                self.reset()
            return
        self.absent = 0
        crop = detect.crop(img, self.rel(L['show_card']))
        res = self.m.match(crop)
        if not Matcher.confident(res):
            return
        art = res[0][1]
        if art == self.shown:
            return
        self.cand_n = self.cand_n + 1 if art == self.cand else 1
        self.cand = art
        # 展示只停留不到 1 秒：特别有把握时一帧就算，否则连续两帧一致才算
        if self.cand_n >= 2 or Matcher.confident(res, min_votes=20, ratio=4):
            self.shown = art
            name = res[0][2][0]['name']
            self.shows.append((t, name))
            self.q.put(('show', t, name, crop))

    def run(self):
        with MSS() as sct:
            found_t = 0
            while not self.stop:
                t0 = time.time()
                if self.paused:
                    time.sleep(0.3)
                    continue
                if t0 - found_t > 2:
                    found_t = t0
                    self.area = game_area(sct, self.args)
                if not self.area or self.area['width'] / self.area['height'] < 1.55:
                    time.sleep(1)  # 没找到游戏，或不是 16:9（没标定展示区）
                    continue
                try:
                    self.step(grab(sct, region(self.area, self.OUTER)), t0)
                except Exception as e:  # noqa: BLE001
                    self.q.put(('status', f'截屏失败：{e}'))
                    time.sleep(1)
                    continue
                time.sleep(max(0.03, 0.15 - (time.time() - t0)))


class BoardWatcher(threading.Thread):
    """扫整个场面和总分，交给 Tracker。用自己的一份特征库（和展示线程并行）。"""

    def __init__(self, args, q, shows, frames_dir=None):
        super().__init__(daemon=True)
        self.args, self.q, self.shows, self.frames_dir = args, q, shows, frames_dir
        self.paused = False
        self.stop = False
        self.lock = threading.Lock()
        self.tr = timeline.Tracker()
        self.states = []      # [(时间, {score, sharp, smin})]，导出比分用
        self.m = None

    def run(self):
        self.m = Matcher()
        self.q.put(('status', '场面扫描已启动'))
        with MSS() as sct:
            area, found_t, used_shows = None, 0, 0
            while not self.stop:
                t0 = time.time()
                if self.paused:
                    time.sleep(0.3)
                    continue
                if t0 - found_t > 2:
                    found_t = t0
                    new = game_area(sct, self.args)
                    if new != area:
                        area = new
                        self.q.put(('status', f"游戏画面 {area['width']}×{area['height']}，识别中" if area
                                    else '没找到游戏窗口（Gwent.exe），等待中…'))
                if not area:
                    time.sleep(1)
                    continue
                try:
                    im = grab(sct, area)
                    ent = timeline.scan_frame(self.m, im)
                except Exception as e:  # noqa: BLE001
                    self.q.put(('status', f'扫描失败：{e}'))
                    time.sleep(1)
                    continue
                with self.lock:
                    while used_shows < len(self.shows):  # 展示线程看到的对方出牌
                        st, name = self.shows[used_shows]
                        used_shows += 1
                        self.tr.shows.append((st, name))
                    ent['show'] = None
                    self.tr.update(t0, ent)
                    self.states.append((t0, {k: ent.get(k) for k in ('score', 'sharp', 'smin', 'prof', 'turn', 'rows', 'pw', 'sh', 'lglow', 'cnt')}))
                    snap = self.tr.snapshot()
                if self.frames_dir:
                    name = time.strftime('%H%M%S', time.localtime(t0)) + f'_{int(t0 * 10) % 10}.jpg'
                    cv2.imencode('.jpg', im, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tofile(os.path.join(self.frames_dir, name))
                self.q.put(('board', snap, ent['rows'], ent.get('score'), time.time() - t0))

    def export(self, date, my_deck=None):
        with self.lock:
            events = self.tr.snapshot()
            scores = export.stable_scores(self.states)
            runs = export.turn_runs(self.states)
            extra = dict(self.tr.extra)
            states = list(self.states) if not self.args.no_sync else None
        return export.build_game(events, scores, date, {c['name']: c for c in (self.m.cards if self.m else [])},
                                 my_deck=my_deck, runs=runs, extra=extra, sync_states=states, states=list(self.states))


class App:
    def __init__(self, root, args):
        self.root, self.args = root, args
        self.q = queue.Queue()
        self.shows = []
        self.events = []
        self.cards = {}
        root.title('昆特对局 HUD')
        root.configure(bg=BG)
        root.attributes('-topmost', True)
        k = root.winfo_fpixels('1i') / 96  # 系统缩放（4K 下常见 150%~200%）
        self.k = k
        root.geometry(f'{int(400 * k)}x{int(720 * k)}+{int(40 * k)}+{int(80 * k)}')
        self.font = ('Microsoft YaHei UI', 11)
        self.small = ('Microsoft YaHei UI', 9)

        bar = tk.Frame(root, bg=BG)
        bar.pack(fill='x', padx=6, pady=(6, 2))
        for txt, cmd in (('导出对局代码', self.export_code), ('扫墓场', self.scan_grave), ('诊断', self.diagnose)):
            tk.Button(bar, text=txt, command=cmd, bg='#343a46', fg=FG, activebackground=GOLD, relief='flat',
                      font=self.small, padx=6).pack(side='left', padx=2)
        self.pause_btn = tk.Button(bar, text='暂停', command=self.toggle_pause, bg='#343a46', fg=FG,
                                   relief='flat', font=self.small, padx=6)
        self.pause_btn.pack(side='left', padx=2)

        self.head = tk.Label(root, text='', bg=BG, fg=GOLD, font=self.font, anchor='w')
        self.head.pack(fill='x', padx=8)
        tk.Label(root, text='对方已出（红色是解牌）', bg=BG, fg=DIM, font=self.small, anchor='w').pack(fill='x', padx=8)
        self.opp = tk.Listbox(root, bg=ROWBG, fg=FG, font=self.font, activestyle='none', selectbackground='#4a5263',
                              highlightthickness=0, borderwidth=0, height=12)
        self.opp.pack(fill='both', expand=True, padx=6, pady=(0, 4))
        self.opp.bind('<<ListboxSelect>>', lambda _e: self.on_select(self.opp, self.opp_rows))
        tk.Label(root, text='场面时间线', bg=BG, fg=DIM, font=self.small, anchor='w').pack(fill='x', padx=8)
        self.tl = tk.Listbox(root, bg=ROWBG, fg=FG, font=self.small, activestyle='none', selectbackground='#4a5263',
                             highlightthickness=0, borderwidth=0, height=10)
        self.tl.pack(fill='both', expand=True, padx=6, pady=(0, 4))
        self.tl.bind('<<ListboxSelect>>', lambda _e: self.on_select(self.tl, self.tl_rows))
        self.detail = tk.Label(root, text='', bg=BG, fg=DIM, font=self.small, anchor='nw', justify='left',
                               wraplength=int(380 * k))
        self.detail.pack(fill='x', padx=8)
        self.status = tk.Label(root, text='载入特征库…', bg=BG, fg=DIM, font=self.small, anchor='w')
        self.status.pack(fill='x', padx=8, pady=(0, 4))
        self.opp_rows, self.tl_rows = [], []
        self.score, self.scan_dt = None, 0
        root.after(50, self.start)

    # ---------- 启动 ----------
    def start(self):
        self.root.update_idletasks()
        if not self.args.no_hide:
            try:  # WDA_EXCLUDEFROMCAPTURE：自己截屏时看不到小窗，不会挡住识别区域
                hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
                ctypes.windll.user32.SetWindowDisplayAffinity(hwnd, 0x11)
            except Exception:  # noqa: BLE001
                pass
        self.session = time.strftime('%Y%m%d-%H%M%S')
        self.dir = os.path.join(LOG_DIR, self.session)
        frames = os.path.join(self.dir, 'frames') if self.args.save_frames else None
        os.makedirs(frames or self.dir, exist_ok=True)
        t0 = time.time()
        self.m = Matcher()
        self.cards = {c['name']: c for c in self.m.cards}
        self.set_status(f'特征库 {len(self.m.arts)} 张，载入 {time.time() - t0:.1f}s；场面扫描载入中…')
        self.sw = ShowWatcher(self.m, self.args, self.q, self.shows)
        self.sw.start()
        self.bw = BoardWatcher(self.args, self.q, self.shows, frames)
        self.bw.start()
        self.render()
        self.poll()

    def set_status(self, s):
        self.status.config(text=s)

    # ---------- 事件 ----------
    def poll(self):
        changed = False
        try:
            while True:
                ev = self.q.get_nowait()
                if ev[0] == 'status':
                    self.set_status(ev[1])
                elif ev[0] == 'show':
                    _k, t, name, crop = ev
                    n = len(self.shows)
                    cv2.imencode('.png', crop)[1].tofile(os.path.join(self.dir, f'show_{n:03d}.png'))
                    self.set_status(f"{time.strftime('%H:%M:%S', time.localtime(t))} 对方展示：{name}")
                elif ev[0] == 'board':
                    _k, snap, rows, score, dt = ev
                    if snap != self.events:
                        self.events = snap
                        changed = True
                    if score and score[0] is not None and score[1] is not None:
                        self.score = score
                    self.scan_dt = dt
        except queue.Empty:
            pass
        if changed:
            self.render()
            self.save()
        self.update_head()
        self.root.after(200, self.poll)

    def rounds(self):
        """时间线按小局切开：[[事件…], …]，不含手牌事件。"""
        out = [[]]
        for e in self.events:
            if e[1] == '小局结束':
                out.append([])
            elif e[4] != '手牌' and e[1] not in ('抽到', '离手'):
                out[-1].append(e)
        return out

    def opp_fac(self):
        cnt = {}
        for e in self.events:
            c = self.cards.get(e[3])
            if e[2] == '对方' and c and c['fac'] != 'NE':
                cnt[c['fac']] = cnt.get(c['fac'], 0) + 1
        return max(cnt, key=cnt.get) if cnt else None

    def update_head(self):
        sc = f'  我 {self.score[1]} : {self.score[0]} 对' if self.score else ''
        self.head.config(text=f"对方：{FAC_CN.get(self.opp_fac(), '未知')}　第 {len(self.rounds())} 小局{sc}"
                              f"　（{self.scan_dt:.1f}s/次）")

    # ---------- 显示 ----------
    def render(self):
        rs = self.rounds()
        self.opp.delete(0, 'end')
        self.opp_rows = []
        for ri, r in enumerate(rs):
            items = [e for e in r if e[2] == '对方' and e[1] in ('打出', '展示', '进场')]
            self.opp.insert('end', f'── 第 {ri + 1} 小局（{len(items)}）──')
            self.opp.itemconfig('end', fg=GOLD)
            self.opp_rows.append(None)
            for e in items:
                c = self.cards.get(e[3], {})
                rk = removal_kind(c) if c else ''
                pw = c.get('power') if c.get('type') == '单位' else c.get('type', '')
                tag = {'进场': '（召唤/生成）', '展示': ''}.get(e[1], '')
                self.opp.insert('end', f"  {e[3]}  {pw}" + (f'  【{rk}】' if rk else '') + tag)
                self.opp.itemconfig('end', fg=RED if rk else (DIM if e[1] == '进场' else FG))
                self.opp_rows.append(e)
        self.opp.see('end')
        self.tl.delete(0, 'end')
        self.tl_rows = []
        for ri, r in enumerate(rs):
            self.tl.insert('end', f'── 第 {ri + 1} 小局 ──')
            self.tl.itemconfig('end', fg=GOLD)
            self.tl_rows.append(None)
            for e in r:
                t = time.strftime('%H:%M:%S', time.localtime(e[0]))
                self.tl.insert('end', f'{t} {e[2]}{e[1]} {e[3]}' + (f'（{e[4]}）' if e[4] else ''))
                self.tl.itemconfig('end', fg=FG if e[1] in ('打出', '展示') else DIM)
                self.tl_rows.append(e)
        self.tl.see('end')

    def on_select(self, lb, rows):
        sel = lb.curselection()
        e = rows[sel[0]] if sel and sel[0] < len(rows) else None
        c = self.cards.get(e[3]) if e else None
        if c:
            self.detail.config(text=f"{c['name']}（{FAC_CN.get(c['fac'], c['fac'])} {c['color']} {c['type']} {c['prov']}费）\n{c['text']}")

    # ---------- 按钮 ----------
    def export_code(self):
        if not self.bw.m:
            self.set_status('场面扫描还没启动')
            return
        game = self.bw.export(time.strftime('%Y%m%d'), deck.load(self.args.deck, self.m.cards))
        gp = os.path.join(self.dir, 'game.json')
        with open(gp, 'w', encoding='utf-8') as f:
            json.dump(game, f, ensure_ascii=False, indent=1)
        try:
            code = export.to_v2(gp)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror('导出失败', str(e))
            return
        with open(os.path.join(self.dir, 'game_v2.txt'), 'w', encoding='utf-8') as f:
            f.write(code)
        self.root.clipboard_clear()
        self.root.clipboard_append(code)
        self.set_status(f"已复制对局代码（{len(game['log'])} 条记录），到对局簿“导入对局”粘贴")

    def toggle_pause(self):
        p = not self.sw.paused
        self.sw.paused = self.bw.paused = p
        self.pause_btn.config(text='继续' if p else '暂停')
        self.set_status('已暂停' if p else '识别中')

    def grab_game(self):
        with MSS() as sct:
            area = game_area(sct, self.args) or pick_monitor(sct, 0)
            return grab(sct, area)

    def scan_grave(self):
        """打开墓场界面后点这个：截游戏画面，找出每张牌并识别。"""
        frame = self.grab_game()
        cards = detect.find_cards(frame)
        cnt = {}
        for *_, img in cards:
            res = self.m.match(img)
            n = res[0][2][0]['name'] if Matcher.confident(res, min_votes=6) else '？'
            cnt[n] = cnt.get(n, 0) + 1
        txt = '\n'.join(f'{n} ×{k}' if k > 1 else n for n, k in cnt.items()) or '没找到卡牌（先打开墓场界面）'
        messagebox.showinfo(f'墓场 {len(cards)} 张（只看得到当前一屏）', txt)

    def diagnose(self):
        """存一张游戏画面，显示检测值。"""
        frame = self.grab_game()
        path = os.path.join(self.dir, f"diag_{time.strftime('%H%M%S')}.png")
        cv2.imencode('.png', frame)[1].tofile(path)
        ent = timeline.scan_frame(self.m, frame)
        n = sum(len(v) for r, v in ent['rows'].items() if r != '手牌')
        self.set_status(f"画面 {frame.shape[1]}×{frame.shape[0]} 清晰度 {ent['sharp']:.0f} 总分 {ent['score']} "
                        f"场上 {n} 张；已存 {os.path.basename(path)}")

    def save(self):
        with open(os.path.join(self.dir, 'events.json'), 'w', encoding='utf-8') as f:
            json.dump(self.events, f, ensure_ascii=False, indent=0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--monitor', type=int, default=0)
    ap.add_argument('--no-hide', action='store_true')
    ap.add_argument('--save-frames', action='store_true')
    ap.add_argument('--no-sync', action='store_true', help='导出时不把画面读到的战力写成改战力记录（核查引擎规则时用）')
    ap.add_argument('--deck', default=None, help='我方卡组：卡组代码或对局簿备份路径（默认读 hud/deck.txt）')
    args = ap.parse_args()
    if not os.path.exists(os.path.join(HERE, 'cache', 'db.npz')):
        print('还没有特征库，先运行：python hud/build_db.py')
        return 1
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # 4K 缩放下截屏坐标用物理像素
    except Exception:  # noqa: BLE001
        pass
    timeline.DECK_SPEC = args.deck
    root = tk.Tk()
    App(root, args)
    root.mainloop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
