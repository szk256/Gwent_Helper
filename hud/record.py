"""录游戏窗口画面（全分辨率 JPEG，只存有变化的帧），给 timeline.py 离线分析、调参数用。

python hud/record.py [分钟数，默认 30]     存到 hud/cache/rec/<开始时间>/，Ctrl+C 结束
一局约 20 分钟、几百帧、几百 MB。只截屏幕画面，游戏窗口被别的窗口挡住的部分也会被截进去。
"""
import ctypes
import os
import sys
import time

import cv2
import mss
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gamewin  # noqa: E402

MSS = getattr(mss, 'MSS', None) or mss.mss
HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    minutes = float(sys.argv[1]) if len(sys.argv) > 1 else 30
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:  # noqa: BLE001
        pass
    out = os.path.join(HERE, 'cache', 'rec', time.strftime('%Y%m%d-%H%M%S'))
    os.makedirs(out, exist_ok=True)
    print(f'录到 {out}，{minutes:.0f} 分钟，Ctrl+C 结束')
    import detect
    prev, n, t_end, last_warn, last_save = None, 0, time.time() + minutes * 60, 0, 0.0
    with MSS() as s:
        try:
            while time.time() < t_end:
                t0 = time.time()
                a = gamewin.find()
                if not a:
                    if t0 - last_warn > 10:
                        print('没找到游戏窗口，等待中…')
                        last_warn = t0
                    time.sleep(1)
                    continue
                im = cv2.cvtColor(np.asarray(s.grab(a)), cv2.COLOR_BGRA2BGR)
                small = cv2.cvtColor(cv2.resize(im, (320, 180), interpolation=cv2.INTER_AREA),
                                     cv2.COLOR_BGR2GRAY).astype(np.float32)
                # 每秒看约 10 次（截屏约 60 ms）：画面变了至少隔 0.3 秒存一张；右侧展示框（对方出牌放大，不到 1 秒）出现时每 0.1 秒存一张
                changed = prev is None or float(np.abs(small - prev).mean()) > 2.5
                showing = detect.paper_ratio(im) > 0.5
                if (changed and t0 - last_save >= 0.3) or (showing and t0 - last_save >= 0.1):
                    name = time.strftime('%H%M%S') + f'_{int(t0 * 10) % 10}.jpg'
                    cv2.imencode('.jpg', im, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tofile(os.path.join(out, name))
                    prev, last_save = small, t0
                    n += 1
                    if n % 50 == 0:
                        print(f'  {n} 帧')
                time.sleep(max(0.005, 0.1 - (time.time() - t0)))
        except KeyboardInterrupt:
            pass
    print(f'共 {n} 帧 → {out}')


if __name__ == '__main__':
    main()
