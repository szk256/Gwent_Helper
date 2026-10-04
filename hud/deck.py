"""读我方卡组：对局簿备份 JSON（db.decks，按名字或取第一套）或 #GWDECK v2 卡组代码。

我方的牌只认卡组里有的（外加衍生牌），手牌区的误识别就进不来。
默认找 hud/deck.txt（放一段卡组代码或备份文件路径）；都没有就不限制。
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))


def from_code(txt, cards):
    """#GWDECK v2 f=NR ld=… tac=… name=… + 编号x张数"""
    by_id = {c['id']: c['name'] for c in cards if c.get('id')}
    out = {}
    for m in re.finditer(r'(?<![=\w])(\d+)x(\d+)', txt):
        n = by_id.get(int(m.group(1)))
        if n:
            out[n] = out.get(n, 0) + int(m.group(2))
    return out


def tactic(spec=None, cards=()):
    """卡组代码里的战术牌（tac=编号）的牌名；读不到返回 None。"""
    if spec is None:
        p = os.path.join(HERE, 'deck.txt')
        if not os.path.exists(p):
            return None
        with open(p, encoding='utf-8') as f:
            spec = f.read()
    m = re.search(r'tac=(\d+)', spec)
    return next((c['name'] for c in cards if m and c.get('id') == int(m.group(1))), None)


def from_backup(path, name=None):
    with open(path, encoding='utf-8') as f:
        db = json.load(f)
    decks = db.get('decks') or []
    d = next((k for k in decks if name and k.get('name') == name), decks[0] if decks else None)
    return dict(d['cards']) if d else {}


def load(spec=None, cards=()):
    """spec：卡组代码、备份文件路径，或 None（读 hud/deck.txt）。返回 {牌名: 张数}，读不到返回 {}。"""
    if spec is None:
        p = os.path.join(HERE, 'deck.txt')
        if not os.path.exists(p):
            return {}
        with open(p, encoding='utf-8') as f:
            spec = f.read().strip()
    if spec.startswith('#GWDECK'):
        return from_code(spec, cards)
    path = spec.split('|')[0].strip()
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            head = f.read(16).lstrip('﻿').strip()
        if head.startswith('#GWDECK'):  # 放着卡组代码的文本文件
            with open(path, encoding='utf-8') as f:
                return from_code(f.read(), cards)
        return from_backup(path, spec.split('|')[1].strip() if '|' in spec else None)
    return {}
