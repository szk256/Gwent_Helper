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
    一方所有单位战力之和应该等于这一方的总分。读数本身已经比较准（2026-10-01 评估 97%），所以只做保守的纠错：
    第一候选加起来正好等于总分 → 可信（ok）；只改一张牌、换成它的备选读数（误差多不超过 0.1）就能凑上、而且这种改法只有一种 → 改它；
    其他情况（有牌没认出、总分里有别的来源）保留第一候选，不硬凑（以前用动态规划硬凑，会把读对的 20 改成 38）。
    返回 ({排: [战力或 None]}, {'对方': bool, '我方': bool})。"""
    pws, ok = {}, {}
    for side, total in (('对方', score[0] if score else None), ('我方', score[1] if score else None)):
        rows = [r for r in cands if r.startswith(side)]
        items = [(r, i, cl) for r in rows for i, cl in enumerate(cands[r])]
        for r in rows:
            pws[r] = [cl[0][0] if cl else None for cl in cands[r]]
        ok[side] = False
        if total is None or not items or any(not cl for _r, _i, cl in items):
            continue
        s1 = sum(cl[0][0] for _r, _i, cl in items)
        if s1 == total:
            ok[side] = True
            continue
        fixes = [(r, i, v) for r, i, cl in items for v, ev in cl[1:]
                 if ev <= cl[0][1] + 0.1 and s1 - cl[0][0] + v == total]
        if len(fixes) == 1:
            r, i, v = fixes[0]
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


CLS_VER = 11   # 分排规则（board.classify）、总分、战力、护盾读法的版本：变了就从缓存的原始检测重新算，不用重新认牌


HAND_MIN_V = 6   # 手牌区检测至少这么多票（假检测 4–5 票；真手牌低于 6 票的不到 5%，靠迟滞照样认得出）


def derive(im, ent):
    """从原始检测（ent['det']）按当前 board.classify 分排，读每张场上牌的战力（和总分一起纠错）、护盾。"""
    import layout
    L = layout.get(im)
    rows = {r: [] for r in board.ROW_KEYS}
    for n, v, x, y, h in ent.get('det') or []:
        r = board.classify(L, x, y, h, v)
        if r == '手牌' and v < HAND_MIN_V:
            continue   # 手牌区只有几个特征点的是假检测（手牌上方空地、悬停说明框；2026-10-01 一局“滚油”100 帧，真手牌中位数 36 票）
        if r:
            rows[r].append((x, n, y, h))
    for cs in rows.values():
        cs.sort()
    cands, sh = {}, {}
    for r, cs in rows.items():
        if r == '手牌':
            continue
        out = []
        hs = board.row_heights(L, [(x, y, h) for x, _n, y, h in cs])   # 同排牌高（截战力 / 护盾的框）
        for (x, n, y, _h), h in zip(cs, hs):
            c = CARDS.get(n, {})
            base = int(c['power']) if str(c.get('power')).isdigit() else None
            out.append(reader().power_cands(im, x, y, h, base) if c.get('type') == '单位' else [(0, 0.0)])
        cands[r] = out
        sh[r] = [detect.shield(im, x, y, h) for (x, _n, y, _h), h in zip(cs, hs)]
    ent['rows'] = {r: [n for _x, n, _y, _h in cs] for r, cs in rows.items()}
    ent['pw'], ent['pw_ok'] = joint_powers(cands, ent.get('score'))
    ent['sh'] = sh
    ent['cls'] = CLS_VER
    return ent


def scan_frame(m, im):
    import layout
    raw = []
    board.scan(m, im, detail=True, mine=mine_matcher(m), raw=raw)
    ent = {'sharp': sharpness(im), 'show': None,
           'score': reader().scores(im), 'smin': layout.get(im)['sharp_min'], 'prof': layout.name(im),
           'lead': reader().leader(im), 'turn': reader().turn(im), 'cnt': reader().counts(im), 'det': raw,
           'lglow': detect.leader_glow(im), 'panel': detect.panel_ratio(im),
           'v3': 1}  # v3：我方半场用卡组子库 + 游戏内卡图模板；det 是分排前的原始检测
    derive(im, ent)
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
            if ent.get('cls') != CLS_VER or 'lglow' not in ent:
                # 分排规则改过：按原始检测重新分排、读战力和护盾；补领袖图标的光
                im = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)
                ent['score'] = reader().scores(im)   # 总分模板改过（9：总分专用模板）；战力纠错要用总分，先读
                derive(im, ent)
                ent['lglow'] = detect.leader_glow(im)
                ent['panel'] = detect.panel_ratio(im)
                ent['cnt'] = reader().counts(im)   # 读数字的规则也可能改了（手牌数“10/10”）
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
    # 看牌的大说明面板挡住了场面（里面的衍生牌小图会被认成场上的牌）：这些帧当没录到
    return fill_gaps([(frame_time(p), done[os.path.basename(p)]) for p in frames
                      if done[os.path.basename(p)].get('panel', 0) <= PANEL_MAX])


BOARD_ROWS = [r for r in board.ROW_KEYS if r != '手牌']
PANEL_MAX = 0.25   # detect.panel_ratio 超过这个 = 看牌的大说明面板


FILL_MIN = 2
OTHER_ROW = {'对方远程': '对方近战', '对方近战': '对方远程', '我方近战': '我方远程', '我方远程': '我方近战'}


def fill_gaps(states, gap=4.0):
    """位置延续：前 gap 秒内和后 gap 秒内（正常对局画面）同一排都认出过某张牌、这一帧却少了，补上（战力、护盾留空）。
    漏认几乎都是动画 / 遮挡的瞬间——神赐增益的白光、锤子、选目标的准星、悬停说明框、“己方回合”横幅、选目标时整排变暗，
    牌面被盖住，认不出来（2026-10-01 真人局人工看过），常常连着好几帧。补上后逐帧的排、战力同步、目标推断能对齐。原数据（det）不动。"""
    ok = [i for i, (_t, e) in enumerate(states)
          if e.get('sharp', 0) >= e.get('smin', 40) and None not in (e.get('score') or [None]) and e.get('rows')]
    orig = {i: {r: list(states[i][1]['rows'].get(r, [])) for r in BOARD_ROWS} for i in ok}
    for j, i in enumerate(ok):
        t, e = states[i]
        before = [orig[ok[a]] for a in range(j - 1, -1, -1) if t - states[ok[a]][0] <= gap]
        after = [orig[ok[a]] for a in range(j + 1, len(ok)) if states[ok[a]][0] - t <= gap]
        if not before or not after:
            continue
        for r in BOARD_ROWS:
            cur = list(e['rows'].get(r, []))
            names = dict.fromkeys(n for fr in before for n in fr[r])
            add = []
            for nm in names:
                # 前后各至少 FILL_MIN 帧看到这么多张（偶尔一帧的误认不延续）
                kb = sorted((fr[r].count(nm) for fr in before), reverse=True)
                ka = sorted((fr[r].count(nm) for fr in after), reverse=True)
                if len(kb) < FILL_MIN or len(ka) < FILL_MIN:
                    continue
                other = OTHER_ROW[r]   # 前后窗口里同一方另一排也出现过这张牌：可能在换排（猫学派猎魔人），不补
                if any(nm in fr[other] for fr in before + after) or nm in e['rows'].get(other, []):
                    continue
                k = min(kb[FILL_MIN - 1], ka[FILL_MIN - 1]) - cur.count(nm)
                add += [nm] * max(0, k)
            if not add:
                continue
            ref = next(fr[r] for fr in before if any(nm in fr[r] for nm in add))   # 最近一帧里的位置
            pw = list((e.get('pw') or {}).get(r, []))
            sh = list((e.get('sh') or {}).get(r, []))
            pw += [None] * (len(cur) - len(pw))
            sh += [None] * (len(cur) - len(sh))
            for nm in add:   # 按前面帧里的位置插回去
                pos = ref.index(nm) if nm in ref else len(ref)
                prev_names = [x for x in ref[:pos] if x in cur]
                at = (max(i2 for i2, x in enumerate(cur) if x == prev_names[-1]) + 1) if prev_names else 0
                cur.insert(at, nm)
                pw.insert(at, None)
                sh.insert(at, None)
            e['rows'] = dict(e['rows'], **{r: cur})
            e['pw'] = dict(e.get('pw') or {}, **{r: pw})
            e['sh'] = dict(e.get('sh') or {}, **{r: sh})
            e['filled'] = True
    return states
CARDS = {c['name']: c for c in Matcher.load_cards_static()}
CARD_TYPE = {c['name']: c['type'] for c in Matcher.load_cards_static()}


class Tracker:
    """按“排 × 牌名”记张数，带迟滞：连续 IN_N 次多看到才算进场，连续 OUT_N 次（且至少 OUT_S 秒）少看到才算离场。
    一次扫描里一大半已知的牌同时不见（被窗口挡住、动画）先不算；ROUND_S 秒内出现过场画面 = 小局结束，清空；
    超过 ROUND_S 秒没有过场画面 = 真的离场，照常按迟滞记。
    展示框里认出的牌（对方刚打出）用来把对方的进场分成“打出”和“召唤/生成”。"""
    IN_N, OUT_N, OUT_S, ROUND_S, SHOW_S, REENTER_S, MOVE_S = 2, 3, 2.5, 8.0, 10.0, 40.0, 4.0

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
            self.update_glow(t, ent.get('lglow'))
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
        for k in sorted(set(obs) | set(self.count)):   # 固定顺序：集合的顺序每次运行不同，同一时刻的事件先后会变
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

    # 我方领袖图标的黄光（已点选、正在找目标）：一段黄光 = 一次点选。只按次数记领袖；
    # 次数没变的点选（皇家激励触发神赐会重置次数、增益 -1，次数一直是 1；或者取消了）记成“领袖?”，导出进待确认清单
    GLOW_GAP = 2.0

    def update_glow(self, t, g):
        eps = self.__dict__.setdefault('glow_eps', [])
        if g == 'Y':
            if eps and t - eps[-1][1] <= self.GLOW_GAP:
                eps[-1][1] = t
            else:
                eps.append([t, t])

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
        ev = [e for i, e in enumerate(ev) if i not in drop]
        # 换排：同一方同名牌 MOVE_S 秒内一离一进、排不同 = 移动（进场确认得比离场快，enter 里按“先离后进”合并不到）
        out, used = [], set()
        for i, e in enumerate(ev):
            if i in used:
                continue
            if e[1] in ('进场', '离场') and e[4] in BOARD_ROWS:
                other = '离场' if e[1] == '进场' else '进场'
                j = next((j for j in range(i + 1, len(ev)) if j not in used and ev[j][0] - e[0] <= self.MOVE_S
                          and ev[j][1] == other and ev[j][2:4] == e[2:4] and ev[j][4] in BOARD_ROWS and ev[j][4] != e[4]),
                         None)
                if j is not None:
                    used.add(j)
                    src, dst = (ev[j][4], e[4]) if e[1] == '进场' else (e[4], ev[j][4])
                    out.append((e[0], '移动', e[2], e[3], f'{src}→{dst}'))
                    continue
            out.append(e)
        return out

    def finish(self, transient=8.0):
        self.events = self.snapshot(transient)
        eps = self.__dict__.get('glow_eps', [])
        used = set()
        for e in self.events:   # 每次按次数记到的领袖，配它之前最近的一段黄光
            if e[1] == '领袖' and e[2] == '我方':
                j = max((j for j, (t0, t1) in enumerate(eps) if j not in used and t0 <= e[0] + 1 and e[0] - t1 <= 12),
                        default=None, key=lambda j: eps[j][0])
                if j is not None:
                    used.add(j)
        for j, (t0, _t1) in enumerate(eps):
            if j not in used:
                self.events.append((t0, '领袖?', '我方', '', ''))
        self.events.sort(key=lambda e: e[0])
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
