"""卡图识别：SIFT 特征 + FLANN 最近邻投票。"""
import json
import os
import re

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
FAC_CN = {'NR': '北方王国', 'NE': '中立', 'MO': '怪兽', 'NG': '尼弗迦德', 'ST': '松鼠党', 'SK': '史凯利格', 'SY': '辛迪加'}
QUERY_H = 357  # 和建库时同一尺度


def load_cards():
    with open(os.path.join(CACHE, 'cards.json'), encoding='utf-8') as f:
        return json.load(f)


# ---- 解牌判定：看卡面文字 ----
_DMG = re.compile(r'造成\s*(\d+)\s*点伤害')


def removal_kind(card):
    """返回解牌类型（锁定/摧毁/放逐/重置/伤害N），不是解牌返回空字符串。只看打出/部署/特殊牌本身的效果。"""
    if card.get('type') in ('领袖能力',):
        return ''
    kinds, dmg = [], 0
    # 按句子看；只作用于己方 / 墓场 / 手牌 / 牌组，或是被动触发条件（“被摧毁时”）的句子不算
    for s in re.split(r'[。/；]', card.get('text') or ''):
        if re.search(r'友军|己方|墓场|手牌|牌组|被摧毁|被锁定|免疫', s):
            continue
        if '锁定' in s:
            kinds.append('锁定')
        if re.search(r'摧毁(?!自身)', s):
            kinds.append('摧毁')
        if '放逐' in s:
            kinds.append('放逐')
        if re.search(r'重置', s):
            kinds.append('重置')
        dmg = max([dmg] + [int(x) for x in _DMG.findall(s)])
    if dmg >= 4:
        kinds.append(f'伤害{dmg}')
    return '、'.join(dict.fromkeys(kinds))


class Matcher:
    load_cards_static = staticmethod(load_cards)

    def __init__(self):
        db = np.load(os.path.join(CACHE, 'db.npz'))
        self.desc = db['desc']
        self.owner = db['owner']
        self.arts = [str(a) for a in db['arts']]
        self.geo = db['geo'] if 'geo' in db.files else None  # 旧特征库没有：重跑 build_db.py
        self.cards = load_cards()
        self.by_art = {}
        for c in self.cards:
            self.by_art.setdefault(c['art'], []).append(c)
        self.sift = cv2.SIFT_create(nfeatures=800)
        self.sift_all = cv2.SIFT_create()
        self.flann = cv2.FlannBasedMatcher({'algorithm': 1, 'trees': 4}, {'checks': 64})
        self.flann.add([self.desc])
        self.flann.train()

    def subset(self, names):
        """只在这些牌（牌名）里找的轻量副本（共用卡牌数据，自己一份小索引）：候选少，比值检验放过的正确匹配更多。"""
        import copy
        keep_art = {self.arts.index(c['art']) for c in self.cards if c['name'] in names and c['art'] in self.arts}
        sel = np.isin(self.owner, list(keep_art))
        sub = copy.copy(self)
        sub.desc, sub.owner = self.desc[sel], self.owner[sel]
        sub.geo = self.geo[sel] if self.geo is not None else None
        sub.flann = cv2.FlannBasedMatcher({'algorithm': 1, 'trees': 4}, {'checks': 64})
        sub.flann.add([sub.desc])
        sub.flann.train()
        return sub

    def features(self, bgr):
        g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr.ndim == 3 else bgr
        scale = QUERY_H / g.shape[0]
        g = cv2.resize(g, (max(1, round(g.shape[1] * scale)), QUERY_H),
                       interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC)
        return self.sift.detectAndCompute(g, None)[1]

    def match_points(self, gray, ratio=0.75):
        """整块图里每个通过比值检验的特征点：[(卡图序号, (x, y))]。用于一张图里有多张牌的情况。"""
        return [(o, (cx, cy)) for o, cx, cy, _h, _a in self.match_cards(gray, ratio, centers=False)]

    def match_cards(self, gray, ratio=0.75, centers=True):
        """整块图里每个通过比值检验的特征点，按它在卡图上的相对位置和缩放反推卡牌：
        [(卡图序号, 中心x, 中心y, 卡牌高度, 旋转角)]（图内像素）。centers=False 时给特征点自己的位置。"""
        kp, d = self.sift_all.detectAndCompute(gray, None)
        if d is None:
            return []
        out = []
        for q, ms in zip(kp, self.flann.knnMatch(d.astype(np.float32), k=4)):
            if not ms:
                continue
            o0 = self.owner[ms[0].trainIdx]
            other = next((m for m in ms[1:] if self.owner[m.trainIdx] != o0), None)
            if other is None or ms[0].distance < ratio * other.distance:
                if not centers or self.geo is None:
                    out.append((o0, q.pt[0], q.pt[1], 0.0, 0.0))
                    continue
                gx, gy, gs, ga = self.geo[ms[0].trainIdx]
                h = q.size / gs                       # 卡牌高度（图内像素）
                da = np.deg2rad(q.angle - ga)
                c, s = np.cos(da), np.sin(da)
                dx, dy = gx * h, gy * h
                out.append((o0, q.pt[0] - (c * dx - s * dy), q.pt[1] - (s * dx + c * dy), h,
                            (q.angle - ga + 180) % 360 - 180))
        return out

    def match(self, bgr, facs=None, top=3):
        """识别一张卡牌图像（BGR，大致只含这张牌）。facs：只在这些阵营里找（如 {'SK','NE'}）。
        返回 [(votes, art, [card…])]，按票数从高到低。"""
        d = self.features(bgr)
        if d is None or len(d) < 5:
            return []
        knn = self.flann.knnMatch(d.astype(np.float32), k=4)
        votes = np.zeros(len(self.arts), np.float32)
        for ms in knn:
            if not ms:
                continue
            o0 = self.owner[ms[0].trainIdx]
            other = next((m for m in ms[1:] if self.owner[m.trainIdx] != o0), None)
            if other is None or ms[0].distance < 0.75 * other.distance:
                votes[o0] += 1
        order = np.argsort(-votes)
        out = []
        for i in order:
            if votes[i] <= 0:
                break
            cs = self.by_art.get(self.arts[i], [])
            if facs:
                cs = [c for c in cs if c['fac'] in facs]
                if not cs:
                    continue
            out.append((float(votes[i]), self.arts[i], cs))
            if len(out) >= top:
                break
        return out

    @staticmethod
    def confident(res, min_votes=8, ratio=2.0):
        if not res:
            return False
        v1 = res[0][0]
        v2 = res[1][0] if len(res) > 1 else 0
        return v1 >= min_votes and v1 >= ratio * max(v2, 1)
