"""从录屏视频里抽帧，文件名按录制时刻 HHMMSS_d.jpg，给 timeline.py / export.py 用（和 record.py 录的帧一样处理）。

python hud/video_frames.py 视频 [开始时刻HHMMSS] [--crop=x,y,w,h] [--fps=3]

- 时刻按视频自带的时间戳（丢帧不会漂移）；开始时刻依次取：参数、OBS 默认文件名（2026-10-01 21-13-45.mp4，本地时间）、
  NVIDIA 录屏文件名（Gwent The Witcher Card Game 2026.10.02 - 23.44.12.06.mp4，本地时间）、
  带 UTC 时间的文件名（20261001-0112-44.6374215.mp4）、iPad 录屏文件名（ScreenRecording_09-30-2026 20-29-17）、
  修改时间 − 时长。
- 抽帧和 record.py 一样：画面变了至少隔 1/fps 秒存一张；右侧展示框（对方出牌放大，不到 1 秒）出现时每 0.1 秒存一张。
- 画面带窗口标题栏 / 边框（不是 16:9 / 4:3）时自动裁出游戏区域；也可以 --crop 指定。
- 输出到 hud/cache/rec/<视频名>/，另写 source.json（视频路径、开始时刻），export.py 用它算“录屏时间”（就是视频进度）。
"""
import json
import os
import re
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def start_of(path, cap):
    """视频开始的时刻（本地，当天秒数）。"""
    base = os.path.basename(path)
    m = re.search(r'(\d{4})-(\d\d)-(\d\d)[ _](\d\d)-(\d\d)-(\d\d)', base)          # OBS 默认（本地时间）
    if not m:
        m = re.search(r'(\d{4})\.(\d\d)\.(\d\d) - (\d\d)\.(\d\d)\.(\d\d)', base)   # NVIDIA 录屏：2026.10.02 - 23.44.12.06（本地时间）
    if m:
        return int(m.group(4)) * 3600 + int(m.group(5)) * 60 + int(m.group(6))
    m = re.search(r'(\d{8})-(\d\d)(\d\d)-(\d\d(?:\.\d+)?)', base)                # 20261001-0112-44.63（UTC）
    if m:
        return (int(m.group(2)) * 3600 + int(m.group(3)) * 60 + float(m.group(4)) + time.localtime().tm_gmtoff) % 86400
    m = re.search(r'(\d\d)-(\d\d)-(\d\d)(?!.*\d\d-\d\d-\d\d)', base)              # iPad：… 20-29-17
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
    dur = cap.get(cv2.CAP_PROP_FRAME_COUNT) / max(1.0, cap.get(cv2.CAP_PROP_FPS) or 30)
    lt = time.localtime(os.path.getmtime(path))
    return lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec - dur


def game_area(W, H):
    """视频画面里游戏区域 (x, y, w, h)：已经是 16:9 / 4:3 就是整幅；否则按“左右各 2 像素边框、顶上标题栏、底下 2 像素”裁
    （窗口模式连边框一起录的，如 3204×1860 → 3200×1800 @ (2, 58)）。"""
    for ar in (16 / 9, 4 / 3):
        if abs(W / H - ar) < 0.01:
            return 0, 0, W, H
    gw = W - 4
    gh = round(gw * 9 / 16)
    if gh > H:
        return 0, 0, W, H
    return 2, H - gh - 2, gw, gh


def main():
    import detect
    path = sys.argv[1]
    base = os.path.splitext(os.path.basename(path))[0]
    cap = cv2.VideoCapture(path)
    arg_start = next((a for a in sys.argv[2:] if re.fullmatch(r'\d{6}', a)), None)
    t0 = (int(arg_start[:2]) * 3600 + int(arg_start[2:4]) * 60 + int(arg_start[4:])) if arg_start else start_of(path, cap)
    fps_out = float(next((a[6:] for a in sys.argv if a.startswith('--fps=')), 3))
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    crop = next((tuple(int(v) for v in a[7:].split(',')) for a in sys.argv if a.startswith('--crop=')), None) or game_area(W, H)
    x, y, w, h = crop
    out = os.path.join(HERE, 'cache', 'rec', re.sub(r'[^\w-]', '_', base))
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'source.json'), 'w', encoding='utf-8') as f:
        json.dump({'video': os.path.abspath(path), 'start': t0, 'crop': crop}, f, ensure_ascii=False)
    print(f'视频 {W}×{H}，游戏区域 {w}×{h} @ ({x},{y})；开始 {time.strftime("%H:%M:%S", time.gmtime(t0))} → {out}')
    prev, n, last_save, i = None, 0, -9.0, 0
    t_start = time.time()
    while True:
        ok, im = cap.read()
        if not ok:
            break
        i += 1
        ts = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        im = im[y:y + h, x:x + w]
        small = cv2.cvtColor(cv2.resize(im, (320, 180), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
        changed = prev is None or float(np.abs(small - prev).mean()) > 2.5
        showing = ts - last_save >= 0.1 and detect.paper_ratio(im) > 0.5
        if (changed and ts - last_save >= 1 / fps_out) or showing:
            t = t0 + ts
            hh, mm, ss = int(t // 3600) % 24, int(t // 60) % 60, int(t) % 60
            name = f'{hh:02d}{mm:02d}{ss:02d}_{int(t * 10) % 10}.jpg'
            cv2.imencode('.jpg', im, [cv2.IMWRITE_JPEG_QUALITY, 92])[1].tofile(os.path.join(out, name))
            prev, last_save = small, ts
            n += 1
            if n % 200 == 0:
                print(f'  {n} 帧（视频 {ts / 60:.1f} 分钟，{(time.time() - t_start) / max(1, i) * 1000:.0f} ms/视频帧）', flush=True)
    print(f'{n} 帧 → {out}')


if __name__ == '__main__':
    main()
