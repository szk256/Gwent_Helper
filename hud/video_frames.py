"""从录屏视频里抽帧（只留有变化的），文件名按录制时刻 HHMMSS_d.jpg，给 timeline.py / export.py 用。

python hud/video_frames.py 视频 [开始时刻HHMMSS] [每秒几帧，默认 3]
开始时刻默认从文件名里找（iPad 录屏 ScreenRecording_09-30-2026 20-29-17 → 202917）。
输出到 hud/cache/rec/<视频名>/。
"""
import os
import re
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    path = sys.argv[1]
    base = os.path.splitext(os.path.basename(path))[0]
    start = next((a for a in sys.argv[2:] if re.fullmatch(r'\d{6}', a)), None)
    if not start:
        m = re.search(r'(\d\d)-(\d\d)-(\d\d)(?!.*\d\d-\d\d-\d\d)', base)
        start = ''.join(m.groups()) if m else '000000'
    fps_out = float(next((a for a in sys.argv[2:] if re.fullmatch(r'\d+(\.\d+)?', a) and len(a) < 4), 3))
    t0 = int(start[:2]) * 3600 + int(start[2:4]) * 60 + int(start[4:])
    out = os.path.join(HERE, 'cache', 'rec', re.sub(r'[^\w-]', '_', base))
    os.makedirs(out, exist_ok=True)
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = max(1, round(fps / fps_out))
    prev, i, n = None, 0, 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if i % step == 0:
            ok, im = cap.retrieve()
            if not ok:
                break
            small = cv2.cvtColor(cv2.resize(im, (320, 240), interpolation=cv2.INTER_AREA),
                                 cv2.COLOR_BGR2GRAY).astype(np.float32)
            if prev is None or float(np.abs(small - prev).mean()) > 2.5:
                t = t0 + i / fps
                hh, mm, ss = int(t // 3600) % 24, int(t // 60) % 60, int(t) % 60
                name = f'{hh:02d}{mm:02d}{ss:02d}_{int(t * 10) % 10}.jpg'
                cv2.imencode('.jpg', im, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tofile(os.path.join(out, name))
                prev = small
                n += 1
        i += 1
    print(f'{n} 帧 → {out}')


if __name__ == '__main__':
    main()
