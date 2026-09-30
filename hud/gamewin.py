"""找游戏窗口（Gwent.exe）的画面区域（客户区，屏幕物理像素）。只读窗口位置，不碰游戏进程内容。"""
import ctypes
import ctypes.wintypes as W

EXE = 'gwent.exe'
_u = ctypes.windll.user32
_k = ctypes.windll.kernel32


def _exe_of(hwnd):
    pid = W.DWORD()
    _u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    hp = _k.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not hp:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(512)
        n = W.DWORD(512)
        if _k.QueryFullProcessImageNameW(hp, 0, buf, ctypes.byref(n)):
            return buf.value.rsplit('\\', 1)[-1].lower()
        return ''
    finally:
        _k.CloseHandle(hp)


def find(exe=EXE):
    """返回 {'left','top','width','height'}（游戏窗口客户区），没找到或最小化时返回 None。"""
    best = []

    def cb(h, _):
        if _u.IsWindowVisible(h) and not _u.IsIconic(h) and _exe_of(h) == exe:
            r = W.RECT()
            _u.GetClientRect(h, ctypes.byref(r))
            p = W.POINT(0, 0)
            _u.ClientToScreen(h, ctypes.byref(p))
            if r.right > 200 and r.bottom > 200:
                best.append({'left': p.x, 'top': p.y, 'width': r.right, 'height': r.bottom})
        return True

    _u.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, W.HWND, W.LPARAM)(cb), 0)
    return max(best, key=lambda m: m['width'] * m['height']) if best else None


if __name__ == '__main__':
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:  # noqa: BLE001
        pass
    print(find() or '没找到游戏窗口')
