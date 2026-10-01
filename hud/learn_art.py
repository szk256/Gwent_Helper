"""从录像帧截一张牌当“游戏内卡图”模板，补进特征库。

有些牌游戏里用的是另一版卡图（动态卡图、构图不同，如雷纳德·奥多），和 gwent.one 的图只能对上几个特征点，
常常认不出、估出的牌高也偏大。截一张游戏里的这张牌（卡框外沿）存到 hud/cache/tmpl/，Matcher 载入时自动并入。

python hud/learn_art.py 帧.jpg 牌名 x0 y0 x1 y1     框为画面比例（卡框外沿）；动态卡图最好从不同帧截 2–3 张
python hud/learn_art.py --list                        列出已有模板
"""
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from matcher import TMPL_DIR, load_cards  # noqa: E402


def main():
    if '--list' in sys.argv:
        by_art = {}
        for c in load_cards():
            by_art.setdefault(c['art'], c['name'])
        for f in sorted(os.listdir(TMPL_DIR)) if os.path.isdir(TMPL_DIR) else []:
            print(by_art.get(f.split('__')[0], '?'), f)
        return 0
    if len(sys.argv) != 7:
        print(__doc__)
        return 1
    path, name = sys.argv[1], sys.argv[2]
    x0, y0, x1, y1 = map(float, sys.argv[3:7])
    card = next((c for c in load_cards() if c['name'] == name), None)
    if not card:
        print(f'没有这张牌：{name}')
        return 1
    im = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)
    H, W = im.shape[:2]
    crop = im[int(y0 * H):int(y1 * H), int(x0 * W):int(x1 * W)]
    os.makedirs(TMPL_DIR, exist_ok=True)
    out = os.path.join(TMPL_DIR, f"{card['art']}__{os.path.splitext(os.path.basename(path))[0]}.png")
    cv2.imencode('.png', crop)[1].tofile(out)
    print(f'{name}（卡图 {card["art"]}）{crop.shape[1]}×{crop.shape[0]} → {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
