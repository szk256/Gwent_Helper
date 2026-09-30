"""训练战力数字模板：白色数字 = 当前战力等于基础战力，用卡牌数据里的基础战力自动标注（不用人工）。

python hud/power_train.py 帧目录 [每几帧取一帧，默认 3] [--jobs=6]
结果写进 hud/digits.npz 的 ptpl / plab（战力专用模板），并报告白色数字的读取准确率（留出一部分帧检验）。
"""
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import board  # noqa: E402
import digits  # noqa: E402
from matcher import Matcher  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
_M = None


def _init():
    global _M, _R
    _M = Matcher()
    _R = digits.Reader()


def badge_color(b):
    """战力数字的颜色：white / green / red / None（看菱形里数字像素的颜色）。"""
    hsv = cv2.cvtColor(b, cv2.COLOR_BGR2HSV)
    h, s, v = (hsv[..., i].astype(np.int16) for i in range(3))
    inner = digits.rhombus(np.ones(h.shape, np.uint8)).astype(bool)
    white = ((s < 55) & (v > 140) & inner).sum()
    green = ((h >= 35) & (h <= 90) & (s > 50) & (v > 110) & inner).sum()
    red = (((h <= 8) | (h >= 172)) & (s > 120) & (v > 120) & inner).sum()
    best = max((white, 'white'), (green, 'green'), (red, 'red'))
    return best[1] if best[0] > 0.03 * inner.sum() else None


def _frame(p):
    im = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)
    out = []
    for r, cs in board.scan(_M, im, detail=True).items():
        if r == '手牌':
            continue
        for x, art, v, y, h in cs:
            c = _M.by_art[art][0]
            if c['type'] != '单位':
                continue
            b = digits.diamond(digits.power_crop(im, x, y, h))
            if b.size == 0 or b.shape[0] < 10:
                continue
            col = badge_color(b)
            gs = digits.glyphs(digits.rhombus(digits.mask_power(b)), min_h=max(4, int(b.shape[0] * 0.3)))
            base = int(c['power']) if str(c['power']).isdigit() else None
            out.append((os.path.basename(p), c['name'], c['power'], col, [g for _x, g, _b in gs],
                        _R.power(im, x, y, h), _R.power(im, x, y, h, base)))
    return out


def main():
    d = sys.argv[1]
    step = int(next((a for a in sys.argv[2:] if a.isdigit()), 3))
    jobs = next((int(a[7:]) for a in sys.argv if a.startswith('--jobs=')), 6)
    import glob
    import multiprocessing as mp
    frames = sorted(glob.glob(os.path.join(d, '*.jpg')))[::step]
    with mp.Pool(jobs, _init) as pool:
        rows = [r for part in pool.imap(_frame, frames, chunksize=4) for r in part]
    whites = [r for r in rows if r[3] == 'white' and str(r[2]).isdigit()]
    print(f'{len(frames)} 帧，场上单位 {len(rows)} 次；白色 {len(whites)} 次；'
          f"颜色分布 { {c: sum(1 for r in rows if r[3] == c) for c in ('white', 'green', 'red', None)} }")
    # 按帧留出 1/4 检验
    test_frames = set(sorted({r[0] for r in whites})[::4])
    tpl, lab = [], []
    for fr, _n, pw, _c, gs, _rd, _rb in whites:
        if fr in test_frames or len(gs) != len(str(pw)):
            continue
        for g, ch in zip(gs, str(pw)):
            tpl.append(g)
            lab.append(int(ch))
    tpl, lab = np.array(tpl), np.array(lab)
    # 每个数字最多留 80 个样本（均匀抽）
    keep = np.concatenate([np.flatnonzero(lab == k)[::max(1, (lab == k).sum() // 80)] for k in range(10) if (lab == k).any()])
    tpl, lab = tpl[keep], lab[keep]
    print('每个数字样本数：', {k: int((lab == k).sum()) for k in range(10)})

    def classify(g):
        dist = np.abs(tpl - g[None]).mean((1, 2))
        idx = np.argsort(dist)[:3]
        vals = lab[idx]
        return int(np.bincount(vals).argmax()), float(dist[idx[0]])

    ok = n = 0
    wrong = []
    for fr, name, pw, _c, gs, rd, _rb in whites:
        if fr not in test_frames:
            continue
        got = str(rd)  # 用 Reader.power（完整流程：菱形、基线、“1”按宽高比）
        n += 1
        ok += got == str(pw)
        if got != str(pw):
            wrong.append((name, pw, got))
    print(f'留出帧上白色数字：{ok}/{n} 读对' + (f'；错的：{wrong[:10]}' if wrong else ''))
    old = dict(np.load(digits.TPL_PATH))
    old.update(ptpl=tpl, plab=lab)
    np.savez_compressed(digits.TPL_PATH, **old)
    print('战力模板已写入', digits.TPL_PATH)
    # 绿色 / 红色：按帧列出同一张牌的读数，看是否稳定
    import collections
    seq = collections.defaultdict(list)
    for fr, name, pw, c, gs, rd, rb in rows:
        if c in ('green', 'red'):
            seq[name].append((fr[:6], c, str(rb)))
    for name, s in list(seq.items())[:8]:
        print(name, ' '.join(f'{f[2:]}{c[0]}{v}' for f, c, v in s[:14]))


if __name__ == '__main__':
    main()
