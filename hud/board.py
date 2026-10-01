"""扫描整个场面：双方四排 + 我方手牌，每排从左到右列出认出的牌。

不先切牌：整块画面找特征点、按卡图投票，再按位置聚成一张张牌（相邻同名牌按宽度拆开），按高度分排。
棋盘会随状态（选中手牌、瞄准）上下移动约 0.05 屏高，排的分界取录像里各层之间的空隙。
"""
import cv2
import numpy as np

import detect
import layout

# 排的分界（画面高度比例）：录像统计出的 5 层——对方远程 ~0.20、对方近战 ~0.34、我方近战 ~0.53、我方远程 ~0.72、手牌 ≥0.85
ROWS = [('对方远程', 0.00, 0.27), ('对方近战', 0.27, 0.44), ('我方近战', 0.44, 0.645), ('我方远程', 0.645, 0.815),
        ('手牌', 0.815, 1.01)]
ROW_KEYS = [r[0] for r in ROWS]
CARD_W = 0.066   # 场上牌宽（画面宽度比例）
HAND_W = 0.058   # 手牌露出来的宽度（扇形叠放，约为牌宽的一半多）


def row_of(y):
    for name, y0, y1 in ROWS:
        if y0 <= y < y1:
            return name
    return None


def _split(xs, ys, cw, min_votes):
    """一堆同一卡图的特征点 → 一张或几张牌的位置。"""
    order = np.argsort(xs)
    xs, ys = xs[order], ys[order]
    out = []
    start = 0
    for i in range(1, len(xs) + 1):
        if i == len(xs) or xs[i] - xs[i - 1] > cw * 0.5:
            gx, gy = xs[start:i], ys[start:i]
            start = i
            if len(gx) < min_votes:
                continue
            n = max(1, round((np.percentile(gx, 95) - np.percentile(gx, 5)) / cw + 0.15))
            edges = np.linspace(gx.min(), gx.max() + 1e-6, n + 1)
            for j in range(n):
                sel = (gx >= edges[j]) & (gx < edges[j + 1])
                if sel.sum() >= min_votes:
                    out.append((int(sel.sum()), float(np.median(gx[sel])), float(np.median(gy[sel]))))
    return out


HAND_H = 0.225  # 牌高（画面高度比例）超过这个算手牌：场上 0.15–0.21，手牌 0.23–0.31
# 场上牌中心的排分界（画面高度比例）：对方远程 ~0.20、对方近战 ~0.35–0.39、我方近战 ~0.53–0.58、我方远程 ~0.72–0.78
ROW_CY = [('对方远程', 0.28), ('对方近战', 0.46), ('我方近战', 0.65), ('我方远程', 9)]


def _cluster(a, min_votes):
    """a: [[cx, cy, h]]（同一卡图的中心估计）→ [(票数, cx, cy, h)]，每个簇是一张牌。"""
    out = []
    left = np.ones(len(a), bool)
    while left.sum() >= min_votes:
        idx = np.flatnonzero(left)
        p = a[idx]
        r = 0.22 * np.median(p[:, 2])
        # 两两距离是 n²：点特别多时（大图、选牌界面）只在抽样的点里找最密的中心，再按它收全部的点
        q = p if len(p) <= 1500 else p[np.random.default_rng(0).choice(len(p), 1500, replace=False)]
        d2 = (q[:, None, 0] - q[None, :, 0]) ** 2 + (q[:, None, 1] - q[None, :, 1]) ** 2
        best = q[(d2 < r * r).sum(1).argmax()]
        mem = idx[(p[:, 0] - best[0]) ** 2 + (p[:, 1] - best[1]) ** 2 < r * r]
        if len(mem) < min_votes:
            break
        c = np.median(a[mem], 0)
        out.append((len(mem), float(c[0]), float(c[1]), float(c[2])))
        # 这张牌范围内的点都去掉（同一张牌里偶尔有偏得较远的估计）
        dd = (a[:, 0] - c[0]) ** 2 + (a[:, 1] - c[1]) ** 2
        left &= ~(dd < (0.3 * c[2]) ** 2)
        left[mem] = False   # 簇里的点估出的牌高接近 0 时上面一个都去不掉，会死循环
    return out


WEAK_V, WEAK_R = 6, 0.15


def classify(L, x, y, h, votes):
    """一张认出的牌（中心 x、y，高度 h，画面比例；票数）→ 排名，None = 丢掉。
    有 board_h（电脑）时按这个位置的场上牌高判断是不是手牌，否则按固定的 hand_h。"""
    if h > L.get('max_h', 9):
        return None
    if y >= L['hand_y']:
        return '手牌'
    if 'board_h' in L:
        y0, h0, k = L['board_h']
        hb = h0 + k * (y - y0)
        if h >= L['board_ratio'] * hb:
            return '手牌'
        if h < L['board_min'] * hb:
            return None   # 比场上的牌还小得多：几个零散特征点凑出来的
    elif h >= L['hand_h']:
        return '手牌'
    return next(r for r, lim in L['row_cy'] if y < lim)


def scan(matcher, frame, card_h=220, min_votes=4, detail=False, mine=None, raw=None):
    """返回 {排名: [(x, 卡图, 票数)]}，x 为画面宽度比例，从左到右。
    每个特征点反推卡牌中心和高度，按中心聚成一张张牌；高度大的是手牌，其余按中心高度分排。
    同一个中心、同一个大小上的几票互相印证，随机误匹配很难凑到一起，所以 4 票就够；高亮（金光）的牌票数少，
    card_h（扫描时把场上牌缩放到的高度）从 160 提到 220 能多认出来，代价是每帧约 1.1 → 1.8 秒。
    mine：我方半场（两排 + 手牌）改用这个匹配器（matcher.subset(卡组 + 衍生牌)）：候选少，高亮的牌也认得出来。
    位置参数按画面比例取 layout（电脑 16:9 / iPad 4:3）。detail=True 时每项为 (x, 卡图, 票数, y, 高度)。
    raw：传一个列表进来，分排之前的每个检测 [牌名, 票数, x, y, 高度] 追加进去（存进缓存，改分排规则不用重扫）。"""
    L = layout.get(frame)
    H, W = frame.shape[:2]
    showing = detect.paper_ratio(frame) > 0.5
    sx0, sy0, sx1 = L['scan']
    split = dict(L['row_cy'])['对方近战']          # 对方 / 我方的分界（牌中心）
    margin = L['card_h'] * 0.6                     # 两半各多扫半张牌高，边界上的牌完整
    parts = [(matcher, sy0, split + margin, lambda y: y < split)] if mine is not None else [(matcher, sy0, 1.0, None)]
    if mine is not None:
        parts.append((mine, split - margin, 1.0, lambda y: y >= split))
    rows = {r: [] for r in ROW_KEYS}
    bx, by = L['show_block']
    for mm, py0, py1, keep in parts:
        X0, Y0, X1, Y1 = int(sx0 * W), int(py0 * H), int(sx1 * W), int(min(1.0, py1) * H)
        g = cv2.cvtColor(frame[Y0:Y1, X0:X1], cv2.COLOR_BGR2GRAY)
        k = card_h / (L['card_h'] * H)
        g = cv2.resize(g, None, fx=k, fy=k, interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_CUBIC)
        pts = {}
        for owner, cx, cy, h, _ang in mm.match_cards(g):
            pts.setdefault(owner, []).append((cx / k + X0, cy / k + Y0, h / k))
        for o, ps in pts.items():
            if len(ps) < min_votes:
                continue
            cl = sorted(_cluster(np.array(ps), min_votes), reverse=True)
            vmax = cl[0][0] if cl else 0
            kept = []
            for v, cx, cy, h in cl:
                if v <= WEAK_V and v < WEAK_R * vmax:
                    continue  # 同一张卡图另有强得多的一簇：这是那张牌的零散特征点凑出来的影子
                if any(abs(cx - c2[1]) < 0.45 * 0.7 * max(h, c2[3]) and abs(cy - c2[2]) < 0.6 * max(h, c2[3])
                       for c2 in kept):
                    continue  # 和更强的一簇是同一张牌（游戏内卡图模板和 gwent.one 卡图构图不同，反推的中心差半张牌）
                kept.append((v, cx, cy, h))
                x, y, hh = cx / W, cy / H, h / H
                if keep and not keep(y):
                    continue
                if showing and x > bx and y < by:  # 展示框（右上）里的牌不算场上的
                    continue
                if raw is not None:
                    raw.append([matcher.by_art[matcher.arts[o]][0]['name'], int(v), round(x, 4), round(y, 4), round(hh, 4)])
                row = classify(L, x, y, hh, v)
                if row is None:
                    continue
                rows[row].append((x, matcher.arts[o], v, y, hh) if detail else (x, matcher.arts[o], v))
    for r in rows.values():
        r.sort()
    return rows


def names(matcher, rows, pick=None):
    """{排名: [牌名…]}；pick(cards) 在同图多牌时选一张（默认第一张）。"""
    out = {}
    for r, cs in rows.items():
        out[r] = []
        for _x, art, _v in cs:
            cards = matcher.by_art.get(art) or []
            if cards:
                out[r].append((pick(cards) if pick else cards[0])['name'])
    return out
