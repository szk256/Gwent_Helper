"""识别效果测试。

python hud/eval.py shots 截图1.png 截图2.png …   对截图跑一遍：右侧展示区 + 墓场网格
python hud/eval.py synth [张数]                    用卡图模拟游戏画面（裁边、缩小、边框、模糊、压缩），统计准确率
python hud/eval.py log [对局目录]                  重新识别 HUD 存下的展示截图（cache/log/…）
"""
import glob
import os
import random
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import detect  # noqa: E402
from matcher import Matcher, removal_kind  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def imread(p):
    return cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)


def fmt(res, n=3):
    return '；'.join(f"{'/'.join(c['name'] for c in cs)} {v:.0f}" for v, _, cs in res[:n]) or '（无）'


def shots(m, paths):
    for p in paths:
        im = imread(p)
        print(f'== {os.path.basename(p)}  {im.shape[1]}×{im.shape[0]}  羊皮纸 {detect.paper_ratio(im):.2f}')
        sc = detect.showcase(im)
        if sc is not None:
            res = m.match(sc)
            tag = '✓' if Matcher.confident(res) else '?'
            rk = removal_kind(res[0][2][0]) if res else ''
            print(f'  展示区 {tag} {fmt(res)}' + (f'  【解牌 {rk}】' if rk else ''))
        cards = detect.find_cards(im)
        for x, y, w, h, img in cards:
            res = m.match(img)
            tag = '✓' if Matcher.confident(res, min_votes=6) else '?'
            print(f'  卡牌 ({x},{y},{w}×{h}) {tag} {fmt(res)}')


def simulate(img, h, rng):
    H, W = img.shape[:2]
    # 游戏里的卡图可能比 gwent.one 的图多裁一点边
    cx, cy = rng.uniform(0, 0.04) * W, rng.uniform(0, 0.04) * H
    img = img[int(cy):int(H - rng.uniform(0, 0.04) * H), int(cx):int(W - rng.uniform(0, 0.04) * W)]
    w = round(h * 0.667)
    img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
    t = max(2, h // 60)
    cv2.rectangle(img, (0, 0), (w - 1, h - 1), (60, 150, 200), t)  # 边框
    d = h // 7  # 左上角战力菱形
    pts = np.array([[d, t], [2 * d - t, d], [d, 2 * d - t], [t, d]], np.int32)
    cv2.fillPoly(img, [pts], (70, 40, 60))
    cv2.putText(img, str(rng.randint(1, 9)), (int(d * 0.7), int(d * 1.3)), cv2.FONT_HERSHEY_SIMPLEX, d / 40,
                (220, 230, 235), max(1, d // 15))
    a, b = rng.uniform(0.75, 1.15), rng.uniform(-20, 15)  # 亮度、对比度
    img = np.clip(img.astype(np.float32) * a + b, 0, 255).astype(np.uint8)
    img = cv2.GaussianBlur(img, (0, 0), rng.uniform(0.3, 1.0))
    ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 75])
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def synth(m, n):
    rng = random.Random(1)
    arts = rng.sample(m.arts, min(n, len(m.arts)))
    for h in (575, 290, 180):  # 4K 展示区 / 2K 展示区、4K 墓场缩小 / 场上小卡
        ok = conf = wrong_conf = 0
        t0 = time.time()
        for a in arts:
            img = simulate(imread(os.path.join(HERE, 'cache', 'art', f'{a}.jpg')), h, rng)
            res = m.match(img)
            good = bool(res) and res[0][1] == a
            ok += good
            if Matcher.confident(res):
                conf += 1
                wrong_conf += not good
        dt = (time.time() - t0) / len(arts)
        print(f'高 {h}px：第一候选正确 {ok}/{len(arts)} = {ok / len(arts):.1%}；'
              f'判为可信 {conf}，其中错 {wrong_conf}；每张 {dt * 1000:.0f} ms')


def relog(m, d):
    if not d:
        ds = sorted(glob.glob(os.path.join(HERE, 'cache', 'log', '*')))
        d = ds[-1] if ds else ''
    for p in sorted(glob.glob(os.path.join(d, '*.png'))):
        res = m.match(imread(p))
        print(os.path.basename(p), '✓' if Matcher.confident(res) else '?', fmt(res))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    t0 = time.time()
    m = Matcher()
    print(f'特征库载入 {time.time() - t0:.1f}s，{len(m.arts)} 张卡图')
    cmd = sys.argv[1]
    if cmd == 'shots':
        shots(m, sys.argv[2:])
    elif cmd == 'synth':
        synth(m, int(sys.argv[2]) if len(sys.argv) > 2 else 200)
    elif cmd == 'log':
        relog(m, sys.argv[2] if len(sys.argv) > 2 else '')
    return 0


if __name__ == '__main__':
    sys.exit(main())
