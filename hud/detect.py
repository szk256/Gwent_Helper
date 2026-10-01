"""从整屏画面里找卡牌：右侧展示区（对方刚打出的牌）、墓场网格。坐标都按画面宽高的比例，和分辨率无关。"""
import os

import cv2
import numpy as np

# 右侧展示区（4K 截图量出：卡图 x 3125–3505, y 290–860；说明框羊皮纸 x 2540–3090, y 500–580）
SHOW_CARD = (0.8110, 0.1300, 0.9150, 0.4020)   # x0, y0, x1, y1（略放宽）
SHOW_PAPER = (0.6615, 0.2315, 0.8047, 0.2685)  # 说明框标题下面的羊皮纸
SHOW_NAME = (0.6600, 0.1370, 0.8080, 0.1900)   # 说明框里的卡名（以后 OCR 用）


def crop(frame, box):
    h, w = frame.shape[:2]
    x0, y0, x1, y1 = box
    return frame[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)]


def paper_ratio(frame):
    """说明框羊皮纸颜色占比；展示区出现时约 0.8，没有时接近 0。"""
    import layout
    return paper_ratio_rel(frame, layout.get(frame)['show_paper'])


def paper_ratio_rel(img, box):
    p = crop(img, box)
    hsv = cv2.cvtColor(p, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    m = (h >= 8) & (h <= 25) & (s >= 40) & (s <= 130) & (v >= 120) & (v <= 235)
    return float(m.mean())


def panel_ratio(frame):
    """画面中间羊皮纸颜色占比：右键 / 长按看牌的大说明面板（带衍生牌小图，会被认成场上的牌）约 0.35–0.6；
    普通画面、悬停小说明框、右侧展示框 < 0.12（2026-10-01 北方营地棋盘量的）。"""
    H, W = frame.shape[:2]
    hsv = cv2.cvtColor(frame[int(0.15 * H):int(0.85 * H):4, int(0.25 * W):int(0.75 * W):4], cv2.COLOR_BGR2HSV)
    h, s, v = (hsv[..., i].astype(np.int16) for i in range(3))
    return float(((h >= 8) & (h <= 28) & (s >= 25) & (s <= 110) & (v >= 140)).mean())


def showcase(frame, thresh=0.5):
    """有展示卡时返回卡图区域（BGR），否则 None。"""
    if paper_ratio(frame) < thresh:
        return None
    import layout
    return crop(frame, layout.get(frame)['show_card'])


def shield(frame, x, y, h):
    """场上这张牌（中心 x、y，高 h，画面比例）有没有护盾：左下图标列里带深色圈的橙色圆点
    （有护盾时整张牌还会泛金光，但神赐、增益动画、金色卡框也会发金光，只看圆点）。
    2026-10-01 真人局 2500 张场上牌人工核对，单帧错 5–6 张（孤立的一帧，导出时要求连续两帧一致）。"""
    H, W = frame.shape[:2]
    ch = h * H * 1.08
    cw = ch * 0.67
    x0, y0 = int(x * W - cw / 2), int(y * H - ch / 2)
    if x0 < 0 or y0 < 0 or x0 + cw > W or y0 + ch > H:
        return None
    c = frame[y0:int(y0 + ch), x0:int(x0 + cw)]
    ch, cw = c.shape[:2]
    reg = c[int(.55 * ch):, :int(.42 * cw)]
    hsv = cv2.cvtColor(reg, cv2.COLOR_BGR2HSV)
    m = ((hsv[..., 0] >= 5) & (hsv[..., 0] <= 25) & (hsv[..., 1] >= 140) & (hsv[..., 2] >= 140)).astype(np.uint8)
    m[:, :int(0.06 * cw)] = 0      # 卡框左边、底边的金光会和圆点连成一片
    m[-int(0.04 * ch):, :] = 0
    n, _lab, st, _cen = cv2.connectedComponentsWithStats(m, 8)
    d0 = 0.15 * cw                 # 圆点直径约卡宽 15%
    for i in range(1, n):
        _x, _y, w, hh, a = st[i]
        if 0.5 * d0 <= w <= 1.5 * d0 and 0.5 * d0 <= hh <= 1.5 * d0 and 0.7 <= w / max(hh, 1) <= 1.4                 and a >= 0.3 * w * hh:   # 圆点中间有时偏暗，填充率 0.37–0.8
            return True
    return False


def leader_glow(frame):
    """我方领袖图标外圈的光：'Y' 黄光（已点选领袖、正在找目标）、'G' 绿光（能用）、None 无光 / 没标定。
    用户确认：绿 = 随时能用；无光 = 正在拖牌等用不了但有次数；黄 = 已点选正在找目标；变暗、没有数字框 = 用完。"""
    import layout
    box = layout.get(frame).get('lead_badge_me')
    if not box:
        return None
    c = crop(frame, box)
    hsv = cv2.cvtColor(c, cv2.COLOR_BGR2HSV)
    h, s, v = (hsv[..., i].astype(int) for i in range(3))
    ring = np.ones(h.shape, bool)
    ch, cw = h.shape
    ring[int(ch * .13):int(ch * .82), int(cw * .23):int(cw * .77)] = False   # 图标本身（金色王冠、数字）不算
    if ((h >= 5) & (h <= 25) & (s >= 150) & (v >= 180) & ring).mean() > 0.08:
        return 'Y'
    if ((h >= 40) & (h <= 95) & (s >= 70) & (v >= 140) & ring).mean() > 0.05:
        return 'G'
    return None


ABILITY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', 'ability')
_ICONS = {}


def _gold(bgr):
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = (hsv[..., i].astype(np.int16) for i in range(3))
    return ((h >= 8) & (h <= 32) & (s >= 60) & (v >= 90)).astype(np.float32)


def _icon(card_id):
    """gwent.one 领袖技能图标（cache/ability/<编号>.png，build_db.py 下载）的金色纹章（裁到纹章外框）。"""
    if card_id not in _ICONS:
        p = os.path.join(ABILITY_DIR, f'{card_id}.png')
        im = cv2.imread(p, cv2.IMREAD_UNCHANGED) if os.path.exists(p) else None
        g = None
        if im is not None and im.shape[2] == 4:
            a = im[..., 3:] / 255.0
            g = _gold((im[..., :3] * a).astype(np.uint8))
            ys, xs = np.nonzero(g)
            g = g[ys.min():ys.max() + 1, xs.min():xs.max() + 1] if len(xs) >= 50 else None
        _ICONS[card_id] = g
    return _ICONS[card_id]


def leader_icon_scores(frame, side, card_ids):
    """左上（对方）/ 左下（我方）领袖徽章顶部的纹章和各领袖技能图标比：{编号: 相似度 -1~1}。
    游戏里徽章只露出金色纹章（图标的彩色盾牌底看不到），所以只比金色部分的形状，按几个缩放找最像的。
    2026-10-01 真人局对方游击战术约 0.7–0.8，别的都在 0.35 以下；用完之后徽章变暗，认不准。"""
    import layout
    box = layout.get(frame).get(f'lead_icon_{side}')
    if not box:
        return {}
    reg = _gold(crop(frame, box))
    if reg.sum() < 30:
        return {}
    out = {}
    for cid in card_ids:
        t0 = _icon(cid)
        if t0 is None:
            continue
        best = -1.0
        for wf in np.arange(0.45, 0.95, 0.05):
            w = int(reg.shape[1] * wf)
            h = int(t0.shape[0] * w / t0.shape[1])
            if h >= reg.shape[0] or w < 8:
                continue
            r = cv2.matchTemplate(reg, cv2.resize(t0, (w, h), interpolation=cv2.INTER_AREA), cv2.TM_CCOEFF_NORMED)
            best = max(best, float(r.max()))
        out[cid] = best
    return out


_sift_board = cv2.SIFT_create()


def board_opp(matcher, frame, card_h=160, min_votes=8):
    """找对方半场上的牌（不用先切牌：整块找特征点、按卡图投票，再按位置聚成一张张牌）。
    棋盘会随状态上下移动，所以不按固定的排位置。返回 [(票数, 卡图, x, y)]（x、y 为画面比例），从左到右。"""
    H, W = frame.shape[:2]
    # 对方半场；展示框出现时右边不看（展示卡和说明框会被当成场上的牌）
    x1 = 0.64 if paper_ratio(frame) > 0.5 else 0.81
    X0, Y0, X1, Y1 = int(.17 * W), int(.10 * H), int(x1 * W), int(.46 * H)
    g = cv2.cvtColor(frame[Y0:Y1, X0:X1], cv2.COLOR_BGR2GRAY)
    k = card_h / (0.155 * H)  # 场上牌高约 0.155H
    g = cv2.resize(g, None, fx=k, fy=k, interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_CUBIC)
    pts = {}
    for owner, (x, y) in matcher.match_points(g):
        pts.setdefault(owner, []).append((x / k + X0, y / k + Y0))
    cw = 0.066 * W  # 场上牌宽
    found = []
    for o, ps in pts.items():
        if len(ps) < min_votes:
            continue
        ps.sort()
        groups, cur = [], [ps[0]]
        for p in ps[1:]:
            if p[0] - cur[-1][0] > cw * 0.5:
                groups.append(cur)
                cur = [p]
            else:
                cur.append(p)
        groups.append(cur)
        for gp in groups:
            xs, ys = np.array(gp).T
            # 相邻的同名牌：特征点横跨几张牌宽就拆成几张
            n = max(1, round((np.percentile(xs, 95) - np.percentile(xs, 5)) / cw + 0.15))
            edges = np.linspace(xs.min(), xs.max() + 1e-6, n + 1)
            for i in range(n):
                sel = (xs >= edges[i]) & (xs < edges[i + 1])
                if sel.sum() >= min_votes:
                    found.append((int(sel.sum()), matcher.arts[o], float(np.median(xs[sel])) / W,
                                  float(np.median(ys[sel])) / H))
    found.sort(key=lambda f: f[2])
    return found


def find_cards(frame, min_h=0.08):
    """在墓场等界面里找一张张卡牌（背景是模糊的暗色）。返回 [(x, y, w, h, 图像)]，按行、列排序。"""
    H, W = frame.shape[:2]
    sw = 960
    k = W / sw
    sm = cv2.resize(frame, (sw, round(H / k)), interpolation=cv2.INTER_AREA)
    g = cv2.cvtColor(sm, cv2.COLOR_BGR2GRAY).astype(np.float32)
    e = cv2.blur(np.abs(cv2.Laplacian(g, cv2.CV_32F)), (9, 9))
    m = cv2.morphologyEx((e > 6).astype(np.uint8) * 255, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cs:
        x, y, w, h = cv2.boundingRect(c)
        if h > min_h * sm.shape[0] and 0.55 < w / h < 0.8:
            X, Y, Wd, Ht = int(x * k), int(y * k), int(w * k), int(h * k)
            out.append((X, Y, Wd, Ht, frame[Y:Y + Ht, X:X + Wd]))
    rowh = max((o[3] for o in out), default=1) / 2
    out.sort(key=lambda o: (round(o[1] / rowh), o[0]))
    return out
