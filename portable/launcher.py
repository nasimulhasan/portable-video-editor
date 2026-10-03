"""No-console Windows EXE entry for the portable app.

Built with PyInstaller (--noconsole --onefile). Starts the bundled
pythonw + host.py (WebView window) next to this executable.

The launcher owns a hidden Win32 window so the WebView is an *owned*
window. Windows then shows a single taskbar button for VideoEditor.exe
(with our icon) instead of a separate Python icon — which is what breaks
pins (pythonw.exe with no args does nothing).
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path

APP_ID = "Local.VideoEditor.App"
WINDOW_TITLE = "Video Editor"
OWNER_TITLE = "VideoEditorOwner"
OWNER_CLASS = "VideoEditorOwnerClass"

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
shell32 = ctypes.windll.shell32

WNDPROC = ctypes.WINFUNCTYPE(
    ctypes.c_long, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
)


def app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    here = Path(__file__).resolve().parent
    if (here / "host.py").is_file() and (here / "python" / "pythonw.exe").is_file():
        return here
    dist = here / "dist" / "VideoEditor"
    if (dist / "host.py").is_file():
        return dist
    return here


def message(title: str, text: str, error: bool = False) -> None:
    try:
        user32.MessageBoxW(0, text, title, 0x10 if error else 0x40)
    except Exception:
        pass


def set_app_id() -> None:
    try:
        shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
    except Exception:
        pass


def focus_existing() -> bool:
    hwnd = user32.FindWindowW(None, WINDOW_TITLE)
    if not hwnd:
        return False
    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.SetForegroundWindow(hwnd)
    return True


def _load_icon(root: Path):
    ico = root / "app.ico"
    if not ico.is_file():
        return None, None
    IMAGE_ICON = 1
    LR_LOADFROMFILE = 0x0010
    LR_DEFAULTSIZE = 0x0040
    h_big = user32.LoadImageW(
        None, str(ico), IMAGE_ICON, 256, 256, LR_LOADFROMFILE
    )
    h_small = user32.LoadImageW(
        None, str(ico), IMAGE_ICON, 32, 32, LR_LOADFROMFILE | LR_DEFAULTSIZE
    )
    return h_big or None, h_small or None


def create_owner_window(root: Path):
    """Hidden owner window — gives the taskbar our EXE identity + icon."""
    h_big, h_small = _load_icon(root)

    @WNDPROC
    def wnd_proc(hwnd, msg, wparam, lparam):
        if msg == 0x0002:  # WM_DESTROY
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    # Keep callback alive for the process lifetime
    create_owner_window._wnd_proc = wnd_proc  # type: ignore[attr-defined]

    class WNDCLASS(ctypes.Structure):
        _fields_ = [
            ("style", wintypes.UINT),
            ("lpfnWndProc", WNDPROC),
            ("cbClsExtra", ctypes.c_int),
            ("cbWndExtra", ctypes.c_int),
            ("hInstance", wintypes.HINSTANCE),
            ("hIcon", wintypes.HICON),
            ("hCursor", wintypes.HANDLE),
            ("hbrBackground", wintypes.HBRUSH),
            ("lpszMenuName", wintypes.LPCWSTR),
            ("lpszClassName", wintypes.LPCWSTR),
        ]

    hinst = kernel32.GetModuleHandleW(None)
    wc = WNDCLASS()
    wc.style = 0
    wc.lpfnWndProc = wnd_proc
    wc.cbClsExtra = 0
    wc.cbWndExtra = 0
    wc.hInstance = hinst
    wc.hIcon = h_big or 0
    wc.hCursor = 0
    wc.hbrBackground = 0
    wc.lpszMenuName = None
    wc.lpszClassName = OWNER_CLASS
    if not user32.RegisterClassW(ctypes.byref(wc)):
        # Already registered from a previous attempt in this process
        pass

    # WS_POPUP | WS_VISIBLE would flash; keep it toolwindow + noactivate off-screen
    WS_POPUP = 0x80000000
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_NOACTIVATE = 0x08000000
    hwnd = user32.CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        OWNER_CLASS,
        OWNER_TITLE,
        WS_POPUP,
        -32000,
        -32000,
        1,
        1,
        None,
        None,
        hinst,
        None,
    )
    if not hwnd:
        return 0, h_big, h_small

    WM_SETICON = 0x0080
    if h_big:
        user32.SendMessageW(hwnd, WM_SETICON, 1, h_big)  # ICON_BIG
    if h_small:
        user32.SendMessageW(hwnd, WM_SETICON, 0, h_small)  # ICON_SMALL
    return int(hwnd), h_big, h_small


def pump_while(proc: subprocess.Popen) -> int:
    """Keep the owner window alive and wait for the host process."""
    msg = wintypes.MSG()
    while proc.poll() is None:
        while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):  # PM_REMOVE
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
        time.sleep(0.02)
    return int(proc.returncode or 0)


def main() -> int:
    set_app_id()

    if focus_existing():
        return 0

    root = app_root()
    os.chdir(root)
    # Prefer branded host EXE (pythonw copy with our icon) so pins never show Python.
    pyw = root / "python" / "VideoEditorHost.exe"
    if not pyw.is_file():
        pyw = root / "python" / "pythonw.exe"
    host = root / "host.py"
    if not pyw.is_file() or not host.is_file():
        message(
            "Video Editor",
            f"Portable files missing.\nExpected:\n  {pyw}\n  {host}",
            error=True,
        )
        return 1
    owner_hwnd, _h_big, _h_small = create_owner_window(root)

    env = os.environ.copy()
    env["VE_NO_BROWSER"] = "1"
    env["PYTHONUTF8"] = "1"
    env["VE_APP_ID"] = APP_ID
    if owner_hwnd:
        env["VE_OWNER_HWND"] = str(owner_hwnd)
    env["VE_LAUNCHER_EXE"] = str(
        Path(sys.executable).resolve()
        if getattr(sys, "frozen", False)
        else (root / "VideoEditor.exe")
    )

    CREATE_NO_WINDOW = 0x08000000
    try:
        proc = subprocess.Popen(
            [str(pyw), str(host)],
            cwd=str(root),
            env=env,
            creationflags=CREATE_NO_WINDOW,
            close_fds=True,
        )
    except OSError as exc:
        message("Video Editor", f"Could not start:\n{exc}", error=True)
        return 1

    code = pump_while(proc)
    if owner_hwnd:
        user32.DestroyWindow(owner_hwnd)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
