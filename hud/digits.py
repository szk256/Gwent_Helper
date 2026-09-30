"""读数字：右侧双方总分、场上每张牌左上角的战力。游戏里的数字是同一种字体，用 0–9 模板比对。

模板从总分截图自动生成（python hud/digits.py build 帧目录，样本写在 SAMPLES 里），存 hud/digits.npz（很小，提交）。
"""
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TPL_PATH = os.path.join(HERE, 'digits.npz')
GW, GH = 16, 24  # 字形归一化大小

# 总分位置（画面比例）：对方在上、我方在下
SCORE_OP = (0.935, 0.31, 0.985, 0.39)
SCORE_ME = (0.935, 0.61, 0.985, 0.69)
# 战力样本：帧文件名前缀 → 场上牌（不含手牌）按 board.scan 顺序（对方远程、对方近战、我方近战、我方远程，各排从左到右）的战力
POWER_SAMPLES = {
    '040835': [('迪门家族轻型长船', 1), ('汉姆多尔', 8), ('迪门家族轻型长船', 2), ('德拉蒙家族好战分子', 3), ('德拉蒙家族好战分子', 3),
               ('布兰王', 6), ('奎特家族战吼者', 7), ('游侠骑士', 10), ('“无畏者”布朗温', 5), ('安赛斯王子', 4), ('不朽者', 6),
               ('贝罗恒王', 1), ('亚特里的温德哈姆', 10)],
    '040910': [('汉姆多尔', 8), ('迪门家族轻型长船', 1), ('德拉蒙家族好战分子', 3), ('德拉蒙家族好战分子', 3), ('布兰王', 6),
               ('奎特家族战吼者', 8), ('游侠骑士', 15), ('“无畏者”布朗温', 12), ('安赛斯王子', 2), ('亚特里的温德哈姆', 10),
               ('赤红男爵', 7)],
    '040634': [('迪门家族轻型长船', 4), ('迪门家族轻型长船', 5), ('布兰王', 6), ('奎特家族战吼者', 4), ('“无畏者”布朗温', 2),
               ('贝罗恒王', 6), ('亚特里的温德哈姆', 12)],
    '040518': [('布兰王', 6), ('奎特家族战吼者', 4), ('贝罗恒王', 6), ('亚特里的温德哈姆', 8)],
    '0408': [('迪门家族轻型长船', 2), ('迪门家族轻型长船', 3), ('德拉蒙家族好战分子', 3), ('德拉蒙家族好战分子', 3), ('布兰王', 6),
             ('奎特家族战吼者', 6), ('少女的盾牌', 13), ('游侠骑士', 9), ('科德温骑士', 11), ('“无畏者”布朗温', 2),
             ('贝罗恒王', 1), ('亚特里的温德哈姆', 12)],
}
# 生成模板用的样本：帧文件名前缀 → (对方总分, 我方总分)（2026-10-01 录像 20261001-035648）
SAMPLES = {'035807': (4, 0), '035947': (14, 5), '040518': (10, 14), '040600': (15, 27), '040738': (22, 48),
           '040835': (30, 62), '040910': (29, 68)}


def crop(frame, box):
    H, W = frame.shape[:2]
    return frame[int(box[1] * H):int(box[3] * H), int(box[0] * W):int(box[2] * W)]


def mask_score(bgr):
    """总分数字：白色或金色（领先时），背景有火焰（饱和的橙红）。"""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = (hsv[..., i].astype(np.int16) for i in range(3))
    return ((v > 150) & ((s < 70) | ((h >= 17) & (h <= 32) & (s < 200)))).astype(np.uint8)


def sig(g):
    """字形图案：缩到 8×12 二值化，存成 24 位十六进制。"""
    b = cv2.resize(g, (8, 12), interpolation=cv2.INTER_AREA) > 0.5
    return f'{int("".join("1" if x else "0" for x in b.flatten()), 2):024x}'


def sig_diff(a, b):
    """两个字形图案串的差别（不同的位数；字形个数不同算很大）。"""
    if not a or not b:
        return None
    pa, pb = a.split('-'), b.split('-')
    if len(pa) != len(pb):
        return 99
    return sum(bin(int(x, 16) ^ int(y, 16)).count('1') for x, y in zip(pa, pb))


def mask_white(bgr, red=False):
    """白色数字（墓场张数、手牌数）；red=True 时红色也算（满手时“10/10”是红的）。"""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = (hsv[..., i].astype(np.int16) for i in range(3))
    m = (s < 60) & (v > 170)
    if red:
        m |= ((h <= 8) | (h >= 172)) & (s > 120) & (v > 120)
    return m.astype(np.uint8)


def mask_lead(bgr):
    """领袖剩余次数：灰白（不能用时）或金色 / 橙色（可以用时）。"""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = (hsv[..., i].astype(np.int16) for i in range(3))
    return (((v > 110) & (s < 90)) | ((h >= 8) & (h <= 32) & (s > 60) & (v > 140))).astype(np.uint8)


def mask_power(bgr):
    """战力数字：白色（基础）、绿色（增益）、红色（受伤）。"""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = (hsv[..., i].astype(np.int16) for i in range(3))
    white = (s < 55) & (v > 140)
    green = (h >= 35) & (h <= 90) & (s > 50) & (v > 110)
    red = ((h <= 8) | (h >= 172)) & (s > 120) & (v > 120)
    # 菱形边框这类细斜线由 glyphs() 按像素占比去掉（开运算会把 8 中间的细横线腐蚀掉）
    return (white | green | red).astype(np.uint8)


def diamond(bgr):
    """在战力区域里按深蓝色底找出菱形的外框，返回裁好的菱形（找不到就原样返回）。"""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = (hsv[..., i].astype(np.int16) for i in range(3))
    navy = ((h >= 100) & (h <= 135) & (s > 50) & (v > 25) & (v < 140)).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(navy, 8)
    if n <= 1:
        return bgr
    # 数字把深蓝底切成几块：取所有够大的块合起来的外框
    big = [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= 0.02 * navy.size]
    if not big:
        return bgr
    x0 = min(st[i, 0] for i in big)
    y0 = min(st[i, 1] for i in big)
    x1 = max(st[i, 0] + st[i, 2] for i in big)
    y1 = max(st[i, 1] + st[i, 3] for i in big)
    if x1 - x0 < bgr.shape[1] * 0.5 or y1 - y0 < bgr.shape[0] * 0.5:
        return bgr  # 框得太小（深蓝底被光效盖住），用原来的区域
    return bgr[y0:y1, x0:x1]


def rhombus(mask, margin=0.8):
    """只保留菱形（战力底框）内部。"""
    h, w = mask.shape
    yy, xx = np.mgrid[0:h, 0:w]
    inside = np.abs(xx - (w - 1) / 2) / (w / 2) + np.abs(yy - (h - 1) / 2) / (h / 2) <= margin
    return mask * inside


def glyphs(mask, min_rel_h=0.55, min_h=6):
    """二值图 → 从左到右的字形 [(x, 归一化后的字形)]。只留高度接近最高字形的连通块（去掉火星、边框碎片）。"""
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask, 8)
    # 横向重叠一大半的连通块合成一个字形（“1”顶上的小旗和竖笔是分开的）
    groups = []
    for i in sorted(range(1, n), key=lambda i: st[i, 0]):
        x, y, w, h = st[i, :4]
        if w * h < 4:
            continue
        for g in groups:
            ov = min(g[0] + g[2], x + w) - max(g[0], x)
            small = min(w * h, g[2] * g[3]) < 0.3 * max(w * h, g[2] * g[3])
            if small and ov > 0.5 * min(g[2], w):
                x1, y1 = min(g[0], x), min(g[1], y)
                g[2], g[3] = max(g[0] + g[2], x + w) - x1, max(g[1] + g[3], y + h) - y1
                g[0], g[1] = x1, y1
                g[4].append(i)
                break
        else:
            groups.append([x, y, w, h, [i]])
    comps = [g for g in groups if g[3] >= min_h]
    # 细斜线（菱形边框）在外框里的像素占比很低，数字不会这么低
    comps = [g for g in comps if np.isin(lab[g[1]:g[1] + g[3], g[0]:g[0] + g[2]], g[4]).mean() >= 0.3]
    if not comps:
        return []
    top = max(c[3] for c in comps)
    comps = [c for c in comps if c[3] >= min_rel_h * top and c[2] <= c[3] * 1.2]
    out = []
    for x, y, w, h, ids in sorted(comps, key=lambda c: c[0]):
        g = np.isin(lab[y:y + h, x:x + w], ids).astype(np.uint8) * 255
        # 保持宽高比放进 GW×GH（“1”很窄，拉伸会和别的数字混）
        k = min(GW / w, GH / h)
        g = cv2.resize(g, (max(1, round(w * k)), max(1, round(h * k))), interpolation=cv2.INTER_AREA)
        box = np.zeros((GH, GW), np.uint8)
        oy, ox = (GH - g.shape[0]) // 2, (GW - g.shape[1]) // 2
        box[oy:oy + g.shape[0], ox:ox + g.shape[1]] = g
        out.append((x, box.astype(np.float32) / 255, (x, y, w, h)))
    return out


def badge_color(b):
    """战力数字的颜色：white（= 基础战力）/ green（增益过，大于基础）/ red（受伤，小于基础）/ None。"""
    hsv = cv2.cvtColor(b, cv2.COLOR_BGR2HSV)
    h, s, v = (hsv[..., i].astype(np.int16) for i in range(3))
    inner = rhombus(np.ones(h.shape, np.uint8)).astype(bool)
    white = ((s < 55) & (v > 140) & inner).sum()
    green = ((h >= 35) & (h <= 90) & (s > 50) & (v > 110) & inner).sum()
    red = (((h <= 8) | (h >= 172)) & (s > 120) & (v > 120) & inner).sum()
    best = max((white, 'white'), (green, 'green'), (red, 'red'))
    return best[1] if best[0] > 0.03 * inner.sum() else None


def power_crop(frame, cx, cy, h):
    """场上牌左上角的战力菱形（略放宽，diamond() 再按深蓝底精确找）。"""
    H, W = frame.shape[:2]
    ch, cw = h * H, h * H * 0.70
    x0, y0 = cx * W - cw / 2, cy * H - ch / 2
    return frame[max(0, int(y0 + ch * 0.0)):int(y0 + ch * 0.26), max(0, int(x0 + cw * 0.02)):int(x0 + cw * 0.40)]


class Reader:
    def __init__(self):
        d = np.load(TPL_PATH)
        self.tpl, self.lab = d['tpl'], d['lab']
        # 战力专用模板（power_train.py 用白色数字自动标注训练）；缺的数字补上总分模板
        if 'ptpl' in d.files:
            have = set(int(x) for x in d['plab'])
            extra = np.isin(self.lab, [k for k in range(10) if k not in have])
            self.ptpl = np.concatenate([d['ptpl'], self.tpl[extra]])
            self.plab = np.concatenate([d['plab'], self.lab[extra]])
        else:
            self.ptpl = self.plab = None

    def ranked(self, g, power=False, k=4):
        """[(数字, 误差)]，按误差从小到大，每个数字只取最近的一个。"""
        tpl, lab = (self.ptpl, self.plab) if power and self.ptpl is not None else (self.tpl, self.lab)
        diff = np.abs(tpl - g[None]).mean((1, 2))
        best = {}
        for i in np.argsort(diff):
            d = int(lab[i])
            if d not in best:
                best[d] = float(diff[i])
            if len(best) >= k:
                break
        return sorted(best.items(), key=lambda x: x[1])

    def classify(self, g, power=False):
        tpl, lab = (self.ptpl, self.plab) if power and self.ptpl is not None else (self.tpl, self.lab)
        diff = np.abs(tpl - g[None]).mean((1, 2))
        idx = np.argsort(diff)[:3]
        vals = lab[idx]
        best = int(np.bincount(vals).argmax())
        return best, float(diff[idx[vals == best]].min())

    def number(self, mask, max_err=0.3, power=False, **kw):
        gs = glyphs(mask, **kw)
        if not gs:
            return None
        cls = [self.classify(g, power) for _x, g, _b in gs]
        # 数字在同一条基线上：以最像数字的字形为准
        ref = gs[int(np.argmin([e for _d, e in cls]))][2]
        rt, rb = ref[1], ref[1] + ref[3]
        tol = 0.2 * ref[3]
        ds = []
        for (x, _g, (bx, by, bw, bh)), c in zip(gs, cls):
            if abs(by - rt) <= tol and abs(by + bh - rb) <= tol:
                ds.append((1, c[1]) if bw < 0.36 * bh else c)  # “1”是唯一特别窄的数字（宽高比约 0.25–0.32）
            elif by < rb and by + bh > rt and min(by + bh, rb) - max(by, rt) > 0.8 * ref[3]:
                # 粘着火焰等碎块：按基准的上下边界裁掉多余部分再认
                sub = mask[rt:rb, bx:bx + bw]
                g2 = glyphs(sub, min_h=int(0.7 * ref[3]))
                if len(g2) == 1:
                    ds.append(self.classify(g2[0][1], power))
        if not ds or len(ds) > 3 or any(e > max_err for _d, e in ds):
            return None
        return int(''.join(str(d) for d, _e in ds))

    def scores(self, frame):
        """(对方总分, 我方总分)，读不出为 None。"""
        import layout
        L = layout.get(frame)
        return (self.number(mask_score(crop(frame, L['score_op']))), self.number(mask_score(crop(frame, L['score_me']))))

    def turn(self, frame):
        """轮到谁：我方总分后面出现蓝旗 = 'me'，否则 'op'。"""
        import layout
        box = layout.get(frame).get('turn_me')
        if not box:
            return None
        hsv = cv2.cvtColor(crop(frame, box), cv2.COLOR_BGR2HSV)
        h, s, v = (hsv[..., i].astype(np.int16) for i in range(3))
        blue = ((h >= 100) & (h <= 125) & (s > 120) & (v > 50)).mean()
        return 'me' if blue > 0.05 else 'op'

    def counts(self, frame):
        """{'grave': (对方, 我方) 墓场张数, 'hand': (对方, 我方) 手牌数}，读不出为 None。"""
        import layout
        L = layout.get(frame)
        out = {}
        sigs = []
        for key in ('grave', 'hand'):
            vals = []
            for side in ('op', 'me'):
                box = L.get(f'{key}_{side}')
                if not box:
                    vals.append(None)
                    continue
                c = crop(frame, box)
                H = frame.shape[0]
                if key == 'grave':  # 大框里找白色数字（高约 0.02 屏高），骷髅是金色的不会混进来
                    m = mask_white(c)
                    v = self.number(m, power=True, min_h=int(0.012 * H), min_rel_h=0.8)
                    # 斜体数字认不准，另存字形图案：离场前后图案变了 = 墓场张数变了
                    gs = glyphs(m, min_h=int(0.012 * H), min_rel_h=0.8)
                    sigs.append('-'.join(sig(g) for _x, g, _b in gs[:2]) if gs and len(gs) <= 2 else None)
                else:
                    v = self.number(mask_white(c, red=True), power=True, min_h=int(0.3 * c.shape[0]))
                if key == 'hand' and v is not None:
                    s = str(v)  # “8/10”：斜杠被当成碎片去掉，剩 810 / 1010；分母固定是 10
                    v = int(s[:-2]) if len(s) > 2 and s.endswith('10') else None
                    if v is not None and v > 10:
                        v = None
                vals.append(v)
            out[key] = tuple(vals)
        out['gsig'] = tuple(sigs) if len(sigs) == 2 else (None, None)
        return out

    def leader(self, frame):
        """(对方, 我方) 领袖剩余次数；标牌不在（用完了）或读不出为 None。"""
        import layout
        L = layout.get(frame)
        if not L.get('lead_op'):
            return (None, None)
        return tuple(self.number(mask_lead(crop(frame, L[k])), min_h=int(0.2 * crop(frame, L[k]).shape[0]))
                     if L.get(k) else None for k in ('lead_op', 'lead_me'))

    def power_cands(self, frame, cx, cy, h, base=None, k=3):
        """战力的几个候选 [(值, 误差)]，按误差从小到大；白色直接 [(基础, 0)]；绿 / 红只留符合大小约束的。读不出返回 []。"""
        b = power_crop(frame, cx, cy, h)
        if b.size == 0:
            return []
        b = diamond(b)
        col = badge_color(b)
        if col == 'white' and base is not None:
            return [(base, 0.0)]
        gs = glyphs(rhombus(mask_power(b)), min_h=max(4, int(b.shape[0] * 0.3)))
        if gs:  # 和 number() 一样按基线去掉碎片
            ref = min(gs, key=lambda g: self.classify(g[1], True)[1])[2]
            tol = 0.2 * ref[3]
            gs = [g for g in gs if abs(g[2][1] - ref[1]) <= tol and abs(g[2][1] + g[2][3] - ref[1] - ref[3]) <= tol]
        if not 1 <= len(gs) <= 2:
            return []
        cands = [[(1, 0.02)] if bb[2] < 0.36 * bb[3] else self.ranked(g, True, k) for _x, g, bb in gs]
        out = []
        if len(cands) == 1:
            out = [(d, e) for d, e in cands[0]]
        else:
            out = [(a * 10 + b2, ea + eb) for a, ea in cands[0] for b2, eb in cands[1] if a > 0]
        if base is not None and col == 'green':
            out = [c for c in out if c[0] > base]
        elif base is not None and col == 'red':
            out = [c for c in out if c[0] < base]
        return sorted(out, key=lambda c: c[1])[:6]

    def power(self, frame, cx, cy, h, base=None):
        """场上一张牌的战力：cx, cy, h 为画面比例（board.scan(detail=True) 给的中心和高度）。特殊牌 / 神器没有数字，返回 None。
        base（基础战力）已知时用颜色约束：白色 = 基础战力（直接返回），绿色 > 基础，红色 < 基础；读数不符合就换候选。"""
        b = power_crop(frame, cx, cy, h)
        if b.size == 0:
            return None
        b = diamond(b)
        col = badge_color(b)
        if col == 'white' and base is not None:
            return base
        v = self.number(rhombus(mask_power(b)), power=True, min_h=max(4, int(b.shape[0] * 0.3)))
        if base is None or col not in ('green', 'red'):
            return v
        ok = (lambda x: x > base) if col == 'green' else (lambda x: x < base)
        if v is not None and ok(v):
            return v
        # 换候选：每个字形取前几名，找满足颜色约束、总误差最小的组合
        gs = glyphs(rhombus(mask_power(b)), min_h=max(4, int(b.shape[0] * 0.3)))
        if not 1 <= len(gs) <= 2:
            return None
        cands = [[(1, 0.0)] if bb[2] < 0.36 * bb[3] else self.ranked(g, True) for _x, g, bb in gs]
        best = None
        for combo in (cands[0] if len(cands) == 1 else [(a, b2) for a in cands[0] for b2 in cands[1]]):
            ds = [combo] if len(cands) == 1 else list(combo)
            val = int(''.join(str(d) for d, _e in ds))
            err = sum(e for _d, e in ds)
            if ok(val) and err < 0.6 and (best is None or err < best[1]):
                best = (val, err)
        return best[0] if best else None


def build(d):
    import glob
    frames = sorted(glob.glob(os.path.join(d, '*.jpg')))
    tpl, lab = [], []
    for pre, (op, me) in SAMPLES.items():
        f = next((x for x in frames if os.path.basename(x).startswith(pre)), None)
        if not f:
            print('没找到样本帧', pre)
            continue
        im = cv2.imdecode(np.fromfile(f, np.uint8), cv2.IMREAD_COLOR)
        for box, val in ((SCORE_OP, op), (SCORE_ME, me)):
            gs = glyphs(mask_score(crop(im, box)))
            s = str(val)
            if len(gs) != len(s):
                print(f'  {pre} {val}: 切出 {len(gs)} 个字形，跳过')
                continue
            for (_x, g, _b), ch in zip(gs, s):
                tpl.append(g)
                lab.append(int(ch))
    # 战力数字（小字号，和总分字形略有不同）
    sys.path.insert(0, HERE)
    import board
    from matcher import Matcher
    m = Matcher()
    reader = type('R', (), {})()
    for pre, vals in POWER_SAMPLES.items():
        f = next((x for x in frames if os.path.basename(x).startswith(pre)), None)
        if not f:
            continue
        im = cv2.imdecode(np.fromfile(f, np.uint8), cv2.IMREAD_COLOR)
        cards = [c for r, cs in board.scan(m, im, detail=True).items() if r != '手牌' for c in cs]
        left = list(vals)
        pairs = []
        for c in cards:  # 按牌名依次对齐（样本里没有的牌跳过）
            name = m.by_art[c[1]][0]['name']
            j = next((j for j, (n, _v) in enumerate(left) if n == name), None)
            if j is not None:
                pairs.append((c, left.pop(j)[1]))
        for (x, _a, _v, y, h), val in pairs:
            b = diamond(power_crop(im, x, y, h))
            gs = glyphs(rhombus(mask_power(b)), min_h=max(4, int(b.shape[0] * 0.3)))
            if len(gs) != len(str(val)):
                print(f'  {pre} 战力 {val}: 切出 {len(gs)} 个字形，跳过')
                continue
            for (_x, g, _b), ch in zip(gs, str(val)):
                tpl.append(g)
                lab.append(int(ch))
    np.savez_compressed(TPL_PATH, tpl=np.array(tpl), lab=np.array(lab))
    print(f'模板 {len(tpl)} 个，数字 {sorted(set(lab))} → {TPL_PATH}')


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'build':
        build(sys.argv[2])
    else:
        print(__doc__)
