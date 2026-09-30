"""把场面时间线导出成对局簿的 v2 对局代码。

python hud/export.py 帧目录 [日期YYYYMMDD] [--jobs=4] [--deck=卡组代码或对局簿备份路径]      （没扫过的帧会先扫描，结果缓存在 帧目录/scan.json）
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
import deck  # noqa: E402
import timeline  # noqa: E402
from matcher import Matcher  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROW = {'对方远程': 'r', '对方近战': 'm', '我方近战': 'm', '我方远程': 'r'}


def stable_scores(states, need=2):
    """[(时间, (我方, 对方))]：连续 need 帧读到同样的双方总分才算；一下跳太多（读错一位）不要。"""
    out, last, run = [], None, 0
    for t, ent in states:
        sc = ent.get('score')
        if not sc or sc[0] is None or sc[1] is None or ent.get('sharp', 0) < ent.get('smin', 300):
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


def turn_runs(states, need=2):
    """[(开始时间, 'me'|'op')]：连续 need 帧一致才算换人（只看正常对局画面）。"""
    out, last, run = [], None, 0
    for t, ent in states:
        sc = ent.get('score') or (None, None)
        if ent.get('sharp', 0) < ent.get('smin', 300) or sc[0] is None or sc[1] is None or not ent.get('turn'):
            continue
        run = run + 1 if ent['turn'] == last else 1
        if run == 1:
            start = t
        last = ent['turn']
        if run == need and (not out or out[-1][1] != last):
            out.append((start, last))
    return out


def infer_passes(log, runs):
    """每个小局最后一段：一方连续行动两次以上、中间没换人 = 另一方在这段开始时停牌。返回 [(时间, 停牌方, 小局)]。"""
    out = []
    rounds = sorted({x['r'] for x in log})
    for r in rounds:
        acts = [x for x in log if x['r'] == r and x['a'] in ('play', 'leader') and 'ts' in x]
        if not acts:
            continue
        t0, t1 = acts[0]['ts'], acts[-1]['ts']
        rr = [(t, w) for t, w in runs if t <= t1]
        if not rr:
            continue
        start, owner = rr[-1]
        start = max(start, t0)
        n = sum(1 for x in acts if x['ts'] >= start - 1 and x['who'] == owner)
        if n >= 2:
            out.append((start, 'op' if owner == 'me' else 'me', r))
    return out


def build_game(events, scores, date, cards_by_name, my_fac='NR', leader='皇家激励', has_show=True, my_deck=None,
               runs=None):
    """has_show=False（iPad 录屏没有右侧展示）时，对方可收集单位的进场也按打出记。
    my_deck（{牌名: 张数}）：我方只认卡组里的牌和衍生牌，其余当误识别丢掉。"""
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
        x.update(id=f'e{n}', r=r, vt=vt(t), ts=t)
        log.append(x)
        if x['a'] in ('play', 'summon') and x.get('row'):
            recent.append((t, x['who'], x['c'], {'m': '近战', 'r': '远程'}[x['row']], '打出' if x['a'] == 'play' else '进场'))

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
    recent = []  # [(时间, 方, 牌名, 排, 类型)] 最近的打出 / 进场（判断完当前这张再加进去）

    def summoner(t, who, name, row):
        """这张进场的牌是不是由几秒内刚打出的牌带出来的：同一排同名（复制、召唤同名牌），或卡面写着“召唤”的牌。"""
        for t2, w2, n2, r2, k2 in reversed(recent):
            if t - t2 > 8:
                break
            if w2 != who:
                continue
            if n2 == name and r2 == row[-2:] and t - t2 <= 4:
                return n2
            if n2 != name and k2 == '打出' and '召唤' in (cards_by_name.get(n2, {}).get('text') or ''):
                return n2
        return None

    for t, kind, side, name, row in events:
        c = cards_by_name.get(name, {})
        if my_deck and side == '我方' and name and name not in my_deck and c.get('set') != 'token':
            continue
        if kind == '离手' and c.get('type') == '特殊' and side == '我方':
            # 我方手牌里的特殊牌消失（不是闪烁）：打出了特殊牌（特殊牌不上场，只能这样看）
            flush_scores(t)
            push({'who': 'me', 'a': 'play', 'c': name, 'side': 'me', 'hud': '手牌里消失的特殊牌'}, t)
            pending_step = True
            continue
        if row == '手牌' or kind in ('离手', '抽到') or c.get('type') == '战术':
            continue  # 战术牌：对局簿开局自动放在先手方近战排最左边
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
        elif kind == '进场' and (via := summoner(t, who, name, row)):
            # 由刚打出的牌带出来（同名复制、从牌组召唤）：记成召唤，带 via，对局簿对应到引擎自动生成的单位
            push({'who': who, 'a': 'summon', 'c': name, 'row': ROW.get(row, 'm'), 'side': who, 'via': via,
                  'hud': '推测由这张牌带出'}, t)
        elif kind == '进场' and (who == 'me' or not has_show) and c.get('set') != 'token' and c.get('type') in ('单位', '神器'):
            # 我方可收集的单位 / 神器落到场上：多半是从手牌打出（从牌组召唤的也会落在这里，标出来核对）
            push({'who': who, 'a': 'play', 'c': name, 'row': ROW.get(row, 'm'), 'side': who,
                  'hud': '没看到手牌少一张'}, t)
            pending_step = True
            first_side = first_side or who
        elif kind == '进场':
            push({'who': who, 'a': 'summon', 'c': name, 'row': ROW.get(row, 'm'), 'side': who,
                  'hud': '进场（召唤/生成，或没看到打出）'}, t)
            pending_step = True
        elif kind == '领袖':
            x = {'who': who, 'a': 'leader'}
            if who == 'me' and leader:
                x['c'] = leader
            push(x, t)
            pending_step = True
        elif kind in ('离场', '移动', '回手'):
            push({'who': who, 'a': 'note', 'c': f'画面：{name} {kind}（{row}）'}, t)
    flush_scores(float('inf'))
    if round_score is not None or (log and log[-1]['r'] == r):
        me, op = round_score or ('', '')
        res = '' if me == '' else ('W' if me > op else 'L' if me < op else 'D')
        rounds.append({'res': res, 'me': str(me), 'op': str(op), 'hm': None, 'ho': None, 'sec': None})
    # 推出来的停牌插到对应位置，重新编号；内部用的时间戳去掉
    for ts, who, rr in infer_passes(log, runs or []):
        i = next((i for i, x in enumerate(log) if x['r'] == rr and x.get('ts', 0) >= ts and x['a'] != 'real'), None)
        rec = {'who': who, 'a': 'pass', 'r': rr, 'vt': vt(ts), 'ts': ts, 'hud': '由回合顺序推出'}
        log.insert(i if i is not None else len(log), rec)
    for i, x in enumerate(log):
        x['id'] = f'e{i + 1}'
        x.pop('ts', None)
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
    jobs = next((int(a[7:]) for a in sys.argv if a.startswith('--jobs=')), 1)
    m = Matcher()
    states = timeline.scan_dir(m, d, jobs)
    tr = timeline.Tracker()
    for t, ent in states:
        tr.update(t, ent)
    events = tr.finish()
    scores = stable_scores(states)
    has_show = any(ent.get('show') for _t, ent in states) or not any(ent.get('smin') == 200 for _t, ent in states)
    spec = next((a[7:] for a in sys.argv if a.startswith('--deck=')), None)
    my_deck = deck.load(spec, m.cards)
    game = build_game(events, scores, date, {c['name']: c for c in m.cards}, has_show=has_show, my_deck=my_deck,
                      runs=turn_runs(states))
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
