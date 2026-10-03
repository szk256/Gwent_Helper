"""回归：改识别代码之后一条命令跑完所有评估，和上一次存的基线比，变差的标出来。

python hud/regress.py            跑一遍，和基线（cache/regress_base.json）比
python hud/regress.py --save     跑完把这次结果存成新基线（确认改进之后再存）
python hud/regress.py --rescan   先删掉 scan.json 重新认牌（改了认牌 / 模板时用；慢，约 10 分钟）

评估项（录像和标注都在 hud/cache/rec/，不提交）：
- 真人局（森林棋盘，对松鼠党）20261001-091223：手记对照（check_record.py）、我方两排逐帧（eval.py board，truth.json）、
  时间线、战力评估集（eval_power.py，power_truth.json）、对方半场抽帧（op_truth.py，op_truth.json）、待确认条数
- 真人局（北方营地棋盘，对斯凯利格乌鸦）20261001-221256：手记对照、对方半场抽帧、战力评估集（39 张）、待确认条数；同一局 OBS 录屏抽帧 2026-10-01_22-13-10
- 人机局 20261001-035648：游戏日志里 AI 的出牌认出几张（timeline.py）
"""
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
REC = os.path.join(HERE, 'cache', 'rec')
BASE = os.path.join(HERE, 'cache', 'regress_base.json')
LAST = os.path.join(HERE, 'cache', 'regress_last.json')

GAMES = {
    '20261001-091223': {'video': '20261001-0112-44.6374215.mp4', 'record': True, 'truth': True, 'op': True},
    '20261001-221256': {'video': '2026-10-01 22-13-10.mp4', 'record': True, 'op': True, 'power': True},
    '2026-10-01_22-13-10': {'record': True},   # 同一局的 OBS 录屏抽帧（source.json 里有视频路径）
    '20261001-035648': {'ai': True},
    'Gwent_The_Witcher_Card_Game_2026_10_02_-_23_44_12_06': {'record': True, 'date': '20261002'},   # 2560×1440 NVIDIA 录屏，对尼弗迦德
}
# 指标：越大越好的 / 越小越好的
HIGHER = {'推算核对点', '对上', '逐帧准确率', '逐帧召回', '时间线对上', '战力原始', 'AI出牌', '对方逐帧对'}
LOWER = {'漏', '多', '目标不同', '待确认', '多认', '漏认', '时间线多出', '时间线漏', '对方多认', '对方漏认'}


def run(args, timeout=1800):
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    p = subprocess.run(args, cwd=HERE, capture_output=True, text=True, encoding='utf-8', errors='replace',
                       env=env, timeout=timeout)
    return p.stdout + p.stderr


def num(pat, text, cast=float):
    m = re.search(pat, text)
    return cast(m.group(1)) if m else None


def eval_game(name, cfg):
    d = os.path.join('cache', 'rec', name)
    out = {}
    if cfg.get('ai'):
        t = run([sys.executable, 'timeline.py', d, name[:8]])
        out['AI出牌'] = num(r'对上 (\d+)/\d+', t, int)
        return name, out
    args = [sys.executable, 'export.py', d, cfg.get('date', name[:8]), '--jobs=6', '--deck=deck.txt']
    if cfg.get('video'):
        args.append('--video=' + os.path.join('cache', 'rec', cfg['video']))
    # 不同步战力的导出喂给对局簿推算引擎（TRACKER=别的 gwent_tracker.html 换引擎）：记录本身（落地战力、目标、来源）对不对，
    # 核对点对上几个（同步战力会把偏差抹掉，所以单独导一次）
    run(args)
    t = run(['node', 'replay_check.js', os.path.join(d, 'game_v2.txt')])
    m = re.search(r'合计核对点一致 (\d+)/(\d+)', t)
    if m:
        out['推算核对点'] = int(m.group(1))
        out['核对点总数'] = int(m.group(2))
    t = run(args + ['--sync-power'])
    out['待确认'] = num(r'待确认 (\d+) 条', t, int)
    out['比分'] = ' / '.join(re.findall(r'第 \d 小局 \w (\d+:\d+)', t))
    if cfg.get('record'):
        t = run([sys.executable, 'check_record.py', os.path.join(d, 'game.json'), os.path.join(d, 'record_v2.txt')])
        m = re.search(r'合计：对上 (\d+)，漏 (\d+)，多 (\d+)，目标不同 / 没推出 (\d+)', t)
        if m:
            out.update({'对上': int(m.group(1)), '漏': int(m.group(2)), '多': int(m.group(3)), '目标不同': int(m.group(4))})
    if cfg.get('op'):
        t = run([sys.executable, 'op_truth.py', 'eval', d])
        m = re.search(r'对 (\d+)，多认 (\d+)，漏认 (\d+)', t)
        if m:
            out.update({'对方逐帧对': int(m.group(1)), '对方多认': int(m.group(2)), '对方漏认': int(m.group(3))})
    if cfg.get('power'):
        t = run([sys.executable, 'eval_power.py', d])
        out['战力原始'] = num(r'原始读数对 (\d+)', t, int)
    if cfg.get('truth'):
        t = run([sys.executable, 'eval.py', 'board', d])
        out['逐帧准确率'] = num(r'准确率 ([\d.]+)%', t)
        out['逐帧召回'] = num(r'召回 ([\d.]+)%', t)
        out['多认'] = num(r'多认 (\d+)', t, int)
        out['漏认'] = num(r'漏认 (\d+)', t, int)
        m = re.search(r'时间线：真实 \d+ 条，对上 (\d+)，漏 (\d+)，多出 (\d+)', t)
        if m:
            out.update({'时间线对上': int(m.group(1)), '时间线漏': int(m.group(2)), '时间线多出': int(m.group(3))})
        t = run([sys.executable, 'eval_power.py', d])
        out['战力原始'] = num(r'原始读数对 (\d+)', t, int)
    return name, out


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    if '--rescan' in sys.argv:
        for name in GAMES:
            p = os.path.join(REC, name, 'scan.json')
            if os.path.exists(p):
                os.replace(p, p + '.bak')
    # 认牌（没缓存时）占满 CPU：几局依次扫，扫完的评估并行
    with ThreadPoolExecutor(3) as ex:
        res = dict(ex.map(lambda kv: eval_game(*kv), GAMES.items()))
    with open(LAST, 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    base = json.load(open(BASE, encoding='utf-8')) if os.path.exists(BASE) else {}
    worse = 0
    for name, r in res.items():
        print(f'== {name}')
        for k, v in r.items():
            b = base.get(name, {}).get(k)
            mark = ''
            if isinstance(v, (int, float)) and isinstance(b, (int, float)) and v != b:
                bad = (k in HIGHER and v < b) or (k in LOWER and v > b)
                mark = f'  （基线 {b}，{"变差" if bad else "变好"}）'
                worse += bad
            elif b is not None and v != b:
                mark = f'  （基线 {b}）'
            print(f'  {k}: {v}{mark}')
    print(f'\n变差 {worse} 项' if base else '\n还没有基线：确认结果没问题后 python hud/regress.py --save')
    if '--save' in sys.argv:
        with open(BASE, 'w', encoding='utf-8') as f:
            json.dump(res, f, ensure_ascii=False, indent=1)
        print('已存为基线 →', BASE)


if __name__ == '__main__':
    main()
