"""把场面时间线导出成对局簿的 v2 对局代码。

python hud/export.py 帧目录 [日期YYYYMMDD]      （先用 timeline.py 扫过，读 帧目录/scan.json）
输出 帧目录/game.json 和 帧目录/game_v2.txt，可直接在对局簿“导入对局”里粘贴。

对应关系（看不准的都写成备注，不让推算引擎误用）：
- 打出（对方有展示、我方手牌少了同名牌）→ 打出记录，带排；对方只展示没落地 → 打出特殊牌
- 其他进场（召唤、生成，或没看到展示的打出）→ 召唤记录，带 x.hud 标记，对局簿里对应到引擎自动生成的单位
- 离场、移动 → 备注（引擎自己推算摧毁 / 移动，这里只留给人看）
- 每一手之后稳定的总分 → 真实比分核对点（偏差报告用）
"""
import json
import os
import subprocess
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import timeline  # noqa: E402
from matcher import Matcher  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROW = {'对方远程': 'r', '对方近战': 'm', '我方近战': 'm', '我方远程': 'r'}


def stable_scores(states, need=2):
    """[(时间, (我方, 对方))]：连续 need 帧读到同样的双方总分才算；一下跳太多（读错一位）不要。"""
    out, last, run = [], None, 0
    for t, ent in states:
        sc = ent.get('score')
        if not sc or sc[0] is None or sc[1] is None or ent.get('sharp', 0) < 300:
            continue
        pair = (sc[1], sc[0])  # scores() 返回 (对方, 我方)
        if max(pair) > 250:
            continue
        run = run + 1 if pair == last else 1
        last = pair
        prev = out[-1][1] if out else (0, 0)
        jump = max(abs(pair[0] - prev[0]), abs(pair[1] - prev[1]))
        # 跳变大（新小局归零、或读错）要连续更多帧一致才采纳；
        # 一方分数掉到一半以下多半是少读了一位（火焰挡住），要持续很久才信
        halved = any(p >= 10 and v < p * 0.5 for v, p in zip(pair, prev)) and pair != (0, 0)
        n_need = need + 8 if halved else need if jump <= 15 else need + 3
        if run == n_need and pair != prev:
            out.append((t, pair))
    return out


def build_game(events, scores, date, cards_by_name, my_fac='NR', leader='皇家激励'):
    log, rounds = [], []
    r, n = 0, 0
    t_start = min([e[0] for e in events] + [s[0] for s in scores]) if events or scores else 0
    si = 0
    last_real = None
    pending_step = False
    round_score = None

    def vt(t):
        s = int(t - t_start)
        return f'{s // 60}:{s % 60:02d}'

    def push(x, t):
        nonlocal n
        n += 1
        x.update(id=f'e{n}', r=r, vt=vt(t))
        log.append(x)

    def flush_scores(upto):
        """把 upto 之前的稳定总分里、最后一个写成核对点（每一手之后一个）。"""
        nonlocal si, last_real, pending_step, round_score
        best = None
        while si < len(scores) and scores[si][0] <= upto:
            best = scores[si]
            si += 1
        if best:
            round_score = best[1]
            if pending_step and best[1] != last_real:
                push({'who': 'me', 'a': 'real', 'v': f'{best[1][0]}:{best[1][1]}'}, best[0])
                last_real = best[1]
                pending_step = False

    first_side = None
    for t, kind, side, name, row in events:
        if row == '手牌' or kind in ('离手', '抽到'):
            continue
        flush_scores(t)
        who = 'me' if side == '我方' else 'op'
        if kind == '小局结束':
            me, op = round_score or ('', '')
            res = '' if me == '' else ('W' if me > op else 'L' if me < op else 'D')
            rounds.append({'res': res, 'me': str(me), 'op': str(op), 'hm': None, 'ho': None, 'sec': None})
            r += 1
            last_real, round_score = None, None
            continue
        c = cards_by_name.get(name, {})
        if kind == '打出':
            x = {'who': who, 'a': 'play', 'c': name, 'side': who}
            if row in ROW and c.get('type') != '特殊':
                x['row'] = ROW[row]
            push(x, t)
            pending_step = True
            first_side = first_side or who
        elif kind == '展示':  # 对方特殊牌（或展示了但没看到落地）
            push({'who': 'op', 'a': 'play', 'c': name, 'side': 'op', 'hud': '只看到展示'}, t)
            pending_step = True
            first_side = first_side or who
        elif kind == '进场' and who == 'me' and c.get('set') != 'token' and c.get('type') == '单位':
            # 我方可收集的单位落到场上：多半是从手牌打出（从牌组召唤的也会落在这里，标出来核对）
            push({'who': who, 'a': 'play', 'c': name, 'row': ROW.get(row, 'm'), 'side': who,
                  'hud': '没看到手牌少一张'}, t)
            pending_step = True
            first_side = first_side or who
        elif kind == '进场':
            push({'who': who, 'a': 'summon', 'c': name, 'row': ROW.get(row, 'm'), 'side': who,
                  'hud': '进场（召唤/生成，或没看到打出）'}, t)
            pending_step = True
        elif kind in ('离场', '移动', '回手'):
            push({'who': who, 'a': 'note', 'c': f'画面：{name} {kind}（{row}）'}, t)
    flush_scores(float('inf'))
    if round_score is not None or (log and log[-1]['r'] == r):
        me, op = round_score or ('', '')
        res = '' if me == '' else ('W' if me > op else 'L' if me < op else 'D')
        rounds.append({'res': res, 'me': str(me), 'op': str(op), 'hm': None, 'ho': None, 'sec': None})
    facs = Counter(cards_by_name[x['c']]['fac'] for x in log
                   if x['who'] == 'op' and x.get('c') in cards_by_name and cards_by_name[x['c']]['fac'] != 'NE')
    return {
        'date': f'{date[:4]}-{date[4:6]}-{date[6:8]}', 'myF': my_fac, 'leader': leader,
        'fac': facs.most_common(1)[0][0] if facs else 'NR', 'opLeader': None,
        'coin': {'me': '先', 'op': '后'}.get(first_side), 'rounds': rounds, 'log': log,
        'note': f'hud 自动识别（{time.strftime("%Y-%m-%d %H:%M")}），召唤记录和备注需要核对',
    }


def to_v2(game_path):
    return subprocess.run(['node', os.path.join(HERE, 'to_v2.js'), game_path], capture_output=True, text=True,
                          encoding='utf-8', check=True).stdout


def main():
    d = sys.argv[1]
    date = next((a for a in sys.argv[2:] if a.isdigit()), time.strftime('%Y%m%d'))
    m = Matcher()
    states = timeline.scan_dir(m, d)
    tr = timeline.Tracker()
    for t, ent in states:
        tr.update(t, ent)
    events = tr.finish()
    scores = stable_scores(states)
    game = build_game(events, scores, date, {c['name']: c for c in m.cards})
    gp = os.path.join(d, 'game.json')
    with open(gp, 'w', encoding='utf-8') as f:
        json.dump(game, f, ensure_ascii=False, indent=1)
    code = to_v2(gp)
    with open(os.path.join(d, 'game_v2.txt'), 'w', encoding='utf-8') as f:
        f.write(code)
    kinds = Counter(x['a'] for x in game['log'])
    print(f"{len(game['rounds'])} 小局，记录 {len(game['log'])} 条：{dict(kinds)}；对方 {game['fac']}，先后手 {game['coin']}")
    for i, R in enumerate(game['rounds']):
        print(f"  第 {i + 1} 小局 {R['res']} {R['me']}:{R['op']}")
    print(code)


if __name__ == '__main__':
    main()
