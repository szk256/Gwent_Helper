"""下载卡图（gwent.one 中等尺寸）并建 SIFT 特征库 hud/cache/db.npz。

用法：python hud/build_db.py        （已下载的卡图不重复下载）
网络走环境变量 HTTPS_PROXY（本机 http://127.0.0.1:7892）。
"""
import json
import os
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
ART_DIR = os.path.join(CACHE, 'art')
ART_URL = 'https://gwent.one/image/gwent/assets/card/art/medium/{}.jpg'
# 建库时卡图统一缩放到的高度（游戏里展示卡在 4K 下约 575 高，墓场约 540）
DB_H = 357
MAX_FEAT = 400


def load_cards():
    path = os.path.join(CACHE, 'cards.json')
    if not os.path.exists(path):
        subprocess.check_call(['node', os.path.join(HERE, 'export_cards.js')])
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def download(art):
    dst = os.path.join(ART_DIR, f'{art}.jpg')
    if os.path.exists(dst) and os.path.getsize(dst) > 1000:
        return art, True
    try:
        req = urllib.request.Request(ART_URL.format(art), headers={'User-Agent': 'gwent-hud/0.1'})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
        with open(dst + '.part', 'wb') as f:
            f.write(data)
        os.replace(dst + '.part', dst)
        return art, True
    except Exception as e:  # noqa: BLE001
        print(f'  下载失败 {art}: {e}')
        return art, False


def imread(path):
    return cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)


def main():
    os.makedirs(ART_DIR, exist_ok=True)
    cards = load_cards()
    arts = sorted({c['art'] for c in cards if c['art'] and c['art'] != '-'})
    print(f'卡图 {len(arts)} 张，开始下载…')
    ok = 0
    with ThreadPoolExecutor(8) as ex:
        for i, (_, good) in enumerate(ex.map(download, arts)):
            ok += good
            if (i + 1) % 200 == 0:
                print(f'  {i + 1}/{len(arts)}')
    print(f'下载完成 {ok}/{len(arts)}')

    sift = cv2.SIFT_create(nfeatures=MAX_FEAT)
    descs, owners, keep, geo = [], [], [], []
    for art in arts:
        p = os.path.join(ART_DIR, f'{art}.jpg')
        if not os.path.exists(p):
            continue
        img = imread(p)
        if img is None:
            continue
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        g = cv2.resize(g, (round(g.shape[1] * DB_H / g.shape[0]), DB_H), interpolation=cv2.INTER_AREA)
        kp, d = sift.detectAndCompute(g, None)
        if d is None or len(d) < 10:
            print(f'  特征太少，跳过 {art}')
            continue
        h, w = g.shape
        # 特征点相对卡图中心的位置（以卡图高度为单位）、大小、角度：识别时用来反推卡牌中心和大小
        geo.append(np.array([((k.pt[0] - w / 2) / h, (k.pt[1] - h / 2) / h, k.size / h, k.angle) for k in kp],
                            np.float32))
        owners.append(np.full(len(d), len(keep), np.int32))
        descs.append(d.astype(np.float32))
        keep.append(art)
    np.savez_compressed(os.path.join(CACHE, 'db.npz'), desc=np.vstack(descs), owner=np.concatenate(owners),
                        arts=np.array(keep), geo=np.vstack(geo))
    print(f'特征库：{len(keep)} 张卡图，{sum(len(d) for d in descs)} 个特征点 → cache/db.npz')


if __name__ == '__main__':
    sys.exit(main())
