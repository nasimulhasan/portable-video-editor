"""Windows portable host: local server + WebView2 window (no browser tab).

Run from a built dist folder (next to server.py), or from this portable/
folder during development (uses the parent project as the app root).
"""

from __future__ import annotations

import os
import sys
import threading
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent


def app_root() -> Path:
    if (HERE / "server.py").is_file():
        return HERE
    parent = HERE.parent
    if (parent / "server.py").is_file():
        return parent
    raise SystemExit("Cannot find server.py next to host or in the parent folder.")


ROOT = app_root()
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))
os.environ["VE_NO_BROWSER"] = "1"

# Prefer bundled python packages inside portable python/Lib/site-packages
_site = HERE / "python" / "Lib" / "site-packages"
if _site.is_dir():
    sys.path.insert(0, str(_site))


def _message(title: str, text: str, error: bool = False) -> None:
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, text, title, 0x10 if error else 0x40)
    except Exception:
        pass


def _fail(exc: BaseException) -> int:
    log = ROOT / "VideoEditor_error.log"
    detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    try:
        log.write_text(detail, encoding="utf-8")
    except Exception:
        pass
    _message(
        "Video Editor",
        f"Could not start:\n{exc}\n\nDetails saved to:\n{log}",
        error=True,
    )
    return 1


def _brand_and_own_window() -> None:
    """Make the taskbar pin use VideoEditor.exe + our icon (not pythonw)."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    title = "Video Editor"
    owner = int(os.environ.get("VE_OWNER_HWND") or 0)
    ico = ROOT / "app.ico"
    launcher = os.environ.get("VE_LAUNCHER_EXE") or str(ROOT / "VideoEditor.exe")
    app_id = os.environ.get("VE_APP_ID") or "Local.VideoEditor.App"

    def set_relaunch_props(hwnd: int) -> None:
        """Pinning this window creates a pin to VideoEditor.exe with our icon."""
        try:
            from win32com.propsys import propsys, pscon
        except Exception:
            return
        try:
            store = propsys.SHGetPropertyStoreForWindow(hwnd, propsys.IID_IPropertyStore)
            store.SetValue(pscon.PKEY_AppUserModel_ID, propsys.PROPVARIANTType(app_id))
            store.SetValue(
                pscon.PKEY_AppUserModel_RelaunchCommand,
                propsys.PROPVARIANTType(f'"{launcher}"'),
            )
            store.SetValue(
                pscon.PKEY_AppUserModel_RelaunchIconResource,
                propsys.PROPVARIANTType(f"{launcher},0"),
            )
            store.SetValue(
                pscon.PKEY_AppUserModel_RelaunchDisplayNameResource,
                propsys.PROPVARIANTType("Video Editor"),
            )
            store.Commit()
        except Exception:
            pass

    def apply(hwnd: int) -> None:
        if not hwnd:
            return
        if owner:
            try:
                if ctypes.sizeof(ctypes.c_void_p) == 8:
                    user32.SetWindowLongPtrW(hwnd, -8, owner)
                else:
                    user32.SetWindowLongW(hwnd, -8, owner)
            except Exception:
                try:
                    user32.SetWindowLongW(hwnd, -8, owner)
                except Exception:
                    pass
        if ico.is_file():
            IMAGE_ICON = 1
            LR_LOADFROMFILE = 0x0010
            h_big = user32.LoadImageW(None, str(ico), IMAGE_ICON, 256, 256, LR_LOADFROMFILE)
            h_small = user32.LoadImageW(None, str(ico), IMAGE_ICON, 32, 32, LR_LOADFROMFILE)
            WM_SETICON = 0x0080
            if h_big:
                user32.SendMessageW(hwnd, WM_SETICON, 1, h_big)
            if h_small:
                user32.SendMessageW(hwnd, WM_SETICON, 0, h_small)
        set_relaunch_props(hwnd)

    def worker() -> None:
        for _ in range(200):  # ~10s
            hwnd = user32.FindWindowW(None, title)
            if hwnd:
                apply(int(hwnd))
                # Re-apply — WebView2 sometimes resets props during init
                for _ in range(10):
                    threading.Event().wait(0.35)
                    hwnd2 = user32.FindWindowW(None, title)
                    if hwnd2:
                        apply(int(hwnd2))
                return
            threading.Event().wait(0.05)

    threading.Thread(target=worker, daemon=True).start()


def main() -> int:
    try:
        import webview
    except ImportError:
        return _fail(
            RuntimeError(
                "pywebview is not installed.\n"
                "Dev:  pip install -r portable/requirements.txt\n"
                "Or run portable\\build.ps1 to assemble the portable app."
            )
        )

    # Match launcher AppUserModelID so taskbar pins behave correctly.
    try:
        import ctypes

        app_id = os.environ.get("VE_APP_ID") or "Local.VideoEditor.App"
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id)
    except Exception:
        pass

    try:
        import server

        httpd, url, _port = server.start_server()
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()

        window = webview.create_window(
            "Video Editor",
            url,
            width=1440,
            height=900,
            min_size=(960, 640),
            background_color="#101218",
        )

        def _on_closed():
            try:
                httpd.shutdown()
            except Exception:
                pass

        try:
            window.events.closed += _on_closed
        except Exception:
            pass

        # Explorer → app file drops (paths). HTML5 File.path is often empty in WebView2.
        def _on_file_drop(files):
            try:
                import json as _json

                if files is None:
                    return
                paths = list(getattr(files, "files", files) or [])
                paths = [str(p) for p in paths if p]
                if not paths:
                    return
                payload = _json.dumps(paths)
                window.evaluate_js(
                    f"(function(){{try{{window.__veNativeDrop&&window.__veNativeDrop({payload});}}catch(e){{}}}})()"
                )
            except Exception:
                pass

        for _ev_name in ("droped", "dropped"):
            _ev = getattr(getattr(window, "events", None), _ev_name, None)
            if _ev is not None:
                try:
                    _ev += _on_file_drop
                    break
                except Exception:
                    pass

        _brand_and_own_window()
        webview.start()
        try:
            httpd.shutdown()
        except Exception:
            pass
        return 0
    except Exception as exc:
        return _fail(exc)


if __name__ == "__main__":
    raise SystemExit(main())
