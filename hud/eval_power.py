"""战力读数评估：帧目录/power_truth.json（人工看图标的场上牌战力）对比 digits.Reader 的读数。

python hud/eval_power.py 帧目录
  原始：power_cands 的第一候选（基础战力已知、白色数字直接取基础战力）
  缓存：scan.json 里的 pw（读数再和总分一起纠错之后）
"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import board  # noqa: E402
import digits  # noqa: E402
import layout  # noqa: E402
from matcher import load_cards  # noqa: E402


def main():
    d = sys.argv[1]
    truth = json.load(open(os.path.join(d, 'power_truth.json'), encoding='utf-8'))
    scan = json.load(open(os.path.join(d, 'scan.json'), encoding='utf-8'))
    cards = {c['name']: c for c in load_cards()}
    r = digits.Reader()
    ok_raw = ok_pw = 0
    bad = []
    for t in truth:
        im = cv2.imdecode(np.fromfile(os.path.join(d, t['frame']), np.uint8), cv2.IMREAD_COLOR)
        c = cards.get(t['name'], {})
        base = int(c['power']) if str(c.get('power')).isdigit() else None
        ent0 = scan.get(t['frame'], {})
        L = layout.get(im)
        same = sorted((x, y, h) for n, v, x, y, h in ent0.get('det', []) if board.classify(L, x, y, h, v) == t['row'])
        hs = board.row_heights(L, same)
        hh = next((h for (x, _y, _h), h in zip(same, hs) if abs(x - t['x']) < 1e-3), t['h'])
        cands = r.power_cands(im, t['x'], t['y'], hh, base)
        raw = cands[0][0] if cands else None
        ent = scan.get(t['frame'], {})
        names = ent.get('rows', {}).get(t['row'], [])
        pws = (ent.get('pw') or {}).get(t['row'], [])
        # 同一排里按 x 找回这张牌在 rows 里的位置
        xs = sorted(x for n, v, x, y, h in ent.get('det', []) if abs(y - t['y']) < 0.06)
        i = next((i for i, x in enumerate(xs) if abs(x - t['x']) < 1e-3), None)
        pw = pws[i] if i is not None and i < len(pws) and i < len(names) and names[i] == t['name'] else 'n/a'
        ok_raw += raw == t['power']
        ok_pw += pw == t['power']
        if raw != t['power'] or pw != t['power']:
            bad.append(f"  {t['frame'][:8]} {t['row']} {t['name']} 真 {t['power']} 原始 {raw} 纠错后 {pw}")
    n = len(truth)
    print(f'{n} 张：原始读数对 {ok_raw}（{ok_raw / n:.0%}），纠错后对 {ok_pw}（{ok_pw / n:.0%}）')
    print('\n'.join(bad))


if __name__ == '__main__':
    main()
