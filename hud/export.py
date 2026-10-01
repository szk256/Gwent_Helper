"""把场面时间线导出成对局簿的 v2 对局代码。

python hud/export.py 帧目录 [日期YYYYMMDD] [--jobs=4] [--deck=卡组代码或对局簿备份路径] [--sync-power]      （没扫过的帧会先扫描，结果缓存在 帧目录/scan.json）
输出 帧目录/game.json 和 帧目录/game_v2.txt，可直接在对局簿“导入对局”里粘贴。

对应关系（看不准的都写成备注，不让推算引擎误用）：
- 打出（对方有展示、我方手牌少了同名牌）→ 打出记录，带排；对方只展示没落地 → 打出特殊牌
- 其他进场（召唤、生成，或没看到展示的打出）→ 召唤记录，带 x.hud 标记，对局簿里对应到引擎自动生成的单位
- 离场、移动 → 备注（引擎自己推算摧毁 / 移动，这里只留给人看）
- 每一手之后稳定的总分 → 真实比分核对点（偏差报告用）
"""
import json
import re
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
TGT_WORDS = re.compile(r'伤害|增益|锁定|摧毁|重置')


def has_shield_kw(card):
    """卡面自带护盾（第一段关键词里有“护盾”），落地时就有，不用记。"""
    first = re.split(r'\s*/\s*', card.get('text') or '')[0]
    return bool(re.search(r'(^|、)护盾([。.、]|$)', first))


DECK_PLAY = re.compile(r'从(?:己方)?牌组(?:中)?打出')


def target_text(card):
    """这张牌打出时要指定目标的那段效果文字（特殊牌第一段、单位的“部署”段），没有返回 ''。"""
    text = card.get('text') or ''
    segs = [s.strip() for s in text.split('/')]
    seg = segs[0] if card.get('type') == '特殊' else next((s for s in segs if s.startswith('部署')), '')
    if not re.search(r'(对|使|摧毁|锁定|重置|放逐)\s*\d+\s*(个|名)', seg) or '所有' in seg or '每' in seg:
        return ''
    return seg
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


def depart_reason(states, t, side):
    """离场原因：离场前后各看几秒——墓场张数的字形图案变了 = 摧毁（进墓场）；否则手牌数 +1 = 回手；都没变 = 放逐。
    数据不够返回 None。side：'对方' / '我方'。"""
    import digits
    k = 0 if side == '对方' else 1

    def mode(vals):
        vals = [v for v in vals if v is not None]
        return Counter(vals).most_common(1)[0][0] if vals else None
    before = [e.get('cnt') for tt, e in states if t - 8 <= tt <= t - 0.5 and e.get('cnt')]
    after = [e.get('cnt') for tt, e in states if t + 1.5 <= tt <= t + 10 and e.get('cnt')]
    if not before or not after:
        return None
    gb, ga = mode(c['gsig'][k] for c in before), mode(c['gsig'][k] for c in after)
    hb, ha = mode(c['hand'][k] for c in before), mode(c['hand'][k] for c in after)
    d = digits.sig_diff(gb, ga)
    if d is not None and d > 8:
        return '摧毁'
    if hb is not None and ha is not None and ha > hb:
        return '回手'
    if d is not None and hb is not None and ha is not None:
        return '放逐'
    return None


def build_game(events, scores, date, cards_by_name, my_fac='NR', leader='皇家激励', has_show=True, my_deck=None,
               runs=None, extra=None, sync_states=None, states=None, deck_filter=True, t0=None, review=None):
    """has_show=False（iPad 录屏没有右侧展示）时，对方可收集单位的进场也按打出记。
    my_deck（{牌名: 张数}）：我方只认卡组里的牌和衍生牌，其余当误识别丢掉。
    sync_states（[(时间, 扫描结果)]）：给了就在每个核对点前，把画面上读到、和上次不同的单位战力写成改战力记录
    （对局簿棋盘就是每个单位的实际战力；偏差报告会因此几乎总是一致，核查规则时别开）。
    t0：录屏开始的时刻（秒），记录的“录屏”时间从它算（用户自己的录屏），默认从第一个事件算。
    review：传一个列表进来，HUD 拿不准、需要人看录屏补的地方追加进去（write_review 写成 review.html）。"""
    log, rounds = [], []
    r, n = 0, 0
    t_start = t0 if t0 is not None else (min([e[0] for e in events] + [s[0] for s in scores]) if events or scores else 0)
    si = 0
    last_real = None
    pending_step = False
    round_score = None

    def vt(t):
        s = max(0, int(t - t_start))
        return f'{s // 60}:{s % 60:02d}'

    extra = extra or {}
    step_t = [0.0]   # 最近一手（打出 / 领袖）的时间

    units = {}   # 排 -> [[记录 id, 牌名, 上次的战力]]，按排内位置
    pend_tgt = []  # [(打出记录, 时间, 打出前的 units 快照)]
    st_t = [s[0] for s in states] if states else []

    def row_at(t, rk):
        import bisect
        i = bisect.bisect_right(st_t, t) - 1
        if i < 0:
            return None, None
        ent = states[i][1]
        names = ent.get('rows', {}).get(rk, [])
        pws = (ent.get('pw') or {}).get(rk, [])
        keep = [j for j, nm in enumerate(names) if cards_by_name.get(nm, {}).get('type') != '战术']
        return [names[j] for j in keep], [pws[j] if j < len(pws) else None for j in keep]

    def resolve_targets(t_after):
        """比较打出前后每个单位的战力：伤害 → 对方掉了的，增益 → 己方涨了的，摧毁 → 没了的；按卡面数值挑最匹配的。"""
        while pend_tgt:
            x, t, snap = pend_tgt.pop(0)
            text = target_text(cards_by_name.get(x['c'], {}))
            nums = [int(v) for v in re.findall(r'(\d+)\s*点', text)]
            want = int(m.group(1)) if (m := re.search(r'(\d+)\s*个', text)) else 1
            cands = []

            def find(names, nm, k):  # 第 k 个叫 nm 的在 names 里的位置
                idx = [j for j, v in enumerate(names) if v == nm]
                return idx[k] if k < len(idx) else None
            for rk, us in snap.items():
                if not us:
                    continue
                n0, p0 = row_at(t - 0.5, rk)
                n1, p1 = row_at(t_after, rk)
                if n0 is None or n1 is None:
                    continue
                enemy = rk.startswith('对方') == (x['who'] == 'me')
                seen = Counter()
                for u in us:  # 按牌名逐张对齐（同名按第几张），别的牌没认出来也不影响
                    k = seen[u[1]]
                    seen[u[1]] += 1
                    j0 = find(n0, u[1], k)
                    if j0 is None:
                        continue
                    j1 = find(n1, u[1], k)
                    if j1 is None:
                        if enemy and ('摧毁' in text or '伤害' in text) and n0.count(u[1]) > n1.count(u[1]):
                            cands.append((0, -99, u[0]))  # 没了：被摧毁
                        continue
                    a_, b_ = p0[j0] if j0 < len(p0) else None, p1[j1] if j1 < len(p1) else None
                    if a_ is None or b_ is None or a_ == b_:
                        continue
                    d = b_ - a_
                    if ('伤害' in text and enemy and d < 0) or ('增益' in text and not enemy and d > 0) or                             ('重置' in text and d != 0) or ('锁定' in text and enemy):
                        fit = min((abs(abs(d) - kk) for kk in nums), default=0)
                        cands.append((fit, -abs(d), u[0]))
            if cands:
                x['tgts'] = [{'uid': c[2]} for c in sorted(cands)[:want]]
                x['hud'] = (x.get('hud', '') + ' 目标由战力变化推出').strip()
    sync_t = [s[0] for s in sync_states] if sync_states else []

    def rowkey(who, rr):
        return ('我方' if who == 'me' else '对方') + ('近战' if rr == 'm' else '远程')

    def sync_powers(t):
        """画面上读到的单位战力和上次不同的，写成改战力记录（整排的牌名顺序对得上才写）。"""
        import bisect
        i = bisect.bisect_right(sync_t, t) - 1
        if i < 1:
            return

        def row_of(ent, rk):
            names = ent.get('rows', {}).get(rk, [])
            pws = (ent.get('pw') or {}).get(rk, [])
            shs = (ent.get('sh') or {}).get(rk, [])
            keep = [j for j, nm in enumerate(names) if cards_by_name.get(nm, {}).get('type') != '战术']
            return ([names[j] for j in keep], [pws[j] if j < len(pws) else None for j in keep],
                    [shs[j] if j < len(shs) else None for j in keep])

        for rk, us in units.items():
            names, pws, _ = row_of(sync_states[i][1], rk)
            names2, pws2, _ = row_of(sync_states[i - 1][1], rk)
            who = 'me' if rk.startswith('我方') else 'op'
            if names == [u[1] for u in us] and names2 == names:
                for u, p, p2 in zip(us, pws, pws2):
                    if p is not None and p == p2 and p != u[2]:  # 连续两帧读到同样的数才写
                        push({'who': who, 'a': 'adj', 'uid': u[0], 'v': str(p), 'hud': '画面读到的战力'}, t)
                        u[2] = p
            # 护盾（左下橙色圆点）：这一步之前 2 秒内、整排牌名对得上的帧都读到同样的有 / 没有才写；落地 4 秒内是动画，不看
            reads = []
            j = i
            while j >= 0 and sync_t[j] >= sync_t[i] - 2.0:
                nm, _, shs = row_of(sync_states[j][1], rk)
                if nm == [u[1] for u in us]:
                    reads.append(shs)
                j -= 1
            if len(reads) < 2:
                continue
            for k, u in enumerate(us):
                vals = {r[k] for r in reads}
                if len(vals) == 1 and None not in vals and vals != {u[3]} and t - u[4] >= 4.0:
                    sh = vals.pop()
                    push({'who': who, 'a': 'adj', 'uid': u[0], 'v': '+盾' if sh else '-盾', 'hud': '画面读到的护盾'}, t)
                    u[3] = sh

    used = Counter()   # 我方每张牌已经打出 / 召唤的次数（不超过卡组张数；回手的退回一次）

    def over_deck(x):
        """我方可收集的牌打出 / 召唤次数超过卡组张数 = 误识别（手牌区时有时无、边缘误判）。"""
        if not my_deck or not deck_filter or x.get('who') != 'me' or x['a'] not in ('play', 'summon'):
            return False
        c = cards_by_name.get(x.get('c'), {})
        if c.get('set') == 'token' or x.get('c') not in my_deck or x.get('via') == x.get('c'):
            return False  # 衍生牌、卡组外、同名复制（不朽者骑兵这类）不占卡组张数
        if used[x['c']] >= my_deck[x['c']]:
            return True
        used[x['c']] += 1
        return False

    def push(x, t):
        nonlocal n
        if over_deck(x):
            if review is not None:
                review.append({'ts': t, 'cat': '丢掉的打出', 'who': x['who'], 'c': x['c'],
                               'text': f"画面上像是又{'打出' if x['a'] == 'play' else '召唤'}了 {x['c']}，但卡组里只有 "
                                       f"{my_deck[x['c']]} 张、已经记满，当成误认丢掉了；真的上场了请补记"})
            return
        ex = extra.get((t, x.get('c'), cur_row[0])) if x['a'] in ('play', 'summon') else None
        if ex:
            if ex.get('pos') is not None and x.get('row'):
                x['pos'] = ex['pos']
            if ex.get('pw') is not None:
                x['pw'] = ex['pw']
        n += 1
        x.update(id=f'e{n}', r=r, vt=vt(t), ts=t)
        log.append(x)
        if x['a'] in ('play', 'leader'):
            step_t[0] = t
        if x['a'] == 'play' and target_text(cards_by_name.get(x.get('c'), {})) and states:
            # 有目标的牌：记下打出前的场面，等下一个核对点再比较前后战力推目标
            pend_tgt.append((x, t, {k: [u[:2] for u in v] for k, v in units.items()}))
        if x['a'] in ('play', 'summon') and x.get('row'):
            us = units.setdefault(rowkey(x['who'], x['row']), [])
            us.insert(min(x.get('pos', len(us)), len(us)), [x['id'], x['c'], x.get('pw'),
                                                            has_shield_kw(cards_by_name.get(x['c'], {})), t])
        if x['a'] in ('play', 'summon') and (x.get('row') or x['a'] == 'play'):
            # 特殊牌没有排，也记进来（水路突袭、骑士册封从牌组打出单位）
            recent.append((t, x['who'], x['c'], {'m': '近战', 'r': '远程'}.get(x.get('row'), ''),
                           '打出' if x['a'] == 'play' else '进场'))

    def flush_scores(upto):
        """把 upto 之前的稳定总分里、最后一个写成核对点（每一手之后一个）。"""
        nonlocal si, last_real, pending_step, round_score
        best = None
        while si < len(scores) and scores[si][0] <= upto:
            if scores[si][0] >= step_t[0] + 1.0:  # 这一手之后至少 1 秒读到的才算（总分更新有延迟）
                best = scores[si]
            si += 1
        if best:
            round_score = best[1]
            if pending_step and best[1] != last_real:
                resolve_targets(best[0])
                if sync_states:
                    sync_powers(best[0])
                push({'who': 'me', 'a': 'real', 'v': f'{best[1][0]}:{best[1][1]}'}, best[0])
                last_real = best[1]
                pending_step = False

    first_side = None
    recent = []  # [(时间, 方, 牌名, 排, 类型)] 最近的打出 / 进场（判断完当前这张再加进去）

    def summoner(t, who, name, row):
        """这张进场的牌是不是由几秒内刚打出的牌带出来的：同一排同名（复制、召唤同名牌），或卡面写着“召唤” / “从牌组打出”的牌。
        返回 (来源牌名, 'summon' | 'play') 或 None。"""
        for t2, w2, n2, r2, k2 in reversed(recent):
            if t - t2 > 8:
                break
            if w2 != who:
                continue
            if n2 == name and r2 == row[-2:] and t - t2 <= 4:
                return n2, 'summon'
            text = cards_by_name.get(n2, {}).get('text') or ''
            if n2 != name and k2 == '打出' and DECK_PLAY.search(text):
                return n2, 'play'   # “从牌组打出”：对局簿记成带 via 的打出（算“己方打出”）
            if n2 != name and k2 == '打出' and '召唤' in text:
                return n2, 'summon'
        return None

    # 比分变化当证据：打出单位 → 这一方总分上涨；打出特殊牌 → 几秒内双方总分有变化。没有证据的当误识别（手牌区误认、拖动）
    def score_delta(t, lo=1.0, hi=10.0):
        before = next((s for tt, s in reversed(scores) if tt <= t - 0.3), None)
        after = next((s for tt, s in scores if t + lo <= tt <= t + hi and s != before), None)
        if before is None:
            return None
        if after is None:
            return (0, 0) if any(t + lo <= tt <= t + hi for tt, _s in scores) else None
        return (after[0] - before[0], after[1] - before[1])

    drop = set()
    mode = os.environ.get('HUD_DECK_MODE', 'cap')   # off / cap（只按卡组张数封顶）/ evidence（再要求比分变化）
    if mode == 'off':
        deck_filter = False
    if my_deck and deck_filter and mode == 'cap':
        # 超出卡组张数时，优先保留有比分变化作证据的那几次（证据一样再按先后）
        occ = {}
        for i, (t, kind, side, name, row) in enumerate(events):
            c = cards_by_name.get(name, {})
            if side != '我方' or name not in my_deck or c.get('set') == 'token':
                continue
            if kind == '离手' and c.get('type') == '特殊':
                d = score_delta(t, 0.5, 12)
                occ.setdefault(name, []).append((0 if d and d != (0, 0) else 1, t, i, None))
            elif kind in ('打出', '进场') and row != '手牌' and c.get('type') in ('单位', '神器'):
                d = score_delta(t, 0.5, 10)
                end = next((j for j in range(i + 1, len(events)) if events[j][1] in ('离场', '小局结束')
                            and (events[j][1] == '小局结束' or (events[j][3] == name and events[j][4] == row))), None)
                occ.setdefault(name, []).append((0 if d and d[0] > 0 else 1, t, i, end))
        for name, lst in occ.items():
            for _ev, _t, i, end in sorted(lst)[my_deck[name]:]:
                drop.add(i)
                if end is not None and events[end][1] == '离场':
                    drop.add(end)
    if my_deck and deck_filter and mode == 'evidence':
        for i, (t, kind, side, name, row) in enumerate(events):
            c = cards_by_name.get(name, {})
            if side != '我方' or name not in my_deck or c.get('set') == 'token':
                continue
            if kind == '离手' and c.get('type') == '特殊':
                d = score_delta(t, 0.5, 12)
                if d is not None and d == (0, 0):
                    drop.add(i)
            elif kind in ('打出', '进场') and row != '手牌' and c.get('type') == '单位':
                d = score_delta(t, 0.5, 10)
                if d is not None and d[0] <= 0:
                    drop.add(i)
                    end = next((j for j in range(i + 1, len(events)) if events[j][1] in ('离场', '小局结束')
                                and (events[j][1] == '小局结束' or (events[j][3] == name and events[j][4] == row))), None)
                    if end is not None and events[end][1] == '离场':
                        drop.add(end)

    cur_row = [None]
    for ei, (t, kind, side, name, row) in enumerate(events):
        if ei in drop:
            continue
        cur_row[0] = row
        c = cards_by_name.get(name, {})
        if my_deck and side == '我方' and name and name not in my_deck and                 (c.get('set') != 'token' or c.get('fac') not in (my_fac, 'NE')):
            continue  # 我方只认卡组里的牌，和本阵营 / 中立的衍生牌
        if kind == '离手' and c.get('type') == '特殊' and side == '我方':
            # 我方手牌里的特殊牌消失（不是闪烁）：打出了特殊牌（特殊牌不上场，只能这样看）
            flush_scores(t)
            k0 = len(log)
            push({'who': 'me', 'a': 'play', 'c': name, 'side': 'me', 'hud': '手牌里消失的特殊牌'}, t)
            pending_step = pending_step or len(log) > k0
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
            units.clear()
            continue
        c = cards_by_name.get(name, {})
        if kind == '打出' and who == 'me' and (src := summoner(t, who, name, row)) and src[0] != name:
            # 一回合只打一张：刚打出召唤 / 从牌组打出的牌，几秒后进场的同名牌是它带出的（手牌里另一张同名牌正好闪了一下）
            push({'who': who, 'a': src[1], 'c': name, 'row': ROW.get(row, 'm'), 'side': who, 'via': src[0],
                  'hud': '推测由这张牌带出'}, t)
        elif kind == '打出':
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
        elif kind == '进场' and (src := summoner(t, who, name, row)):
            # 由刚打出的牌带出来（同名复制、从牌组召唤 / 打出）：带 via，对局簿对应到引擎自动产生的单位
            push({'who': who, 'a': src[1], 'c': name, 'row': ROW.get(row, 'm'), 'side': who, 'via': src[0],
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
        elif kind == '领袖?':
            if review is not None:
                review.append({'ts': t, 'cat': '领袖次数', 'who': 'me', 'c': leader or '',
                               'text': '看到我方点选了领袖（图标黄光），但次数没变：皇家激励触发神赐会重置次数（增益 -1），'
                                       '次数一直显示 1；也可能是取消了。用了的话请补记领袖和目标'})
        elif kind == '领袖':
            x = {'who': who, 'a': 'leader'}
            if who == 'me' and leader:
                x['c'] = leader
            push(x, t)
            pending_step = True
        elif kind in ('离场', '移动', '回手'):
            why = depart_reason(states, t, side) if kind == '离场' and states else None
            if (why == '回手' or kind == '回手') and who == 'me' and used[name] > 0:
                used[name] -= 1   # 回到手牌，可以再打一次
            push({'who': who, 'a': 'note', 'c': f'画面：{name} {why or kind}（{row}）'}, t)
            src = row.split('→')[0]
            u = next((u for u in units.get(src, []) if u[1] == name), None)
            if u:
                units[src].remove(u)
                if kind == '移动' and '→' in row:
                    units.setdefault(row.split('→')[1], []).append(u)
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
    if review is not None:
        for i, x in enumerate(log):
            c, side = x.get('c') or '', '我方' if x['who'] == 'me' else '对方'
            item = None
            if x['a'] == 'leader':
                item = ('领袖目标', f'{side}用了领袖{"（" + c + "）" if c else ""}：HUD 看不出用在谁身上（对方领袖也不知道是哪个技能）')
            elif x['a'] == 'play' and target_text(cards_by_name.get(c, {})) and not x.get('tgts'):
                item = ('效果目标', f'{side}打出 {c}：目标没推出来（{target_text(cards_by_name[c])}）')
            elif x['a'] == 'summon' and x.get('hud', '').startswith('进场（召唤') and                     cards_by_name.get(c, {}).get('set') != 'token':   # 衍生牌只能是生成的
                item = ('打出还是带出', f'{side} {c} 进场，没看到打出：是从手牌打出、还是被别的牌召唤 / 生成？')
            elif x['a'] == 'note' and re.search(r' 离场（', c):
                item = ('离场原因', f'{c[3:]}：看不出是被摧毁、放逐还是回手')
            if item and 'ts' in x:
                review.append({'ts': x['ts'], 'step': i + 1, 'cat': item[0], 'who': x['who'], 'c': c, 'text': item[1]})
        for it in review:
            it['vt'] = vt(it['ts'])
            if 'step' not in it:   # 丢掉的记录：放在它之前最近的一步后面
                it['after'] = max((i + 1 for i, x in enumerate(log) if x.get('ts', 0) <= it['ts']), default=0)
        review.sort(key=lambda it: it['ts'])
    remap = {}
    for i, x in enumerate(log):
        if 'id' in x:
            remap[x['id']] = f'e{i + 1}'
        x['id'] = f'e{i + 1}'
        x.pop('ts', None)
    for x in log:
        if x.get('uid') in remap:
            x['uid'] = remap[x['uid']]
        for tg in x.get('tgts') or []:
            if tg.get('uid') in remap:
                tg['uid'] = remap[tg['uid']]
    facs = Counter(cards_by_name[x['c']]['fac'] for x in log
                   if x['who'] == 'op' and x.get('c') in cards_by_name and cards_by_name[x['c']]['fac'] != 'NE')
    return {
        'date': f'{date[:4]}-{date[4:6]}-{date[6:8]}', 'myF': my_fac, 'leader': leader,
        'fac': facs.most_common(1)[0][0] if facs else 'NR', 'opLeader': None,
        'coin': {'me': '先', 'op': '后'}.get(first_side), 'rounds': rounds, 'log': log,
        'note': f'hud 自动识别（{time.strftime("%Y-%m-%d %H:%M")}），召唤记录和备注需要核对',
    }


def video_start(path):
    """用户录屏的开始时刻（本地，当天秒数）：文件名里的 UTC 时间（如 20261001-0112-44.6374215.mp4 = 01:12:44.6 UTC），
    没有就用“修改时间 − 时长”。2026-10-01 和 HUD 录的帧核对过，误差 3 秒内。"""
    m = re.search(r'(\d{8})-(\d\d)(\d\d)-(\d\d(?:\.\d+)?)', os.path.basename(path))
    off = time.localtime().tm_gmtoff
    if m:
        return (int(m.group(2)) * 3600 + int(m.group(3)) * 60 + float(m.group(4)) + off) % 86400
    import cv2
    v = cv2.VideoCapture(path)
    dur = v.get(cv2.CAP_PROP_FRAME_COUNT) / max(1.0, v.get(cv2.CAP_PROP_FPS))
    lt = time.localtime(os.path.getmtime(path))
    return lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec - dur


REVIEW_PAGE = """<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HUD 待确认</title><style>
:root{--bg:#16181d;--panel:#20232a;--ink:#e6e1d6;--dim:#a9a395;--gold:#d8b25a}
body{background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:16px}
main{max-width:1100px;margin:auto} h1{font-size:20px} .sum{color:var(--dim)}
section{background:var(--panel);border-radius:8px;padding:12px 14px;margin:12px 0}
h2{font-size:16px;margin:0 0 4px} .cat{color:var(--gold)} p{margin:4px 0 8px}
.imgs{display:flex;gap:8px;flex-wrap:wrap} figure{margin:0;flex:1 1 320px} img{width:100%;border-radius:4px}
figcaption{color:var(--dim);font-size:13px}
</style><main><h1>HUD 待确认（@N@ 条）</h1><p class="sum">@SUM@</p>
@BODY@</main></html>
"""


def write_review(d, review, video=None):
    """review.html：HUD 拿不准、要人看录屏补的地方，每条附前后两帧截图（帧文件就在同一目录）。"""
    import bisect
    import glob
    import html
    frames = sorted(glob.glob(os.path.join(d, '*.jpg')) + glob.glob(os.path.join(d, '*.png')), key=timeline.frame_time)
    ft = [timeline.frame_time(p) for p in frames]

    def near(t):
        i = min(bisect.bisect_left(ft, t), len(ft) - 1)
        return html.escape(os.path.basename(frames[i])) if frames else ''
    cards = []
    for k, it in enumerate(review, 1):
        where = f"对局簿第 {it['step']} 步" if 'step' in it else f"对局簿第 {it['after']} 步之后（没记）"
        imgs = ''.join(f'<figure><img src="{near(it["ts"] + dt)}" loading="lazy"><figcaption>{lab}</figcaption></figure>'
                       for dt, lab in ((-1.5, '之前'), (2.5, '之后')))
        cards.append(f'<section><h2>{k}. <span class="cat">{html.escape(it["cat"])}</span> 录屏 {it["vt"]} · {where}</h2>'
                     f'<p>{html.escape(it["text"])}</p><div class="imgs">{imgs}</div></section>')
    summ = '、'.join(f'{c} {n}' for c, n in Counter(it['cat'] for it in review).most_common())
    summ += '。' + (f'录屏时间按 {html.escape(os.path.basename(video))} 算' if video else '录屏时间从 HUD 录到的第一帧算')
    summ += '；“对局簿第 N 步”是导入后记录列表里的序号。'
    page = (REVIEW_PAGE.replace('@N@', str(len(review))).replace('@SUM@', summ)
            .replace('@BODY@', '\n'.join(cards) or '<p>没有拿不准的地方。</p>'))
    p = os.path.join(d, 'review.html')
    with open(p, 'w', encoding='utf-8') as f:
        f.write(page)
    return p


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
    has_show = any(ent.get('show') for _t, ent in states) or not any(ent.get('prof') == '4:3' for _t, ent in states)
    spec = next((a[7:] for a in sys.argv if a.startswith('--deck=')), None)
    my_deck = deck.load(spec, m.cards)
    sync = '--sync-power' in sys.argv
    video = next((a[8:] for a in sys.argv if a.startswith('--video=')), None)
    review = []
    game = build_game(events, scores, date, {c['name']: c for c in m.cards}, has_show=has_show, my_deck=my_deck,
                      runs=turn_runs(states), extra=tr.extra, sync_states=states if sync else None, states=states,
                      deck_filter='--no-deck-filter' not in sys.argv, t0=video_start(video) if video else None,
                      review=review)
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
    rp = write_review(d, review, video)
    print(f'待确认 {len(review)} 条（' + '、'.join(f'{c} {n}' for c, n in Counter(it['cat'] for it in review).most_common())
          + f'）→ {rp}')
    print(code)


if __name__ == '__main__':
    main()
