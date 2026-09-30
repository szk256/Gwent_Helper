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
