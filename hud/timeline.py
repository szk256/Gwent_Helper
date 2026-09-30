"""把一串画面（录像帧）变成场面时间线：逐帧扫描场面，稳定后和上一个场面比较，推出进场 / 离场 / 移动。

python hud/timeline.py 帧目录 [日期YYYYMMDD] [--jobs=4] [--hand]   帧文件名以 HHMMSS 开头（record.py 录的）
扫描结果缓存在 帧目录/scan.json，重跑只做比较。
"""
import collections
import glob
import json
import os
import re
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import board  # noqa: E402
import detect  # noqa: E402
from matcher import Matcher  # noqa: E402

SIDES = {'对方远程': '对方', '对方近战': '对方', '我方近战': '我方', '我方远程': '我方', '手牌': '我方'}


def frame_time(path):
    m = re.match(r'(\d\d)(\d\d)(\d\d)(?:_(\d+))?', os.path.basename(path))
    h, mi, s, frac = m.groups()
    return int(h) * 3600 + int(mi) * 60 + int(s) + (int(frac) / 10 ** len(frac) if frac else 0)


def hms(t):
    return time.strftime('%H:%M:%S', time.gmtime(t))


def sharpness(im):
    """左侧场景的清晰度：正常对局约 1000；调度、墓场、过场画面是模糊的暗背景，接近 0。"""
    import layout
    H, W = im.shape[:2]
    x0, y0, x1, y1 = layout.get(im)['sharp']
    g = cv2.cvtColor(im[int(y0 * H):int(y1 * H), int(x0 * W):int(x1 * W)], cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(g, cv2.CV_32F).var())


_READER = None


def reader():
    global _READER
    if _READER is None:
        import digits
        _READER = digits.Reader()
    return _READER


def scan_frame(m, im):
    import layout
    ent = {'rows': board.names(m, board.scan(m, im)), 'sharp': sharpness(im), 'show': None,
           'score': reader().scores(im), 'smin': layout.get(im)['sharp_min']}
    sc = detect.showcase(im)
    if sc is not None:
        res = m.match(sc)
        if Matcher.confident(res):
            ent['show'] = res[0][2][0]['name']
    return ent


_W = None


def _init_worker():
    global _W
    _W = Matcher()


def _scan_path(p):
    im = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)
    return os.path.basename(p), scan_frame(_W, im)


def scan_dir(m, d, jobs=1):
    cache = os.path.join(d, 'scan.json')
    done = {}
    if os.path.exists(cache):
        with open(cache, encoding='utf-8') as f:
            done = json.load(f)
    frames = sorted(glob.glob(os.path.join(d, '*.jpg')) + glob.glob(os.path.join(d, '*.png')), key=frame_time)
    t0 = time.time()
    todo = [p for p in frames if 'rows' not in (done.get(os.path.basename(p)) or {})]
    if jobs > 1 and len(todo) > 20:
        import multiprocessing as mp
        with mp.Pool(jobs, _init_worker) as pool:
            for i, (k, ent) in enumerate(pool.imap_unordered(_scan_path, todo, chunksize=4)):
                done[k] = ent
                if (i + 1) % 100 == 0:
                    print(f'  扫描 {i + 1}/{len(todo)}  {(time.time() - t0) / (i + 1):.2f}s/帧', flush=True)
                    with open(cache, 'w', encoding='utf-8') as f:
                        json.dump(done, f, ensure_ascii=False)
    for i, p in enumerate(frames):
        k = os.path.basename(p)
        ent = done.get(k)
        if ent is not None and 'rows' in ent:
            if 'score' not in ent:  # 旧缓存：补读总分（很快）
                ent['score'] = reader().scores(cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR))
            continue
        im = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)
        if ent is not None:  # 旧缓存只有各排牌名：补上清晰度和展示
            e2 = {'rows': ent, 'sharp': sharpness(im), 'show': None}
            sc = detect.showcase(im)
            if sc is not None:
                res = m.match(sc)
                if Matcher.confident(res):
                    e2['show'] = res[0][2][0]['name']
            done[k] = e2
        else:
            done[k] = scan_frame(m, im)
        if (i + 1) % 50 == 0:
            print(f'  扫描 {i + 1}/{len(frames)}  {(time.time() - t0) / (i + 1):.2f}s/帧', flush=True)
            with open(cache, 'w', encoding='utf-8') as f:
                json.dump(done, f, ensure_ascii=False)
    with open(cache, 'w', encoding='utf-8') as f:
        json.dump(done, f, ensure_ascii=False)
    return [(frame_time(p), done[os.path.basename(p)]) for p in frames]


BOARD_ROWS = [r for r in board.ROW_KEYS if r != '手牌']
CARD_TYPE = {c['name']: c['type'] for c in Matcher.load_cards_static()}


class Tracker:
    """按“排 × 牌名”记张数，带迟滞：连续 IN_N 次多看到才算进场，连续 OUT_N 次（且至少 OUT_S 秒）少看到才算离场。
    一次扫描里一大半已知的牌同时不见（被窗口挡住、动画）不算；持续 ROUND_S 秒都这样 = 小局结束，清空。
    展示框里认出的牌（对方刚打出）用来把对方的进场分成“打出”和“召唤/生成”。"""
    IN_N, OUT_N, OUT_S, ROUND_S, SHOW_S, REENTER_S = 2, 3, 2.5, 8.0, 10.0, 40.0

    def __init__(self):
        self.count = {}      # (排, 名) -> 张数
        self.more = {}       # (排, 名) -> (连续次数, 首次时间, 看到的张数)
        self.less = {}       # (排, 名) -> (连续次数, 首次时间, 看到的张数)
        self.vanish_since = None
        self.blur_seen = False
        self.shows = []      # [(时间, 名)] 还没对上进场的展示
        self.events = []     # [(时间, 类型, 方, 名, 排)]

    def emit(self, t, kind, row, name):
        self.events.append((t, kind, SIDES[row], name, row))

    def update(self, t, ent):
        if ent.get('show') and (not self.shows or self.shows[-1][1] != ent['show'] or t - self.shows[-1][0] > 3):
            self.shows.append((t, ent['show']))
        sc = ent.get('score') or (None, None)
        if ent['sharp'] < ent.get('smin', 300) or sc[0] is None or sc[1] is None:
            # 调度、墓场、选牌、过场画面（背景模糊、右侧没有总分），或开局前的界面：不看
            self.blur_seen = True
            return
        obs = {}
        for r in board.ROW_KEYS:
            for n in ent['rows'].get(r, []):
                obs[(r, n)] = obs.get((r, n), 0) + 1
        # 场上出现特殊牌 = 不是正常对局画面（发牌、选牌界面等），不看
        if any(r != '手牌' and CARD_TYPE.get(n) == '特殊' for r, n in obs):
            return
        total = sum(c for k, c in self.count.items() if k[0] != '手牌')
        missing = sum(max(0, c - obs.get(k, 0)) for k, c in self.count.items() if k[0] != '手牌')
        if total >= 3 and missing > total / 2:
            # 一大半场上的牌同时不见：被窗口挡住（不算），或小局结束（中间会有模糊的过场画面）
            if self.vanish_since is None:
                self.vanish_since, self.blur_seen = t, False
            if self.blur_seen:
                self.events.append((self.vanish_since, '小局结束', '', '', ''))
                self.count = {k: c for k, c in self.count.items() if k[0] == '手牌'}
                self.more, self.less, self.vanish_since = {}, {}, None
            return
        self.vanish_since = None
        for k in set(obs) | set(self.count):
            o, c = obs.get(k, 0), self.count.get(k, 0)
            if o > c:
                self.less.pop(k, None)
                n, t0, _ = self.more.get(k, (0, t, o))
                self.more[k] = (n + 1, t0, o)
                if n + 1 >= self.IN_N:
                    for _ in range(o - c):
                        self.enter(t0, k)
                    self.count[k] = o
                    self.more.pop(k)
            elif o < c:
                self.more.pop(k, None)
                n, t0, _ = self.less.get(k, (0, t, o))
                self.less[k] = (n + 1, t0, o)
                if n + 1 >= self.OUT_N and t - t0 >= self.OUT_S:
                    for _ in range(c - o):
                        self.leave(t0, k)
                    self.count[k] = o
                    if not o:
                        self.count.pop(k)
                    self.less.pop(k)
            else:
                self.more.pop(k, None)
                self.less.pop(k, None)

    def enter(self, t, k):
        row, name = k
        side = SIDES[row]
        # 同一排的同名牌离场后不久又出现：多半是识别闪烁（画面糊、被挡），撤销那次离场
        for i in range(len(self.events) - 1, -1, -1):
            e = self.events[i]
            if t - e[0] > self.REENTER_S:
                break
            if e[1] in ('离场', '离手') and e[2] == side and e[3] == name and e[4] == row:
                del self.events[i]
                return
        # 同一方同名牌刚从另一排离场 = 移动
        for i in range(len(self.events) - 1, -1, -1):
            e = self.events[i]
            if t - e[0] > 4:
                break
            if e[1] == '离场' and e[2] == side and e[3] == name and e[4] != row:
                if row == '手牌':  # 从场上回到手牌
                    self.events[i] = (e[0], '回手', side, name, e[4])
                    return
                self.events[i] = (e[0], '移动', side, name, f'{e[4]}→{row}')
                return
        if row == '手牌':
            self.emit(t, '抽到', row, name)
            return
        if side == '我方':  # 手牌里刚少了一张同名牌 = 从手牌打出
            for i in range(len(self.events) - 1, -1, -1):
                e = self.events[i]
                if t - e[0] > 6:
                    break
                if e[1] == '离手' and e[3] == name:
                    del self.events[i]
                    self.emit(t, '打出', row, name)
                    return
        if side == '对方':
            s = next((s for s in self.shows if s[1] == name and -3 <= t - s[0] <= self.SHOW_S), None)
            if s:
                self.shows.remove(s)
                self.emit(s[0], '打出', row, name)
                return
        self.emit(t, '进场', row, name)

    def leave(self, t, k):
        row, name = k
        if row == '手牌':
            self.emit(t, '离手', row, name)
            return
        self.emit(t, '离场', row, name)

    def snapshot(self, transient=5.0):
        """当前时间线（不改内部状态，实时显示用）：没落到场上的展示记为“展示”；进场后几秒内就离场的去掉。"""
        ev = sorted(self.events + [(t, '展示', '对方', n, '') for t, n in self.shows], key=lambda e: e[0])
        drop = set()
        for i, e in enumerate(ev):
            if e[1] not in ('进场', '抽到') or i in drop:
                continue
            out = '离场' if e[1] == '进场' else '离手'
            j = next((j for j in range(i + 1, len(ev)) if j not in drop and ev[j][1] == out
                      and ev[j][2:] == e[2:] and ev[j][0] - e[0] < transient), None)
            if j is not None:
                drop |= {i, j}
        return [e for i, e in enumerate(ev) if i not in drop]

    def finish(self, transient=5.0):
        self.events = self.snapshot(transient)
        self.shows = []
        return self.events


def ai_plays(t0, t1, day):
    by_id = {c['id']: c['name'] for c in Matcher.load_cards_static() if c.get('id')}
    plays = []
    for p in glob.glob(os.path.expandvars(rf'%USERPROFILE%\AppData\LocalLow\CDProjektRED\Gwent\GwentClient-{day}*.log')):
        with open(p, encoding='utf-8', errors='replace') as f:
            for line in f:
                mt = re.match(r'(\d\d):(\d\d):(\d\d\.\d+).*Playing card: \[T:(.*?), ID:(\d+)', line)
                if mt:
                    t = int(mt.group(1)) * 3600 + int(mt.group(2)) * 60 + float(mt.group(3))
                    if t0 - 5 <= t <= t1 + 5:
                        plays.append((t, by_id.get(int(mt.group(5)), mt.group(4))))
    return sorted(plays)


def main():
    d = sys.argv[1]
    jobs = next((int(a[7:]) for a in sys.argv if a.startswith('--jobs=')), 1)
    m = Matcher()
    states = scan_dir(m, d, jobs)
    tr = Tracker()
    for t, ent in states:
        tr.update(t, ent)
    events = tr.finish()
    for t, kind, side, name, row in events:
        if row == '手牌' and '--hand' not in sys.argv:
            continue
        print(hms(t), kind, side, name, row)
    day = next((a for a in sys.argv[2:] if a.isdigit()), time.strftime('%Y%m%d'))
    plays = ai_plays(states[0][0], states[-1][0], day)
    if plays:
        opp = [(t, n, k) for t, k, side, n, r in events if side == '对方' and k in ('打出', '进场', '展示')]
        used, hit = set(), 0
        print(f'\n核对 AI 出牌（游戏日志 {len(plays)} 张）：')
        for t, n in plays:
            j = next((j for j, (t2, n2, _k) in enumerate(opp) if j not in used and n2 == n and -2 <= t2 - t <= 15), None)
            if j is None:
                print(f'  没看到  {hms(t)} {n}')
            else:
                used.add(j)
                hit += 1
        extra = [opp[j] for j in range(len(opp)) if j not in used]
        print(f'  对上 {hit}/{len(plays)}；对方其他进场 {len(extra)} 次：' + '、'.join(f'{n}({k})' for _t, n, k in extra))


if __name__ == '__main__':
    main()
