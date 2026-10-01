"""HUD 导出的对局（game.json）和对局簿里手记的同一局（v2 对局代码）逐条对照。

python hud/check_record.py 帧目录/game.json 对局代码.txt

按小局、按双方，把“打出 / 带出（via）/ 领袖 / 指令”排成序列，用最长公共子序列对齐，列出两边不同的地方：
  - 手记有、HUD 没有 = 漏；HUD 有、手记没有 = 多；带出的写成 牌名<来源。
  - 领袖、带目标的牌另外比目标（HUD 推出的目标和手记的不同，或 HUD 没推出）。
用来在给用户待确认清单之前，先把 HUD 能自己答出来的找出来。
"""
import difflib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ACTS = ('play', 'summon', 'spawn', 'leader', 'order')


def load_record(path):
    out = subprocess.run(['node', os.path.join(HERE, 'from_v2.js'), path], capture_output=True, text=True,
                         encoding='utf-8', check=True).stdout
    return json.loads(out)


def tokens(g, r, who):
    ids = {x.get('id'): x for x in g['log']}
    out = []
    for x in g['log']:
        if x.get('r', 0) != r or x.get('who') != who or x.get('a') not in ACTS:
            continue
        c = x.get('c') or ''
        a = {'summon': 'play', 'spawn': 'play'}.get(x['a'], x['a'])
        tok = f"{a} {c}" + (f"<{x['via']}" if x.get('via') else '')
        tg = []
        for t in x.get('tgts') or []:
            u = ids.get(str(t.get('uid', '')).split('/')[0])
            tg.append((u.get('c') if u else None) or '带出的单位')
        out.append((tok, tg, x.get('vt', ''), x['a'] == 'summon'))
    return out


def main():
    hud = json.load(open(sys.argv[1], encoding='utf-8'))
    rec = load_record(sys.argv[2])
    nr = max(len(hud.get('rounds', [])), len(rec.get('rounds', [])))
    tot = {'same': 0, 'miss': 0, 'extra': 0, 'tg': 0, 'auto': 0}
    for r in range(nr):
        print(f'\n== 第 {r + 1} 小局  手记 {rec["rounds"][r]["me"] if r < len(rec["rounds"]) else "?"}:'
              f'{rec["rounds"][r]["op"] if r < len(rec["rounds"]) else "?"}')
        for who, lab in (('me', '我方'), ('op', '对方')):
            a, b = tokens(rec, r, who), tokens(hud, r, who)
            # HUD 不知道对方领袖是哪个技能（记成没有牌名的 leader）：按手记里的领袖名对齐
            opl = next((t[0] for t in a if t[0].startswith('leader ') and t[0] != 'leader '), None)
            if opl:
                b = [((opl,) + t[1:]) if t[0] == 'leader ' else t for t in b]
            sm = difflib.SequenceMatcher(a=[t[0] for t in a], b=[t[0] for t in b], autojunk=False)
            for op, i1, i2, j1, j2 in sm.get_opcodes():
                if op == 'equal':
                    for (ta, ga, _, _s), (tb, gb, vt, _s2) in zip(a[i1:i2], b[j1:j2]):
                        tot['same'] += 1
                        if ga and gb and len(ga) == len(gb) and all(x == y or x == '带出的单位' for x, y in zip(ga, gb)):
                            continue   # 手记里引用“第 N 步带出的单位”没有牌名，按 HUD 的算对
                        if ga and ga != gb:
                            tot['tg'] += 1
                            print(f'  {lab} 目标不同  {ta}：手记 {"、".join(ga)}，HUD {"、".join(gb) or "（没推出）"}  [{vt}]')
                    continue
                for t in a[i1:i2]:
                    tot['miss'] += 1
                    print(f'  {lab} 漏  {t[0]}' + (f' → {"、".join(t[1])}' if t[1] else ''))
                for t in b[j1:j2]:
                    if '<' in t[0] and t[3]:
                        tot['auto'] += 1   # 引擎会自己生成的（千里镜计时、伊达兰随之生成、布朗温……），手记里不记
                        print(f'  {lab} 带出  {t[0]}  [{t[2]}]（引擎自动生成，手记不记，不算多）')
                        continue
                    tot['extra'] += 1
                    print(f'  {lab} 多  {t[0]}  [{t[2]}]')
    print(f"\n合计：对上 {tot['same']}，漏 {tot['miss']}，多 {tot['extra']}，目标不同 / 没推出 {tot['tg']}")


if __name__ == '__main__':
    main()
