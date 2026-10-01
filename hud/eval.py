"""识别效果测试。

python hud/eval.py shots 截图1.png 截图2.png …   对截图跑一遍：右侧展示区 + 墓场网格
python hud/eval.py synth [张数]                    用卡图模拟游戏画面（裁边、缩小、边框、模糊、压缩），统计准确率
python hud/eval.py log [对局目录]                  重新识别 HUD 存下的展示截图（cache/log/…）
python hud/eval.py ai [对局目录]                   人机对局：和游戏日志里 AI 的出牌核对，算准确率
python hud/eval.py board 帧目录 [--det]             和人工核对的我方场面（帧目录/truth.json）比较：逐帧两排 + 时间线进场离场
                                                   --det：用缓存里分排前的原始检测按当前 board.classify 重新分排（调分排规则不用重扫）
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


def ai_check(m, d):
    """人机对局：拿游戏日志里 AI 的出牌（[AIPCP] Playing card）核对 HUD 记录（cache/log/<时间>/log.json）。"""
    import json
    import re
    if not d:
        ds = sorted(glob.glob(os.path.join(HERE, 'cache', 'log', '*')))
        d = ds[-1] if ds else ''
    with open(os.path.join(d, 'log.json'), encoding='utf-8') as f:
        hud = [it for r in json.load(f) for it in r]
    by_id = {c['id']: c['name'] for c in m.cards if c.get('id')}
    sec = lambda t: int(t[:2]) * 3600 + int(t[3:5]) * 60 + float(t[6:])  # noqa: E731
    day = os.path.basename(d)[:8]
    plays = []
    for p in glob.glob(os.path.expandvars(rf'%USERPROFILE%\AppData\LocalLow\CDProjektRED\Gwent\GwentClient-{day}*.log')):
        with open(p, encoding='utf-8', errors='replace') as f:
            for line in f:
                mt = re.match(r'(\d\d:\d\d:\d\d\.\d+).*Playing card: \[T:(.*?), ID:(\d+)', line)
                if mt:
                    plays.append((sec(mt.group(1)), by_id.get(int(mt.group(3)), mt.group(2))))
    t0 = sec(hud[0]['t']) - 60 if hud else 0
    t1 = sec(hud[-1]['t']) + 10 if hud else 0
    plays = sorted(p for p in plays if t0 <= p[0] <= t1)
    used, hit = set(), 0
    for t, name in plays:
        j = next((j for j, it in enumerate(hud) if j not in used and it['name'] == name
                  and -1 <= sec(it['t']) - t <= 8), None)
        if j is None:
            print(f'  漏记/认错  {time.strftime("%H:%M:%S", time.gmtime(t))}  {name}')
        else:
            used.add(j)
            hit += 1
    extra = [it for j, it in enumerate(hud) if j not in used]
    for it in extra:
        print(f'  多记（可能是己方或悬停）  {it["t"]}  {it["name"]}')
    print(f'AI 出牌 {len(plays)} 张，HUD 认对 {hit}；HUD 多出 {len(extra)} 条')


def _sec(s):
    h, m, x = s.split(':')
    return int(h) * 3600 + int(m) * 60 + float(x)


def board_check(d, use_det=False):
    """我方场面和 truth.json 比：
    逐帧：正常对局画面里（小局内、离每次真实变化 3 秒以外），我方近战 / 远程每排认出的牌名和真实场面比（多重集合），
    统计对 / 多认（含手牌当成场上）/ 漏认，另外数场上的牌被分进手牌的次数；
    时间线：Tracker 推出的我方两排进场 / 离场和真实事件按牌名、排、8 秒内对应。"""
    import collections
    import json
    import board
    import layout
    import timeline
    with open(os.path.join(d, 'truth.json'), encoding='utf-8') as f:
        truth = json.load(f)
    with open(os.path.join(d, 'scan.json'), encoding='utf-8') as f:
        scan = json.load(f)
    det = None
    if use_det:
        if any('det' in e for e in scan.values()):
            det = {k: [[None] + e for e in v['det']] for k, v in scan.items() if 'det' in v}
        else:
            with open(os.path.join(d, 'det.json'), encoding='utf-8') as f:
                det = json.load(f)
    rounds = [(_sec(a), _sec(b)) for a, b in truth['rounds']]
    tev = sorted((_sec(t), k, r, n) for t, k, r, n in truth['me'])
    rows_me = ('我方近战', '我方远程')
    ctype = timeline.CARD_TYPE
    states = []
    for k in sorted(scan, key=timeline.frame_time):
        ent = dict(scan[k])
        ent.setdefault('prof', '4:3' if ent.get('smin') == 200 else '16:9')
        ent['smin'] = layout.PROFILES[ent['prof']]['sharp_min']
        if det is not None and k in det:
            L = layout.PROFILES[ent['prof']]
            rows = {r: [] for r in board.ROW_KEYS}
            for _r, n, v, x, y, h in det[k]:
                r = board.classify(L, x, y, h, v)
                if r:
                    rows[r].append((x, n))
            ent['rows'] = {r: [n for _x, n in sorted(cs)] for r, cs in rows.items()}
        states.append((timeline.frame_time(k), ent))
    states = timeline.fill_gaps(states)   # 和导出一样补上动画 / 遮挡瞬间的漏认
    # 逐帧
    tp = fp = fn = to_hand = nfr = 0
    bad = collections.Counter()
    for t, ent in states:
        if not any(a <= t <= b for a, b in rounds) or any(abs(t - e[0]) < 3 for e in tev):
            continue
        sc = ent.get('score') or (None, None)
        if ent['sharp'] < ent['smin'] or sc[0] is None or sc[1] is None:
            continue
        nfr += 1
        r0 = next(a for a, b in rounds if a <= t <= b)
        cur = collections.Counter()
        for te, kind, r, n in tev:
            if r0 <= te <= t:
                cur[(r, n)] += 1 if kind == '进场' else -1
        seen = collections.Counter((r, n) for r in rows_me for n in ent['rows'].get(r, []) if ctype.get(n) != '战术')
        hand = collections.Counter(ent['rows'].get('手牌', []))
        for key in set(cur) | set(seen):
            c, s = max(0, cur[key]), seen[key]
            tp += min(c, s)
            if s > c:
                fp += s - c
                bad[('多', key[0], key[1])] += s - c
            if c > s:
                fn += c - s
                bad[('漏', key[0], key[1])] += c - s
                if hand[key[1]]:
                    to_hand += min(c - s, hand[key[1]])
    print(f'逐帧（{nfr} 帧）：对 {tp}，多认 {fp}，漏认 {fn}（其中被当成手牌 {to_hand}）；'
          f'准确率 {tp / max(1, tp + fp):.1%}，召回 {tp / max(1, tp + fn):.1%}')
    print('  最多的：' + '、'.join(f'{a}{r[2:]}{n}×{c}' for (a, r, n), c in bad.most_common(8)))
    # 时间线
    tr = timeline.Tracker()
    for t, ent in states:
        tr.update(t, ent)
    evs = [(t, k, r, n) for t, k, side, n, r in tr.finish() if side == '我方' and k in ('打出', '进场', '离场', '回手', '移动')]
    flat = []
    for t, k, r, n in evs:
        if k == '移动':
            a, b = r.split('→')
            flat += [(t, '离场', a, n), (t, '进场', b, n)]
        else:
            flat.append((t, '进场' if k in ('打出', '进场') else '离场', r, n))
    flat = [e for e in flat if e[2] in rows_me]
    used, miss = set(), []
    for te, kind, r, n in tev:
        j = next((j for j, e in enumerate(flat) if j not in used and e[1:] == (kind, r, n) and abs(e[0] - te) <= 8), None)
        if j is None:
            miss.append((te, kind, r, n))
        else:
            used.add(j)
    extra = [e for j, e in enumerate(flat) if j not in used]
    print(f'时间线：真实 {len(tev)} 条，对上 {len(tev) - len(miss)}，漏 {len(miss)}，多出 {len(extra)}')
    for te, kind, r, n in miss:
        print(f'  漏  {timeline.hms(te)} {kind} {n}（{r}）')
    for te, kind, r, n in extra:
        print(f'  多  {timeline.hms(te)} {kind} {n}（{r}）')
    return tp, fp, fn, len(miss), len(extra)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    if sys.argv[1] == 'board':
        board_check(sys.argv[2], '--det' in sys.argv)
        return 0
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
    elif cmd == 'ai':
        ai_check(m, sys.argv[2] if len(sys.argv) > 2 else '')
    return 0


if __name__ == '__main__':
    sys.exit(main())
