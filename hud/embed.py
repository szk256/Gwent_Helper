"""对方半场的漏认补位：SIFT 没认出、但按排的几何一定有牌的位置，截图用 DINOv2 特征和参考库比。

昆特牌每排的牌紧挨着、以画面中线为中心：由认出的几张能确定这一排至少横跨多宽，范围内的空位一定有牌
（牌在动、位置对不上格子的排跳过）。参考库 = gwent.one 卡图 + 游戏内模板（cache/tmpl）+ 这一局 SIFT 高票认出的截图；
第一名比别的牌高出 EMB_LEAD、相似度 ≥ EMB_SIM 才采用（没把握的不补）。

2026-10-02 实验（对方半场标准答案两局 316 张）：只用 gwent.one 卡图时 SIFT 漏掉的 25 张补回 12 张（游戏里的牌和官方图差得多），
加上同一局 SIFT 高票截图补回 17 张、再加游戏内模板 20 张；认错的第一名都几乎不领先第二名（≤ 0.008）。
需要 torch（CPU 版即可，python -m pip install --user torch torchvision --index-url https://download.pytorch.org/whl/cpu），
没装或 HUD_EMB=0 时整步跳过。模型 dinov2_vits14（torch.hub 首次下载约 90 MB）。
"""
import glob
import os

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = 'dinov2_vits14'
EMB_VER = 1
EMB_SIM, EMB_LEAD = 0.5, 0.01
EMB_V = 8               # 补上的牌在原始检测里记的“票数”
AUTO_V, AUTO_PER = 40, 6
SPACING = 0.413         # 同排相邻两张牌的中心距 / 牌高
OP_ROWS = ('对方远程', '对方近战')
_IX0, _IX1, _IY0, _IY1 = 0.08, 0.92, 0.20, 0.86   # 卡面里避开左上战力菱形、底部图标
_MEAN = np.array([0.485, 0.456, 0.406])
_STD = np.array([0.229, 0.224, 0.225])
_M = None


def available():
    if os.environ.get('HUD_EMB') == '0':
        return False
    try:
        import torch  # noqa: F401
        return True
    except ImportError:
        return False


def _model():
    global _M
    if _M is None:
        import torch
        torch.set_num_threads(max(1, (os.cpu_count() or 4)))
        _M = torch.hub.load('facebookresearch/dinov2', MODEL, trust_repo=True, verbose=False).eval()
    return _M


def inner(img):
    h, w = img.shape[:2]
    return img[int(_IY0 * h):int(_IY1 * h), int(_IX0 * w):int(_IX1 * w)]


def embed(imgs, bs=64):
    import torch
    out = []
    with torch.no_grad():
        for i in range(0, len(imgs), bs):
            x = np.stack([((cv2.resize(b, (224, 224), interpolation=cv2.INTER_AREA)[:, :, ::-1] / 255.0 - _MEAN) / _STD)
                          .transpose(2, 0, 1).astype(np.float32) for b in imgs[i:i + bs]])
            out.append(torch.nn.functional.normalize(_model()(torch.from_numpy(x)), dim=1).numpy())
    return np.concatenate(out) if out else np.zeros((0, 384), np.float32)


def card_crop(im, x, y, h):
    H, W = im.shape[:2]
    ch = h * H
    cw = ch * 0.72
    x0, y0 = int(x * W - cw / 2), int(y * H - ch / 2)
    return inner(im[max(0, y0):max(0, y0) + int(ch), max(0, x0):max(0, x0) + int(cw)])


def base_refs(cards):
    """gwent.one 卡图 + 游戏内模板的特征（缓存 cache/emb_refs_<模型>.npz，卡图 / 模板变了就重算）。"""
    by_art = {}
    for c in cards:
        by_art.setdefault(str(c['art']), c['name'])
    files = sorted(glob.glob(os.path.join(HERE, 'cache', 'art', '*.jpg'))) + sorted(glob.glob(os.path.join(HERE, 'cache', 'tmpl', '*.png')))
    files = [p for p in files if os.path.basename(p).split('__')[0].split('.')[0] in by_art]
    key = f'{len(files)}_{int(sum(os.path.getmtime(p) for p in files))}'
    cp = os.path.join(HERE, 'cache', f'emb_refs_{MODEL}.npz')
    if os.path.exists(cp):
        z = np.load(cp, allow_pickle=True)
        if str(z['key']) == key:
            return z['E'], list(z['names'])
    imgs = [inner(cv2.imread(p)) for p in files]
    names = [by_art[os.path.basename(p).split('__')[0].split('.')[0]] for p in files]
    E = embed(imgs)
    np.savez(cp, E=E, names=np.array(names), key=key)
    return E, names


def gaps(dets):
    """一排对方牌（[(x, y, h)]）里按几何一定有牌、却没认出的位置 [(x, y, h)]；对不上格子返回 []。"""
    if not dets:
        return []
    y = float(np.median([d[1] for d in dets]))
    h = float(np.median([d[2] for d in dets]))
    s = SPACING * h
    offs = [(d[0] - 0.5) / s for d in dets]
    frac = [o - np.floor(o) for o in offs]
    if all(min(f, 1 - f) < 0.2 for f in frac):
        half = 0.0          # 奇数张：中线上有一张
    elif all(abs(f - 0.5) < 0.2 for f in frac):
        half = 0.5          # 偶数张
    else:
        return []           # 牌在动 / 插入中
    grid = sorted({round(o - half) + half for o in offs})
    m = max(abs(g) for g in grid)
    if 2 * m + 1 > 9:
        return []
    want = [k + half for k in range(-int(np.ceil(m)) - 1, int(np.ceil(m)) + 2) if abs(k + half) <= m + 1e-6]
    return [(0.5 + g * s, y, h) for g in want if all(abs(g - o) > 0.3 for o in offs)]


def fill(d, frames, done, cards, cand_names, classify, layout_get, usable, frame_time, read_im):
    """给 done 里每帧算 ent['emb'] = [[牌名, 相似度, x, y, h]]（补上的对方牌）。返回有补位的帧名列表（要重新 derive）。"""
    todo = [p for p in frames if (done.get(os.path.basename(p)) or {}).get('emb_ver') != EMB_VER]
    if not todo:
        return []
    E0, n0 = base_refs(cards)
    # 这一局 SIFT 高票认出的对方牌：每种取几张（时间上分散）
    seen = {}
    for p in frames:
        e = done.get(os.path.basename(p)) or {}
        if not usable(e):
            continue
        for n, v, x, y, h in e.get('det') or []:
            if v >= AUTO_V and n in cand_names and y < 0.46:
                seen.setdefault(n, []).append((p, x, y, h))
    auto_imgs, auto_names = [], []
    for n, lst in seen.items():
        for p, x, y, h in lst[::max(1, len(lst) // AUTO_PER)][:AUTO_PER]:
            auto_imgs.append(card_crop(read_im(p), x, y, h))
            auto_names.append(n)
    R = np.concatenate([E0, embed(auto_imgs)]) if auto_imgs else E0
    names = np.array(list(n0) + auto_names)
    ok = np.array([n in cand_names for n in names])
    changed = []
    for p in todo:
        k = os.path.basename(p)
        e = done[k]
        e['emb'], e['emb_ver'] = [], EMB_VER
        if not usable(e) or e.get('show'):
            continue
        L = layout_get(e)
        rows = {r: [] for r in OP_ROWS}
        for n, v, x, y, h in e.get('det') or []:
            r = classify(L, x, y, h, v)
            if r in rows:
                rows[r].append((x, y, h))
        slots = [g for r in OP_ROWS for g in gaps(rows[r])]
        if not slots:
            continue
        im = read_im(p)
        F = embed([card_crop(im, x, y, h) for x, y, h in slots])
        for (x, y, h), f in zip(slots, F):
            sim = R @ f
            sim[~ok] = -9
            i = int(np.argmax(sim))
            top = names[i]
            lead = float(sim[i] - np.max(np.where(names == top, -9, sim)))
            if sim[i] >= EMB_SIM and lead >= EMB_LEAD:
                e['emb'].append([str(top), round(float(sim[i]), 3), round(x, 4), round(y, 4), round(h, 4)])
        if e['emb']:
            changed.append(k)
    return changed
