"""从整屏画面里找卡牌：右侧展示区（对方刚打出的牌）、墓场网格。坐标都按画面宽高的比例，和分辨率无关。"""
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
    return paper_ratio_rel(frame, SHOW_PAPER)


def paper_ratio_rel(img, box):
    p = crop(img, box)
    hsv = cv2.cvtColor(p, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    m = (h >= 8) & (h <= 25) & (s >= 40) & (s <= 130) & (v >= 120) & (v <= 235)
    return float(m.mean())


def showcase(frame, thresh=0.5):
    """有展示卡时返回卡图区域（BGR），否则 None。"""
    if paper_ratio(frame) < thresh:
        return None
    return crop(frame, SHOW_CARD)


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
