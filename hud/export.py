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

import numpy as np

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


# 卡面机制（HUD 本质上是记牌局：画面上的变化先用卡牌能力解释，解释不了的才问人）
M_SEIZE = re.compile(r'抓捕')                                   # 薇歌的嘴套：敌军单位被抓到己方
M_TRANSFORM = re.compile(r'转变为.*敌军单位')                    # 杜度：变成敌军单位的同名牌
M_TIMER_SPAWN = re.compile(r'计时\s*\d+\s*[：:].*生成.*同名牌')  # 千里镜：计时到了在右侧生成所选单位的同名牌
M_ECHO_SPAWN = re.compile(r'随之生成')                           # 乌里沃的伊达兰：己方生成单位时同排跟着生成 1 战力的同名牌
M_SELF_MOVE = re.compile(r'回合结束时，移至另一排')               # 猫学派猎魔人：己方回合结束时换排
M_MOVE_ORDER = re.compile(r'指令\s*[：:]\s*将\s*1\s*个单位移至')  # 玛丽娜：指令移排
M_DMG_ORDER = re.compile(r'指令\s*[：:][^/]*(伤害|摧毁)|对决')     # 安赛斯王子：指令伤害 / 激励对决


def synth_specials(events, states, my_deck, cards_by_name, runs):
    """我方回合里手牌数稳定地少了 1、几秒内又没有我方单位落地、也没认出哪张特殊牌离手：打出了特殊牌。
    是哪张：卡组里的特殊牌，前 20 秒在手牌区认出的比例减去后 20 秒的，掉得最多的那张（至少掉 0.3）。
    手牌区的特殊牌时有时无，“离手”常常凑不够连续几帧，会记晚甚至漏掉（2026-10-01 真人局的滚油晚了 3 分钟）。"""
    if not my_deck or not states:
        return events
    specials = [n for n in my_deck if cards_by_name.get(n, {}).get('type') == '特殊']

    def turn_at(t):
        cur = None
        for s, side in runs or []:
            if s > t + 0.3:
                break
            cur = side
        return cur
    hc = [(t, ent['cnt']['hand'][1]) for t, ent in states
          if (ent.get('cnt') or {}).get('hand') and ent['cnt']['hand'][1] is not None and ent.get('sharp', 0) >= ent.get('smin', 40)]
    drops, prev, last, run = [], None, None, 0
    for t, v in hc:
        run = run + 1 if v == last else 1
        last = v
        if run == 2:
            if prev is not None and v == prev - 1:
                drops.append(t)
            prev = v

    def pres(a, b, n):
        fr = [ent for t, ent in states if a <= t <= b and ent.get('rows') and ent.get('sharp', 0) >= ent.get('smin', 40)]
        return sum(n in ent['rows'].get('手牌', []) for ent in fr) / max(1, len(fr))
    out = list(events)
    for td in drops:
        if turn_at(td) != 'me':
            continue
        if any(e[2] == '我方' and e[1] == '离手' and cards_by_name.get(e[3], {}).get('type') == '特殊'
               and abs(e[0] - td) <= 8 for e in events):
            continue
        # 卡组里只有 1 张、之后 2 分钟（本小局内）手牌区照样认得出的不算（识别时有时无；2026-10-01 滚油）
        gain = {n: pres(td - 20, td - 1, n) - pres(td + 1, td + 20, n) for n in specials
                if not (my_deck.get(n) == 1 and pres(td + 3, min([td + 120] + [e[0] - 1 for e in events if e[1] == '小局结束' and e[0] > td]), n)
                         >= 0.5 * pres(td - 40, td - 3, n) > 0)}
        best = max(gain, key=gain.get, default=None)
        if best is None or gain[best] < 0.2:
            continue
        landed = [e for e in events if e[2] == '我方' and e[1] in ('打出', '进场') and e[4] in ('我方近战', '我方远程')
                  and abs(e[0] - td) <= 5]
        if landed:
            # 有单位落地：从牌组打出单位的特殊牌（水路突袭）也是这样。只有特殊牌在手牌区明显消失（≥ 0.5）、
            # 落地那张在手牌区没少（< 0.2，卡组里的另一张、或者手里本来就没有）才算打出了特殊牌；
            # 落地那张之前 60 秒从没在手牌区出现过、这张特殊牌卡面又是“从牌组打出”，掉 0.2 就够（特殊牌本来就时有时无）
            u = landed[0][3]
            from_deck = DECK_PLAY.search(cards_by_name.get(best, {}).get('text') or '') and pres(td - 60, td - 1, u) < 0.05
            if gain[best] < (0.2 if from_deck else 0.5) or pres(td - 20, td - 1, u) - pres(td + 1, td + 20, u) >= 0.2:
                continue
        elif gain[best] < 0.3:
            continue
        # 效果先于手牌数更新：时间取它前面 6 秒内最早的对方离场 / 我方落地，没有就往前 1 秒
        tt = min([e[0] for e in events if e[2] == '对方' and e[1] == '离场' and td - 6 <= e[0] <= td]
                 + [e[0] for e in landed] + [td - 1]) - 0.3
        out.append((tt, '离手', '我方', best, '手牌数'))
    return sorted(out, key=lambda e: e[0])


M_ECHO = re.compile(r'(^|/)\s*回响')
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


def build_game(events, scores, date, cards_by_name, my_fac='NR', leader=None, has_show=True, my_deck=None,
               runs=None, extra=None, sync_states=None, states=None, deck_filter=True, t0=None, review=None,
               op_leader=None):
    """has_show=False（iPad 录屏没有右侧展示）时，对方可收集单位的进场也按打出记。
    my_deck（{牌名: 张数}）：我方只认卡组里的牌和衍生牌，其余当误识别丢掉。
    sync_states（[(时间, 扫描结果)]）：给了就在每个核对点前，把画面上读到、和上次不同的单位战力写成改战力记录
    （对局簿棋盘就是每个单位的实际战力；偏差报告会因此几乎总是一致，核查规则时别开）。
    t0：录屏开始的时刻（秒），记录的“录屏”时间从它算（用户自己的录屏），默认从第一个事件算。
    review：传一个列表进来，HUD 拿不准、需要人看录屏补的地方追加进去（write_review 写成 review.html）。"""
    leader = leader or LEADER_ME
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

    def row_med(a, b, rk):
        """[a, b] 里这一排最常见的牌名序列，以及这些帧里每个位置战力的中位数（单帧读数会跳，尤其是泛金光的两位数）。"""
        import statistics
        fr = []
        for tt, ent in states or []:
            if a <= tt <= b and ent.get('sharp', 0) >= ent.get('smin', 40):
                names = ent.get('rows', {}).get(rk, [])
                pws = (ent.get('pw') or {}).get(rk, [])
                keep = [j for j, nm in enumerate(names) if cards_by_name.get(nm, {}).get('type') != '战术']
                fr.append((tuple(names[j] for j in keep), [pws[j] if j < len(pws) else None for j in keep]))
        if not fr:
            return row_at(b, rk)
        top = Counter(nm for nm, _p in fr).most_common(1)[0][0]
        cols = list(zip(*[p for nm, p in fr if nm == top])) if top else []
        med = [statistics.median([v for v in col if v is not None]) if any(v is not None for v in col) else None
               for col in cols]
        return list(top), med

    def resolve_targets(t_after):
        """比较打出前后每个单位的战力：伤害 → 对方掉了的，增益 → 己方涨了的，摧毁 → 没了的；按卡面数值挑最匹配的。"""
        claimed = set()   # 同一个核对点里几张牌各推各的目标，不抢同一个（玛哈坎麦酒 +5、致幻菌菇 -3+9）
        while pend_tgt:
            x, t, snap = pend_tgt.pop(0)
            if x.get('tgts'):
                continue   # 卡面机制（抓捕、转变……）已经定了目标
            text = target_text(cards_by_name.get(x.pop('tc', None) or x['c'], {}))
            nums = [int(v) for v in re.findall(r'(\d+)\s*点', text)][:1]   # 主数值（伤害 / 增益量），附带的护甲等不算
            want = int(m.group(1)) if (m := re.search(r'(\d+)\s*个', text)) else 1
            cands = []
            # 前后窗口：打出后第一次总分变化到下一次总分变化之间（连着结算的几张牌各看各的一段，2026-10-01 三张炼金牌 4 秒内结算）
            chg = [tt for tt, _sc in scores if tt > t + 0.3]
            w0, w1 = (t - 3.0, t - 0.3), (t_after, t_after + 3.0)
            # 我方特殊牌“离手”确认得晚（效果早出现了），只给对方（展示框时间准）用
            if chg and chg[0] <= t_after + 0.5 and x['who'] == 'op':
                prev_chg = max((tt for tt, _sc in scores if tt <= t + 0.3), default=t - 3.0)
                w0 = (max(prev_chg, t - 3.0), chg[0] - 0.05)
                w1 = (chg[0], (chg[1] - 0.05) if len(chg) > 1 and chg[1] - chg[0] < 3.0 else chg[0] + 3.0)

            def find(names, nm, k):  # 第 k 个叫 nm 的在 names 里的位置
                idx = [j for j, v in enumerate(names) if v == nm]
                return idx[k] if k < len(idx) else None
            for rk, us in snap.items():
                if not us:
                    continue
                n0, p0 = row_med(w0[0], w0[1], rk)
                n1, p1 = row_med(w1[0], w1[1], rk)
                if n0 is None or n1 is None:
                    continue
                enemy = rk.startswith('对方') == (x['who'] == 'me')
                seen = Counter()
                for u in us:  # 按牌名逐张对齐（同名按第几张），别的牌没认出来也不影响
                    k = seen[u[1]]
                    seen[u[1]] += 1
                    if re.search(r'(^|/)\s*免疫', text_of(u[1])):
                        continue   # 免疫的不能被指定（布朗温）
                    j0 = find(n0, u[1], k)
                    if j0 is None:
                        continue
                    j1 = find(n1, u[1], k)
                    if j1 is None:
                        if (enemy if '友军' not in text else not enemy) and ('摧毁' in text or '伤害' in text) and \
                                n0.count(u[1]) > n1.count(u[1]):
                            cands.append((0, -99, u[0]))  # 没了：被摧毁
                        continue
                    a_, b_ = p0[j0] if j0 < len(p0) else None, p1[j1] if j1 < len(p1) else None
                    if a_ is None or b_ is None or a_ == b_:
                        continue
                    d = b_ - a_
                    side_ok = (not enemy) if '友军' in text else enemy if '敌军' in text else None   # 卡面写明哪一方（暴怒的熊：友军）
                    if ('伤害' in text and d < 0 and (enemy if side_ok is None else side_ok)) or \
                            ('增益' in text and d > 0 and ((not enemy) if side_ok is None else side_ok)) or \
                            ('重置' in text and d != 0) or (re.search(r'(?<!移除其)锁定', text) and enemy):
                        # 正好等于主数值的最好；超过的其次（还有别的加成），不到的按差多少
                        fit = min(((0 if abs(d) == kk else 1 if abs(d) > kk else 1 + kk - abs(d)) for kk in nums), default=0)
                        cands.append((fit + (10 if u[0] in claimed else 0), -abs(d), u[0]))
            if cands:
                x['tgts'] = [{'uid': c[2]} for c in sorted(cands)[:want]]
                claimed.update(c['uid'] for c in x['tgts'])
                if any(y is not x and y['who'] == x['who'] and abs(y.get('ts', -99) - t) <= 4 and
                       y['a'] in ('play', 'spawn', 'leader') and target_text(cards_by_name.get(y.get('c'), {}))
                       for y in log):
                    x['tgt_unsure'] = True   # 几张牌 4 秒内连着结算，战力数字刷新又慢，分不开各自的目标
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
        key = (x['c'], r) if M_ECHO.search(c.get('text') or '') else x['c']   # 回响：每小局回到牌组
        if used[key] >= my_deck[x['c']]:
            return True
        used[key] += 1
        return False

    def push(x, t):
        nonlocal n
        if over_deck(x):
            if review is not None and cards_by_name.get(x['c'], {}).get('type') != '特殊':
                review.append({'ts': t, 'cat': '丢掉的打出', 'who': x['who'], 'c': x['c'],
                               'text': f"画面上像是又{'打出' if x['a'] == 'play' else '召唤'}了 {x['c']}，但卡组里只有 "
                                       f"{my_deck[x['c']]} 张、已经记满，当成误认丢掉了；真的上场了请补记"})
            return
        ex = extra.get((t, x.get('c'), cur_row[0])) if x['a'] in ('play', 'summon', 'spawn') else None
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
        if x['a'] in ('play', 'spawn') and target_text(cards_by_name.get(x.get('c'), {})) and states:
            # 有目标的牌：记下打出前的场面，等下一个核对点再比较前后战力推目标
            pend_tgt.append((x, t, {k: [u[:2] for u in v] for k, v in units.items()}))
        if x['a'] in ('play', 'summon', 'spawn') and x.get('row'):
            us = units.setdefault(rowkey(x['who'], x['row']), [])
            us.insert(min(x.get('pos', len(us)), len(us)), [x['id'], x['c'], x.get('pw'),
                                                            has_shield_kw(cards_by_name.get(x['c'], {})), t])
        if x['a'] in ('play', 'summon', 'spawn') and (x.get('row') or x['a'] == 'play'):
            # 特殊牌没有排，也记进来（水路突袭、骑士册封从牌组打出单位）
            recent.append((t, x['who'], x['c'], {'m': '近战', 'r': '远程'}.get(x.get('row'), ''),
                           '打出' if x['a'] == 'play' else '进场'))

    def op_power_drop(a, b):
        """[a 之前 3 秒] 和 [b 之后 3 秒] 对方各单位读到的战力（整排牌名对得上的帧取中位数），掉得最多的 (排, 第几个, 掉了多少)。"""
        import statistics

        def med(lo, hi):
            acc = {}
            for tt, ent in (states or []):
                if lo <= tt <= hi:
                    for rk in ('对方近战', '对方远程'):
                        names = [u[1] for u in units.get(rk, [])]
                        if ent.get('rows', {}).get(rk, []) == names:
                            for j, pv in enumerate((ent.get('pw') or {}).get(rk, [])):
                                if pv is not None:
                                    acc.setdefault((rk, j), []).append(pv)
            return {k: statistics.median(v) for k, v in acc.items() if len(v) >= 2}
        p0, p1 = med(a - 3, a), med(b, b + 3)
        return max(((k[0], k[1], p0[k] - p1[k], p1[k]) for k in p0 if k in p1), key=lambda x: x[2], default=None)

    def drop_order(prev, cur):
        """我方回合对方总分掉了（≥ 3）、没有单位离场、我方这几秒没有带目标的动作：
        我方场上有“指令：重置 / 伤害”、这回合能用（不是这回合进场的）的单位 → 记它的指令，目标是战力掉得最多的对方单位（赤红男爵）。"""
        tc = cur[0]
        d = prev[1][1] - cur[1][1]
        ts0 = turn_start('me', tc)
        if d < 3 or ts0 is None or prev[1][0] < cur[1][0] - 2:
            return
        if any(x['who'] == 'me' and -6 <= x.get('ts', -99) - tc <= 1 and
               (x['a'] in ('order', 'leader') or target_text(cards_by_name.get(x.get('c'), {}))) for x in log):
            return
        if any(dd[1] == 'op' and abs(dd[0] - tc) <= 4 for dd in departed):
            return
        srcs = [u for _rk, u in side_units('me') if re.search(r'指令\s*[：:][^/]*(重置|伤害)', text_of(u[1]))
                and order_used.get(u[0]) != ts0 and u[4] < ts0]
        drop = op_power_drop(prev[0], tc)
        if not srcs or not drop or drop[2] < 3:
            return
        tu = units.get(drop[0], [])[drop[1]] if drop[1] < len(units.get(drop[0], [])) else None
        if tu is None:
            return
        if len(srcs) > 1:   # 几张都能用：重置的话目标正好回到基础战力
            base = cards_by_name.get(tu[1], {}).get('power')
            reset = [u for u in srcs if '重置' in text_of(u[1])]
            srcs = reset if str(base).isdigit() and drop[3] == int(base) and len(reset) == 1 else srcs
        if len(srcs) != 1:
            return
        order_used[srcs[0][0]] = ts0
        push({'who': 'me', 'a': 'order', 'c': srcs[0][1], 'uid': srcs[0][0], 'tgts': [{'uid': tu[0]}],
              'hud': f'我方回合对方总分 -{d}、没有单位离场：推测是这张的指令（{tu[1]} 战力 -{drop[2]:g}）'}, tc - 0.3)

    def resolve_leader_chain():
        """我方领袖“触发友军神赐就刷新”（皇家激励）连用时按机制补目标：
        - 用完之后次数还在（没有连着两帧读到 0）= 刷新了 = 目标触发了神赐：
          前 4 秒到后 6 秒内有单位神赐生成了牌（少女的盾牌 → 布朗温；按画面第一次出现算）→ 目标就是它；
          否则场上只有一个还有没触发的神赐门槛、能被指定的单位 → 它（少女的盾牌神赐 8 之后还有神赐 14）；
        - 没刷新（最后一次）而目标没推出：同一回合上一次用在谁就是谁（连用都是为了推同一张的神赐；2026-10-01 用户确认三次都给少女的盾牌）。"""
        text = text_of(leader) if leader else ''
        if not (re.search(r'增益', text) and re.search(r'神赐', text) and re.search(r'刷新', text)):
            return
        uses = [x for x in log if x['who'] == 'me' and x['a'] == 'leader' and 'ts' in x]
        spawns = [y for y in log if y['who'] == 'me' and y.get('via') and '神赐' in (y.get('hud') or '') and 'ts' in y]
        used_spawn, fired = set(), {}
        gone = {d[3][0]: d[0] for d in departed}
        for i, x in enumerate(uses):
            nxt = next((u['ts'] for u in uses[i + 1:] if u.get('r') == x.get('r')), x['ts'] + 10)
            # 次数变化可能比领袖事件（按次数确认，有迟滞）还早一点：从前 1.5 秒看起
            reads = [(ent.get('lead') or [None, None])[1] for tt, ent in (states or []) if x['ts'] - 1.5 <= tt <= nxt]
            zeros = [v == 0 for v in reads if v is not None]   # 读不到的帧不算（图标变暗、被挡）
            refreshed = not any(a_ and b_ for a_, b_ in zip(zeros, zeros[1:]))
            if refreshed:
                y = next((y for y in spawns if id(y) not in used_spawn and -4 <= y['ts'] - x['ts'] <= 6), None)
                if y:
                    used_spawn.add(id(y))
                    src = next((z for z in reversed(log) if z['who'] == 'me' and z.get('c') == y['via'] and z.get('row')
                                and z.get('ts', 1e9) <= y['ts'] and z.get('r') == x.get('r')), None)
                    if src:
                        th = re.search(r'神赐\s*(\d+)', y.get('hud') or '')
                        fired.setdefault(src['id'], set()).add(int(th.group(1)) if th else 0)
                        if not x.get('tgts'):
                            x['tgts'] = [{'uid': src['id']}]
                            x['hud'] = f"目标：{y['via']} 随后神赐生成了 {y.get('c')}（领袖刷新了）"
                        continue
                def cur_pw(z):   # 这一刻之前最后读到的战力（改战力记录），没有就用落地战力
                    v = next((y.get('v') for y in reversed(log) if y['a'] == 'adj' and y.get('uid') == z['id']
                              and y.get('ts', 1e9) <= x['ts'] and str(y.get('v', '')).isdigit()), None)
                    return int(v) if v is not None else (z.get('pw') or 0)

                def unfired(z):
                    return [int(v) for v in re.findall(r'神赐\s*(\d+)', text_of(z.get('c')))
                            if int(v) not in fired.get(z['id'], set()) and cur_pw(z) < int(v)]
                if x.get('tgts'):
                    tz = next((z for z in log if z.get('id') == x['tgts'][0].get('uid')), None)
                    if tz is None or unfired(tz):
                        continue
                    # 刷新了说明目标触发了神赐，按战力变化猜的那张没有神赐可触发：不对，改按神赐推
                    x.pop('tgts')
                    x['hud'] = ''
                cands = []
                for z in log:
                    if z['who'] != 'me' or not z.get('row') or z.get('r') != x.get('r') or z.get('ts', 1e9) > x['ts'] or \
                            gone.get(z.get('id'), 1e9) <= x['ts'] or z['a'] not in ('play', 'summon', 'spawn'):
                        continue
                    zt = text_of(z.get('c'))
                    if re.search(r'(^|/)\s*免疫', zt):
                        continue
                    if unfired(z) or (fired.get(z['id']) and [v for v in re.findall(r'神赐\s*(\d+)', zt)
                                                               if int(v) not in fired[z['id']]]):
                        cands.append(z)   # 已经触发过神赐的那张，战力读数常被护盾金光弄错，只看还剩没剩门槛
                # 连用多半是推同一张的下一个神赐：已经触发过神赐、还有更高门槛的那张优先（少女的盾牌 8 → 14）
                cont = [z for z in cands if fired.get(z['id'])]
                cands = cont if len(cont) == 1 else cands
                if len(cands) == 1:
                    x['tgts'] = [{'uid': cands[0]['id']}]
                    x['hud'] = f"目标：领袖刷新了，场上只有 {cands[0]['c']} 还有没触发的神赐"
                    fired.setdefault(cands[0]['id'], set()).add(min(int(v) for v in re.findall(r'神赐\s*(\d+)', text_of(cands[0]['c']))
                                                                    if int(v) not in fired.get(cands[0]['id'], set())))
            elif not x.get('tgts'):
                prev = next((u for u in reversed(uses[:i]) if u.get('r') == x.get('r') and x['ts'] - u['ts'] <= 30 and u.get('tgts')), None)
                if prev:
                    x['tgts'] = [dict(t_) for t_ in prev['tgts']]
                    x['hud'] = '目标：连用的最后一次，和上一次同一个目标'

    def flush_scores(upto):
        """把 upto 之前的稳定总分里、最后一个写成核对点（每一手之后一个）。"""
        nonlocal si, last_real, pending_step, round_score
        best = None
        while si < len(scores) and scores[si][0] <= upto:
            if si > 0:
                drop_order(scores[si - 1], scores[si])
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
    carry = []   # [(小局结束时间, 排, 单位)] 带坚韧、留到下一小局的

    # ---- 卡面机制 ----
    flips = list(runs or [])
    mech = []       # 进行中的抓捕 / 转变：{'k', 't', 'who', 'x', 'u', 'name'}
    spawners = []   # 计时生成（千里镜）：{'who', 'x', 't', 'snap', 'fired'}
    last_spawn = [None]   # (时间, 方, 牌名, 排)
    order_used = {}       # 指令来源 uid -> 用过的那个回合的开始时间
    departed = []         # [(时间, 方, 排, unit)] 离场的单位（特殊牌“离手”确认得晚，目标可能已经离场了）
    round_ends = [e[0] for e in events if e[1] == '小局结束']
    live = [tt for tt, ent in (states or []) if ent.get('sharp', 0) >= ent.get('smin', 40) and None not in (ent.get('score') or [None])]
    if live:
        round_ends.append(live[-1] + 1.0)   # 对局最后一帧之后直接是结算画面，没有“小局结束”事件：也是当时那一方的回合结束

    lead_used = {}        # 对方回合开始时间 -> 按次数已经记了几次领袖

    def op_lead_drop(ts0, t):
        """对方回合（从 ts0 开始）到 t+3 秒为止，对方领袖次数减少了几次（读到的最小值比回合开始时少多少）。"""
        vals = [ent['lead'][0] for tt, ent in (states or []) if ts0 - 1 <= tt <= t + 3 and ent.get('lead')
                and ent['lead'][0] is not None and ent['lead'][0] <= 9]
        return max(0, vals[0] - min(vals)) if vals else 0

    def text_of(nm):
        return cards_by_name.get(nm, {}).get('text') or ''

    def turn_start(who, t):
        """t 所在的 who 回合从什么时候开始；t 不在 who 的回合里返回 None。"""
        cur = None
        for s, side in flips:
            if s > t + 0.3:
                break
            cur = (s, side)
        return cur[0] if cur and cur[1] == who else None

    def near_turn_end(who, t, before=5.0, after=2.0):
        ends = [s for (s, side), (_s0, side0) in zip(flips[1:], flips[:-1]) if side0 == who and side != who]
        ends += [te for te in round_ends if turn_start(who, te - 0.5) is not None]   # 小局结束也是回合结束
        return any(-before <= t - te <= after for te in ends)

    def turn_ends_between(who, a, b):
        """(a, b] 里 who 的回合结束了几次（换到另一方，或小局结束）。"""
        ends = [s for (s, side), (_s0, side0) in zip(flips[1:], flips[:-1]) if side0 == who and side != who]
        ends += [te for te in round_ends if turn_start(who, te - 0.5) is not None]
        return sum(1 for te in ends if a < te <= b)

    def seen_count(rk, nm, t):
        """t 之后 3 秒内画面上这一排这个名字最多同时看到几张（识别时有时无，取最大）。"""
        cnt = [ent['rows'].get(rk, []).count(nm) for tt, ent in (states or []) if t <= tt <= t + 3 and ent.get('rows')
               and ent.get('sharp', 0) >= ent.get('smin', 40)]
        return max(cnt) if cnt else None

    def side_units(who):
        pre = '我方' if who == 'me' else '对方'
        return [(rk, u) for rk, us in units.items() if rk.startswith(pre) for u in us]

    def note_mech(x, t, who):
        """打出一张牌后，登记它之后会在画面上引起的变化。"""
        text = text_of(x.get('c'))
        if M_SEIZE.search(text):
            mech.append({'k': 'seize', 't': t, 'who': who, 'x': x})
        if M_TRANSFORM.search(text):
            mech.append({'k': 'transform', 't': t, 'who': who, 'x': x, 'name': x['c']})
        if M_TIMER_SPAWN.search(text):
            spawners.append({'who': who, 'x': x, 't': t, 'fired': False,
                             'n': int(re.search(r'计时\s*(\d+)', text).group(1)),
                             'snap': [(u[0], u[1]) for _rk, u in side_units(who)]})

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

    def refers(src, name):
        """src 的卡面有没有“生成 / 召唤 / 从某处打出”name 这张牌的效果（点名、类别“炼金”、会师单位、墓场里的铜色单位……）。
        触发条件（“每打出 1 张“炼金”牌”“若手牌中有……”）不算。返回 (动作, 那一段, 几张, 时机) 或 None；
        时机：'order' 指令、'chapter' 剧情的章节（场上的牌在之后触发），否则 None（打出时）。"""
        e = cards_by_name.get(name, {})
        etext, etags = e.get('text') or '', set(re.split(r'[,，、\s]+', e.get('tags') or '')) - {''}
        for seg in text_of(src).split('/'):
            body = re.sub(r'(每(?:打出|有|控制)|若)[^，。]*[，。]', '', seg)   # 去掉触发条件
            vm = re.search(r'生成|召唤|从[^，。]*?打出', body)
            if not vm:
                continue
            obj = body[vm.start():]
            hit = (name in obj or any(f'“{tg}”' in obj for tg in etags) or '任一张牌' in obj or
                   any(kw in etext for kw in re.findall(r'(会师|坚韧|狂热|列阵|卫士)单位', obj)))
            if not hit and e.get('type') == '单位' and re.search(r'墓场(?:中)?(?:召唤|打出)\s*1\s*(?:个|张)[^，。]*单位', obj):
                hit = ('非中立' not in obj or e.get('fac') != 'NE') and ('铜色' not in obj or e.get('color') == '铜')
            if not hit and re.search(r'所选牌', obj):   # 幻觉：展示几张（写在前一句），生成并打出所选的
                pre = body[:vm.start()]
                hit = any(f'“{tg}”' in pre for tg in etags)
            if hit:
                kind = 'summon' if '召唤' in vm.group(0) else 'spawn' if '生成' in vm.group(0) else 'play'   # 看第一个动词（佛卡夏：打出…随后生成雨）
                nm = re.search(r'(\d+)\s*(?:张|个|只)', obj)
                n = 99 if '所有' in obj else int(nm.group(1)) if nm else 1
                when = 'order' if re.match(r'\s*指令', seg) else 'chapter' if re.match(r'\s*第.章', seg) else None
                return kind, seg.strip(), n, when
        return None

    via_uses = {}

    def text_source(t, who, name, ei, future=True):
        """进场 / 展示的 name 是谁带出来的：同一回合里 15 秒内（要选牌的 20 秒内；future 时也看之后 4 秒内才确认的展示、
        战术牌离场）同一方打出的牌，或场上的牌的指令 / 剧情章节，卡面写着生成 / 召唤 / 打出它；每个来源按卡面张数封顶，
        剧情每章只触发一次、而且要刚打出过推进剧情的那类牌。返回 (来源, 动作, 那一段, 来源单位 or None)。"""
        ts0 = turn_start(who, t)
        lo = -1e9 if ts0 is None else ts0 - 1.0
        same = lambda e: (e[2] == '我方') == (who == 'me')
        cands = [(t - t2, t2, n2) for t2, w2, n2, _r2, k2 in recent if w2 == who and k2 == '打出' and 0 <= t - t2 <= 20 and t2 >= lo]
        if future:
            cands += [(e[0] - t, e[0], e[3]) for e in events[ei + 1:ei + 30] if 0 <= e[0] - t <= 4 and same(e) and
                      (e[1] in ('打出', '展示') or (e[1] == '离场' and cards_by_name.get(e[3], {}).get('type') == '战术'))
                      and not refers(name, e[3])]   # 反过来是它带出那张（莫斯萨克 → 幻觉）就不是来源
        for dt, t2, n2 in sorted(cands):
            rf = refers(n2, name) if n2 != name else None
            tactic = cards_by_name.get(n2, {}).get('type') == '战术'   # 战术牌的指令就是打出它
            if not rf or (rf[3] and not (tactic and rf[3] == 'order')) or \
                    (dt > 15 and '选择' not in rf[1] and '所选' not in rf[1]):
                continue
            key = (n2, round(t2, 1))
            if via_uses.get(key, 0) >= rf[2]:
                continue
            via_uses[key] = via_uses.get(key, 0) + 1
            return n2, rf[0], rf[1], None
        for _rk, u in side_units(who):   # 场上的牌：指令（伤感松露酒馆）、剧情章节（盖迪尼斯的阴影下）
            if u[1] == name or not (rf := refers(u[1], name)) or not rf[3]:
                continue
            if rf[3] == 'chapter':
                key = (u[0], rf[1])
                adv = re.search(r'每打出\s*1\s*(?:张|个)“([^”]+)”', text_of(u[1]))
                pushed = adv and any(adv.group(1) in (cards_by_name.get(n2, {}).get('tags') or '') for t2, w2, n2, _r, k2 in recent
                                     if w2 == who and k2 == '打出' and 0 <= t - t2 <= 15 and t2 >= lo)
                pushed = pushed or (adv and any(same(e) and e[1] in ('打出', '展示', '进场') and -8 <= e[0] - t <= 4 and
                                                adv.group(1) in (cards_by_name.get(e[3], {}).get('tags') or '')
                                                for e in events[max(0, ei - 30):ei + 30] if abs(e[0] - t) <= 8))
                if via_uses.get(key) or not pushed:
                    continue
                via_uses[key] = 1
            return u[1], rf[0], rf[1], (u if rf[3] == 'order' else None)
        return None

    def explained(who, nm):
        """nm 有没有卡面来源（场上的牌的指令 / 剧情章节，或这一方最近打出的牌写着带出它）：不算从手牌打出。"""
        return any(refers(u[1], nm) for _rk, u in side_units(who) if u[1] != nm) or \
            any(refers(n2, nm) for t2, w2, n2, _r, k2 in recent[-6:] if w2 == who and k2 == '打出' and n2 != nm)

    def grave_trigger(t, who, name, ei):
        """name 自己卡面上的墓场能力：“己方每打出 1 张“炼金”牌，便从墓场召唤自身”，前后几秒同一方打出过这类牌。"""
        m = re.search(r'每打出\s*1\s*张“([^”]+)”牌，便从墓场召唤“' + re.escape(name), text_of(name))
        if not m:
            return None
        cat = m.group(1)
        near = [n2 for t2, w2, n2, _r, k2 in recent if w2 == who and k2 == '打出' and 0 <= t - t2 <= 8]
        near += [e[3] for e in events[ei + 1:ei + 30] if 0 < e[0] - t <= 6 and e[1] in ('打出', '展示')
                 and (e[2] == '我方') == (who == 'me')]
        return next((n2 for n2 in near if cat in (cards_by_name.get(n2, {}).get('tags') or '')), None)

    # 比分变化当证据：打出单位 → 这一方总分上涨；打出特殊牌 → 几秒内双方总分有变化。没有证据的当误识别（手牌区误认、拖动）
    def score_change(a, b):
        s0 = next((s for tt, s in reversed(scores) if tt <= a), None)
        s1 = next((s for tt, s in reversed(scores) if tt <= b), None)
        return None if s0 is None or s1 is None else (s1[0] - s0[0], s1[1] - s0[1])

    def in_hand(nm, a, b, grow=None):
        """[a, b] 秒里（正常对局画面）手牌区认出 nm 的帧占比；grow：帧太少（对方回合画面不变、存得少）时 b 往后放宽到 a + grow。"""
        def frames(b_):
            return [nm in (ent.get('rows') or {}).get('手牌', []) for tt, ent in (states or [])
                    if a <= tt <= b_ and ent.get('sharp', 0) >= ent.get('smin', 40)]
        fr = frames(b)
        while grow and len(fr) < 8 and b < a + grow:
            b += 20
            fr = frames(b)
        return sum(fr) / len(fr) if len(fr) >= 5 else 0.0

    def hand_drops(a, b):
        """[a, b] 里我方手牌数（连续两帧一样才算）减少了几次。"""
        vals = [(ent.get('cnt') or {}).get('hand', [None, None])[1] for tt, ent in (states or [])
                if a <= tt <= b and ent.get('sharp', 0) >= ent.get('smin', 40)]
        vals = [v for v in vals if v is not None]
        st = [v for v, w in zip(vals, vals[1:]) if v == w]
        st = [v for i, v in enumerate(st) if i == 0 or v != st[i - 1]]
        # 回合中途手牌数不会变多：读数变多（“0/10”的 0 读成 8）说明这段读数不可靠
        ok = len(st) > 0 and not any(w > v for v, w in zip(st, st[1:]))
        return sum(1 for v, w in zip(st, st[1:]) if w == v - 1), ok

    def flicker_special(t, name, row):
        """我方特殊牌“离手”其实不是打出：
        - 卡组里只有 1 张、之后 2 分钟（本小局内）手牌区照样认得出（不少于之前的一半）——识别时有时无；
        - 前后 8 秒手牌数减少的次数，都被同时从手牌落地的单位用掉了（之前在手牌区认出过的才算从手牌打出；
          从牌组打出 / 召唤的单位之前不在手里）——一回合只打一张，2026-10-01 一局手牌上方空地认出 46 帧“滚油”。"""
        if row == '手牌数':
            return False
        before = in_hand(name, t - 40, t - 3)
        if (my_deck or {}).get(name, 0) == 1 and before > 0 and \
                in_hand(name, t + 3, min([t + 120] + [te - 1 for te in round_ends if te > t])) >= 0.5 * before:
            return True
        n_drop, seen = hand_drops(t - 8, t + 8)
        landed = {e[3] for e in events if e[2] == '我方' and e[1] in ('打出', '进场') and abs(e[0] - t) <= 8
                  and cards_by_name.get(e[3], {}).get('type') in ('单位', '神器') and in_hand(e[3], t - 60, t - 8) >= 0.05}
        return seen and n_drop <= len(landed)

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
        rnd = 0
        for i, (t, kind, side, name, row) in enumerate(events):
            if kind == '小局结束':
                rnd += 1
            c = cards_by_name.get(name, {})
            if side != '我方' or name not in my_deck or c.get('set') == 'token':
                continue
            key = (name, rnd if M_ECHO.search(c.get('text') or '') else None)   # 回响：每小局开始回到牌组，按小局计数
            if kind == '离手' and c.get('type') == '特殊' and not flicker_special(t, name, row):
                # 特殊牌的效果往往在“离手”确认之前就出现了（离手要连续几帧看不到）：比较离手前 6 秒和后 12 秒的比分
                d = score_change(t - 6, t + 12)
                occ.setdefault(key, []).append((0 if d and d != (0, 0) else 1, t, i, None))
            elif kind in ('打出', '进场') and row != '手牌' and c.get('type') in ('单位', '神器'):
                d = score_delta(t, 0.5, 10)
                end = next((j for j in range(i + 1, len(events)) if events[j][1] in ('离场', '小局结束')
                            and (events[j][1] == '小局结束' or (events[j][3] == name and events[j][4] == row))), None)
                occ.setdefault(key, []).append((0 if d and d[0] > 0 else 1, t, i, end))
        for (name, _r), lst in occ.items():
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
                # 特殊牌的效果往往在“离手”确认之前就出现了（离手要连续几帧看不到）：比较离手前 6 秒和后 12 秒的比分
                d = score_change(t - 6, t + 12)
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
        if my_deck and side == '我方' and name and name not in my_deck and \
                (c.get('set') != 'token' or c.get('fac') not in (my_fac, 'NE')):
            continue  # 我方只认卡组里的牌，和本阵营 / 中立的衍生牌
        if kind == '离手' and c.get('type') == '特殊' and side == '我方' and flicker_special(t, name, row):
            # 卡组里只有 1 张、之后 2 分钟（本小局内）手牌区照样认得出（和之前差不多常见）：是识别时有时无，没打出
            # （2026-10-01 滚油；水路突袭在对方回合里连着 60 秒没认出来，之后又一直在，3 分钟后才真打出）
            push({'who': 'me', 'a': 'note', 'c': f'画面：{name} 像是离手，但之后还在手牌里 / 手牌数没少，不算打出'}, t)
            continue
        if kind == '离手' and c.get('type') == '特殊' and side == '我方':
            # 我方手牌里的特殊牌消失（不是闪烁）：打出了特殊牌（特殊牌不上场，只能这样看）
            flush_scores(t)
            k0 = len(log)
            x = {'who': 'me', 'a': 'play', 'c': name, 'side': 'me',
                 'hud': '手牌数少了 1、没有单位落地：打出了特殊牌（手牌区认得最少的那张）' if row == '手牌数' else '手牌里消失的特殊牌'}
            tt = target_text(cards_by_name.get(name, {}))
            gone = [d for d in departed if d[1] == 'op' and 0 <= t - d[0] <= 8] if re.search(r'伤害|摧毁', tt) else []
            if len(gone) == 1:
                x['tgts'] = [{'uid': gone[0][3][0]}]
                x['hud'] += '；目标在离手确认前已经离场'
            push(x, t)
            note_mech(x, t, 'me')
            stext = text_of(name)
            if log and log[-1] is x and (DECK_PLAY.search(stext) or '召唤' in stext):
                j = next((j for j in range(len(log) - 2, -1, -1) if log[j]['who'] == 'me' and log[j]['a'] in ('play', 'summon')
                          and not log[j].get('via') and log[j].get('row') and 0 <= t - log[j].get('ts', 0) <= 5
                          and cards_by_name.get(log[j].get('c'), {}).get('type') == '单位'), None)
                if j is not None:
                    u = log[j]
                    u['via'] = name
                    u['a'] = 'play' if DECK_PLAY.search(stext) else 'summon'
                    u['hud'] = f'{name} 带出（{name} 离手确认得晚，回头关联）'
                    log.insert(j, log.pop())   # 特殊牌挪到它带出的单位前面
                    if u['c'] in used and cards_by_name.get(u['c'], {}).get('set') != 'token':
                        pass   # 从牌组打出的仍然占卡组张数
            pending_step = pending_step or len(log) > k0
            continue
        if c.get('type') == '战术' and kind == '离场' and row != '手牌':
            # 战术牌离场 = 用了（指令）；它生成的牌（衔尾蛇面具的乌鸦）在 text_source 里找到它
            flush_scores(t)
            tw = 'me' if side == '我方' else 'op'
            push({'who': tw, 'a': 'tactic', 'c': name, 'hud': '战术牌离场：用了战术'}, t - 0.1)
            recent.append((t - 0.1, tw, name, '', '打出'))
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
            carry[:] = [(t, rk, u) for rk, us in units.items() for u in us if '坚韧' in text_of(u[1])]
            units.clear()
            continue
        if kind == '进场' and (cu := next((x for x in carry if 0 <= t - x[0] <= 90 and x[1] == row and x[2][1] == name), None)):
            carry.remove(cu)   # 坚韧：小局结束后留在场上（对局簿引擎自己带入），不是新进场
            units.setdefault(row, []).append(cu[2])
            push({'who': who, 'a': 'note', 'c': f'画面：{name} 坚韧留场（{row}）'}, t)
            continue
        c = cards_by_name.get(name, {})
        if kind in ('进场', '打出') and row in ROW and (sc_ := seen_count(row, name, t)) is not None and \
                sc_ >= 1 and sum(1 for u in units.get(row, []) if u[1] == name) >= sc_ and \
                not any(m['who'] == who and m.get('u') for m in mech):
            continue   # 重复识别：这一排已经记的同名牌不少于画面上同时看到的（识别抖动、展示框里放大的被选目标）
        if kind == '打出' and who == 'me' and (src := summoner(t, who, name, row)) and src[0] != name:
            # 一回合只打一张：刚打出召唤 / 从牌组打出的牌，几秒后进场的同名牌是它带出的（手牌里另一张同名牌正好闪了一下）
            push({'who': who, 'a': src[1], 'c': name, 'row': ROW.get(row, 'm'), 'side': who, 'via': src[0],
                  'hud': '推测由这张牌带出'}, t)
        elif kind == '打出':
            x = {'who': who, 'a': 'play', 'c': name, 'side': who}
            if row in ROW and c.get('type') != '特殊':
                x['row'] = ROW[row]
            if who == 'op' and (ts_ := text_source(t, who, name, ei, future=False)):   # 对方生成并打出的也有展示（幻觉 → 暴怒的熊）
                x.update(via=ts_[0], hud=f'{ts_[0]} 带出（卡面：{ts_[2]}）')
                if ts_[1] != 'play':
                    x['a'] = ts_[1]
            push(x, t)
            note_mech(x, t, who)
            pending_step = True
            first_side = first_side or who
        elif kind == '展示' and op_leader and refers(op_leader, name) and (ts0 := turn_start('op', t)) is not None and \
                op_lead_drop(ts0, t + 2) > lead_used.get(ts0, 0):
            # 对方领袖技能“生成并打出”这张（战斗狂热 → 致幻菌菇），这回合对方领袖次数在减少：记成领袖，目标按战力变化推
            lead_used[ts0] = lead_used.get(ts0, 0) + 1
            x = {'who': 'op', 'a': 'leader', 'c': op_leader, 'hud': f'对方领袖 {op_leader} 生成并打出 {name}（领袖次数减少）'}
            push(x, t)
            if target_text(cards_by_name.get(name, {})) and states:
                x['tc'] = name   # 用生成的那张牌的卡面推目标
                pend_tgt.append((x, t, {k: [u[:2] for u in v] for k, v in units.items()}))
            pending_step = True
        elif kind == '展示':  # 对方特殊牌（或展示了但没看到落地）
            x = {'who': 'op', 'a': 'play', 'c': name, 'side': 'op', 'hud': '只看到展示'}
            if (ts_ := text_source(t, 'op', name, ei)):
                if ts_[3] is not None:
                    push({'who': 'op', 'a': 'order', 'c': ts_[0], 'uid': ts_[3][0], 'hud': f'{name} 出现：推测是这张的指令'}, t - 0.1)
                x.update(via=ts_[0], hud=f'{ts_[0]} 带出（卡面：{ts_[2]}）')
                if ts_[1] != 'play':
                    x['a'] = ts_[1]
            push(x, t)
            note_mech(x, t, 'op')
            pending_step = True
            first_side = first_side or who
        elif kind == '进场' and (m := next((m for m in mech if m['k'] == 'seize' and m['who'] == who and m.get('u')
                                              and m['u'][1] == name and -2 <= t - m['t'] <= 8), None)):
            mech.remove(m)   # 被抓过来的单位到了（离场那一步已经挪进 units），不另记
        elif kind == '进场' and (m := next((m for m in mech if m['k'] == 'transform' and m['who'] == who and m.get('u')
                                              and -1 <= t - m['t'] <= 6), None)):
            # 转变：原来那张（杜度）变成了这张敌军单位的同名牌；目标是敌方叫这个名字的单位，units 里改名
            mech.remove(m)
            enemy = 'op' if who == 'me' else 'me'
            tu = next((u for _rk, u in side_units(enemy) if u[1] == name), None)
            if tu:
                m['x']['tgts'] = [{'uid': tu[0]}]
                m['x']['hud'] = (m['x'].get('hud', '') + f' 转变为 {name}').strip()
            m['u'][1] = name
            units.setdefault(row, []).append(m['u'])
        elif kind == '进场' and (sp := next((s for s in spawners if s['who'] == who and not s['fired']
                                               and turn_ends_between(who, s['t'], t + 3) >= s['n']
                                               and any(nm == name for _id, nm in s['snap'])), None)):
            # 计时生成（千里镜）：生成的是部署时选的那张的同名牌，所以目标就是它
            sp['fired'] = True
            tid = next(i for i, nm in sp['snap'] if nm == name)
            sp['x']['tgts'] = [{'uid': tid}]
            push({'who': who, 'a': 'summon', 'c': name, 'row': ROW.get(row, 'm'), 'side': who, 'via': sp['x']['c'],
                  'hud': f"{sp['x']['c']} 计时生成"}, t)
            last_spawn[0] = (t, who, name, row)
        elif kind == '进场' and last_spawn[0] and last_spawn[0][1] == who and last_spawn[0][2] == name and \
                0 <= t - last_spawn[0][0] <= 4 and \
                (echo := next((u[1] for _rk, u in side_units(who) if M_ECHO_SPAWN.search(text_of(u[1]))), None)):
            # 随之生成（伊达兰）：己方刚生成一张，同排跟着生成 1 战力的同名牌
            push({'who': who, 'a': 'summon', 'c': name, 'row': ROW.get(row, 'm'), 'side': who, 'via': echo,
                  'pw': 1, 'hud': f'{echo} 随之生成'}, t)
            last_spawn[0] = None
        elif kind == '进场' and (gsrc := grave_trigger(t, who, name, ei)):
            push({'who': who, 'a': 'summon', 'c': name, 'row': ROW.get(row, 'm'), 'side': who,
                  'hud': f'墓场能力：打出 {gsrc} 后从墓场召唤'}, t)
        elif kind == '进场' and c.get('type') in ('单位', '神器') and (ts_ := text_source(t, who, name, ei)):
            # 卡面写明带出它的牌（生成并打出会师单位、从墓场打出、从牌组打出炼金牌……）
            if ts_[3] is not None:
                push({'who': who, 'a': 'order', 'c': ts_[0], 'uid': ts_[3][0], 'hud': f'{name} 进场：推测是这张的指令'}, t - 0.1)
            push({'who': who, 'a': ts_[1], 'c': name, 'row': ROW.get(row, 'm'), 'side': who, 'via': ts_[0],
                  'hud': f'{ts_[0]} 带出（卡面：{ts_[2]}）'}, t)
            last_spawn[0] = (t, who, name, row) if ts_[1] == 'spawn' else last_spawn[0]
        elif kind == '进场' and c.get('set') == 'token' and \
                (tsrc := next((u[1] for _rk, u in side_units(who) if name in text_of(u[1])), None)):
            push({'who': who, 'a': 'summon', 'c': name, 'row': ROW.get(row, 'm'), 'side': who, 'via': tsrc,
                  'hud': f'{tsrc} 卡面生成的衍生牌'}, t)
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
        elif False and kind == '进场' and who == 'op' and c.get('set') != 'token' and (ts0 := turn_start('op', t)) is not None and \
                not any(x['who'] == 'op' and x['a'] == 'play' and not x.get('via') and x.get('ts', 0) >= ts0 - 0.5 for x in log) and \
                not any(e[2] == '对方' and e[1] in ('打出', '展示') and 0 <= e[0] - t <= 4 and not explained('op', e[3])
                        for e in events[ei + 1:ei + 30]):
            # 每回合要从手牌打出 1 张：对方这回合还没有别的打出，这张又没有卡面来源 → 从手牌打出（展示框没认出来）
            push({'who': 'op', 'a': 'play', 'c': name, 'row': ROW.get(row, 'm'), 'side': 'op',
                  'hud': '对方这回合唯一的进场、没有卡面来源：按从手牌打出（没认出展示）'}, t)
            pending_step = True
            first_side = first_side or who
        elif kind == '进场':
            push({'who': who, 'a': 'summon', 'c': name, 'row': ROW.get(row, 'm'), 'side': who,
                  'hud': '进场（召唤/生成，或没看到打出）'}, t)
            pending_step = True
        elif kind == '领袖?':
            ltext = text_of(leader) if leader else ''
            if re.search(r'增益', ltext) and not re.search(r'伤害|摧毁|移至|锁定|生成', ltext):
                pass   # 只会加分的领袖（皇家激励）：总分没涨 = 点选后取消了，不用问
            elif review is not None:
                review.append({'ts': t, 'cat': '领袖次数', 'who': 'me', 'c': leader or '',
                               'text': '看到我方点选了领袖（图标黄光），但次数没变、我方总分也没涨：多半是取消了；'
                                       '用了的话（效果不加分）请补记领袖和目标'})
        elif kind == '领袖':
            x = {'who': who, 'a': 'leader'}
            if who == 'me' and leader:
                x['c'] = leader
            elif who == 'op' and op_leader:
                x['c'] = op_leader
            if name and row:   # 目标（leader_from_glow 按战力变化认出的）
                u = next((u for u in units.get(rowkey(who, ROW[row]), []) if u[1] == name), None)
                if u:
                    x['tgts'] = [{'uid': u[0]}]
                    x['hud'] = '目标由战力变化推出'
            push(x, t)
            pending_step = True
        elif kind == '离场' and (m := next((m for m in mech if m['k'] == 'seize' and m['who'] != who and not m.get('u')
                                              and -2 <= t - m['t'] <= 8), None)) and \
                (u := next((u for u in units.get(row, []) if u[1] == name), None)):
            # 抓捕：被抓的单位挪到对方同一排（引擎按目标自己挪），记成那张特殊牌的目标
            m['u'] = u
            m['x']['tgts'] = [{'uid': u[0]}]
            m['x']['hud'] = (m['x'].get('hud', '') + f' 抓捕 {name}').strip()
            units[row].remove(u)
            units.setdefault(rowkey(m['who'], ROW[row]), []).append(u)
            push({'who': who, 'a': 'note', 'c': f"画面：{name} 被 {m['x']['c']} 抓走（{row}）"}, t)
        elif kind == '离场' and (m := next((m for m in mech if m['k'] == 'transform' and m['who'] == who and not m.get('u')
                                              and m['name'] == name and -1 <= t - m['t'] <= 6), None)) and \
                (u := next((u for u in units.get(row, []) if u[1] == name), None)):
            m['u'] = u   # 转变：先消失，等同一方新出现的那张（进场里处理）
            units[row].remove(u)
        elif kind in ('离场', '移动', '回手'):
            if kind == '离场' and who == 'op' and (ts0 := turn_start('me', t)) is not None and \
                    (du := next((u for u in units.get(row, []) if u[1] == name), None)):
                # 对方单位在我方回合里离场，而我方这回合打出的牌解释不了（没有目标效果）：我方场上带伤害 / 对决指令的单位用了指令
                mine = [x for x in log if x['who'] == 'me' and x.get('ts', 0) >= ts0 - 0.5 and x['a'] in ('play', 'order', 'leader')]
                soon = any(e[2] == '我方' and e[1] == '离手' and cards_by_name.get(e[3], {}).get('type') == '特殊'
                           and 0 <= e[0] - t <= 8 and not flicker_special(e[0], e[3], e[4]) for e in events[ei + 1:ei + 40])
                if not soon and not any(x['a'] in ('order', 'leader') or target_text(cards_by_name.get(x.get('c'), {}))
                                        for x in mine):
                    cands = [u for _rk, u in side_units('me') if M_DMG_ORDER.search(text_of(u[1])) and order_used.get(u[0]) != ts0]
                    if len(cands) == 1:
                        order_used[cands[0][0]] = ts0
                        push({'who': 'me', 'a': 'order', 'c': cands[0][1], 'uid': cands[0][0], 'tgts': [{'uid': du[0]}],
                              'hud': '对方单位在我方回合离场，这回合打出的牌没有目标效果：推测是这张的指令'}, t - 0.2)
                        pending_step = True
                    elif review is not None:
                        review.append({'ts': t, 'cat': '我方指令', 'who': 'me', 'c': name,
                                       'text': f'对方 {name} 在我方回合离场，这回合打出的牌解释不了；能用伤害指令的：'
                                               f"{'、'.join(u[1] for u in cands) or '没有'}。请补记是谁的指令"})
            if kind == '移动' and '→' in row:
                mu = next((u for u in units.get(row.split('→')[0], []) if u[1] == name), None)
                self_move = M_SELF_MOVE.search(text_of(name)) and near_turn_end(who, t)
                ts0 = turn_start(who, t)
                if mu and not self_move and ts0 is not None:
                    # 不是回合结束时的自动换排：这一方场上有“指令：将 1 个单位移至另一排”、这回合还没用过的单位（玛丽娜）
                    srcs = [u for _rk, u in side_units(who) if M_MOVE_ORDER.search(text_of(u[1])) and order_used.get(u[0]) != ts0]
                    if srcs:
                        order_used[srcs[0][0]] = ts0
                        push({'who': who, 'a': 'order', 'c': srcs[0][1], 'uid': srcs[0][0], 'tgts': [{'uid': mu[0]}],
                              'hud': '回合中途移排：推测是这张的指令'}, t - 0.2)
                        pending_step = True
                    elif who == 'op' and op_lead_drop(ts0, t) > lead_used.get(ts0, 0):
                        lead_used[ts0] = lead_used.get(ts0, 0) + 1
                        push({'who': 'op', 'a': 'leader', **({'c': op_leader} if op_leader else {}), 'tgts': [{'uid': mu[0]}],
                              'hud': '回合中途移排、没有可用的移排指令、这回合对方领袖次数在减少：推测是领袖技能'}, t - 0.2)
                        pending_step = True
                    elif review is not None:
                        review.append({'ts': t, 'cat': '中途移排', 'who': who, 'c': name,
                                       'text': f"{'我方' if who == 'me' else '对方'} {name} 在自己回合中途换排（{row}），"
                                               '场上没有可用的移排指令：多半是领袖技能，请补记'})
            if kind == '离场' and (du2 := next((u for u in units.get(row, []) if u[1] == name), None)):
                departed.append((t, who, row, du2))
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
    # 按卡面机制补目标（都是画面上能确定的）
    tgt_used = {t_['uid'] for x in log for t_ in x.get('tgts') or [] if isinstance(t_, dict) and 'uid' in t_}
    for i, x in enumerate(log):
        if x.get('tgts') or 'ts' not in x:
            continue
        c = cards_by_name.get(x.get('c'), {})
        tt = target_text(c) if x['a'] in ('play', 'spawn') else ''
        if x['a'] in ('play', 'spawn') and re.search(r'伤害|摧毁', tt):
            # 伤害 / 摧毁：特殊牌前后 8 秒、单位打出后 6 秒内，卡面那一方（友军 / 敌军）正好离场 1 个（还没算到别的动作头上）的单位
            lo_, hi_ = (-8, 8) if c.get('type') == '特殊' else (0, 6)
            sides = {x['who']} if '友军' in tt else {'me', 'op'} - {x['who']} if '敌军' in tt else {'me', 'op'}
            gone = [d for d in departed if d[1] in sides and lo_ <= d[0] - x['ts'] <= hi_ and d[3][0] not in tgt_used
                    and d[3][0] != x.get('id')]
            if len(gone) == 1:
                x['tgts'] = [{'uid': gone[0][3][0]}]
                tgt_used.add(gone[0][3][0])
                x['hud'] = (x.get('hud', '') + '；目标：前后几秒唯一离场的单位').strip('；')
        elif x['a'] == 'play' and '移除其锁定' in (c.get('text') or ''):
            # 增益并解除锁定：同一方场上唯一被锁定的单位（铁隼吟游诗人生成的会师单位）
            gone_ids = {d[3][0] for d in departed if d[0] <= x['ts']}
            locked = [y for y in log[:i] if y['who'] == x['who'] and y['a'] in ('play', 'spawn', 'summon') and y.get('row')
                      and '锁定' in (y.get('hud') or '') and y.get('id') not in gone_ids and y.get('r') == x.get('r')]
            if len(locked) == 1:
                x['tgts'] = [{'uid': locked[0]['id']}]
                x['hud'] = (x.get('hud', '') + '；目标：场上唯一被锁定的单位（卡面会解除锁定）').strip('；')
    resolve_leader_chain()
    if review is not None:
        for i, x in enumerate(log):
            c, side = x.get('c') or '', '我方' if x['who'] == 'me' else '对方'
            item = None
            if x.pop('tgt_unsure', False):
                names = '、'.join((next((y.get('c') for y in log if y.get('id') == t_.get('uid')), None) or '?')
                                  for t_ in x.get('tgts') or [])
                item = ('效果目标', f'{side}{"用了领袖" if x["a"] == "leader" else "打出"} {c}：和别的带目标的牌几秒内连着结算，'
                                   f'HUD 按战力变化猜是 {names}，拿不准，请核对')
            elif x['a'] == 'leader' and not x.get('tgts'):
                item = ('领袖目标', f'{side}用了领袖{"（" + c + "）" if c else ""}：HUD 看不出用在谁身上' +
                        ('（对方领袖也不知道是哪个技能）' if x['who'] == 'op' else ''))
            elif x['a'] in ('play', 'spawn') and target_text(cards_by_name.get(c, {})) and not x.get('tgts'):
                item = ('效果目标', f'{side}打出 {c}：目标没推出来（{target_text(cards_by_name[c])}）')
            elif x['a'] == 'summon' and x.get('hud', '').startswith('进场（召唤') and \
                    cards_by_name.get(c, {}).get('set') != 'token':   # 衍生牌只能是生成的
                item = ('打出还是带出', f'{side} {c} 进场，没看到打出：是从手牌打出、还是被别的牌召唤 / 生成？')
            elif x['a'] == 'note' and re.search(r' 离场（', c) and not any(
                    y['a'] in ('play', 'order', 'leader') and y.get('tgts') and abs(y.get('ts', 0) - x.get('ts', 0)) <= 10
                    and re.search(r'伤害|摧毁|对决', target_text(cards_by_name.get(y.get('c'), {})) + text_of(y.get('c', '')))
                    for y in log):   # 附近有带伤害 / 摧毁目标的动作，离场原因清楚
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
        'fac': facs.most_common(1)[0][0] if facs else 'NR', 'opLeader': op_leader,
        'coin': {'me': '先', 'op': '后'}.get(first_side), 'rounds': rounds, 'log': log,
        'note': f'hud 自动识别（{time.strftime("%Y-%m-%d %H:%M")}），召唤记录和备注需要核对',
    }


LEADER_ME = '皇家激励'   # 用户的领袖（卡组固定）


def leader_from_glow(events, states, eps, cards_by_name=None, boost_max=None):
    """我方领袖：图标黄光（已点选、正在找目标）的每一段 [t0, t1]，看前后的证据——
    总分：黄光前稳定的我方总分 vs 黄光后（t1 + 1 ~ 4 秒）稳定的总分，涨了 = 真的用了（取消不会涨分）；
    目标：前后我方各单位战力（整排牌名对得上的帧取中位数），涨得最多（≥ 2）的那张。
    皇家激励触发神赐会重置次数（增益 -1），次数一直显示 1，所以不能只看次数。
    次数减少记到的领袖配它之前最近的一段黄光，补上目标；没配上黄光的照旧。
    返回新的事件表：领袖事件的 牌名 / 排 = 目标（没认出为空）。"""
    import statistics

    def score_at(a, b, pick, my_turn=False):
        # my_turn：只看还在我方回合的帧——停牌那一下也结算回合结束效果（对局簿 2026-10-02 确认），
        # 停牌后的加分不能当成领袖的证据
        vals = [ent['score'][1] for t, ent in states if a <= t <= b and ent.get('score') and ent['score'][1] is not None
                and ent.get('sharp', 0) >= ent.get('smin', 40) and (not my_turn or ent.get('turn') != 'op')]
        runs = [v for v, w in zip(vals, vals[1:]) if v == w]   # 连续两帧一样的才算
        return (runs[-1] if pick == 'last' else runs[0]) if runs else None

    def powers(a, b):
        """{(排, 牌名, 第几张): 中位数战力}"""
        acc = {}
        for t, ent in states:
            if not a <= t <= b:
                continue
            for rk in ('我方近战', '我方远程'):
                seen = {}
                for n, p in zip(ent.get('rows', {}).get(rk, []), (ent.get('pw') or {}).get(rk, [])):
                    k = seen[n] = seen.get(n, -1) + 1
                    if p is not None:
                        acc.setdefault((rk, n, k), []).append(p)
        return {k: statistics.median(v) for k, v in acc.items() if len(v) >= 2}

    info = []
    for t0, t1 in eps:
        # 黄光常在加分之后才拍到（点选后很快就结算、光还在淡出）：黄光前的总分取开始前 1.5 秒以前的（2026-10-01 皇家激励 → 雷纳德）
        s0, s1 = score_at(t0 - 8, t0 - 1.5, 'last'), score_at(t1 + 1, t1 + 5, 'first', my_turn=True)
        p0, p1 = powers(t0 - 4, t0 - 0.1), powers(t1 + 1, t1 + 5)
        gains = [(p1[k] - p0[k], k) for k in p0 if k in p1]
        # 黄光之前几秒才落地的（少女的盾牌）前面没有读数：按卡面基础战力算增益
        present = set()   # 黄光期间场上已经有的（之后才生成的布朗温不算）
        for t_, ent in states:
            if t0 - 3 <= t_ <= t1 + 0.5:
                for rk in ('我方近战', '我方远程'):
                    seen = {}
                    for n in ent.get('rows', {}).get(rk, []):
                        seen[n] = seen.get(n, -1) + 1
                        present.add((rk, n, seen[n]))
        gains += [(p1[k] - int(base), k) for k in p1 if k not in p0 and k in present
                  and str(base := ((cards_by_name or {}).get(k[1]) or {}).get('power')).isdigit()]
        # 免疫的（布朗温）不能被指定；涨得最多的要比第二名多 2 以上才算（同时还有神赐、灌注、护盾金光读错，拿不准就问）
        gains = sorted((g for g in gains if '免疫' not in ((cards_by_name or {}).get(g[1][1]) or {}).get('text', '')
                        and (boost_max is None or g[0] <= boost_max)), reverse=True)   # 比卡面增益还多的是读错（护盾金光下的两位数）
        best = gains[0] if gains else (0, None)
        sure = best[0] >= 2 and (len(gains) < 2 or best[0] - gains[1][0] >= 2)
        info.append({'t0': t0, 't1': t1, 'used': s0 is not None and s1 is not None and s1 > s0,
                     'tg': best[1] if sure else None})
    out, taken = [], set()
    for e in events:
        if e[1] == '领袖' and e[2] == '我方':
            j = max((j for j, it in enumerate(info) if j not in taken and it['t0'] <= e[0] + 1 and e[0] - it['t1'] <= 12),
                    default=None, key=lambda j: info[j]['t0'])
            if j is not None:
                taken.add(j)
                tg = info[j]['tg']
                out.append((e[0], '领袖', '我方', tg[1] if tg else '', tg[0] if tg else ''))
                continue
        if e[1] == '领袖?':
            continue
        out.append(e)
    for j, it in enumerate(info):
        if j in taken:
            continue
        tg = it['tg']
        if it['used']:
            out.append((it['t0'], '领袖', '我方', tg[1] if tg else '', tg[0] if tg else ''))
        else:
            out.append((it['t0'], '领袖?', '我方', '', ''))
    return sorted(out, key=lambda e: e[0])


def identify_op_leader(frame_paths, fac, cards, every=8):
    """对方领袖技能：抽样的帧里对方徽章纹章和该阵营各领袖技能图标比，取各自分数的中位数；
    最高的 ≥ 0.45、比第二名高 0.12 以上才算认出（返回牌名），否则 None（清单里问一次）。
    游击战术 0.79 / 0.35；战斗狂热（蘑菇）0.52 / 0.39——游戏里蘑菇柄是暗褐色、不算金色，只比得上伞盖（2026-10-01）。"""
    import statistics
    import cv2
    import detect
    leaders = {str(c['id']): c['name'] for c in cards if c.get('type') == '领袖能力' and (not fac or c.get('fac') == fac)
               and c.get('id')}
    acc = {k: [] for k in leaders}
    for p in frame_paths[::every]:
        im = cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)
        sc = detect.leader_icon_scores(im, 'op', list(leaders))
        if sc and max(sc.values()) > 0.3:   # 覆盖界面 / 徽章不在的帧不算
            for k, v in sc.items():
                acc[k].append(v)
    med = sorted(((statistics.median(v), k) for k, v in acc.items() if len(v) >= 5), reverse=True)
    if med and med[0][0] >= 0.45 and (len(med) < 2 or med[0][0] - med[1][0] >= 0.12):
        return leaders[med[0][1]], med[:3]
    return None, med[:3]


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
    """review.html：HUD 拿不准、要人看录屏补的地方，每条附前后两帧截图（嵌在页面里）。"""
    import bisect
    import glob
    import html
    frames = sorted(glob.glob(os.path.join(d, '*.jpg')) + glob.glob(os.path.join(d, '*.png')), key=timeline.frame_time)
    ft = [timeline.frame_time(p) for p in frames]

    def near(t):
        """离 t 最近的帧，缩到 1280 宽嵌进页面（单个文件拿到哪都能看）。"""
        import base64
        import cv2
        import numpy as np
        if not frames:
            return ''
        i = min(bisect.bisect_left(ft, t), len(ft) - 1)
        im = cv2.imdecode(np.fromfile(frames[i], np.uint8), cv2.IMREAD_COLOR)
        im = cv2.resize(im, (1280, round(im.shape[0] * 1280 / im.shape[1])), interpolation=cv2.INTER_AREA)
        return 'data:image/jpeg;base64,' + base64.b64encode(cv2.imencode('.jpg', im, [cv2.IMWRITE_JPEG_QUALITY, 80])[1]).decode()
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
    by_name = {c['name']: c for c in m.cards}
    lb = re.search(r'获得\s*(\d+)\s*点增益', (by_name.get(LEADER_ME) or {}).get('text') or '')
    events = leader_from_glow(tr.finish(), states, tr.__dict__.get('glow_eps', []), by_name, int(lb.group(1)) + 1 if lb else None)
    spec = next((a[7:] for a in sys.argv if a.startswith('--deck=')), None)
    events = synth_specials(events, states, deck.load(spec, m.cards), {c['name']: c for c in m.cards}, turn_runs(states))
    scores = stable_scores(states)
    has_show = any(ent.get('show') for _t, ent in states) or not any(ent.get('prof') == '4:3' for _t, ent in states)
    spec = next((a[7:] for a in sys.argv if a.startswith('--deck=')), None)
    my_deck = deck.load(spec, m.cards)
    sync = '--sync-power' in sys.argv
    video = next((a[8:] for a in sys.argv if a.startswith('--video=')), None)
    t0 = video_start(video) if video else None
    src = os.path.join(d, 'source.json')   # video_frames.py 从视频抽的帧：录屏时间就是这个视频的进度
    if t0 is None and os.path.exists(src):
        with open(src, encoding='utf-8') as f:
            meta = json.load(f)
        video, t0 = meta.get('video'), meta.get('start')
    review = []
    import glob
    op_facs = Counter(m.cards_by_name[n]['fac'] for _t, k, side, n, _r in events
                      if side == '对方' and k in ('打出', '展示') and n in m.cards_by_name and m.cards_by_name[n]['fac'] != 'NE')
    frame_paths = sorted(glob.glob(os.path.join(d, '*.jpg')) + glob.glob(os.path.join(d, '*.png')), key=timeline.frame_time)
    op_leader, lead_scores = identify_op_leader(frame_paths, op_facs.most_common(1)[0][0] if op_facs else None, m.cards)
    print('对方领袖：' + (op_leader or '没认出') + '（' + '、'.join(f'{m.by_id.get(int(k), k)} {v:.2f}' for v, k in lead_scores) + '）')
    if not op_leader and any(e[1] == '领袖' and e[2] == '对方' for e in events):
        review.append({'ts': next(e[0] for e in events if e[1] == '领袖' and e[2] == '对方'), 'cat': '对方领袖',
                       'who': 'op', 'c': '', 'text': '对方领袖技能没认出（徽章图案和 gwent.one 图标比不上）：是哪个？导入后在对方领袖处选'})
    game = build_game(events, scores, date, {c['name']: c for c in m.cards}, has_show=has_show, my_deck=my_deck,
                      runs=turn_runs(states), extra=tr.extra, sync_states=states if sync else None, states=states,
                      deck_filter='--no-deck-filter' not in sys.argv, t0=t0,
                      review=review, op_leader=op_leader)
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
