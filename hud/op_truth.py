"""对方半场的标准答案：抽帧人工核对对方两排（从左到右的牌名），评估对方半场的逐帧识别。

python hud/op_truth.py sample 帧目录 [张数=30]     抽帧（正常对局画面、没有看牌面板），画出对方半场 + HUD 认出的牌，
                                                  存到 帧目录/op_label/，并写 op_truth_draft.json（HUD 的结果当草稿）
python hud/op_truth.py eval 帧目录                 按 帧目录/op_truth.json（人工改好的草稿）评估：逐帧对 / 多认 / 漏认

标注：看 op_label/*.jpg（框上的编号对应草稿里的顺序），把草稿里认错的改掉、漏的按从左到右的位置补上、多的删掉，
另存为 op_truth.json。看不清的帧整个删掉。
"""
import collections
import json
import os
import random
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import timeline  # noqa: E402

OP_ROWS = ('对方远程', '对方近战')


def usable(e):
    return (e.get('sharp', 0) >= e.get('smin', 40) and e.get('panel', 0) <= timeline.PANEL_MAX and not e.get('show')
            and None not in (e.get('score') or [None]))


def sample(d, n=30, seed=7):
    with open(os.path.join(d, 'scan.json'), encoding='utf-8') as f:
        sc = json.load(f)
    keys = sorted((k for k, e in sc.items() if usable(e) and any(e['rows'].get(r) for r in OP_ROWS)), key=timeline.frame_time)
    random.seed(seed)
    pick = sorted(random.sample(keys, min(n, len(keys))), key=timeline.frame_time)
    out_dir = os.path.join(d, 'op_label')
    os.makedirs(out_dir, exist_ok=True)
    draft = []
    import board
    import layout
    for k in pick:
        im = cv2.imdecode(np.fromfile(os.path.join(d, k), np.uint8), cv2.IMREAD_COLOR)
        H, W = im.shape[:2]
        L = layout.get(im)
        rows = {r: [] for r in OP_ROWS}
        for nm, v, x, y, h in sc[k].get('det') or []:
            r = board.classify(L, x, y, h, v)
            if r in rows:
                rows[r].append((x, nm, y, h))
        img = im[int(0.08 * H):int(0.56 * H), int(0.15 * W):int(0.83 * W)].copy()
        ox, oy = int(0.15 * W), int(0.08 * H)
        for r in OP_ROWS:
            rows[r].sort()
            for i, (x, nm, y, h) in enumerate(rows[r]):
                cx, cy, hh = x * W - ox, y * H - oy, h * H
                cv2.rectangle(img, (int(cx - hh * 0.35), int(cy - hh / 2)), (int(cx + hh * 0.35), int(cy + hh / 2)), (0, 255, 255), 3)
                cv2.putText(img, f'{"R" if r == "对方远程" else "M"}{i}', (int(cx - hh * 0.3), int(cy + hh / 2 - 8)),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 255, 255), 3)
        cv2.imencode('.jpg', cv2.resize(img, None, fx=0.5, fy=0.5), [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tofile(
            os.path.join(out_dir, k))
        draft.append({'frame': k, **{r: [nm for _x, nm, _y, _h in rows[r]] for r in OP_ROWS}})
    with open(os.path.join(d, 'op_truth_draft.json'), 'w', encoding='utf-8') as f:
        json.dump(draft, f, ensure_ascii=False, indent=1)
    print(f'{len(pick)} 帧 → {out_dir}，草稿 op_truth_draft.json')


def evaluate(d, verbose=True):
    with open(os.path.join(d, 'op_truth.json'), encoding='utf-8') as f:
        truth = json.load(f)
    with open(os.path.join(d, 'scan.json'), encoding='utf-8') as f:
        sc = json.load(f)
    states = dict((os.path.basename(k), e) for k, e in ((k, sc[k]) for k in sc))
    tp = fp = fn = 0
    bad = collections.Counter()
    for t in truth:
        e = states.get(t['frame'])
        if not e:
            continue
        for r in OP_ROWS:
            want, got = collections.Counter(t.get(r, [])), collections.Counter(e['rows'].get(r, []))
            tp += sum((want & got).values())
            for nm, c in (got - want).items():
                fp += c
                bad[f'多{r[2:]}{nm}'] += c
            for nm, c in (want - got).items():
                fn += c
                bad[f'漏{r[2:]}{nm}'] += c
    prec, rec = tp / max(1, tp + fp), tp / max(1, tp + fn)
    if verbose:
        print(f'对方半场 {len(truth)} 帧：对 {tp}，多认 {fp}，漏认 {fn}；准确率 {prec:.1%}，召回 {rec:.1%}')
        print('  最多的：' + '、'.join(f'{k}×{v}' for k, v in bad.most_common(8)))
    return tp, fp, fn


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) >= 3 and sys.argv[1] == 'sample':
        sample(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 30)
    elif len(sys.argv) >= 3 and sys.argv[1] == 'eval':
        evaluate(sys.argv[2])
    else:
        print(__doc__)
