"""Portrait ↔ landscape video rotator. Zero pip deps. Uses the fastest encoder on this PC."""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

# Embeddable/portable Python has no tkinter. The web editor only needs the
# ffmpeg helpers in this module; the optional desktop App loads tk when present.
try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
except ImportError:  # pragma: no cover - portable embeddable Python
    tk = None  # type: ignore
    filedialog = None  # type: ignore
    messagebox = None  # type: ignore
    ttk = None  # type: ignore

_AppBase = tk.Tk if tk is not None else object

VIDEO_EXTS = {
    ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".3gp", ".mts", ".m2ts", ".wmv",
}
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# Fastest-first. We bake pixels (not a rotate tag) so the file is landscape/portrait everywhere.
ENCODERS = [
    ("h264_nvenc", ["-preset", "p1", "-cq", "19", "-b:v", "0"], "NVIDIA GPU"),
    ("h264_amf", ["-quality", "speed", "-rc", "cqp", "-qp_i", "18", "-qp_p", "20"], "AMD GPU"),
    ("h264_qsv", ["-preset", "veryfast", "-global_quality", "20"], "Intel GPU"),
    ("h264_mf", ["-rate_control", "quality", "-quality", "70"], "Windows GPU"),
    ("libx264", ["-preset", "ultrafast", "-crf", "20"], "CPU (ultrafast)"),
]

BG = "#101218"
CARD = "#181c28"
CARD2 = "#202636"
TEXT = "#eef1f6"
MUTED = "#8b93a7"
ACCENT = "#5eead4"
ACCENT2 = "#38bdf8"
DANGER = "#f87171"
LINE = "#2a3144"


def bundled_bin(name: str) -> str | None:
    local = Path(__file__).resolve().parent / "bin" / (name + (".exe" if os.name == "nt" else ""))
    if local.exists():
        return str(local)
    found = shutil.which(name)
    return found


def ffmpeg_path() -> str:
    path = bundled_bin("ffmpeg")
    if not path:
        raise RuntimeError("ffmpeg not found. Install it with:  winget install Gyan.FFmpeg")
    return path


def ffprobe_path() -> str:
    path = bundled_bin("ffprobe")
    if not path:
        raise RuntimeError("ffprobe not found. Install ffmpeg with:  winget install Gyan.FFmpeg")
    return path


def run_cmd(cmd: list[str], timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=CREATE_NO_WINDOW,
    )


@dataclass
class Media:
    path: str
    width: int
    height: int
    display_w: int
    display_h: int
    duration: float
    vcodec: str

    @property
    def orientation(self) -> str:
        if self.display_w == self.display_h:
            return "square"
        return "portrait" if self.display_h > self.display_w else "landscape"

    @property
    def label(self) -> str:
        name = os.path.basename(self.path)
        dur = fmt_duration(self.duration)
        return f"{name}  ·  {self.display_w}×{self.display_h}  ·  {self.orientation}  ·  {dur}"


def fmt_duration(seconds: float) -> str:
    if seconds <= 0:
        return "?"
    s = int(round(seconds))
    return f"{s // 60}:{s % 60:02d}"


def rotation_from_stream(stream: dict) -> int:
    rot = 0
    tags = stream.get("tags") or {}
    for key in ("rotate", "ROTATE"):
        if key in tags:
            try:
                rot = int(round(float(str(tags[key]).replace("deg", ""))))
            except ValueError:
                pass
    for sd in stream.get("side_data_list") or []:
        if str(sd.get("side_data_type", "")).lower().find("display matrix") >= 0 and "rotation" in sd:
            try:
                rot = int(round(float(sd["rotation"])))
            except (TypeError, ValueError):
                pass
    return rot % 360


def probe(path: str) -> Media:
    cmd = [
        ffprobe_path(),
        "-v", "error",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        "--",
        path,
    ]
    proc = run_cmd(cmd, timeout=30)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "Could not read this file.")
    data = json.loads(proc.stdout or "{}")
    stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if not stream:
        raise RuntimeError("No video stream in this file.")
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    rot = rotation_from_stream(stream)
    display_w, display_h = (height, width) if rot in (90, 270) else (width, height)
    duration = 0.0
    for src in (stream.get("duration"), (data.get("format") or {}).get("duration")):
        if src:
            try:
                duration = max(duration, float(src))
            except ValueError:
                pass
    return Media(
        path=path,
        width=width,
        height=height,
        display_w=display_w,
        display_h=display_h,
        duration=duration,
        vcodec=str(stream.get("codec_name") or "?"),
    )


@dataclass
class Encoder:
    name: str
    args: list[str]
    label: str
    hwaccel: bool = True


_encoder_lock = threading.Lock()
_cached_encoder: Encoder | None = None
_CACHE_PATH = Path(__file__).resolve().parent / ".encoder-cache.json"


def _gpu_hint(name: str) -> bool:
    sys32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    if name == "h264_nvenc":
        return (sys32 / "nvcuda.dll").exists() or (sys32 / "nvml.dll").exists()
    if name == "h264_amf":
        return (sys32 / "amfrt64.dll").exists() or (sys32 / "amfrt32.dll").exists()
    return True


def _load_cached_encoder() -> Encoder | None:
    try:
        data = json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
        return Encoder(data["name"], list(data["args"]), data["label"], bool(data.get("hwaccel", True)))
    except Exception:
        return None


def _save_cached_encoder(enc: Encoder) -> None:
    try:
        _CACHE_PATH.write_text(
            json.dumps({"name": enc.name, "args": enc.args, "label": enc.label, "hwaccel": enc.hwaccel}),
            encoding="utf-8",
        )
    except OSError:
        pass


def list_encoders() -> str:
    proc = run_cmd([ffmpeg_path(), "-hide_banner", "-encoders"], timeout=15)
    return proc.stdout or ""


def encoder_available(name: str, listing: str | None = None) -> bool:
    text = listing if listing is not None else list_encoders()
    return bool(re.search(rf"^\s*[A-Z.]+\s+{re.escape(name)}\s", text, re.M))


def encoder_works(enc: Encoder) -> bool:
    cmd = [
        ffmpeg_path(),
        "-hide_banner",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", "color=c=black:s=128x128:d=0.04",
        "-pix_fmt", "yuv420p",
        "-c:v", enc.name,
        *enc.args,
        "-frames:v", "1",
        "-f", "null",
        "-",
    ]
    try:
        proc = run_cmd(cmd, timeout=6)
    except subprocess.TimeoutExpired:
        return False
    return proc.returncode == 0


def pick_encoder(force: bool = False) -> Encoder:
    global _cached_encoder
    with _encoder_lock:
        if _cached_encoder and not force:
            return _cached_encoder
        if not force:
            cached = _load_cached_encoder()
            if cached:
                _cached_encoder = cached
                return cached
        listing = list_encoders()
        for name, args, label in ENCODERS:
            if not _gpu_hint(name):
                continue
            if not encoder_available(name, listing):
                continue
            enc = Encoder(name, args, label, hwaccel=(name != "libx264"))
            if encoder_works(enc):
                _cached_encoder = enc
                _save_cached_encoder(enc)
                return enc
        enc = Encoder("libx264", ["-preset", "ultrafast", "-crf", "20"], "CPU (ultrafast)", False)
        _cached_encoder = enc
        _save_cached_encoder(enc)
        return enc


def unique_path(path: str) -> str:
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    n = 2
    while os.path.exists(f"{stem}_{n}{ext}"):
        n += 1
    return f"{stem}_{n}{ext}"


def output_path(src: str, tag: str) -> str:
    folder, name = os.path.split(src)
    stem = os.path.splitext(name)[0]
    return unique_path(os.path.join(folder, f"{stem}_{tag}.mp4"))


def filter_for(degrees: int) -> str:
    degrees = degrees % 360
    if degrees == 90:
        return "transpose=1"
    if degrees == 270:
        return "transpose=2"
    if degrees == 180:
        return "hflip,vflip"
    raise ValueError("Rotation must be 90, 180, or 270.")


def parse_progress(line: str, duration: float) -> float | None:
    if line.startswith("out_time_ms="):
        raw = line.split("=", 1)[1].strip()
        if raw.isdigit() and duration > 0:
            return min(1.0, (int(raw) / 1_000_000) / duration)
    if line.startswith("out_time=") and duration > 0:
        stamp = line.split("=", 1)[1].strip()
        parts = stamp.split(":")
        try:
            if len(parts) == 3:
                sec = float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
                return min(1.0, sec / duration)
        except ValueError:
            return None
    if line.startswith("progress=end"):
        return 1.0
    return None


def transcode(
    src: str,
    dest: str,
    vf: str,
    encoder: Encoder,
    duration: float,
    progress_q: queue.Queue | None = None,
    hwaccel: bool | None = None,
    audio: str = "copy",
    af: str | None = None,
    extra_in: list[str] | None = None,
) -> None:
    use_hw = encoder.hwaccel if hwaccel is None else hwaccel
    cmd = [ffmpeg_path(), "-y", "-hide_banner", "-nostdin"]
    if use_hw:
        cmd += ["-hwaccel", "auto"]
    if extra_in:
        cmd += extra_in
    cmd += ["-i", src]
    if vf:
        cmd += ["-vf", vf]
    cmd += [
        "-pix_fmt", "yuv420p",
        "-c:v", encoder.name,
        *encoder.args,
        "-map", "0:v:0",
        "-map", "0:a?",
    ]
    if af:
        cmd += ["-af", af, "-c:a", "aac", "-b:a", "160k"]
    else:
        cmd += ["-c:a", audio]
        if audio != "copy":
            cmd += ["-b:a", "160k"]
    cmd += [
        "-sn",
        "-dn",
        "-metadata:s:v:0", "rotate=0",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        "-loglevel", "error",
        dest,
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=CREATE_NO_WINDOW,
    )
    err_chunks: list[str] = []

    def _read_err() -> None:
        if proc.stderr:
            err_chunks.append(proc.stderr.read() or "")

    err_thread = threading.Thread(target=_read_err, daemon=True)
    err_thread.start()
    assert proc.stdout is not None
    for line in proc.stdout:
        pct = parse_progress(line.strip(), duration)
        if pct is not None and progress_q is not None:
            progress_q.put(pct)
    code = proc.wait()
    err_thread.join(timeout=2)
    if code != 0:
        if os.path.exists(dest):
            try:
                os.remove(dest)
            except OSError:
                pass
        raise RuntimeError((err_chunks[0] if err_chunks else "").strip() or f"ffmpeg failed ({code})")


def transcode_with_fallback(
    src: str,
    dest: str,
    vf: str,
    encoder: Encoder,
    duration: float,
    progress_q: queue.Queue | None = None,
    af: str | None = None,
    extra_in: list[str] | None = None,
) -> Encoder:
    first_audio = "aac" if af else "copy"
    attempts = [
        (encoder, True, first_audio),
        (encoder, False, first_audio),
    ]
    if first_audio == "copy":
        attempts.append((encoder, False, "aac"))
    if encoder.name != "libx264":
        cpu = Encoder("libx264", ["-preset", "ultrafast", "-crf", "20"], "CPU (ultrafast)", False)
        attempts.append((cpu, False, "aac"))
    last_err = "Processing failed."
    for enc, hw, audio in attempts:
        try:
            transcode(src, dest, vf, enc, duration, progress_q, hw, audio, af, extra_in)
            return enc
        except RuntimeError as exc:
            last_err = str(exc)
    raise RuntimeError(last_err)


def rotate_with_fallback(
    src: str,
    degrees: int,
    dest: str,
    encoder: Encoder,
    duration: float,
    progress_q: queue.Queue | None = None,
) -> Encoder:
    return transcode_with_fallback(src, dest, filter_for(degrees), encoder, duration, progress_q)


def degrees_for_target(media: Media, target: str) -> int | None:
    if media.orientation == "square":
        return None
    if target == "landscape" and media.orientation == "portrait":
        return 90
    if target == "portrait" and media.orientation == "landscape":
        return 90
    return None


class App(_AppBase):
    def __init__(self) -> None:
        if tk is None:
            raise RuntimeError("tkinter is not available in this Python install.")
        super().__init__()
        self.title("Video Rotate")
        self.configure(bg=BG)
        self.minsize(520, 560)
        self.geometry("560x640")
        self.files: list[Media] = []
        self.busy = False
        self.encoder_label = tk.StringVar(value="Detecting fastest encoder…")
        self.status = tk.StringVar(value="Drop a video, or click to open.")
        self.progress = tk.DoubleVar(value=0)
        self._build()
        self.after(200, self._hook_drops)
        threading.Thread(target=self._detect_encoder, daemon=True).start()

    def _build(self) -> None:
        self.header = tk.Frame(self, bg=BG)
        self.header.pack(fill="x", padx=22, pady=(22, 8))
        header = self.header
        tk.Label(header, text="Video Rotate", fg=TEXT, bg=BG, font=("Segoe UI Semibold", 22)).pack(anchor="w")
        tk.Label(
            header,
            text="Turn vertical clips horizontal — and the other way around.",
            fg=MUTED,
            bg=BG,
            font=("Segoe UI", 10),
        ).pack(anchor="w", pady=(4, 0))

        self.drop = tk.Frame(self, bg=CARD, highlightbackground=LINE, highlightthickness=1, cursor="hand2")
        self.drop.pack(fill="both", expand=True, padx=22, pady=(16, 10))
        inner = tk.Frame(self.drop, bg=CARD)
        inner.place(relx=0.5, rely=0.5, anchor="center")
        self.drop_title = tk.Label(inner, text="Drop a video here", fg=TEXT, bg=CARD, font=("Segoe UI Semibold", 14))
        self.drop_title.pack()
        self.drop_sub = tk.Label(inner, text="or click to browse  ·  Ctrl+O", fg=MUTED, bg=CARD, font=("Segoe UI", 10))
        self.drop_sub.pack(pady=(6, 0))
        for w in (self.drop, inner, self.drop_title, self.drop_sub):
            w.bind("<Button-1>", lambda _e: self.open_files())

        self.list_frame = tk.Frame(self, bg=BG)
        self.file_list = tk.Text(
            self.list_frame,
            height=4,
            bg=CARD,
            fg=TEXT,
            relief="flat",
            font=("Segoe UI", 9),
            wrap="word",
            highlightthickness=1,
            highlightbackground=LINE,
            padx=12,
            pady=10,
            state="disabled",
        )
        self.file_list.pack(fill="x")

        self.actions = tk.Frame(self, bg=BG)
        self.actions.pack(fill="x", padx=22, pady=(4, 8))
        btns = self.actions
        self.btn_land = self._big_btn(btns, "Make landscape", ACCENT, lambda: self.run_target("landscape"))
        self.btn_port = self._big_btn(btns, "Make portrait", ACCENT2, lambda: self.run_target("portrait"))
        self.btn_land.pack(side="left", expand=True, fill="x", padx=(0, 8))
        self.btn_port.pack(side="left", expand=True, fill="x")

        fine = tk.Frame(self, bg=BG)
        fine.pack(fill="x", padx=22, pady=(0, 10))
        tk.Label(fine, text="If it faces the wrong way:", fg=MUTED, bg=BG, font=("Segoe UI", 9)).pack(anchor="w")
        row = tk.Frame(fine, bg=BG)
        row.pack(fill="x", pady=(6, 0))
        self._small_btn(row, "90° left", lambda: self.run_degrees(270)).pack(side="left", expand=True, fill="x", padx=(0, 6))
        self._small_btn(row, "180°", lambda: self.run_degrees(180)).pack(side="left", expand=True, fill="x", padx=6)
        self._small_btn(row, "90° right", lambda: self.run_degrees(90)).pack(side="left", expand=True, fill="x", padx=(6, 0))

        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(
            "Fast.Horizontal.TProgressbar",
            troughcolor=CARD2,
            background=ACCENT,
            bordercolor=CARD2,
            lightcolor=ACCENT,
            darkcolor=ACCENT,
            thickness=8,
        )
        bar = ttk.Progressbar(self, variable=self.progress, maximum=100, style="Fast.Horizontal.TProgressbar")
        bar.pack(fill="x", padx=22, pady=(4, 8))

        foot = tk.Frame(self, bg=BG)
        foot.pack(fill="x", padx=22, pady=(0, 18))
        tk.Label(foot, textvariable=self.status, fg=TEXT, bg=BG, font=("Segoe UI", 9), wraplength=500, justify="left").pack(anchor="w")
        tk.Label(foot, textvariable=self.encoder_label, fg=MUTED, bg=BG, font=("Segoe UI", 8)).pack(anchor="w", pady=(4, 0))

        self.bind("<Control-o>", lambda _e: self.open_files())

    def _big_btn(self, parent: tk.Widget, text: str, color: str, cmd) -> tk.Button:
        return tk.Button(
            parent,
            text=text,
            command=cmd,
            bg=color,
            fg="#042f2e",
            activebackground=color,
            activeforeground="#042f2e",
            relief="flat",
            font=("Segoe UI Semibold", 12),
            cursor="hand2",
            pady=12,
            bd=0,
        )

    def _small_btn(self, parent: tk.Widget, text: str, cmd) -> tk.Button:
        return tk.Button(
            parent,
            text=text,
            command=cmd,
            bg=CARD2,
            fg=TEXT,
            activebackground=LINE,
            activeforeground=TEXT,
            relief="flat",
            font=("Segoe UI", 10),
            cursor="hand2",
            pady=8,
            bd=0,
        )

    def _detect_encoder(self) -> None:
        try:
            ffmpeg_path()
            enc = pick_encoder()
            msg = f"Encoder: {enc.label} · originals are never overwritten"
        except Exception as exc:
            msg = str(exc)
        self.after(0, lambda: self.encoder_label.set(msg))

    def _hook_drops(self) -> None:
        try:
            enable_file_drop(self, self.load_paths)
        except Exception:
            pass

    def open_files(self) -> None:
        if self.busy:
            return
        paths = filedialog.askopenfilenames(
            title="Choose video",
            filetypes=[
                ("Video", "*.mp4 *.mov *.m4v *.mkv *.webm *.avi *.3gp *.mts *.m2ts *.wmv"),
                ("All files", "*.*"),
            ],
        )
        if paths:
            self.load_paths(list(paths))

    def load_paths(self, paths: list[str]) -> None:
        videos = [p for p in paths if os.path.splitext(p)[1].lower() in VIDEO_EXTS and os.path.isfile(p)]
        if not videos:
            self.status.set("That drop had no video files.")
            return
        loaded: list[Media] = []
        errors: list[str] = []
        for path in videos:
            try:
                loaded.append(probe(path))
            except Exception as exc:
                errors.append(f"{os.path.basename(path)}: {exc}")
        self.files = loaded
        self._render_files()
        if errors and not loaded:
            self.status.set(errors[0])
        elif errors:
            self.status.set(f"Loaded {len(loaded)} · skipped {len(errors)}")
        elif loaded:
            n = len(loaded)
            self.status.set(f"{n} clip ready." if n == 1 else f"{n} clips ready.")

    def _render_files(self) -> None:
        if self.files:
            self.drop.pack_forget()
            self.list_frame.pack(fill="x", padx=22, pady=(16, 10), before=self.actions)
            self.file_list.configure(state="normal")
            self.file_list.delete("1.0", "end")
            self.file_list.insert("1.0", "\n".join(m.label for m in self.files) + "\n\nCtrl+O to choose other files")
            self.file_list.configure(state="disabled")
            self.drop_title.configure(text=f"{len(self.files)} video" + ("s" if len(self.files) != 1 else ""))
        else:
            self.list_frame.pack_forget()
            self.drop.pack(fill="both", expand=True, padx=22, pady=(16, 10), before=self.actions)

    def run_target(self, target: str) -> None:
        if not self._ready():
            return
        jobs: list[tuple[Media, int, str]] = []
        skipped = 0
        for media in self.files:
            deg = degrees_for_target(media, target)
            if deg is None:
                skipped += 1
                continue
            jobs.append((media, deg, target))
        if not jobs:
            already = "landscape" if target == "landscape" else "portrait"
            self.status.set(f"Already {already}. Use 90° if you still need a turn.")
            return
        self._start(jobs, skipped)

    def run_degrees(self, degrees: int) -> None:
        if not self._ready():
            return
        tag = {90: "rot90", 180: "rot180", 270: "rot270"}[degrees]
        jobs = [(m, degrees, tag) for m in self.files]
        self._start(jobs, 0)

    def _ready(self) -> bool:
        if self.busy:
            return False
        if not self.files:
            self.open_files()
            return False
        return True

    def _start(self, jobs: list[tuple[Media, int, str]], skipped: int) -> None:
        self.busy = True
        self.progress.set(0)
        self.status.set("Rotating…")
        threading.Thread(target=self._worker, args=(jobs, skipped), daemon=True).start()

    def _worker(self, jobs: list[tuple[Media, int, str]], skipped: int) -> None:
        started = time.perf_counter()
        done: list[str] = []
        try:
            encoder = pick_encoder()
        except Exception as exc:
            self.after(0, lambda: self._fail(str(exc)))
            return
        progress_q: queue.Queue = queue.Queue()

        def pump() -> None:
            latest = None
            while True:
                try:
                    latest = progress_q.get_nowait()
                except queue.Empty:
                    break
            if latest is not None:
                base = (pump.i + latest) / pump.n * 100  # type: ignore[attr-defined]
                self.progress.set(base)
            if self.busy:
                self.after(80, pump)

        pump.i = 0  # type: ignore[attr-defined]
        pump.n = max(len(jobs), 1)  # type: ignore[attr-defined]
        self.after(0, pump)

        used = encoder
        try:
            for i, (media, degrees, tag) in enumerate(jobs):
                pump.i = i  # type: ignore[attr-defined]
                dest = output_path(media.path, tag)
                used = rotate_with_fallback(media.path, degrees, dest, encoder, media.duration, progress_q)
                done.append(dest)
            elapsed = time.perf_counter() - started
            self.after(0, lambda: self._succeed(done, skipped, elapsed, used))
        except Exception as exc:
            self.after(0, lambda: self._fail(str(exc)))

    def _succeed(self, done: list[str], skipped: int, elapsed: float, enc: Encoder) -> None:
        self.busy = False
        self.progress.set(100)
        extra = f" · skipped {skipped} already-correct" if skipped else ""
        names = ", ".join(os.path.basename(p) for p in done)
        self.status.set(f"Done in {elapsed:.1f}s{extra}\n{names}")
        self.encoder_label.set(f"Encoder: {enc.label} · originals are never overwritten")
        if done:
            folder = os.path.dirname(done[0])
            try:
                os.startfile(folder)  # type: ignore[attr-defined]
            except Exception:
                pass

    def _fail(self, message: str) -> None:
        self.busy = False
        self.status.set(message)
        messagebox.showerror("Video Rotate", message)


def enable_file_drop(window: tk.Tk, callback) -> None:
    """Explorer drag-and-drop via WM_DROPFILES. Optional; click-to-open still works if this fails."""
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    GA_ROOT = 2
    WM_DROPFILES = 0x0233
    GWL_WNDPROC = -4

    hwnd = user32.GetAncestor(wintypes.HWND(int(window.winfo_id())), GA_ROOT)
    if not hwnd:
        hwnd = int(window.winfo_id())

    LRESULT = ctypes.c_ssize_t
    WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t)
    user32.CallWindowProcW.argtypes = [ctypes.c_void_p, wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t]
    user32.CallWindowProcW.restype = LRESULT
    user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongPtrW.restype = ctypes.c_void_p
    user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_void_p]
    user32.SetWindowLongPtrW.restype = ctypes.c_void_p
    shell32.DragQueryFileW.argtypes = [ctypes.c_void_p, wintypes.UINT, ctypes.c_wchar_p, wintypes.UINT]
    shell32.DragQueryFileW.restype = wintypes.UINT

    old_proc = user32.GetWindowLongPtrW(hwnd, GWL_WNDPROC)
    shell32.DragAcceptFiles(wintypes.HWND(hwnd), True)

    @WNDPROC
    def hooked(h, msg, wparam, lparam):
        if msg == WM_DROPFILES:
            count = shell32.DragQueryFileW(wparam, 0xFFFFFFFF, None, 0)
            paths: list[str] = []
            for i in range(count):
                nchars = shell32.DragQueryFileW(wparam, i, None, 0) + 1
                buf = ctypes.create_unicode_buffer(nchars)
                shell32.DragQueryFileW(wparam, i, buf, nchars)
                paths.append(buf.value)
            shell32.DragFinish(ctypes.c_void_p(wparam))
            window.after(0, lambda p=paths: callback(p))
            return 0
        return user32.CallWindowProcW(old_proc, h, msg, wparam, lparam)

    window._drop_hook = hooked  # keep callback alive
    window._drop_old = old_proc
    user32.SetWindowLongPtrW(hwnd, GWL_WNDPROC, ctypes.cast(hooked, ctypes.c_void_p))


def cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Rotate video to landscape or portrait as fast as possible.")
    parser.add_argument("files", nargs="+")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--landscape", action="store_true")
    group.add_argument("--portrait", action="store_true")
    group.add_argument("--cw", action="store_true", help="90° clockwise")
    group.add_argument("--ccw", action="store_true", help="90° counter-clockwise")
    group.add_argument("--180", dest="flip", action="store_true")
    args = parser.parse_args(argv)
    encoder = pick_encoder()
    print(f"Encoder: {encoder.label}")
    for path in args.files:
        media = probe(path)
        if args.landscape:
            deg = degrees_for_target(media, "landscape")
            tag = "landscape"
        elif args.portrait:
            deg = degrees_for_target(media, "portrait")
            tag = "portrait"
        elif args.cw:
            deg, tag = 90, "rot90"
        elif args.ccw:
            deg, tag = 270, "rot270"
        else:
            deg, tag = 180, "rot180"
        if deg is None:
            print(f"skip (already {media.orientation}): {path}")
            continue
        dest = output_path(path, tag)
        used = rotate_with_fallback(path, deg, dest, encoder, media.duration)
        print(f"wrote ({used.label}): {dest}")
    return 0


def main() -> int:
    if os.name == "nt":
        try:
            ctypes_mod = __import__("ctypes")
            ctypes_mod.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    argv = sys.argv[1:]
    if argv and any(a.startswith("-") for a in argv):
        return cli(argv)
    app = App()
    if argv:
        app.after(50, lambda: app.load_paths(argv))
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
