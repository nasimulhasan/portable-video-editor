"""Local backend for the timeline video editor (Phase 1).

- Serves the web UI and streams media with HTTP Range support.
- Native file dialogs, browser-safe preview proxies.
- Project save/load as JSON (sources are never modified — the project stores instructions).
- Silence detection for auto jump-cuts.
- ffmpeg export: multi-clip timeline with speed, transitions (xfade), filters,
  fades, text overlays (drawtext), image/logo overlays, music mixing, canvas modes.

Zero pip dependencies. Run:  python server.py
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import struct
import subprocess
import threading
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from app import (
    CREATE_NO_WINDOW,
    Encoder,
    ffmpeg_path,
    ffprobe_path,
    filter_for,
    parse_progress,
    pick_encoder,
    rotation_from_stream,
    run_cmd,
    unique_path,
)

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
LUT_DIR = ROOT / "luts"
PROXY_DIR = Path(os.environ.get("TEMP", str(ROOT))) / "videoeditor_proxies"

MEDIA: dict[str, dict] = {}
JOBS: dict[str, dict] = {}
_media_seq = 0
_state_lock = threading.Lock()
_dialog_lock = threading.Lock()
_last_export_dir = ""


def _default_export_dir(project: dict | None = None) -> str:
    global _last_export_dir
    if _last_export_dir and os.path.isdir(_last_export_dir):
        return _last_export_dir
    if project:
        for key in ("clips", "images", "pips", "music"):
            for item in project.get(key) or []:
                path = item.get("path") or (MEDIA.get(item.get("mid", ""), {}) or {}).get("path")
                if path and os.path.isfile(path):
                    return os.path.dirname(path)
    home = os.path.expanduser("~")
    for name in ("Videos", "Desktop", "Documents"):
        cand = os.path.join(home, name)
        if os.path.isdir(cand):
            return cand
    return home or os.getcwd()


def _win_save_as(
    *,
    title: str,
    filter_label: str,
    ext: str,
    initial_dir: str = "",
    initial_file: str = "",
) -> str:
    """In-process Windows Save As (comdlg32) — reliable from HTTP worker threads."""
    import ctypes
    from ctypes import wintypes

    ext = (ext if ext.startswith(".") else f".{ext}").lstrip(".")
    # IMPORTANT: do not assign a Python str with embedded NULs to LPCWSTR — ctypes
    # truncates at the first \\0. Build a real wchar buffer instead.
    raw_filter = f"{filter_label}\0*.{ext}\0All files\0*.*\0\0"
    filter_buf = (ctypes.c_wchar * len(raw_filter))()
    for i, ch in enumerate(raw_filter):
        filter_buf[i] = ch

    name = os.path.basename(initial_file) if initial_file else f"export.{ext}"
    file_buf = ctypes.create_unicode_buffer(name, 1024)

    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [
            ("lStructSize", wintypes.DWORD),
            ("hwndOwner", wintypes.HWND),
            ("hInstance", wintypes.HINSTANCE),
            ("lpstrFilter", wintypes.LPCWSTR),
            ("lpstrCustomFilter", wintypes.LPWSTR),
            ("nMaxCustFilter", wintypes.DWORD),
            ("nFilterIndex", wintypes.DWORD),
            ("lpstrFile", wintypes.LPWSTR),
            ("nMaxFile", wintypes.DWORD),
            ("lpstrFileTitle", wintypes.LPWSTR),
            ("nMaxFileTitle", wintypes.DWORD),
            ("lpstrInitialDir", wintypes.LPCWSTR),
            ("lpstrTitle", wintypes.LPCWSTR),
            ("Flags", wintypes.DWORD),
            ("nFileOffset", wintypes.WORD),
            ("nFileExtension", wintypes.WORD),
            ("lpstrDefExt", wintypes.LPCWSTR),
            ("lCustData", wintypes.LPARAM),
            ("lpfnHook", ctypes.c_void_p),
            ("lpTemplateName", wintypes.LPCWSTR),
            ("pvReserved", ctypes.c_void_p),
            ("dwReserved", wintypes.DWORD),
            ("FlagsEx", wintypes.DWORD),
        ]

    OFN_OVERWRITEPROMPT = 0x00000002
    OFN_PATHMUSTEXIST = 0x00000800
    OFN_EXPLORER = 0x00080000
    OFN_NOCHANGEDIR = 0x00000008

    ofn = OPENFILENAMEW()
    ofn.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    try:
        ofn.hwndOwner = ctypes.windll.user32.GetForegroundWindow()
    except Exception:
        ofn.hwndOwner = None
    ofn.lpstrFilter = ctypes.cast(filter_buf, wintypes.LPCWSTR)
    ofn.nFilterIndex = 1
    ofn.lpstrFile = ctypes.cast(file_buf, wintypes.LPWSTR)
    ofn.nMaxFile = 1024
    ofn.lpstrTitle = title
    ofn.lpstrInitialDir = initial_dir if initial_dir and os.path.isdir(initial_dir) else None
    ofn.lpstrDefExt = ext
    ofn.Flags = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR

    ok = ctypes.windll.comdlg32.GetSaveFileNameW(ctypes.byref(ofn))
    if ok:
        return file_buf.value
    return ""


def _win_open_files(
    *,
    title: str,
    filters: list[tuple[str, str]],
    multi: bool = False,
) -> list[str]:
    """In-process Windows Open (comdlg32) — works without tkinter."""
    import ctypes
    from ctypes import wintypes

    parts: list[str] = []
    for label, pattern in filters:
        parts.append(label)
        parts.append(pattern)
    parts.append("")
    raw_filter = "\0".join(parts) + "\0"
    filter_buf = (ctypes.c_wchar * len(raw_filter))()
    for i, ch in enumerate(raw_filter):
        filter_buf[i] = ch

    # Multi-select needs a large buffer: dir + many relative names.
    buf_chars = 65536 if multi else 1024
    file_buf = ctypes.create_unicode_buffer(buf_chars)

    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [
            ("lStructSize", wintypes.DWORD),
            ("hwndOwner", wintypes.HWND),
            ("hInstance", wintypes.HINSTANCE),
            ("lpstrFilter", wintypes.LPCWSTR),
            ("lpstrCustomFilter", wintypes.LPWSTR),
            ("nMaxCustFilter", wintypes.DWORD),
            ("nFilterIndex", wintypes.DWORD),
            ("lpstrFile", wintypes.LPWSTR),
            ("nMaxFile", wintypes.DWORD),
            ("lpstrFileTitle", wintypes.LPWSTR),
            ("nMaxFileTitle", wintypes.DWORD),
            ("lpstrInitialDir", wintypes.LPCWSTR),
            ("lpstrTitle", wintypes.LPCWSTR),
            ("Flags", wintypes.DWORD),
            ("nFileOffset", wintypes.WORD),
            ("nFileExtension", wintypes.WORD),
            ("lpstrDefExt", wintypes.LPCWSTR),
            ("lCustData", wintypes.LPARAM),
            ("lpfnHook", ctypes.c_void_p),
            ("lpTemplateName", wintypes.LPCWSTR),
            ("pvReserved", ctypes.c_void_p),
            ("dwReserved", wintypes.DWORD),
            ("FlagsEx", wintypes.DWORD),
        ]

    OFN_FILEMUSTEXIST = 0x00001000
    OFN_PATHMUSTEXIST = 0x00000800
    OFN_EXPLORER = 0x00080000
    OFN_NOCHANGEDIR = 0x00000008
    OFN_ALLOWMULTISELECT = 0x00000200

    ofn = OPENFILENAMEW()
    ofn.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    try:
        ofn.hwndOwner = ctypes.windll.user32.GetForegroundWindow()
    except Exception:
        ofn.hwndOwner = None
    ofn.lpstrFilter = ctypes.cast(filter_buf, wintypes.LPCWSTR)
    ofn.nFilterIndex = 1
    ofn.lpstrFile = ctypes.cast(file_buf, wintypes.LPWSTR)
    ofn.nMaxFile = buf_chars
    ofn.lpstrTitle = title
    flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR
    if multi:
        flags |= OFN_ALLOWMULTISELECT
    ofn.Flags = flags

    ok = ctypes.windll.comdlg32.GetOpenFileNameW(ctypes.byref(ofn))
    if not ok:
        return []

    raw = file_buf[: buf_chars]
    # Explorer multi-select: "dir\0file1\0file2\0\0" (or single full path).
    chunks = []
    cur = []
    for ch in raw:
        if ch == "\0":
            if not cur and chunks:
                break
            chunks.append("".join(cur))
            cur = []
            continue
        cur.append(ch)
    chunks = [c for c in chunks if c]
    if not chunks:
        return []
    if len(chunks) == 1:
        return chunks
    directory = chunks[0]
    return [os.path.join(directory, name) for name in chunks[1:]]


BROWSER_VCODECS = {"h264", "vp8", "vp9", "av1"}
BROWSER_VEXT = {".mp4", ".m4v", ".mov", ".webm"}
BROWSER_ACODECS = {"mp3", "aac", "vorbis", "opus", "flac", "pcm_s16le", "pcm_s24le", "pcm_u8"}
BROWSER_AEXT = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".flac", ".webm", ".mp4", ".mov"}
BROWSER_IEXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

CANVAS_RES = {
    "16:9": (1920, 1080),
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
    "4:3": (1440, 1080),
    "3:4": (1080, 1440),
}

XFADE_TYPES = {
    "dissolve": "fade",
    "dipblack": "fadeblack",
    "flash": "fadewhite",
    "slideleft": "slideleft",
    "slideright": "slideright",
    "slideup": "slideup",
    "slidedown": "slidedown",
    "push": "smoothleft",
    "zoom": "zoomin",
    "blur": "hblur",
    "pixelize": "pixelize",
    "wipe": "wipeleft",
    "circle": "circleopen",
}

WIN_FONTS = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "Fonts"
EXPORT_FONT_DIR = PROXY_DIR / "fonts"

# family shown in UI -> (ASS family name, bold flag, source file in Windows fonts)
BUILTIN_FONTS = {
    "Arial": ("Arial", 0, "arial.ttf"),
    "Arial Bold": ("Arial", -1, "arialbd.ttf"),
    "Arial Black": ("Arial Black", 0, "ariblk.ttf"),
    "Impact": ("Impact", 0, "impact.ttf"),
    "Segoe UI": ("Segoe UI", 0, "segoeui.ttf"),
    "Segoe UI Bold": ("Segoe UI", -1, "segoeuib.ttf"),
    "Times New Roman": ("Times New Roman", 0, "times.ttf"),
    "Georgia": ("Georgia", 0, "georgia.ttf"),
    "Verdana": ("Verdana", 0, "verdana.ttf"),
    "Comic Sans": ("Comic Sans MS", 0, "comic.ttf"),
    "Consolas": ("Consolas", 0, "consola.ttf"),
    "Nirmala UI (Bangla)": ("Nirmala UI", 0, "Nirmala.ttf"),
    "Nirmala UI Bold (Bangla)": ("Nirmala UI", -1, "NirmalaB.ttf"),
    "Shonar Bangla": ("Shonar Bangla", 0, "Shonar.ttf"),
    "Vrinda (Bangla)": ("Vrinda", 0, "vrinda.ttf"),
}

CUSTOM_FONTS: dict[str, dict] = {}  # font id -> {family, path}


def even(n: float) -> int:
    return max(2, int(n) // 2 * 2)


def q(s: str) -> str:
    """ffmpeg filter-graph quoting."""
    return "'" + str(s).replace("'", "'\\''") + "'"


def hexcolor(c: str, alpha: float | None = None) -> str:
    c = str(c or "#ffffff").lstrip("#")
    if len(c) != 6:
        c = "ffffff"
    out = "0x" + c
    if alpha is not None and alpha < 0.999:
        out += f"@{max(0.0, min(alpha, 1.0)):.3f}"
    return out


def overlay_border_filter(item: dict, canvas_h: int) -> str:
    """ffmpeg pad filter for an optional colored border around an overlay."""
    if not item.get("border"):
        return ""
    # borderW is UI px relative to ~1080p preview; scale to export height
    w = max(1, int(round(float(item.get("borderW", 4) or 4) * (canvas_h / 1080.0))))
    w = max(1, min(w, 80))
    # keep even pad for yuv-friendly sizes
    if w % 2:
        w += 1
    color = hexcolor(item.get("borderColor", "#ffffff"))
    return f",pad=iw+{2 * w}:ih+{2 * w}:{w}:{w}:color={color}"


def overlay_border_pad_px(item: dict, canvas_h: int) -> int:
    if not item.get("border"):
        return 0
    w = max(1, int(round(float(item.get("borderW", 4) or 4) * (canvas_h / 1080.0))))
    w = max(1, min(w, 80))
    if w % 2:
        w += 1
    return w


def overlay_round_filter(item: dict, w: int, h: int) -> str:
    """Transparent rounded corners via geq alpha. Append after format=rgba (or following pad)."""
    try:
        pct = float(item.get("cornerRadius") or 0)
    except (TypeError, ValueError):
        pct = 0.0
    if pct < 0.5 or w < 4 or h < 4:
        return ""
    r = max(1, int(round(min(w, h) * 0.5 * min(max(pct, 0.0), 100.0) / 100.0)))
    # Outside the rounded-rect corners → alpha 0
    a = (
        f"if(gt(abs(W/2-X)\\,W/2-{r})*gt(abs(H/2-Y)\\,H/2-{r})\\,"
        f"if(lte(hypot(abs(W/2-X)-(W/2-{r})\\,abs(H/2-Y)-(H/2-{r}))\\,{r})\\,alpha(X\\,Y)\\,0)\\,"
        f"alpha(X\\,Y))"
    )
    return f",format=rgba,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='{a}'"


def _parse_rgb(c: str) -> tuple[int, int, int]:
    c = str(c or "#ffffff").lstrip("#")
    if len(c) != 6:
        return (255, 255, 255)
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))


def _point_in_poly(x: float, y: float, poly: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi):
            inside = not inside
        j = i
    return inside


def _dist_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    abx, aby = bx - ax, by - ay
    apx, apy = px - ax, py - ay
    ab2 = abx * abx + aby * aby
    if ab2 < 1e-9:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = max(0.0, min(1.0, (apx * abx + apy * aby) / ab2))
    cx, cy = ax + t * abx, ay + t * aby
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def _near_poly_edge(x: float, y: float, poly: list[tuple[float, float]], width: float) -> bool:
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        if _dist_to_segment(x, y, ax, ay, bx, by) <= width:
            return True
    return False


def _shape_polygon(kind: str, w: int, h: int, pad: float = 0.0) -> list[tuple[float, float]]:
    """Polygon in pixel coords for the shape interior (inset by pad)."""
    L, T, R, B = pad, pad, w - 1 - pad, h - 1 - pad
    cx, cy = (L + R) / 2, (T + B) / 2
    kind = kind or "rect"
    if kind == "triangle":
        return [(cx, T), (R, B), (L, B)]
    if kind == "diamond":
        return [(cx, T), (R, cy), (cx, B), (L, cy)]
    if kind == "star":
        pts = [
            (50, 6), (61, 38), (95, 38), (68, 58), (78, 92),
            (50, 72), (22, 92), (32, 58), (5, 38), (39, 38),
        ]
        return [(L + (p[0] / 100) * (R - L), T + (p[1] / 100) * (B - T)) for p in pts]
    if kind == "arrow":
        pts = [(8, 32), (58, 32), (58, 12), (94, 50), (58, 88), (58, 68), (8, 68)]
        return [(L + (p[0] / 100) * (R - L), T + (p[1] / 100) * (B - T)) for p in pts]
    # rect / roundrect / ellipse handled separately
    return [(L, T), (R, T), (R, B), (L, B)]


def _dash_on(dist: float, style: str, thickness: float) -> bool:
    style = (style or "solid").lower()
    if style == "dotted":
        on, off = max(1.5, thickness), max(4.0, thickness * 2.8)
    elif style == "dashed":
        on, off = max(10.0, thickness * 4.0), max(6.0, thickness * 2.5)
    else:
        return True
    period = on + off
    return (dist % period) <= on


def _draw_thick_line(
    set_px,
    w: int,
    h: int,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    thickness: float,
    rgb: tuple[int, int, int],
    a: int,
    style: str = "solid",
    along0: float = 0.0,
) -> float:
    """Draw a stroked segment (optional dash/dot). Returns segment length."""
    dx, dy = x1 - x0, y1 - y0
    length = (dx * dx + dy * dy) ** 0.5
    if length < 1e-6:
        return 0.0
    half = max(thickness / 2.0, 0.5)
    pad = int(half) + 2
    minx = max(0, int(min(x0, x1) - pad))
    maxx = min(w - 1, int(max(x0, x1) + pad))
    miny = max(0, int(min(y0, y1) - pad))
    maxy = min(h - 1, int(max(y0, y1) + pad))
    for y in range(miny, maxy + 1):
        for x in range(minx, maxx + 1):
            d = _dist_to_segment(x + 0.5, y + 0.5, x0, y0, x1, y1)
            if d > half:
                continue
            t = ((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / (length * length)
            t = max(0.0, min(1.0, t))
            along = along0 + t * length
            if _dash_on(along, style, thickness):
                set_px(x, y, rgb, a)
    return length


def _stroke_polyline(
    set_px,
    w: int,
    h: int,
    pts: list[tuple[float, float]],
    thickness: float,
    rgb: tuple[int, int, int],
    a: int,
    style: str = "solid",
    closed: bool = True,
) -> None:
    if len(pts) < 2:
        return
    along = 0.0
    n = len(pts)
    count = n if closed else n - 1
    for i in range(count):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % n]
        along += _draw_thick_line(set_px, w, h, x0, y0, x1, y1, thickness, rgb, a, style, along)


def _outline_points(kind: str, w: int, h: int) -> list[tuple[float, float]]:
    """Closed outline polyline for stroking a shape border."""
    kind = kind or "rect"
    if kind == "ellipse":
        cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
        rx, ry = max((w - 1) / 2.0, 1.0), max((h - 1) / 2.0, 1.0)
        n = max(48, int(max(w, h) * 1.5))
        import math
        return [
            (cx + rx * math.cos(2 * math.pi * i / n), cy + ry * math.sin(2 * math.pi * i / n))
            for i in range(n)
        ]
    if kind == "roundrect":
        import math
        rad = min(w, h) * 0.16
        L, T, R, B = 0.5, 0.5, w - 1.5, h - 1.5
        rad = min(rad, (R - L) / 2, (B - T) / 2)
        pts: list[tuple[float, float]] = []
        def corner(cx, cy, a0, a1):
            steps = 8
            for i in range(steps + 1):
                a = a0 + (a1 - a0) * (i / steps)
                pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
        corner(R - rad, T + rad, -math.pi / 2, 0)
        corner(R - rad, B - rad, 0, math.pi / 2)
        corner(L + rad, B - rad, math.pi / 2, math.pi)
        corner(L + rad, T + rad, math.pi, 3 * math.pi / 2)
        return pts
    if kind == "rect":
        return [(0.5, 0.5), (w - 1.5, 0.5), (w - 1.5, h - 1.5), (0.5, h - 1.5)]
    return _shape_polygon(kind, w, h, pad=0.5)


def _fill_poly(set_px, w: int, h: int, poly: list[tuple[float, float]], rgb: tuple[int, int, int], a: int) -> None:
    if len(poly) < 3:
        return
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    minx, maxx = max(0, int(min(xs))), min(w - 1, int(max(xs)) + 1)
    miny, maxy = max(0, int(min(ys))), min(h - 1, int(max(ys)) + 1)
    for y in range(miny, maxy + 1):
        for x in range(minx, maxx + 1):
            if _point_in_poly(x + 0.5, y + 0.5, poly):
                set_px(x, y, rgb, a)


def render_shape_pam(shape: dict, canvas_w: int, canvas_h: int) -> Path:
    """Rasterize a shape to a PAM (RGBA) file for ffmpeg overlay."""
    scale_w = max(0.02, min(float(shape.get("scaleW", shape.get("scale", 0.28)) or 0.28), 4.0))
    scale_h = max(0.02, min(float(shape.get("scaleH", scale_w) or scale_w), 4.0))
    w = even(canvas_w * scale_w)
    h = even(max(canvas_h * scale_h, 4))
    kind = shape.get("kind") or "rect"
    do_fill = shape.get("fill", True) is not False
    fill_rgb = _parse_rgb(shape.get("color", "#5eead4"))
    do_border = bool(shape.get("border"))
    border_rgb = _parse_rgb(shape.get("borderColor", "#ffffff"))
    bw = max(1, int(round(float(shape.get("borderW", 3) or 3) * (canvas_h / 1080.0)))) if do_border else 0
    opacity = max(0.0, min(float(shape.get("opacity", 1) or 1), 1.0))
    fa = int(round(255 * opacity)) if do_fill else 0
    ba = int(round(255 * opacity)) if do_border else 0
    line_style = shape.get("lineStyle") or "solid"
    line_like = kind in ("line", "linearrow")

    buf = bytearray(w * h * 4)
    poly = _shape_polygon(kind, w, h, pad=max(bw, 1))

    def set_px(x: int, y: int, rgb: tuple[int, int, int], a: int) -> None:
        if x < 0 or y < 0 or x >= w or y >= h or a <= 0:
            return
        i = (y * w + x) * 4
        buf[i] = rgb[0]
        buf[i + 1] = rgb[1]
        buf[i + 2] = rgb[2]
        buf[i + 3] = a

    if line_like:
        # Stroke uses fill color; thickness from borderW (fallback 3)
        thick = max(1, int(round(float(shape.get("borderW", 3) or 3) * (canvas_h / 1080.0))))
        la = int(round(255 * opacity))
        cy = (h - 1) / 2.0
        if kind == "line":
            _draw_thick_line(set_px, w, h, 2, cy, w - 3, cy, thick, fill_rgb, la, line_style)
        else:
            # line arrow: shaft into open chevron (>) — shaft meets tip, no gap
            tip_x = w - 2.0
            wing = max(thick * 3.0, min(w, h) * 0.28)
            join_x = tip_x - wing
            _draw_thick_line(set_px, w, h, 2, cy, tip_x, cy, thick, fill_rgb, la, line_style)
            # two strokes forming ">"
            _draw_thick_line(
                set_px, w, h, join_x, cy - wing, tip_x, cy, thick, fill_rgb, la, "solid"
            )
            _draw_thick_line(
                set_px, w, h, join_x, cy + wing, tip_x, cy, thick, fill_rgb, la, "solid"
            )
    else:
        # Fill full shape, then stroke outline (supports solid / dashed / dotted)
        inset = max(bw / 2.0, 0.0) if do_border and bw else 0.0
        fill_poly = _shape_polygon(kind, w, h, pad=inset) if kind not in ("ellipse", "roundrect", "rect") else None

        def point_inside(x: int, y: int) -> bool:
            if kind == "ellipse":
                cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
                rx = max((w - 1) / 2.0 - inset, 1.0)
                ry = max((h - 1) / 2.0 - inset, 1.0)
                nx = (x - cx) / rx
                ny = (y - cy) / ry
                return nx * nx + ny * ny <= 1.0
            if kind == "roundrect":
                rad = min(w, h) * 0.16
                L, T, R, B = inset, inset, w - 1 - inset, h - 1 - inset
                rad = min(rad, max((R - L) / 2, 0.1), max((B - T) / 2, 0.1))
                if not (L <= x <= R and T <= y <= B):
                    return False
                if (L + rad <= x <= R - rad) or (T + rad <= y <= B - rad):
                    return True
                for cx, cy in (
                    (L + rad, T + rad), (R - rad, T + rad),
                    (L + rad, B - rad), (R - rad, B - rad),
                ):
                    if (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad:
                        return True
                return False
            if kind == "rect":
                return inset <= x <= w - 1 - inset and inset <= y <= h - 1 - inset
            return _point_in_poly(x + 0.5, y + 0.5, fill_poly or poly)

        if fa:
            for y in range(h):
                for x in range(w):
                    if point_inside(x, y):
                        set_px(x, y, fill_rgb, fa)

        if do_border and bw and ba:
            outline = _outline_points(kind, w, h)
            _stroke_polyline(set_px, w, h, outline, float(bw), border_rgb, ba, line_style, closed=True)

    PROXY_DIR.mkdir(parents=True, exist_ok=True)
    out = PROXY_DIR / (uuid.uuid4().hex + ".pam")
    header = (
        f"P7\nWIDTH {w}\nHEIGHT {h}\nDEPTH 4\nMAXVAL 255\n"
        f"TUPLTYPE RGB_ALPHA\nENDHDR\n"
    ).encode("ascii")
    out.write_bytes(header + bytes(buf))
    return out


# ---------- probing / registration ----------

def probe_full(path: str) -> dict:
    proc = run_cmd(
        [ffprobe_path(), "-v", "error", "-print_format", "json", "-show_streams", "-show_format", "--", path],
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "Could not read this file.")
    data = json.loads(proc.stdout or "{}")
    vstream = None
    astream = None
    for s in data.get("streams", []):
        if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic"):
            vstream = vstream or s
        if s.get("codec_type") == "audio":
            astream = astream or s
    duration = 0.0
    for src in ((data.get("format") or {}).get("duration"), (vstream or {}).get("duration"), (astream or {}).get("duration")):
        if src:
            try:
                duration = max(duration, float(src))
            except ValueError:
                pass
    width = height = 0
    if vstream:
        w, h = int(vstream.get("width") or 0), int(vstream.get("height") or 0)
        rot = rotation_from_stream(vstream)
        width, height = (h, w) if rot in (90, 270) else (w, h)
    return {
        "path": path,
        "name": os.path.basename(path),
        "duration": duration,
        "width": width,
        "height": height,
        "has_video": vstream is not None,
        "has_audio": astream is not None,
        "vcodec": (vstream or {}).get("codec_name", ""),
        "acodec": (astream or {}).get("codec_name", ""),
    }


def needs_proxy(info: dict, kind: str) -> bool:
    ext = os.path.splitext(info["path"])[1].lower()
    if kind == "video":
        return not (info["vcodec"] in BROWSER_VCODECS and ext in BROWSER_VEXT)
    if kind == "image":
        return ext not in BROWSER_IEXT
    return not (info["acodec"] in BROWSER_ACODECS and ext in BROWSER_AEXT)


def make_proxy(info: dict, kind: str) -> str | None:
    PROXY_DIR.mkdir(parents=True, exist_ok=True)
    if kind == "video":
        dest = str(PROXY_DIR / (uuid.uuid4().hex + ".mp4"))
        cmd = [
            ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-i", info["path"],
            "-vf", "scale=-2:min(720\\,ih)", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", dest,
        ]
    elif kind == "image":
        dest = str(PROXY_DIR / (uuid.uuid4().hex + ".png"))
        cmd = [ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-i", info["path"], "-frames:v", "1", dest]
    else:
        dest = str(PROXY_DIR / (uuid.uuid4().hex + ".m4a"))
        cmd = [
            ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-i", info["path"],
            "-vn", "-c:a", "aac", "-b:a", "160k", dest,
        ]
    proc = subprocess.run(cmd, capture_output=True, creationflags=CREATE_NO_WINDOW)
    if proc.returncode != 0 or not os.path.exists(dest):
        return None
    return dest


def font_family(path: str) -> str | None:
    """Read the family name from a TTF/OTF/TTC font file (sfnt 'name' table)."""
    try:
        data = Path(path).read_bytes()
        offset = struct.unpack(">I", data[12:16])[0] if data[:4] == b"ttcf" else 0
        num_tables = struct.unpack(">H", data[offset + 4:offset + 6])[0]
        toff = None
        for i in range(num_tables):
            off = offset + 12 + i * 16
            if data[off:off + 4] == b"name":
                toff = struct.unpack(">I", data[off + 8:off + 12])[0]
                break
        if toff is None:
            return None
        count, str_off = struct.unpack(">HH", data[toff + 2:toff + 6])
        best = None
        for i in range(count):
            r = toff + 6 + i * 12
            pid, _eid, lang, nameid, length, off2 = struct.unpack(">6H", data[r:r + 12])
            if nameid != 1:
                continue
            raw = data[toff + str_off + off2: toff + str_off + off2 + length]
            name = raw.decode("utf-16-be", "ignore") if pid in (0, 3) else raw.decode("latin-1", "ignore")
            name = name.strip().strip("\x00")
            if name:
                best = name
                if pid == 3 and lang == 0x409:
                    break
        return best
    except Exception:
        return None


def register_font(path: str) -> dict:
    global _media_seq
    family = font_family(path) or os.path.splitext(os.path.basename(path))[0]
    EXPORT_FONT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copy2(path, EXPORT_FONT_DIR / os.path.basename(path))
    except OSError:
        pass
    with _state_lock:
        _media_seq += 1
        mid = f"m{_media_seq}"
        MEDIA[mid] = {"path": path, "proxy": None, "kind": "font", "name": os.path.basename(path)}
        CUSTOM_FONTS[mid] = {"family": family, "path": path}
    return {"id": mid, "family": family, "path": path, "name": os.path.basename(path)}


def _srt_time(s: str) -> float:
    m = re.match(r"(\d+):(\d+):(\d+)[,.](\d+)", s.strip())
    if not m:
        return 0.0
    ms = m.group(4).ljust(3, "0")[:3]
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(ms) / 1000


def parse_srt(path: str) -> list[dict]:
    text = Path(path).read_text(encoding="utf-8-sig", errors="replace").replace("\r", "")
    entries: list[dict] = []
    pattern = r"(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)[^\n]*\n(.*?)(?=\n\s*\n|\Z)"
    for m in re.finditer(pattern, text, re.S):
        start, end = _srt_time(m.group(1)), _srt_time(m.group(2))
        body = re.sub(r"<[^>]+>", "", m.group(3)).strip()
        if body and end > start:
            entries.append({"start": round(start, 3), "end": round(end, 3), "text": body})
    return entries


def ask_file(kind: str, save: bool = False, **opts):
    with _dialog_lock:
        if save and kind == "export":
            global _last_export_dir
            fmt = (opts.get("format") or "mp4").lower()
            ext = ".webm" if fmt == "webm" else ".mp4"
            label = "WebM video" if ext == ".webm" else "MP4 video"
            initial = opts.get("initial") or ("export" + ext)
            if not str(initial).lower().endswith(ext):
                initial = os.path.splitext(str(initial))[0] + ext
            initial_name = os.path.basename(str(initial))
            initial_dir = opts.get("initialdir") or _default_export_dir(opts.get("project"))
            path = ""
            if os.name == "nt":
                try:
                    path = _win_save_as(
                        title="Export video — choose where to save",
                        filter_label=label,
                        ext=ext,
                        initial_dir=initial_dir,
                        initial_file=initial_name,
                    )
                except Exception:
                    path = ""
            if not path and os.name != "nt":
                try:
                    import tkinter as tk
                    from tkinter import filedialog
                except ImportError:
                    return ""
                root = tk.Tk()
                root.withdraw()
                try:
                    root.attributes("-topmost", True)
                except Exception:
                    pass
                root.lift()
                root.focus_force()
                root.update()
                try:
                    path = filedialog.asksaveasfilename(
                        title="Export video — choose where to save",
                        defaultextension=ext,
                        initialdir=initial_dir if os.path.isdir(initial_dir) else None,
                        initialfile=initial_name,
                        filetypes=[(label, f"*{ext}"), ("All files", "*.*")],
                    )
                finally:
                    root.destroy()
            if path:
                _last_export_dir = os.path.dirname(path)
            return path or ""

        # Prefer native Windows dialogs (portable embeddable Python has no tkinter).
        if os.name == "nt":
            try:
                if save:
                    path = _win_save_as(
                        title="Save project",
                        filter_label="Project",
                        ext="json",
                        initial_file="project.json",
                    )
                    return path or ""
                specs = {
                    "audio": (
                        "Add music / audio",
                        [("Audio", "*.mp3;*.m4a;*.aac;*.wav;*.ogg;*.oga;*.flac;*.wma;*.opus"), ("All files", "*.*")],
                        False,
                    ),
                    "image": (
                        "Add image / logo",
                        [("Images", "*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp"), ("All files", "*.*")],
                        False,
                    ),
                    "font": (
                        "Add font",
                        [("Fonts", "*.ttf;*.otf;*.ttc"), ("All files", "*.*")],
                        False,
                    ),
                    "srt": (
                        "Import subtitles",
                        [("Subtitles", "*.srt;*.vtt"), ("All files", "*.*")],
                        False,
                    ),
                    "lut": (
                        "Pick a LUT (.cube)",
                        [("3D LUT", "*.cube"), ("All files", "*.*")],
                        False,
                    ),
                    "project": (
                        "Open project",
                        [("Project", "*.json"), ("All files", "*.*")],
                        False,
                    ),
                    "media": (
                        "Import media",
                        [
                            (
                                "Media",
                                "*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.3gp;*.mp3;*.m4a;*.aac;*.wav;*.ogg;*.flac;*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.srt;*.vtt",
                            ),
                            ("Video", "*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.3gp;*.mts;*.m2ts;*.wmv"),
                            ("Audio", "*.mp3;*.m4a;*.aac;*.wav;*.ogg;*.oga;*.flac;*.wma;*.opus"),
                            ("Images", "*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp"),
                            ("Subtitles", "*.srt;*.vtt"),
                            ("All files", "*.*"),
                        ],
                        True,
                    ),
                }
                title, filters, multi = specs.get(
                    kind,
                    (
                        "Add video",
                        [("Video", "*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.3gp;*.mts;*.m2ts;*.wmv"), ("All files", "*.*")],
                        False,
                    ),
                )
                paths = _win_open_files(title=title, filters=filters, multi=multi)
                if kind == "media":
                    return paths
                return paths[0] if paths else ""
            except Exception:
                pass

        try:
            import tkinter as tk
            from tkinter import filedialog
        except ImportError:
            return [] if kind == "media" else ""

        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:
            pass
        root.lift()
        root.focus_force()
        root.update()
        try:
            if save:
                path = filedialog.asksaveasfilename(
                    title="Save project", defaultextension=".json",
                    filetypes=[("Project", "*.json")],
                )
            elif kind == "audio":
                path = filedialog.askopenfilename(
                    title="Add music / audio",
                    filetypes=[("Audio", "*.mp3 *.m4a *.aac *.wav *.ogg *.oga *.flac *.wma *.opus"), ("All files", "*.*")],
                )
            elif kind == "image":
                path = filedialog.askopenfilename(
                    title="Add image / logo",
                    filetypes=[("Images", "*.png *.jpg *.jpeg *.webp *.gif *.bmp"), ("All files", "*.*")],
                )
            elif kind == "font":
                path = filedialog.askopenfilename(
                    title="Add font",
                    filetypes=[("Fonts", "*.ttf *.otf *.ttc"), ("All files", "*.*")],
                )
            elif kind == "srt":
                path = filedialog.askopenfilename(
                    title="Import subtitles",
                    filetypes=[("Subtitles", "*.srt *.vtt"), ("All files", "*.*")],
                )
            elif kind == "lut":
                path = filedialog.askopenfilename(
                    title="Pick a LUT (.cube)",
                    filetypes=[("3D LUT", "*.cube"), ("All files", "*.*")],
                )
            elif kind == "project":
                path = filedialog.askopenfilename(
                    title="Open project", filetypes=[("Project", "*.json"), ("All files", "*.*")],
                )
            elif kind == "media":
                path = list(filedialog.askopenfilenames(
                    title="Import media",
                    filetypes=[
                        ("Media", "*.mp4 *.mov *.m4v *.mkv *.webm *.avi *.3gp *.mp3 *.m4a *.aac *.wav *.ogg *.flac *.png *.jpg *.jpeg *.webp *.gif *.bmp *.srt *.vtt"),
                        ("Video", "*.mp4 *.mov *.m4v *.mkv *.webm *.avi *.3gp *.mts *.m2ts *.wmv"),
                        ("Audio", "*.mp3 *.m4a *.aac *.wav *.ogg *.oga *.flac *.wma *.opus"),
                        ("Images", "*.png *.jpg *.jpeg *.webp *.gif *.bmp"),
                        ("Subtitles", "*.srt *.vtt"),
                        ("All files", "*.*"),
                    ],
                ) or [])
            else:
                path = filedialog.askopenfilename(
                    title="Add video",
                    filetypes=[("Video", "*.mp4 *.mov *.m4v *.mkv *.webm *.avi *.3gp *.mts *.m2ts *.wmv"), ("All files", "*.*")],
                )
        finally:
            root.destroy()
        return path or ("" if kind != "media" else [])


def register_media(path: str, kind: str) -> dict:
    global _media_seq
    info = probe_full(path)
    if kind == "video" and not info["has_video"]:
        raise RuntimeError("That file has no video stream.")
    if kind == "audio" and not info["has_audio"]:
        raise RuntimeError("That file has no audio stream.")
    if kind == "image" and not info["has_video"]:
        raise RuntimeError("That file is not an image.")
    proxy = make_proxy(info, kind) if needs_proxy(info, kind) else None
    with _state_lock:
        _media_seq += 1
        mid = f"m{_media_seq}"
        MEDIA[mid] = {**info, "proxy": proxy, "kind": kind}
    return {
        "id": mid,
        "kind": kind,
        "name": info["name"],
        "path": path,
        "duration": info["duration"],
        "width": info["width"],
        "height": info["height"],
        "has_audio": info["has_audio"],
        "has_video": info["has_video"],
    }


IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
AUDIO_EXT = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".flac", ".wma", ".opus"}
SUB_EXT = {".srt", ".vtt"}


def infer_kind(path: str, info: dict | None = None) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in AUDIO_EXT:
        return "audio"
    if ext in SUB_EXT:
        return "srt"
    if info:
        if info.get("has_video"):
            return "video"
        if info.get("has_audio"):
            return "audio"
    return "video"


def make_thumb(mid: str) -> Path | None:
    info = MEDIA.get(mid)
    if not info:
        return None
    thumb_dir = PROXY_DIR / "thumbs"
    thumb_dir.mkdir(parents=True, exist_ok=True)
    dest = thumb_dir / f"{mid}.jpg"
    if dest.is_file() and dest.stat().st_size > 0:
        return dest
    src = info.get("proxy") or info["path"]
    kind = info.get("kind") or infer_kind(info["path"], info)
    if kind == "audio":
        cmd = [
            ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-i", src,
            "-filter_complex", "showwavespic=s=240x136:colors=5eead4",
            "-frames:v", "1", str(dest),
        ]
    else:
        ss = 0.0
        dur = float(info.get("duration") or 0)
        if kind != "image" and dur > 0.4:
            ss = min(max(dur * 0.12, 0.1), dur - 0.15)
        cmd = [
            ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{ss:.3f}", "-i", src, "-vf", "scale=240:-2",
            "-frames:v", "1", "-q:v", "4", str(dest),
        ]
    proc = subprocess.run(cmd, capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=30)
    if proc.returncode != 0 or not dest.is_file():
        return None
    return dest


def register_srt(path: str) -> dict:
    global _media_seq
    entries = parse_srt(path)
    with _state_lock:
        _media_seq += 1
        mid = f"s{_media_seq}"
    end = entries[-1]["end"] if entries else 0.0
    return {
        "id": mid,
        "kind": "srt",
        "name": os.path.basename(path),
        "path": path,
        "duration": end,
        "entries": entries,
    }


def import_media_paths(paths: list) -> tuple[list[dict], list[str]]:
    """Register local files by path. Returns (items, errors)."""
    items: list[dict] = []
    errors: list[str] = []
    for raw in paths or []:
        pth = os.path.abspath(os.path.expanduser(str(raw or "").strip().strip('"')))
        if not pth:
            continue
        if not os.path.isfile(pth):
            errors.append(f"Not found: {os.path.basename(pth) or pth}")
            continue
        try:
            k = infer_kind(pth)
            if k == "srt":
                items.append(register_srt(pth))
            else:
                items.append(register_media(pth, k))
        except Exception as exc:
            errors.append(f"{os.path.basename(pth)}: {exc}")
    return items, errors


def save_upload_stream(rfile, length: int, filename: str) -> str:
    """Stream an uploaded body to PROXY_DIR/uploads; return saved path."""
    safe = re.sub(r"[^\w.\- ()\[\]]+", "_", os.path.basename(filename or "upload.bin"))[:120] or "upload.bin"
    dest_dir = PROXY_DIR / "uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{uuid.uuid4().hex}_{safe}"
    remaining = max(0, int(length or 0))
    with open(dest, "wb") as out:
        while remaining > 0:
            chunk = rfile.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            out.write(chunk)
            remaining -= len(chunk)
    return str(dest)


# ---------- silence detection ----------

def detect_silences(mid: str, noise_db: float, min_dur: float) -> list[list[float]]:
    info = MEDIA[mid]
    cmd = [
        ffmpeg_path(), "-hide_banner", "-i", info["path"],
        "-af", f"silencedetect=noise={noise_db}dB:d={min_dur}",
        "-vn", "-f", "null", "-",
    ]
    proc = run_cmd(cmd, timeout=600)
    text = proc.stderr or ""
    silences: list[list[float]] = []
    start = None
    for m in re.finditer(r"silence_(start|end): ([0-9.]+)", text):
        if m.group(1) == "start":
            start = float(m.group(2))
        elif start is not None:
            silences.append([start, float(m.group(2))])
            start = None
    if start is not None and info["duration"]:
        silences.append([start, info["duration"]])
    return silences


# ---------- export ----------

def _clip_is_full_frame(c: dict) -> bool:
    scale_w = float(c.get("scaleW", c.get("scale", 1)) or 1)
    scale_h = float(c.get("scaleH", scale_w) or scale_w)
    cx = float(c.get("x", 0.5))
    cy = float(c.get("y", 0.5))
    return (
        abs(scale_w - 1.0) < 0.01
        and abs(scale_h - 1.0) < 0.01
        and abs(cx - 0.5) < 0.01
        and abs(cy - 0.5) < 0.01
    )


def canvas_size(project: dict) -> tuple[int, int]:
    canvas = project.get("canvas") or {}
    preset = canvas.get("preset", "auto")
    if preset in CANVAS_RES:
        return CANVAS_RES[preset]
    if preset == "custom":
        return even(float(canvas.get("w") or 1920)), even(float(canvas.get("h") or 1080))
    clips = project.get("clips") or []
    if clips:
        first = clips[0]
        info = MEDIA.get(first["mid"]) or {}
        w, h = info.get("width") or 1920, info.get("height") or 1080
        # Only reorient canvas when the main clip fills the frame at 90°/270°.
        if _clip_is_full_frame(first):
            r = int(round(float(first.get("rotate", 0) or 0))) % 360
            if r in (90, 270):
                w, h = h, w
        return even(w), even(h)
    images = project.get("images") or []
    if images:
        info = MEDIA.get(images[0]["mid"]) or {}
        return even(info.get("width") or 1920), even(info.get("height") or 1080)
    return 1920, 1080


def atempo_chain(speed: float) -> str:
    parts = []
    s = speed
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        parts.append("atempo=0.5")
        s *= 2.0
    if abs(s - 1.0) > 1e-3:
        parts.append(f"atempo={s:.4f}")
    return ",".join(parts)


def clip_video_chain(c: dict, i: int, k: int, W: int, H: int, mode: str, bg: str, length: float) -> list[str]:
    import math

    pre: list[str] = []
    speed = max(0.25, min(float(c.get("speed", 1)) or 1, 4.0))
    vf = f"[{i}:v]trim=start={float(c['in']):.4f}:end={float(c['out']):.4f},setpts=(PTS-STARTPTS)/{speed:.4f}"

    scale_w = float(c.get("scaleW", c.get("scale", 1)) or 1)
    scale_h = float(c.get("scaleH", scale_w) or scale_w)
    scale_w = max(0.05, min(scale_w, 4.0))
    scale_h = max(0.05, min(scale_h, 4.0))
    cx = float(c.get("x", 0.5))
    cy = float(c.get("y", 0.5))
    free = (
        abs(scale_w - 1.0) > 0.01
        or abs(scale_h - 1.0) > 0.01
        or abs(cx - 0.5) > 0.01
        or abs(cy - 0.5) > 0.01
    )
    try:
        corner_pct = float(c.get("cornerRadius") or 0)
    except (TypeError, ValueError):
        corner_pct = 0.0
    want_round = corner_pct >= 0.5
    # Rounded full-frame clips composite onto the canvas bg so corners show through.
    if want_round:
        free = True

    rot_f = float(c.get("rotate", 0) or 0)
    rot_i = int(round(rot_f)) % 360
    # Full-frame: discrete 90° transpose (also drives canvas aspect). Free: continuous rotate after scale.
    if not free and rot_i:
        snapped = (round(rot_i / 90) * 90) % 360
        if snapped in (90, 180, 270):
            vf += "," + filter_for(snapped)

    if c.get("flipH"):
        vf += ",hflip"
    if c.get("flipV"):
        vf += ",vflip"
    adj = c.get("adj") or {}
    exp = float(adj.get("exposure", 0))
    con = float(adj.get("contrast", 1))
    sat = float(adj.get("saturation", 1))
    if abs(exp) > 1e-3 or abs(con - 1) > 1e-3 or abs(sat - 1) > 1e-3:
        vf += f",eq=brightness={exp * 0.3:.4f}:contrast={con:.4f}:saturation={sat:.4f}"
    temp = float(adj.get("temperature", 0))
    if abs(temp) > 1:
        vf += f",colortemperature=temperature={int(6500 - temp * 20)}"
    sharpen = float(adj.get("sharpen", 0))
    if sharpen > 0.01:
        vf += f",unsharp=5:5:{min(sharpen, 1.0) * 1.5:.3f}"
    if adj.get("vignette"):
        vf += ",vignette"

    lut = c.get("lut") or {}
    if lut.get("path") and os.path.isfile(lut["path"]):
        inten = max(0.0, min(float(lut.get("intensity", 1)), 1.0))
        lut_f = f"lut3d=file='{filter_path(lut['path'])}':interp=tetrahedral"
        if inten >= 0.99:
            vf += f",{lut_f}"
        elif inten > 0.01:
            pre.append(vf + f",format=yuv420p,split=2[pl{k}a][pl{k}b]")
            pre.append(f"[pl{k}b]{lut_f},format=yuv420p[pl{k}c]")
            vf = f"[pl{k}a][pl{k}c]blend=all_mode=normal:all_opacity={inten:.3f}"

    fade_in = float(c.get("fadeIn", 0) or 0)
    fade_out = float(c.get("fadeOut", 0) or 0)
    if fade_in > 0.01:
        vf += f",fade=t=in:st=0:d={fade_in:.3f}"
    if fade_out > 0.01:
        vf += f",fade=t=out:st={max(length - fade_out, 0):.4f}:d={fade_out:.3f}"

    color = hexcolor(bg) if bg else "black"

    if free:
        ow = even(W * scale_w)
        oh = even(H * scale_h)
        vf += f",scale={ow}:{oh}"
        vf += overlay_round_filter(c, ow, oh)
        if abs(rot_f) > 0.05:
            rad = rot_f * math.pi / 180.0
            vf += f",rotate={rad:.6f}:ow=rotw(iw):oh=roth(ih):c=none"
        fmt = "rgba" if want_round else "yuv420p"
        vf += f",fps=30,setsar=1,format={fmt}[fg{k}]"
        bgf = f"color=c={color}:s={W}x{H}:d={length:.4f}:r=30,format=yuv420p,setsar=1[bg{k}]"
        ov = (
            f"[bg{k}][fg{k}]overlay=x=(W*{cx:.4f})-(w/2):y=(H*{cy:.4f})-(h/2)"
            f":shortest=1,format=yuv420p[v{k}]"
        )
        return pre + [vf, bgf, ov]

    tail = f",fps=30,setsar=1,format=yuv420p[v{k}]"
    if mode == "fill":
        vf += f",scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}" + tail
        return pre + [vf]
    if mode == "blur":
        split = vf + f",split=2[s{k}a][s{k}b]"
        bgc = f"[s{k}a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=20:2[bg{k}]"
        fgc = f"[s{k}b]scale={W}:{H}:force_original_aspect_ratio=decrease[fg{k}]"
        ov = f"[bg{k}][fg{k}]overlay=(W-w)/2:(H-h)/2" + tail
        return pre + [split, bgc, fgc, ov]
    vf += f",scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color={color}" + tail
    return pre + [vf]


def clip_audio_chain(c: dict, i: int, k: int, length: float, has_audio: bool) -> str:
    speed = max(0.25, min(float(c.get("speed", 1)) or 1, 4.0))
    if not has_audio or c.get("mute"):
        return f"anullsrc=r=48000:cl=stereo:d={length:.4f}[a{k}]"
    af = f"[{i}:a]atrim=start={float(c['in']):.4f}:end={float(c['out']):.4f},asetpts=PTS-STARTPTS"
    tempo = atempo_chain(speed)
    if tempo:
        af += "," + tempo
    if c.get("denoise"):
        af += ",afftdn=nr=12:nf=-25"
    vol = float(c.get("volume", 1))
    if abs(vol - 1) > 1e-3:
        af += f",volume={vol:.3f}"
    fade_in = float(c.get("fadeIn", 0) or 0)
    fade_out = float(c.get("fadeOut", 0) or 0)
    if fade_in > 0.01:
        af += f",afade=t=in:st=0:d={fade_in:.3f}"
    if fade_out > 0.01:
        af += f",afade=t=out:st={max(length - fade_out, 0):.4f}:d={fade_out:.3f}"
    af += (
        ",aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
        f",apad=whole_dur={length:.4f},atrim=0:{length:.4f}[a{k}]"
    )
    return af


def ass_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def ass_color(c: str, alpha: float = 1.0) -> str:
    """#rrggbb + opacity -> ASS &HAABBGGRR (AA=0 opaque)."""
    c = str(c or "#ffffff").lstrip("#")
    if len(c) != 6:
        c = "ffffff"
    r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    aa = int(round((1 - max(0.0, min(alpha, 1.0))) * 255))
    return f"&H{aa:02X}{b:02X}{g:02X}{r:02X}"


def esc_ass(text: str) -> str:
    return str(text).replace("{", "(").replace("}", ")").replace("\r", "").replace("\n", "\\N")


def resolve_font(name: str) -> tuple[str, int]:
    """UI font name -> (ASS family, bold flag). Copies the font file to EXPORT_FONT_DIR."""
    EXPORT_FONT_DIR.mkdir(parents=True, exist_ok=True)
    if name in BUILTIN_FONTS:
        family, bold, filename = BUILTIN_FONTS[name]
        src = WIN_FONTS / filename
        dst = EXPORT_FONT_DIR / filename
        if src.is_file() and not dst.is_file():
            try:
                shutil.copy2(src, dst)
            except OSError:
                pass
        return family, bold
    for f in CUSTOM_FONTS.values():
        if f["family"] == name:
            return name, 0
    return name, 0


def build_ass(project: dict, W: int, H: int) -> str | None:
    texts = project.get("texts") or []
    subs = project.get("subs") or {}
    entries = subs.get("entries") or []
    if not texts and not entries:
        return None

    styles: list[str] = []
    events: list[str] = []

    def style_line(name: str, t: dict) -> str:
        family, bold = resolve_font(t.get("font", "Arial"))
        size = max(8, int(float(t.get("size", 0.08)) * H))
        opacity = float(t.get("opacity", 1))
        primary = ass_color(t.get("color", "#ffffff"), opacity)
        outline_c = ass_color(t.get("stroke", "#000000"), opacity)
        stroke_w = max(0, int(float(t.get("strokeW", 0))))
        if t.get("box"):
            border_style = 3
            back = ass_color(t.get("boxColor", "#000000"), float(t.get("boxAlpha", 0.5)) * opacity)
            outline_w = max(stroke_w, max(3, size // 8))
        else:
            border_style = 1
            # BackColour is the shadow colour in BorderStyle 1
            back = ass_color(t.get("shadowColor", "#000000"), 0.6 * opacity)
            outline_w = stroke_w
        shadow = 2 if t.get("shadow") else 0
        return (
            f"Style: {name},{family},{size},{primary},{primary},{outline_c},{back},"
            f"{bold},0,0,0,100,100,0,0,{border_style},{outline_w},{shadow},5,0,0,0,1"
        )

    for i, t in enumerate(texts):
        name = f"T{i}"
        styles.append(style_line(name, t))
        start = float(t.get("start", 0))
        end = start + float(t.get("durn", 3))
        x = float(t.get("x", 0.5)) * W
        y = float(t.get("y", 0.85)) * H
        rot = float(t.get("rotate", 0) or 0)
        frz = f"\\frz{rot:.1f}" if abs(rot) > 0.05 else ""
        raw = str(t.get("text", "") or "").replace("\r\n", "\n").replace("\r", "\n")
        lines = raw.split("\n")
        nlines = max(1, len(lines))
        size_f = float(t.get("size", 0.08) or 0.08)
        size_px = max(8, int(size_f * H))
        gap = max(0.5, min(float(t.get("lineGap", 1.35) or 1.35), 4.0))
        bw = float(t.get("scaleW", 0.55) or 0.55) * W
        # Grow clip height for explicit newlines so multi-line isn't cropped to one line
        bh_frac = max(float(t.get("scaleH", 0.11) or 0.11), nlines * size_f * gap + 0.02)
        bh = bh_frac * H
        x1, y1 = x - bw / 2, y - bh / 2
        x2, y2 = x + bw / 2, y + bh / 2
        clip = f"\\clip({x1:.0f},{y1:.0f},{x2:.0f},{y2:.0f})"
        # ASS has no line-spacing tag: one event per line, rotated around the block center.
        org = f"\\org({x:.0f},{y:.0f})" if frz else ""
        pitch = gap * size_px
        for li, line in enumerate(lines):
            ly = y + (li - (nlines - 1) / 2) * pitch
            events.append(
                f"Dialogue: 1,{ass_time(start)},{ass_time(end)},{name},,0,0,0,,"
                f"{{\\pos({x:.0f},{ly:.0f}){org}{frz}{clip}\\q2}}{esc_ass(line)}"
            )

    if entries:
        style = subs.get("style") or {}
        style = {"font": "Arial", "size": 0.055, "color": "#ffffff", "stroke": "#000000",
                 "strokeW": 2, "box": True, "boxColor": "#000000", "boxAlpha": 0.55,
                 "shadow": False, "shadowColor": "#000000", "opacity": 1, **style}
        styles.append(style_line("SUB", style))
        y = float(style.get("y", 0.92)) * H
        for e in entries:
            start = float(e.get("start", 0))
            end = start + float(e.get("durn", e.get("end", start + 2) - start))
            events.append(
                f"Dialogue: 0,{ass_time(start)},{ass_time(end)},SUB,,0,0,0,,"
                f"{{\\pos({W / 2:.0f},{y:.0f})}}{esc_ass(e.get('text', ''))}"
            )

    return "\n".join([
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {W}",
        f"PlayResY: {H}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        *styles,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        *events,
        "",
    ])


def filter_path(p: str) -> str:
    """Escape a Windows path for use inside a quoted filter option."""
    return str(p).replace("\\", "/").replace(":", "\\:")


def list_luts() -> list[dict]:
    if not LUT_DIR.is_dir():
        return []
    return [{"name": p.stem, "path": str(p)} for p in sorted(LUT_DIR.glob("*.cube"))]


def apply_lut_filter(parts: list[str], cur: str, lut: dict | None, tag: str) -> str:
    """Append lut3d (with optional mix) onto the current video label. Returns new label."""
    lut = lut or {}
    path = lut.get("path") or ""
    if not path or not os.path.isfile(path):
        return cur
    inten = max(0.0, min(float(lut.get("intensity", 1)), 1.0))
    if inten < 0.01:
        return cur
    lut_f = f"lut3d=file='{filter_path(path)}':interp=tetrahedral"
    if inten >= 0.99:
        parts.append(f"[{cur}]{lut_f}[{tag}]")
        return tag
    parts.append(f"[{cur}]format=yuv420p,split=2[{tag}a][{tag}b]")
    parts.append(f"[{tag}b]{lut_f},format=yuv420p[{tag}c]")
    parts.append(f"[{tag}a][{tag}c]blend=all_mode=normal:all_opacity={inten:.3f}[{tag}]")
    return tag


def content_duration(project: dict) -> float:
    """Timeline length from main clips and/or overlays/music/subs."""
    clips = project.get("clips") or []
    end = 0.0
    if clips:
        # Prefer free-placement offsets when present; fall back to packed sequence.
        has_offset = any(c.get("offset") is not None for c in clips)
        if has_offset:
            for c in clips:
                speed = max(0.25, min(float(c.get("speed", 1)) or 1, 4.0))
                length = max((float(c["out"]) - float(c["in"])) / speed, 0.05)
                off = max(0.0, float(c.get("offset", 0) or 0))
                end = max(end, off + length)
        else:
            lengths = []
            for c in clips:
                speed = max(0.25, min(float(c.get("speed", 1)) or 1, 4.0))
                lengths.append(max((float(c["out"]) - float(c["in"])) / speed, 0.05))
            acc = lengths[0]
            for k in range(1, len(clips)):
                trans = (clips[k - 1].get("trans") or {})
                ttype = XFADE_TYPES.get(trans.get("type", "none"))
                tdur = float(trans.get("dur", 0.5) or 0.5)
                tdur = min(tdur, lengths[k - 1] * 0.45, lengths[k] * 0.45)
                if ttype and tdur >= 0.05:
                    acc = acc - tdur + lengths[k]
                else:
                    acc += lengths[k]
            end = acc
    for m in project.get("music") or []:
        end = max(end, float(m.get("offset", 0)) + max(0.05, float(m["out"]) - float(m["in"])))
    for p in project.get("pips") or []:
        end = max(end, float(p.get("offset", 0)) + max(0.05, float(p["out"]) - float(p["in"])))
    for x in project.get("images") or []:
        end = max(end, float(x.get("start", 0)) + float(x.get("durn", 4)))
    for x in project.get("texts") or []:
        end = max(end, float(x.get("start", 0)) + float(x.get("durn", 3)))
    for x in project.get("shapes") or []:
        end = max(end, float(x.get("start", 0)) + float(x.get("durn", 5)))
    subs = (project.get("subs") or {}).get("entries") or []
    for e in subs:
        start = float(e.get("start", 0))
        durn = float(e.get("durn", e.get("end", start + 2) - start))
        end = max(end, start + max(0.2, durn))
    return max(end, 0.0)


def has_exportable(project: dict) -> bool:
    return bool(
        (project.get("clips") or [])
        or (project.get("music") or [])
        or (project.get("images") or [])
        or (project.get("texts") or [])
        or (project.get("shapes") or [])
        or (project.get("pips") or [])
        or ((project.get("subs") or {}).get("entries") or [])
    )


def build_export(project: dict, enc: Encoder, dest: str) -> tuple[list[str], float]:
    # Lower track numbers are the base; higher tracks composite on top.
    clips = sorted(
        list(project.get("clips") or []),
        key=lambda c: (int(c.get("track") or 0), float(c.get("offset") or 0)),
    )
    music = project.get("music") or []
    texts = project.get("texts") or []
    images = project.get("images") or []
    pips = project.get("pips") or []
    shapes = project.get("shapes") or []
    if not has_exportable(project):
        raise RuntimeError("Timeline is empty — add an image, music, text, shape, or video.")

    total = content_duration(project)
    if total < 0.2:
        total = 3.0

    mids: list[str] = []
    for item in clips + music + images + pips:
        if item["mid"] not in mids:
            mids.append(item["mid"])
    idx = {mid: i for i, mid in enumerate(mids)}
    W, H = canvas_size(project)
    canvas = project.get("canvas") or {}
    mode = canvas.get("mode", "fit")
    bg = canvas.get("bg", "#000000")
    color = hexcolor(bg) if bg else "black"

    inputs: list[str] = []
    for mid in mids:
        inputs += ["-i", MEDIA[mid]["path"]]

    parts: list[str] = []
    extra_audio: list[str] = []

    if clips:
        lengths: list[float] = []
        offsets: list[float] = []
        packed = True
        multi_track = len({int(c.get("track") or 0) for c in clips}) > 1
        acc = 0.0
        for k, c in enumerate(clips):
            info = MEDIA[c["mid"]]
            i = idx[c["mid"]]
            speed = max(0.25, min(float(c.get("speed", 1)) or 1, 4.0))
            length = max((float(c["out"]) - float(c["in"])) / speed, 0.05)
            lengths.append(length)
            if c.get("offset") is not None:
                off = max(0.0, float(c.get("offset") or 0))
                packed = False
            else:
                off = acc
            offsets.append(off)
            acc = off + length
            parts += clip_video_chain(c, i, k, W, H, mode, bg, length)
            parts.append(clip_audio_chain(c, i, k, length, info["has_audio"]))

        # Free placement (gaps / overlaps / multi-track): composite onto a full-length canvas.
        # Packed sequential clips keep concat/xfade for transitions.
        use_free = multi_track or (not packed) or any(
            abs(offsets[k] - (0 if k == 0 else offsets[k - 1] + lengths[k - 1])) > 0.05
            for k in range(len(clips))
        )
        if use_free:
            total = max(total, max(o + l for o, l in zip(offsets, lengths)))
            parts.append(
                f"color=c={color}:s={W}x{H}:d={total:.4f}:r=30,format=yuv420p,setsar=1[vbase]"
            )
            parts.append(f"anullsrc=r=48000:cl=stereo:d={total:.4f}[abase]")
            cur_v, cur_a = "vbase", "abase"
            for k in range(len(clips)):
                off = offsets[k]
                # Delay clip to its timeline start, then overlay / amix.
                if off > 0.001:
                    parts.append(
                        f"[v{k}]tpad=start_mode=add:start_duration={off:.4f}:color={color}[vd{k}]"
                    )
                    delay_ms = int(round(off * 1000))
                    parts.append(f"[a{k}]adelay={delay_ms}|{delay_ms},aformat=sample_fmts=fltp:channel_layouts=stereo[ad{k}]")
                else:
                    parts.append(f"[v{k}]null[vd{k}]")
                    parts.append(f"[a{k}]aformat=sample_fmts=fltp:channel_layouts=stereo[ad{k}]")
                parts.append(f"[{cur_v}][vd{k}]overlay=0:0:eof_action=pass[vo{k}]")
                parts.append(
                    f"[{cur_a}][ad{k}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[ao{k}]"
                )
                cur_v, cur_a = f"vo{k}", f"ao{k}"
        else:
            cur_v, cur_a = "v0", "a0"
            cur_end = lengths[0]
            for k in range(1, len(clips)):
                trans = (clips[k - 1].get("trans") or {})
                ttype = XFADE_TYPES.get(trans.get("type", "none"))
                tdur = float(trans.get("dur", 0.5) or 0.5)
                tdur = min(tdur, lengths[k - 1] * 0.45, lengths[k] * 0.45)
                if ttype and tdur >= 0.05:
                    parts.append(
                        f"[{cur_v}][v{k}]xfade=transition={ttype}:duration={tdur:.3f}:offset={max(cur_end - tdur, 0):.4f}[vx{k}]"
                    )
                    parts.append(f"[{cur_a}][a{k}]acrossfade=d={tdur:.3f}[ax{k}]")
                    cur_end = cur_end - tdur + lengths[k]
                else:
                    parts.append(f"[{cur_v}][v{k}]concat=n=2:v=1:a=0[vx{k}]")
                    parts.append(f"[{cur_a}][a{k}]concat=n=2:v=0:a=1[ax{k}]")
                    cur_end += lengths[k]
                cur_v, cur_a = f"vx{k}", f"ax{k}"
            total = max(total, cur_end)
            if total > cur_end + 0.05:
                pad = total - cur_end
                parts.append(f"[{cur_v}]tpad=stop_mode=clone:stop_duration={pad:.4f}[vpad]")
                parts.append(f"[{cur_a}]apad=pad_dur={pad:.4f}[apad]")
                cur_v, cur_a = "vpad", "apad"
    else:
        # No main video: solid canvas + silence for the full duration
        parts.append(
            f"color=c={color}:s={W}x{H}:d={total:.4f}:r=30,format=yuv420p,setsar=1[v0]"
        )
        parts.append(f"anullsrc=r=48000:cl=stereo:d={total:.4f}[a0]")
        cur_v, cur_a = "v0", "a0"

    # video overlays (inset / picture-in-picture), below images and text
    for j, p in enumerate(pips):
        i = idx[p["mid"]]
        info = MEDIA[p["mid"]]
        start = float(p.get("offset", 0))
        length = max(0.05, float(p["out"]) - float(p["in"]))
        end = start + length
        scale_w = max(0.05, min(float(p.get("scaleW", p.get("scale", 0.35)) or 0.35), 4.0))
        scale_h = max(0.05, min(float(p.get("scaleH", scale_w) or scale_w), 4.0))
        opacity = float(p.get("opacity", 1))
        rot = float(p.get("rotate", 0) or 0)
        ow = even(W * scale_w)
        oh = even(H * scale_h)
        chain = (
            f"[{i}:v]trim=start={float(p['in']):.4f}:end={float(p['out']):.4f}"
            f",setpts=PTS-STARTPTS+{start:.4f}/TB"
            f",scale={ow}:{oh},format=rgba"
        )
        pad = overlay_border_pad_px(p, H)
        chain += overlay_border_filter(p, H)
        chain += overlay_round_filter(p, ow + 2 * pad, oh + 2 * pad)
        if abs(rot) > 0.05:
            rad = rot * 3.141592653589793 / 180.0
            chain += f",rotate={rad:.6f}:ow=rotw(iw):oh=roth(ih):c=none"
        if opacity < 0.995:
            chain += f",colorchannelmixer=aa={opacity:.3f}"
        chain += f"[pip{j}]"
        parts.append(chain)
        x = float(p.get("x", 0.72))
        y = float(p.get("y", 0.72))
        parts.append(
            f"[{cur_v}][pip{j}]overlay=x=(W*{x:.4f})-(w/2):y=(H*{y:.4f})-(h/2)"
            f":enable='between(t,{start:.3f},{end:.3f})':eof_action=pass[vpip{j}]"
        )
        cur_v = f"vpip{j}"
        vol = float(p.get("volume", 1))
        if info["has_audio"] and not p.get("mute") and vol > 0.001:
            af = (
                f"[{i}:a]atrim=start={float(p['in']):.4f}:end={float(p['out']):.4f},asetpts=PTS-STARTPTS"
            )
            if abs(vol - 1) > 1e-3:
                af += f",volume={vol:.3f}"
            af += (
                ",aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
                f",adelay={max(0, int(round(start * 1000)))}:all=1[pipa{j}]"
            )
            parts.append(af)
            extra_audio.append(f"pipa{j}")

    # overlays: images then texts on top
    for j, im in enumerate(images):
        i = idx[im["mid"]]
        scale_w = max(0.02, min(float(im.get("scaleW", im.get("scale", 0.2)) or 0.2), 4.0))
        scale_h = max(0.02, min(float(im.get("scaleH", scale_w) or scale_w), 4.0))
        opacity = float(im.get("opacity", 1))
        rot = float(im.get("rotate", 0) or 0)
        start = float(im.get("start", 0))
        end = start + float(im.get("durn", 4))
        chain = f"[{i}:v]format=rgba,scale={even(W * scale_w)}:{even(H * scale_h)}"
        pad = overlay_border_pad_px(im, H)
        ow = even(W * scale_w)
        oh = even(H * scale_h)
        chain += overlay_border_filter(im, H)
        chain += overlay_round_filter(im, ow + 2 * pad, oh + 2 * pad)
        if abs(rot) > 0.05:
            rad = rot * 3.141592653589793 / 180.0
            chain += f",rotate={rad:.6f}:ow=rotw(iw):oh=roth(ih):c=none"
        if opacity < 0.995:
            chain += f",colorchannelmixer=aa={opacity:.3f}"
        chain += f"[ov{j}]"
        parts.append(chain)
        x = float(im.get("x", 0.5))
        y = float(im.get("y", 0.5))
        parts.append(
            f"[{cur_v}][ov{j}]overlay=x=(W*{x:.4f})-(w/2):y=(H*{y:.4f})-(h/2)"
            f":enable='between(t,{start:.3f},{end:.3f})'[vo{j}]"
        )
        cur_v = f"vo{j}"

    # shape overlays (generated PAM images)
    shape_input_base = len(mids)
    for j, sh in enumerate(shapes):
        pam = render_shape_pam(sh, W, H)
        inputs += ["-i", str(pam)]
        si = shape_input_base + j
        rot = float(sh.get("rotate", 0) or 0)
        start = float(sh.get("start", 0))
        end = start + float(sh.get("durn", 5))
        chain = f"[{si}:v]format=rgba"
        if abs(rot) > 0.05:
            rad = rot * 3.141592653589793 / 180.0
            chain += f",rotate={rad:.6f}:ow=rotw(iw):oh=roth(ih):c=none"
        chain += f"[shp{j}]"
        parts.append(chain)
        x = float(sh.get("x", 0.5))
        y = float(sh.get("y", 0.5))
        parts.append(
            f"[{cur_v}][shp{j}]overlay=x=(W*{x:.4f})-(w/2):y=(H*{y:.4f})-(h/2)"
            f":enable='between(t,{start:.3f},{end:.3f})'[vsh{j}]"
        )
        cur_v = f"vsh{j}"

    # master LUT after picture, before titles so text stays readable
    cur_v = apply_lut_filter(parts, cur_v, (project.get("canvas") or {}).get("lut"), "vlut")

    ass = build_ass(project, W, H)
    if ass:
        PROXY_DIR.mkdir(parents=True, exist_ok=True)
        ass_path = PROXY_DIR / (uuid.uuid4().hex + ".ass")
        ass_path.write_text(ass, encoding="utf-8")
        parts.append(
            f"[{cur_v}]subtitles=filename='{filter_path(str(ass_path))}'"
            f":fontsdir='{filter_path(str(EXPORT_FONT_DIR))}'[vtxt]"
        )
        cur_v = "vtxt"

    # music
    for j, m in enumerate(music):
        i = idx[m["mid"]]
        af = f"[{i}:a]atrim=start={float(m['in']):.4f}:end={float(m['out']):.4f},asetpts=PTS-STARTPTS"
        vol = float(m.get("volume", 1))
        if abs(vol - 1) > 1e-3:
            af += f",volume={vol:.3f}"
        fade_in = float(m.get("fadeIn", 0) or 0)
        fade_out = float(m.get("fadeOut", 0) or 0)
        mlen = float(m["out"]) - float(m["in"])
        if fade_in > 0.01:
            af += f",afade=t=in:st=0:d={fade_in:.3f}"
        if fade_out > 0.01:
            af += f",afade=t=out:st={max(mlen - fade_out, 0):.4f}:d={fade_out:.3f}"
        delay = max(0, int(round(float(m.get("offset", 0)) * 1000)))
        af += (
            ",aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
            f",adelay={delay}:all=1[mu{j}]"
        )
        parts.append(af)
        extra_audio.append(f"mu{j}")

    if extra_audio:
        labels = f"[{cur_a}]" + "".join(f"[{lbl}]" for lbl in extra_audio)
        parts.append(f"{labels}amix=inputs={1 + len(extra_audio)}:duration=first:normalize=0[aout]")
        cur_a = "aout"

    settings = export_settings(project)
    out_w, out_h = export_output_size(W, H, settings["resolution"])
    fps = settings["fps"]
    need_scale = out_w != W or out_h != H
    if need_scale or fps != 30:
        vf_tail = []
        if need_scale:
            vf_tail.append(f"scale={out_w}:{out_h}:flags=bicubic")
        if fps != 30:
            vf_tail.append(f"fps={fps}")
        vf_tail += ["setsar=1", "format=yuv420p"]
        parts.append(f"[{cur_v}]{','.join(vf_tail)}[vexport]")
        cur_v = "vexport"

    vcodec, vargs, acodec, aargs, mux_flags = export_codec_args(enc, settings)

    cmd = [
        ffmpeg_path(), "-y", "-hide_banner", "-nostdin",
        *inputs,
        "-filter_complex", ";".join(parts),
        "-map", f"[{cur_v}]", "-map", f"[{cur_a}]",
        "-c:v", vcodec, *vargs, "-pix_fmt", "yuv420p",
        "-c:a", acodec, *aargs,
        "-t", f"{total:.4f}",
        *mux_flags,
        "-progress", "pipe:1", "-nostats", "-loglevel", "error",
        dest,
    ]
    return cmd, total


def export_settings(project: dict) -> dict:
    raw = project.get("export") or {}
    fmt = str(raw.get("format") or "mp4").lower()
    if fmt not in ("mp4", "webm"):
        fmt = "mp4"
    res = str(raw.get("resolution") or "original")
    if res not in ("original", "1080", "720", "480", "360"):
        res = "original"
    quality = str(raw.get("quality") or "medium")
    if quality not in ("high", "medium", "small"):
        quality = "medium"
    try:
        fps = int(raw.get("fps") or 30)
    except (TypeError, ValueError):
        fps = 30
    if fps not in (15, 24, 30):
        fps = 30
    return {"format": fmt, "resolution": res, "quality": quality, "fps": fps}


def export_output_size(W: int, H: int, resolution: str) -> tuple[int, int]:
    caps = {"1080": 1080, "720": 720, "480": 480, "360": 360}
    if resolution not in caps:
        return even(W), even(H)
    max_h = caps[resolution]
    if H <= max_h:
        return even(W), even(H)
    nh = max_h
    nw = max(2, int(round(W * max_h / H)))
    return even(nw), even(nh)


def export_codec_args(enc: Encoder, settings: dict) -> tuple[str, list[str], str, list[str], list[str]]:
    """Return (vcodec, vargs, acodec, aargs, mux_flags)."""
    q = settings["quality"]
    crf = {"high": 18, "medium": 23, "small": 28}[q]
    cq = {"high": 19, "medium": 24, "small": 30}[q]
    audio_br = {"high": "192k", "medium": "128k", "small": "96k"}[q]
    cpu_preset = {"high": "fast", "medium": "veryfast", "small": "veryfast"}[q]

    if settings["format"] == "webm":
        # VP9 is CPU-only here; reliable and typically smaller for web
        vcrf = {"high": 28, "medium": 33, "small": 38}[q]
        return (
            "libvpx-vp9",
            ["-crf", str(vcrf), "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4"],
            "libopus",
            ["-b:a", audio_br],
            [],
        )

    # MP4 H.264 — prefer the picked encoder, retuned for quality
    name = enc.name
    if name == "h264_nvenc":
        return name, ["-preset", "p4", "-cq", str(cq), "-b:v", "0"], "aac", ["-b:a", audio_br], ["-movflags", "+faststart"]
    if name == "h264_amf":
        qp = {"high": 18, "medium": 22, "small": 28}[q]
        return name, ["-quality", "balanced", "-qp_i", str(qp), "-qp_p", str(qp)], "aac", ["-b:a", audio_br], ["-movflags", "+faststart"]
    if name == "h264_qsv":
        return name, ["-preset", "veryfast", "-global_quality", str(cq)], "aac", ["-b:a", audio_br], ["-movflags", "+faststart"]
    if name == "h264_mf":
        qual = {"high": 80, "medium": 70, "small": 50}[q]
        return name, ["-rate_control", "quality", "-quality", str(qual)], "aac", ["-b:a", audio_br], ["-movflags", "+faststart"]
    return (
        "libx264",
        ["-preset", cpu_preset, "-crf", str(crf)],
        "aac",
        ["-b:a", audio_br],
        ["-movflags", "+faststart"],
    )


def export_dest(project: dict) -> str:
    settings = export_settings(project)
    ext = ".webm" if settings["format"] == "webm" else ".mp4"
    chosen = (project.get("exportPath") or "").strip()
    if chosen:
        root, cur_ext = os.path.splitext(chosen)
        if not cur_ext:
            chosen = chosen + ext
        return chosen
    for key in ("clips", "images", "pips", "music"):
        for item in project.get(key) or []:
            path = item.get("path") or (MEDIA.get(item.get("mid", ""), {}) or {}).get("path")
            if path:
                return unique_path(os.path.splitext(path)[0] + "_export" + ext)
    PROXY_DIR.mkdir(parents=True, exist_ok=True)
    return unique_path(str(PROXY_DIR / ("slideshow_export" + ext)))


def suggest_export_name(project: dict, fmt: str = "mp4") -> str:
    ext = ".webm" if fmt == "webm" else ".mp4"
    for key in ("clips", "images", "pips", "music"):
        for item in project.get(key) or []:
            name = item.get("name") or ""
            path = item.get("path") or ""
            base = os.path.splitext(name or os.path.basename(path) or "export")[0]
            if base:
                return base + "_export" + ext
    return "export" + ext


def run_export(job: str, project: dict) -> None:
    try:
        dest = export_dest(project)
        settings = export_settings(project)
        encoder = pick_encoder()
    except Exception as exc:
        JOBS[job] = {"state": "error", "pct": 0, "error": str(exc)}
        return
    # WebM always uses VP9 path; MP4 can fall back to libx264
    attempts = [encoder]
    if settings["format"] == "mp4" and encoder.name != "libx264":
        attempts.append(Encoder("libx264", ["-preset", "ultrafast", "-crf", "20"], "CPU (ultrafast)", False))
    elif settings["format"] == "webm":
        attempts = [Encoder("libvpx-vp9", [], "VP9", False)]
    last_err = "Export failed."
    for enc in attempts:
        try:
            cmd, total = build_export(project, enc, dest)
        except Exception as exc:
            JOBS[job] = {"state": "error", "pct": 0, "error": str(exc)}
            return
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", creationflags=CREATE_NO_WINDOW,
        )
        err_chunks: list[str] = []
        threading.Thread(target=lambda: err_chunks.append(proc.stderr.read() or ""), daemon=True).start()
        assert proc.stdout is not None
        for line in proc.stdout:
            pct = parse_progress(line.strip(), total)
            if pct is not None:
                JOBS[job] = {"state": "running", "pct": round(pct * 100, 1)}
        if proc.wait() == 0:
            JOBS[job] = {"state": "done", "pct": 100, "dest": dest, "encoder": enc.label}
            return
        last_err = (err_chunks[0] if err_chunks else "").strip() or last_err
        if os.path.exists(dest):
            try:
                os.remove(dest)
            except OSError:
                pass
    JOBS[job] = {"state": "error", "pct": 0, "error": last_err[:600]}


# ---------- project save / load ----------

def load_project(path: str) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    project = data.get("project") or data
    media_map: dict[str, dict] = {}
    remap: dict[str, str] = {}

    def ensure(old_mid: str, file_path: str, kind: str) -> str | None:
        if old_mid in remap:
            return remap[old_mid]
        if not file_path or not os.path.isfile(file_path):
            return None
        media = register_media(file_path, kind)
        remap[old_mid] = media["id"]
        media_map[media["id"]] = media
        return media["id"]

    missing: list[str] = []
    for key, kind in (("clips", "video"), ("music", "audio"), ("images", "image"), ("pips", "video")):
        kept = []
        for item in project.get(key) or []:
            new_mid = ensure(item.get("mid", ""), item.get("path", ""), kind)
            if new_mid:
                item["mid"] = new_mid
                kept.append(item)
            else:
                missing.append(item.get("name") or item.get("path") or "?")
        project[key] = kept

    kept_bin = []
    for item in project.get("bin") or []:
        k = item.get("kind") or infer_kind(item.get("path", ""))
        if k == "pip":
            k = "video"
        if k == "srt":
            fpath = item.get("path", "")
            if fpath and os.path.isfile(fpath):
                srt = register_srt(fpath)
                item["mid"] = srt["id"]
                item["kind"] = "srt"
                item["entries"] = srt["entries"]
                item["duration"] = srt["duration"]
                kept_bin.append(item)
            else:
                missing.append(item.get("name") or fpath or "srt?")
            continue
        new_mid = ensure(item.get("mid", ""), item.get("path", ""), k)
        if new_mid:
            item["mid"] = new_mid
            item["kind"] = k
            kept_bin.append(item)
        else:
            missing.append(item.get("name") or item.get("path") or "bin?")
    project["bin"] = kept_bin

    for c in project.get("clips") or []:
        lut = c.get("lut") or {}
        if lut.get("path") and not os.path.isfile(lut["path"]):
            missing.append(lut.get("name") or lut["path"])
            c["lut"] = None
    canvas = project.get("canvas") or {}
    clut = canvas.get("lut") or {}
    if clut.get("path") and not os.path.isfile(clut["path"]):
        missing.append(clut.get("name") or clut["path"])
        canvas["lut"] = None

    fonts_out = []
    for f in project.get("fonts") or []:
        fpath = f.get("path", "")
        if fpath and os.path.isfile(fpath):
            fonts_out.append(register_font(fpath))
        else:
            missing.append(f.get("family") or fpath or "font?")
    project["fonts"] = fonts_out
    return {"project": project, "media": media_map, "missing": missing}


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:
        pass

    def _json(self, obj: dict, code: int = 200) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(404)
            return
        body = path.read_bytes()
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _media(self, mid: str) -> None:
        info = MEDIA.get(mid)
        if not info:
            self.send_error(404)
            return
        path = info.get("proxy") or info["path"]
        try:
            size = os.path.getsize(path)
        except OSError:
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        partial = False
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
                partial = True
        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        try:
            with open(path, "rb") as fh:
                fh.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = fh.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        route = url.path
        try:
            if route == "/":
                self._file(STATIC / "index.html")
            elif route.startswith("/static/"):
                self._file(STATIC / os.path.basename(route))
            elif route.startswith("/media/"):
                self._media(route.split("/media/", 1)[1])
            elif route == "/api/pick":
                kind = (qs.get("kind") or ["video"])[0]
                path = (qs.get("path") or [""])[0]
                if kind == "media":
                    paths = [path] if path else (ask_file("media") or [])
                    if isinstance(paths, str):
                        paths = [paths] if paths else []
                    items = []
                    for pth in paths:
                        if not os.path.isfile(pth):
                            continue
                        k = infer_kind(pth)
                        if k == "srt":
                            items.append(register_srt(pth))
                        else:
                            items.append(register_media(pth, k))
                    if not items:
                        self._json({"ok": False} if not path else {"ok": False, "error": "File not found."})
                    else:
                        self._json({"ok": True, "items": items})
                    return
                if not path:
                    path = ask_file(kind)
                if not path:
                    self._json({"ok": False})
                    return
                if not os.path.isfile(path):
                    self._json({"ok": False, "error": f"File not found: {path}"})
                    return
                if kind == "font":
                    self._json({"ok": True, "font": register_font(path)})
                elif kind == "lut":
                    self._json({"ok": True, "lut": {"path": path, "name": os.path.basename(path)}})
                elif kind == "pip":
                    self._json({"ok": True, "media": register_media(path, "video")})
                elif kind == "srt":
                    entries = parse_srt(path)
                    if not entries:
                        self._json({"ok": False, "error": "No subtitles found in that file."})
                    else:
                        self._json({"ok": True, "entries": entries})
                else:
                    self._json({"ok": True, "media": register_media(path, kind)})
            elif route == "/api/silence":
                mid = (qs.get("mid") or [""])[0]
                if mid not in MEDIA:
                    self._json({"ok": False, "error": "Unknown media."})
                    return
                noise = float((qs.get("db") or ["-35"])[0])
                min_dur = float((qs.get("min") or ["0.6"])[0])
                self._json({"ok": True, "silences": detect_silences(mid, noise, min_dur)})
            elif route == "/api/load":
                path = (qs.get("path") or [""])[0] or ask_file("project")
                if not path:
                    self._json({"ok": False})
                    return
                self._json({"ok": True, **load_project(path)})
            elif route == "/api/pick-export":
                fmt = (qs.get("format") or ["mp4"])[0]
                name = (qs.get("name") or [""])[0] or suggest_export_name({}, fmt)
                dest = ask_file(
                    "export",
                    save=True,
                    format=fmt,
                    initial=name,
                )
                if not dest:
                    self._json({"ok": False, "cancelled": True})
                else:
                    self._json({"ok": True, "path": dest})
            elif route == "/api/progress":
                job = (qs.get("job") or [""])[0]
                self._json({"ok": True, **JOBS.get(job, {"state": "unknown", "pct": 0})})
            elif route == "/api/luts":
                self._json({"ok": True, "luts": list_luts()})
            elif route == "/api/thumb":
                mid = (qs.get("mid") or [""])[0]
                dest = make_thumb(mid)
                if not dest:
                    self.send_error(404)
                    return
                data = dest.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(data)
            elif route == "/api/lutframe":
                mid = (qs.get("mid") or [""])[0]
                lut_path = (qs.get("lut") or [""])[0]
                t = float((qs.get("t") or ["0"])[0])
                inten = max(0.0, min(float((qs.get("intensity") or ["1"])[0]), 1.0))
                if mid not in MEDIA or not os.path.isfile(lut_path):
                    self._json({"ok": False, "error": "Unknown media or LUT."})
                    return
                vf = "scale=960:-2"
                if inten >= 0.99:
                    vf += f",lut3d=file='{filter_path(lut_path)}':interp=tetrahedral"
                elif inten > 0.01:
                    vf = (
                        f"scale=960:-2,format=yuv420p,split=2[a][b];"
                        f"[b]lut3d=file='{filter_path(lut_path)}':interp=tetrahedral,format=yuv420p[c];"
                        f"[a][c]blend=all_mode=normal:all_opacity={inten:.3f}"
                    )
                res = subprocess.run(
                    [ffmpeg_path(), "-hide_banner", "-loglevel", "error",
                     "-ss", f"{t:.3f}", "-i", MEDIA[mid]["path"],
                     "-filter_complex", vf, "-frames:v", "1", "-f", "mjpeg", "-q:v", "4", "pipe:1"],
                    capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=30,
                )
                if res.returncode != 0 or not res.stdout:
                    self._json({"ok": False, "error": (res.stderr or b"").decode("utf-8", "replace")[:300]})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(res.stdout)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(res.stdout)
            elif route == "/api/reveal":
                path = (qs.get("path") or [""])[0]
                if os.path.exists(path):
                    subprocess.Popen(["explorer", f"/select,{os.path.normpath(path)}"], creationflags=CREATE_NO_WINDOW)
                self._json({"ok": True})
            else:
                self.send_error(404)
        except Exception as exc:
            try:
                self._json({"ok": False, "error": str(exc)})
            except Exception:
                pass

    def do_POST(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            # Streamed file drop upload (avoids loading whole video into RAM as JSON).
            if url.path == "/api/upload-one":
                from urllib.parse import unquote

                raw_name = self.headers.get("X-Filename") or "upload.bin"
                try:
                    filename = unquote(raw_name)
                except Exception:
                    filename = raw_name
                saved = save_upload_stream(self.rfile, length, filename)
                try:
                    items, errors = import_media_paths([saved])
                    if not items:
                        self._json({"ok": False, "error": (errors[0] if errors else "Could not import file.")})
                    else:
                        self._json({"ok": True, "item": items[0], "errors": errors})
                except Exception as exc:
                    try:
                        os.remove(saved)
                    except OSError:
                        pass
                    self._json({"ok": False, "error": str(exc)})
                return

            body = json.loads(self.rfile.read(length) or b"{}")
            if url.path == "/api/import-paths":
                paths = body.get("paths") or []
                if isinstance(paths, str):
                    paths = [paths]
                items, errors = import_media_paths(paths)
                if not items:
                    self._json({
                        "ok": False,
                        "error": (errors[0] if errors else "No supported media in that drop."),
                        "errors": errors,
                    })
                else:
                    self._json({"ok": True, "items": items, "errors": errors})
                return
            if url.path == "/api/export":
                if not has_exportable(body):
                    self._json({"ok": False, "error": "Timeline is empty — add an image, music, text, or video."})
                    return
                settings = export_settings(body)
                fmt = settings.get("format") or "mp4"
                dest = (body.get("exportPath") or "").strip()
                # Always open a Save As explorer unless the client already picked a path.
                if not dest:
                    dest = ask_file(
                        "export",
                        save=True,
                        format=fmt,
                        initial=suggest_export_name(body, fmt),
                        project=body,
                    )
                if not dest:
                    self._json({"ok": False, "cancelled": True})
                    return
                body["exportPath"] = dest
                job = uuid.uuid4().hex[:12]
                JOBS[job] = {"state": "running", "pct": 0, "dest": dest}
                threading.Thread(target=run_export, args=(job, body), daemon=True).start()
                self._json({"ok": True, "job": job, "dest": dest})
            elif url.path == "/api/save":
                path = body.get("path") or ask_file("project", save=True)
                if not path:
                    self._json({"ok": False})
                    return
                Path(path).write_text(
                    json.dumps({"app": "videoeditor", "version": 1, "project": body.get("project") or {}}, indent=1),
                    encoding="utf-8",
                )
                self._json({"ok": True, "path": path})
            else:
                self.send_error(404)
        except Exception as exc:
            self._json({"ok": False, "error": str(exc)})


def start_server(prefer_port: int = 8765) -> tuple[ThreadingHTTPServer, str, int]:
    """Bind the local HTTP server; returns (server, url, port)."""
    port = prefer_port
    server = None
    for _ in range(20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    if server is None:
        raise RuntimeError("No free port found.")
    url = f"http://127.0.0.1:{port}"
    return server, url, port


def main(open_browser: bool | None = None) -> int:
    if open_browser is None:
        open_browser = os.environ.get("VE_NO_BROWSER", "").strip() not in ("1", "true", "yes")
    try:
        server, url, _port = start_server()
    except RuntimeError as exc:
        print(str(exc), flush=True)
        return 1
    print(f"Video editor running at {url}", flush=True)
    if open_browser:
        threading.Thread(target=lambda: webbrowser.open(url), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
