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


def joint_powers(cands, score):
    """每张牌的战力候选 + 右侧总分 → 每张牌的战力。
    一方所有单位战力之和应该等于这一方的总分：从每张牌的候选里各选一个、加起来等于总分、总误差最小（动态规划）。
    凑得上的一方标 ok（整方战力可信）；凑不上（有牌没认出、总分读错）就用各自误差最小的候选。
    返回 ({排: [战力或 None]}, {'对方': bool, '我方': bool})。"""
    pws, ok = {}, {}
    for side, total in (('对方', score[0] if score else None), ('我方', score[1] if score else None)):
        rows = [r for r in cands if r.startswith(side)]
        items = [(r, i, cl) for r in rows for i, cl in enumerate(cands[r])]
        for r in rows:
            pws[r] = [cl[0][0] if cl else None for cl in cands[r]]
        ok[side] = False
        if total is None or not items or any(not cl for _r, _i, cl in items) or total > 400:
            continue
        # dp: 和 -> (误差, 选择)
        dp = {0: (0.0, [])}
        for _r, _i, cl in items:
            nd = {}
            for s, (e, ch) in dp.items():
                for v, ev in cl:
                    s2 = s + v
                    if s2 > total:
                        continue
                    if s2 not in nd or e + ev < nd[s2][0]:
                        nd[s2] = (e + ev, ch + [v])
            dp = nd
        if total in dp:
            for (r, i, _cl), v in zip(items, dp[total][1]):
                pws[r][i] = v
            ok[side] = True
    return pws, ok


_MINE = {}
DECK_SPEC = None   # 卡组代码 / 文件路径；None = hud/deck.txt


def deck_tokens(cards, dk):
    """卡组里的牌（和它们生成的牌）卡面上点名的衍生牌，如“无畏者”布朗温。只认这些：同阵营 / 中立的衍生牌有几十张，
    卡图里常有和场面纹理凑巧对上的（古德伦·约斯多蒂尔误认在我方两排之间）。"""
    toks = [c for c in cards if c['set'] == 'token']
    texts = [c.get('text') or '' for c in cards if c['name'] in dk]
    out = set()
    while True:
        new = {c['name'] for c in toks if c['name'] not in out and any(c['name'] in t for t in texts)}
        if not new:
            return out
        out |= new
        texts = [c.get('text') or '' for c in toks if c['name'] in new]


def mine_matcher(m):
    """我方半场用的子库：hud/deck.txt 里的卡组 + 卡面点名的衍生牌。没有卡组返回 None（用全库）。"""
    if id(m) not in _MINE:
        import deck
        dk = deck.load(DECK_SPEC, m.cards)
        if not dk:
            _MINE[id(m)] = None
        else:
            names = set(dk) | deck_tokens(m.cards, dk)
            _MINE[id(m)] = m.subset(names)
    return _MINE[id(m)]


def shields_from_det(im, ent):
    """{排: [护盾 True/False/None]}，顺序和 ent['rows'] 一样（从左到右）。"""
    import layout
    L = layout.get(im)
    rows = {}
    for n, v, x, y, h in ent.get('det') or []:
        r = board.classify(L, x, y, h, v)
        if r and r != '手牌':
            rows.setdefault(r, []).append((x, y, h))
    return {r: [detect.shield(im, x, y, h) for x, y, h in sorted(cs)] for r, cs in rows.items()}


def scan_frame(m, im):
    import layout
    raw = []
    det = board.scan(m, im, detail=True, mine=mine_matcher(m), raw=raw)
    rows = board.names(m, {r: [c[:3] for c in cs] for r, cs in det.items()})
    score = reader().scores(im)
    cands = {}
    sh = {r: [detect.shield(im, x, y, h) for x, _a, _v, y, h in cs] for r, cs in det.items() if r != '手牌'}
    for r, cs in det.items():
        if r == '手牌':
            continue
        out = []
        for x, art, _v, y, h in cs:
            c = m.by_art[art][0]
            base = int(c['power']) if str(c['power']).isdigit() else None
            out.append(reader().power_cands(im, x, y, h, base) if c['type'] == '单位' else [(0, 0.0)])
        cands[r] = out
    pws, ok = joint_powers(cands, score)
    ent = {'rows': rows, 'pw': pws, 'pw_ok': ok, 'sharp': sharpness(im), 'show': None,
           'score': score, 'smin': layout.get(im)['sharp_min'], 'prof': layout.name(im), 'lead': reader().leader(im),
           'turn': reader().turn(im), 'cnt': reader().counts(im), 'det': raw, 'sh': sh,
           'v3': 1}  # v3：我方半场用卡组子库 + 游戏内卡图模板、按透视分排；det 是分排前的原始检测
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


def save_json(path, obj):
    """先写临时文件再替换，中途被打断也不会把缓存写坏。"""
    with open(path + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(path + '.tmp', path)


def scan_dir(m, d, jobs=1):
    import layout
    cache = os.path.join(d, 'scan.json')
    done = {}
    if os.path.exists(cache):
        with open(cache, encoding='utf-8') as f:
            done = json.load(f)
    frames = sorted(glob.glob(os.path.join(d, '*.jpg')) + glob.glob(os.path.join(d, '*.png')), key=frame_time)
    t0 = time.time()
    todo = [p for p in frames if 'v3' not in (done.get(os.path.basename(p)) or {})]
    if jobs > 1 and len(todo) > 20:
        import multiprocessing as mp
        with mp.Pool(jobs, _init_worker) as pool:
            for i, (k, ent) in enumerate(pool.imap_unordered(_scan_path, todo, chunksize=4)):
                done[k] = ent
                if (i + 1) % 100 == 0:
                    print(f'  扫描 {i + 1}/{len(todo)}  {(time.time() - t0) / (i + 1):.2f}s/帧', flush=True)
                    save_json(cache, done)
    for i, p in enumerate(frames):
        k = os.path.basename(p)
        ent = done.get(k)
        if ent is not None and 'v3' in ent:
            # 阈值按当前 layout（旧缓存没存画面比例：iPad 的旧阈值是 200）
            ent.setdefault('prof', '4:3' if ent.get('smin') == 200 else '16:9')
            ent['smin'] = layout.PROFILES[ent['prof']]['sharp_min']
            if 'sh' not in ent:
                # 旧缓存：按原始检测重新分排（和扫描时同一规则、同一顺序），补算每张场上牌的护盾
                im = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)
                ent['sh'] = shields_from_det(im, ent)
            if 'score' not in ent or 'lead' not in ent or 'turn' not in ent or 'cnt' not in ent:
                # 旧缓存：补读总分、领袖、回合、墓场 / 手牌数（很快）
                im = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)
                ent['cnt'] = reader().counts(im)
                ent['score'] = reader().scores(im)
                ent['lead'] = reader().leader(im)
                ent['turn'] = reader().turn(im)
            continue
        im = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)
        if ent is not None and False:  # （旧缓存格式不再兼容：没有战力的重扫）
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
            save_json(cache, done)
    save_json(cache, done)
    return [(frame_time(p), done[os.path.basename(p)]) for p in frames]


BOARD_ROWS = [r for r in board.ROW_KEYS if r != '手牌']
CARD_TYPE = {c['name']: c['type'] for c in Matcher.load_cards_static()}


class Tracker:
    """按“排 × 牌名”记张数，带迟滞：连续 IN_N 次多看到才算进场，连续 OUT_N 次（且至少 OUT_S 秒）少看到才算离场。
    一次扫描里一大半已知的牌同时不见（被窗口挡住、动画）先不算；ROUND_S 秒内出现过场画面 = 小局结束，清空；
    超过 ROUND_S 秒没有过场画面 = 真的离场，照常按迟滞记。
    展示框里认出的牌（对方刚打出）用来把对方的进场分成“打出”和“召唤/生成”。"""
    IN_N, OUT_N, OUT_S, ROUND_S, SHOW_S, REENTER_S = 2, 3, 2.5, 8.0, 10.0, 40.0

    def __init__(self):
        self.count = {}      # (排, 名) -> 张数
        self.more = {}       # (排, 名) -> (连续次数, 首次时间, 看到的张数)
        self.less = {}       # (排, 名) -> (连续次数, 首次时间, 看到的张数)
        self.vanish_since = None
        self.blur_seen, self.blur_t = False, None
        self.lead = {}
        self.last_score, self.zero_n, self.zero_t, self.score_run = None, 0, None, 0
        self.extra = {}      # (时间, 牌名, 排) -> {'pos': 排内第几个（从 0 数）, 'pw': 落地战力}
        self.cur = None
        self.shows = []      # [(时间, 名)] 还没对上进场的展示
        self.events = []     # [(时间, 类型, 方, 名, 排)]

    def emit(self, t, kind, row, name):
        self.events.append((t, kind, SIDES[row], name, row))
        if kind in ('打出', '进场') and self.cur and row in self.cur.get('rows', {}):
            names = self.cur['rows'][row]
            if name in names:
                i = len(names) - 1 - names[::-1].index(name)   # 同名取最右边那张（多半是新来的）
                pw = (self.cur.get('pw') or {}).get(row) or []
                self.extra[(t, name, row)] = {'pos': i, 'pw': pw[i] if i < len(pw) else None}

    def update(self, t, ent):
        self.cur = ent
        if ent.get('show') and (not self.shows or self.shows[-1][1] != ent['show'] or t - self.shows[-1][0] > 3):
            self.shows.append((t, ent['show']))
        sc = ent.get('score') or (None, None)
        if ent['sharp'] >= ent.get('smin', 300) and sc[0] is not None and sc[1] is not None:
            self.update_leader(t, ent.get('lead') or (None, None))
            # 双方总分从大于 0 回到 0:0（连续两帧）= 新小局开始（场上牌少时“一大半消失”的规则触发不了）
            if sc[0] == 0 and sc[1] == 0 and self.last_score and sum(self.last_score) >= 5 and self.score_run >= 3                     and not any(e[1] == '小局结束' and t - e[0] < 60 for e in self.events):
                self.zero_n += 1
                if self.zero_n >= 2:
                    if not any(e[1] == '小局结束' and t - e[0] < 30 for e in self.events):
                        self.events.append((self.zero_t, '小局结束', '', '', ''))
                        self.count = {k: c for k, c in self.count.items() if k[0] == '手牌'}
                        self.more, self.less, self.vanish_since = {}, {}, None
                    self.last_score, self.zero_n = (0, 0), 0
            else:
                if self.zero_n == 0:
                    self.zero_t = t
                self.zero_n = 0 if (sc[0], sc[1]) != (0, 0) else self.zero_n
                if (sc[0], sc[1]) != (0, 0):
                    self.score_run = self.score_run + 1 if (sc[0], sc[1]) == self.last_score else 1
                    self.last_score = (sc[0], sc[1])
            if (sc[0], sc[1]) == (0, 0) and self.zero_n == 1:
                self.zero_t = self.zero_t or t
        if ent['sharp'] < ent.get('smin', 300) or sc[0] is None or sc[1] is None:
            # 调度、墓场、选牌、过场画面（背景模糊、右侧没有总分），或开局前的界面：不看
            if not self.blur_seen:
                self.blur_t = t
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
            # 过场画面要在消失后 ROUND_S 秒内出现才算小局结束；一直没有，就是真的离场（场上 3 张被解掉 2 张），照常记
            if self.vanish_since is None:
                self.vanish_since, self.blur_seen = t, False
            if self.blur_seen and self.blur_t - self.vanish_since <= self.ROUND_S:
                self.events.append((self.vanish_since, '小局结束', '', '', ''))
                self.count = {k: c for k, c in self.count.items() if k[0] == '手牌'}
                self.more, self.less, self.vanish_since = {}, {}, None
                return
            if t - self.vanish_since <= self.ROUND_S:
                return
        else:
            self.vanish_since = None
        # 这一帧没看到的牌，之前攒的“多看到”作废（否则隔几十秒的两次零星误认会凑成“连续两次”）
        for k in [k for k in self.more if k not in obs]:
            self.more.pop(k)
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

    # 领袖剩余次数：读数稳定下降 = 用了；标牌消失很久 = 用完了（我方标牌用完就消失；对方的时隐时现，要等更久）
    # 对方的次数标牌只在对方回合显示，所以对方只看读数下降（最后一次用完看不出来）
    LEAD_RUN, LEAD_GONE = 3, {'我方': 8, '对方': 10 ** 9}

    def update_leader(self, t, vals):
        for side, v in zip(('对方', '我方'), vals):
            st = self.lead.setdefault(side, {'n': None, 'val': None, 'run': 0, 'gone': 0, 't': t})
            if v is None:
                st['gone'] += 1
                st['run'], st['val'] = 0, None
                if st['n'] and st['gone'] >= self.LEAD_GONE[side]:
                    for _ in range(st['n']):
                        self.events.append((st['t'], '领袖', side, '', ''))
                    st['n'] = 0
                continue
            if st['gone']:
                st['t'] = t
            st['gone'] = 0
            if v > 9:
                continue  # 读错（领袖次数都是个位数）
            st['run'] = st['run'] + 1 if v == st['val'] else 1
            if v != st['val']:
                st['t'] = t
            st['val'] = v
            if st['run'] >= self.LEAD_RUN:
                if st['n'] is None or (v == st['n'] + 1 and side == '我方'):
                    st['n'] = v            # 第一次读到，或次数恢复 1（皇家激励刷新等）
                elif v < st['n']:
                    for _ in range(st['n'] - v):
                        self.events.append((st['t'], '领袖', side, '', ''))
                    st['n'] = v

    def enter(self, t, k):
        row, name = k
        side = SIDES[row]
        # 同一排的同名牌离场后不久又出现：多半是识别闪烁（画面糊、被挡），撤销那次离场
        # ——除非展示框刚看到对方打出这张牌（真的又打了一张）
        shown = side == '对方' and any(s[1] == name and -3 <= t - s[0] <= self.SHOW_S for s in self.shows)
        for i in range(len(self.events) - 1 if not shown else -1, -1, -1):
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
                self.emit(t, '打出', row, name)  # 用落地时间（展示比落地早，AI 还要选目标）
                return
        self.emit(t, '进场', row, name)

    def leave(self, t, k):
        row, name = k
        if row == '手牌':
            self.emit(t, '离手', row, name)
            return
        self.emit(t, '离场', row, name)

    def snapshot(self, transient=8.0):
        """当前时间线（不改内部状态，实时显示用）：没落到场上的展示记为“展示”；进场后几秒内就离场 / 回手的去掉。"""
        ev = sorted(self.events + [(t, '展示', '对方', n, '') for t, n in self.shows], key=lambda e: e[0])
        drop = set()
        for i, e in enumerate(ev):
            if e[1] not in ('进场', '抽到') or i in drop:
                continue
            # 进场后几秒就离场 / 回到手牌：拖动、悬停的手牌，或识别闪烁
            out = ('离场', '回手') if e[1] == '进场' else ('离手',)
            j = next((j for j in range(i + 1, len(ev)) if j not in drop and ev[j][1] in out
                      and ev[j][2:] == e[2:] and ev[j][0] - e[0] < transient), None)
            if j is not None:
                drop |= {i, j}
        return [e for i, e in enumerate(ev) if i not in drop]

    def finish(self, transient=8.0):
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
