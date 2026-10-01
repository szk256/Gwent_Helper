"""下载 gwent.one 的闪卡动画（公开的 webm），抽几帧存成游戏内卡图模板（hud/cache/tmpl/<卡图编号>__prem<k>.png）。

拥有闪卡的玩家，游戏里显示的是动画版卡图（雷纳德·奥多：构图和静态卡图明显不同），静态卡图对不上；
动画每一帧姿势不同，所以抽几帧。不拆游戏资源包：用的是 gwent.one 网页上本来就公开播放的视频。
衍生牌（乌鸦）gwent.one 没有闪卡视频，还得用 learn_art.py 从录像截。

**不要整副卡组一起加**：2026-10-01 给卡组 22 张都加了 6 帧，真人局逐帧准确率 98.8% → 92.0%（召回 99.5% → 99.9%），
滚油、不朽者的动画全是火焰 / 烟雾纹理，到处都对得上。默认只存到 cache/premium_tmpl/（不载入）；
确认某张牌游戏里显示闪卡、又认不出来时，加 --use 只给那一张放进 cache/tmpl/，再用 eval.py board 验证。

python hud/premium_art.py 牌名 [牌名 ...] [--use]
python hud/premium_art.py deck [卡组文件]       卡组里的牌（默认 hud/deck.txt），只存不载入
"""
import os
import sys
import urllib.request

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from matcher import CACHE, TMPL_DIR, load_cards  # noqa: E402

VIDEO_URL = 'https://gwent.one/video/card/premium/{}.webm'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
FRAMES = 6


def fetch(card_id):
    """下载闪卡视频到 cache/premium/<编号>.webm；没有闪卡（404）返回 None。"""
    out = os.path.join(CACHE, 'premium', f'{card_id}.webm')
    if os.path.exists(out):
        return out
    os.makedirs(os.path.dirname(out), exist_ok=True)
    req = urllib.request.Request(VIDEO_URL.format(card_id),
                                 headers={'User-Agent': UA, 'Referer': f'https://gwent.one/cn/card/{card_id}'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
    except Exception:
        return None
    if data[:4] != b'\x1a\x45\xdf\xa3':   # 不是 webm（找不到时网站返回的是网页）
        return None
    with open(out, 'wb') as f:
        f.write(data)
    return out


def frames(path, n=FRAMES):
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    out = []
    for i in np.linspace(0, max(total - 1, 0), n + 1).astype(int)[:-1]:   # 动画首尾相接，最后一帧和第一帧一样
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
        ok, f = cap.read()
        if ok:
            out.append(f)
    return out


def main():
    use = '--use' in sys.argv
    args = [a for a in sys.argv[1:] if a != '--use']
    if not args:
        print(__doc__)
        return 1
    cards = load_cards()
    by_name = {c['name']: c for c in cards}
    by_id = {str(c.get('id')): c for c in cards if c.get('id')}
    if args[0] == 'deck':
        path = args[1] if len(args) > 1 else os.path.join(HERE, 'deck.txt')
        ids = []
        for line in open(path, encoding='utf-8'):
            if not line.startswith('#'):
                ids += [tok.split('x')[0] for tok in line.split() if 'x' in tok]
        todo = [by_id[i] for i in ids if i in by_id]
    else:
        todo = [by_name[n] for n in args if n in by_name]
    dest = TMPL_DIR if use else os.path.join(CACHE, 'premium_tmpl')
    os.makedirs(dest, exist_ok=True)
    for c in todo:
        if c.get('set') == 'token':
            continue
        p = fetch(c['id'])
        if not p:
            print(f'  {c["name"]}：gwent.one 没有闪卡视频')
            continue
        fs = frames(p)
        for k, f in enumerate(fs):
            cv2.imencode('.png', f)[1].tofile(os.path.join(dest, f"{c['art']}__prem{k}.png"))
        print(f'{c["name"]}（卡图 {c["art"]}）：{len(fs)} 帧 → {dest}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
