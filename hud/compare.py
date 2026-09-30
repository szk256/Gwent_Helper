"""把 hud 导出的对局（game.json）和对局簿里手记的同一局比较：出牌认出了多少、多记了多少、每局比分对不对。

python hud/compare.py 帧目录/game.json 对局簿备份.json      （自动按每局比分找最像的那一局）
"""
import json
import sys
from collections import Counter


def plays(g, r, kinds=('play',)):
    """第 r 局双方的出牌（牌名计数）。对局簿里带 via 的是由别的牌带出的，不算从手牌打出。"""
    out = {'me': Counter(), 'op': Counter()}
    for x in g['log']:
        if x.get('r', 0) != r or x.get('a') not in kinds or not x.get('c'):
            continue
        if x.get('via'):
            continue
        out[x.get('who', 'me')][x['c']] += 1
    return out


def units(g, r):
    """第 r 局双方上过场的所有牌（打出、召唤、生成都算）。"""
    return plays(g, r, kinds=('play', 'summon', 'spawn'))


def score_key(g):
    return [(str((R or {}).get('me', '')), str((R or {}).get('op', ''))) for R in g.get('rounds', [])]


def pick(truth_games, g):
    mine = score_key(g)

    def num(v):
        try:
            return int(v)
        except ValueError:
            return 0

    def dist(t):  # 每局比分差的总和，越小越像
        return sum(abs(num(a[0]) - num(b[0])) + abs(num(a[1]) - num(b[1])) for a, b in zip(mine, score_key(t)))
    return min(truth_games, key=dist)


def main():
    g = json.load(open(sys.argv[1], encoding='utf-8'))
    db = json.load(open(sys.argv[2], encoding='utf-8'))
    games = db.get('games', []) + ([db['live']] if db.get('live') else [])
    t = pick(games, g)
    print(f"对局簿那局：{t.get('date')} 比分 {score_key(t)}；hud：{score_key(g)}")
    tot = {'hit': 0, 'miss': 0, 'extra': 0}
    for r in range(max(len(t.get('rounds', [])), len(g.get('rounds', [])))):
        tp, hp = plays(t, r), units(g, r)
        tu = units(t, r)
        print(f'\n第 {r + 1} 小局')
        for who, lab in (('me', '我方'), ('op', '对方')):
            hit = sum((tp[who] & hp[who]).values())
            miss = tp[who] - hp[who]
            extra = hp[who] - tu[who]       # 连召唤/生成的也不在对局簿里的，才算多记
            tot['hit'] += hit
            tot['miss'] += sum(miss.values())
            tot['extra'] += sum(extra.values())
            print(f"  {lab}：对局簿打出 {sum(tp[who].values())} 张，认出 {hit}；"
                  f"漏 {dict(miss) or '无'}；多记 {dict(extra) or '无'}")
    n = tot['hit'] + tot['miss']
    print(f"\n合计：对局簿打出 {n} 张，认出 {tot['hit']}（{tot['hit'] / max(1, n):.0%}），多记 {tot['extra']} 张")


if __name__ == '__main__':
    main()
