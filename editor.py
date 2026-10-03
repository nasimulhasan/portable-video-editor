"""Light video editor on top of app.py: rotate video, rotate/reshape canvas, crop, audio noise removal.

Zero pip dependencies — tkinter UI, ffmpeg engine, GPU encoder auto-detected.
"""

from __future__ import annotations

import base64
import math
import os
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from app import (
    ACCENT,
    ACCENT2,
    BG,
    CARD,
    CARD2,
    CREATE_NO_WINDOW,
    LINE,
    MUTED,
    TEXT,
    VIDEO_EXTS,
    Media,
    enable_file_drop,
    ffmpeg_path,
    filter_for,
    fmt_duration,
    pick_encoder,
    probe,
    transcode_with_fallback,
    unique_path,
)

CANVAS_MODES = ["auto", "16:9", "9:16", "1:1", "4:3", "3:4"]
CANVAS_RATIO = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1.0, "4:3": 4 / 3, "3:4": 3 / 4}


def grab_frame_png(src: str, t: float, vf: str, max_w: int, max_h: int) -> bytes:
    """Extract one frame as PNG bytes with the given filter chain applied."""
    chain = (vf + "," if vf else "") + (
        f"scale=w={max_w}:h={max_h}:force_original_aspect_ratio=decrease"
    )
    cmd = [
        ffmpeg_path(),
        "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(t, 0):.3f}",
        "-i", src,
        "-vf", chain,
        "-frames:v", "1",
        "-f", "image2pipe",
        "-c:v", "png",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=30, creationflags=CREATE_NO_WINDOW)
    if proc.returncode != 0 or not proc.stdout:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(err or "Could not render preview frame.")
    return proc.stdout


def even(n: float) -> int:
    return max(2, int(n) // 2 * 2)


def even_up(n: float) -> int:
    v = int(math.ceil(n))
    return v + (v % 2)


def pad_dims(w: int, h: int, ratio: float) -> tuple[int, int]:
    """Smallest even canvas of the given aspect ratio that contains w×h."""
    if w / h < ratio:
        return even_up(h * ratio), even_up(h)
    return even_up(w), even_up(w / ratio)


class Editor(tk.Tk):
    PREVIEW_PAD = 16

    def __init__(self) -> None:
        super().__init__()
        self.title("Video Editor")
        self.configure(bg=BG)
        self.minsize(960, 620)
        self.geometry("1080x680")

        self.media: Media | None = None
        self.deg = 0
        self.crop: tuple[int, int, int, int] | None = None  # x, y, w, h in rotated-video px
        self.canvas_mode = tk.StringVar(value="auto")
        self.noise_on = tk.BooleanVar(value=False)
        self.noise_db = tk.IntVar(value=12)
        self.show_result = tk.BooleanVar(value=False)
        self.t = 0.0
        self.busy = False

        self.status = tk.StringVar(value="Open a video to start.")
        self.info = tk.StringVar(value="")
        self.encoder_label = tk.StringVar(value="Detecting fastest encoder…")
        self.progress = tk.DoubleVar(value=0)

        # preview state
        self._img: tk.PhotoImage | None = None
        self._img_box = (0, 0, 0, 0)  # ox, oy, iw, ih on canvas
        self._preview_token = 0
        self._seek_job: str | None = None
        self._drag: dict | None = None

        self._build()
        self.after(200, lambda: self._try(enable_file_drop, self, self._on_drop))
        threading.Thread(target=self._detect_encoder, daemon=True).start()
        self.bind("<Control-o>", lambda _e: self.open_file())

    @staticmethod
    def _try(fn, *a):
        try:
            fn(*a)
        except Exception:
            pass

    # ---------- UI ----------

    def _build(self) -> None:
        top = tk.Frame(self, bg=BG)
        top.pack(fill="x", padx=16, pady=(14, 6))
        tk.Button(
            top, text="Open video", command=self.open_file, bg=CARD2, fg=TEXT,
            activebackground=LINE, activeforeground=TEXT, relief="flat",
            font=("Segoe UI Semibold", 10), cursor="hand2", padx=14, pady=6, bd=0,
        ).pack(side="left")
        self.name_label = tk.Label(top, text="No file", fg=MUTED, bg=BG, font=("Segoe UI", 10))
        self.name_label.pack(side="left", padx=12)
        tk.Checkbutton(
            top, text="Show final result", variable=self.show_result, command=self._render_preview,
            bg=BG, fg=TEXT, activebackground=BG, activeforeground=TEXT,
            selectcolor=CARD2, font=("Segoe UI", 9),
        ).pack(side="right")

        body = tk.Frame(self, bg=BG)
        body.pack(fill="both", expand=True, padx=16)

        # left: preview + seek
        left = tk.Frame(body, bg=BG)
        left.pack(side="left", fill="both", expand=True)
        self.canvas = tk.Canvas(left, bg="#0a0c10", highlightthickness=1, highlightbackground=LINE)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda _e: self._schedule_seek_render(60))
        self.canvas.bind("<ButtonPress-1>", self._crop_press)
        self.canvas.bind("<B1-Motion>", self._crop_drag)
        self.canvas.bind("<ButtonRelease-1>", self._crop_release)

        seek_row = tk.Frame(left, bg=BG)
        seek_row.pack(fill="x", pady=(8, 0))
        self.seek = tk.Scale(
            seek_row, from_=0, to=100, orient="horizontal", showvalue=0,
            bg=BG, troughcolor=CARD2, highlightthickness=0, sliderrelief="flat",
            activebackground=ACCENT, command=self._on_seek,
        )
        self.seek.pack(side="left", fill="x", expand=True)
        self.time_label = tk.Label(seek_row, text="0:00 / 0:00", fg=MUTED, bg=BG, font=("Segoe UI", 9), width=12)
        self.time_label.pack(side="right")

        tk.Label(left, textvariable=self.info, fg=MUTED, bg=BG, font=("Segoe UI", 9)).pack(anchor="w", pady=(4, 8))

        # right: controls
        right = tk.Frame(body, bg=BG, width=300)
        right.pack(side="right", fill="y", padx=(16, 0))
        right.pack_propagate(False)

        self._section(right, "Rotate video")
        rot = tk.Frame(right, bg=BG)
        rot.pack(fill="x", pady=(2, 10))
        self._btn(rot, "⟲ 90°", lambda: self.rotate(-90)).pack(side="left", expand=True, fill="x", padx=(0, 4))
        self._btn(rot, "180°", lambda: self.rotate(180)).pack(side="left", expand=True, fill="x", padx=4)
        self._btn(rot, "⟳ 90°", lambda: self.rotate(90)).pack(side="left", expand=True, fill="x", padx=(4, 0))

        self._section(right, "Canvas (frame shape)")
        canv = tk.Frame(right, bg=BG)
        canv.pack(fill="x", pady=(2, 4))
        for i, mode in enumerate(CANVAS_MODES):
            rb = tk.Radiobutton(
                canv, text=mode, value=mode, variable=self.canvas_mode, command=self._on_canvas_mode,
                bg=BG, fg=TEXT, activebackground=BG, activeforeground=TEXT,
                selectcolor=CARD2, font=("Segoe UI", 9), indicatoron=True,
            )
            rb.grid(row=i // 3, column=i % 3, sticky="w", padx=2, pady=1)
        self._btn_row = tk.Frame(right, bg=BG)
        self._btn_row.pack(fill="x", pady=(2, 10))
        self._btn(self._btn_row, "⇄ Rotate canvas", self.rotate_canvas).pack(fill="x")

        self._section(right, "Crop")
        tk.Label(right, text="Drag on the preview to crop.", fg=MUTED, bg=BG, font=("Segoe UI", 9)).pack(anchor="w")
        crop_row = tk.Frame(right, bg=BG)
        crop_row.pack(fill="x", pady=(4, 10))
        self._btn(crop_row, "Reset crop", self.reset_crop).pack(fill="x")

        self._section(right, "Audio")
        tk.Checkbutton(
            right, text="Remove background noise", variable=self.noise_on, command=self._update_info,
            bg=BG, fg=TEXT, activebackground=BG, activeforeground=TEXT,
            selectcolor=CARD2, font=("Segoe UI", 10),
        ).pack(anchor="w")
        noise_row = tk.Frame(right, bg=BG)
        noise_row.pack(fill="x", pady=(2, 10))
        tk.Label(noise_row, text="Strength", fg=MUTED, bg=BG, font=("Segoe UI", 9)).pack(side="left")
        tk.Scale(
            noise_row, from_=6, to=36, orient="horizontal", variable=self.noise_db, showvalue=1,
            bg=BG, fg=TEXT, troughcolor=CARD2, highlightthickness=0, sliderrelief="flat",
            activebackground=ACCENT, font=("Segoe UI", 8), command=lambda _v: self._update_info(),
        ).pack(side="left", fill="x", expand=True, padx=(8, 0))

        self._section(right, "Export")
        self._btn(right, "Preview 5s clip", self.preview_clip).pack(fill="x", pady=(2, 6))
        tk.Button(
            right, text="Export video", command=self.export, bg=ACCENT, fg="#042f2e",
            activebackground=ACCENT, activeforeground="#042f2e", relief="flat",
            font=("Segoe UI Semibold", 12), cursor="hand2", pady=10, bd=0,
        ).pack(fill="x")

        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(
            "Fast.Horizontal.TProgressbar", troughcolor=CARD2, background=ACCENT,
            bordercolor=CARD2, lightcolor=ACCENT, darkcolor=ACCENT, thickness=7,
        )
        bottom = tk.Frame(self, bg=BG)
        bottom.pack(fill="x", padx=16, pady=(4, 12))
        ttk.Progressbar(bottom, variable=self.progress, maximum=100, style="Fast.Horizontal.TProgressbar").pack(fill="x")
        tk.Label(bottom, textvariable=self.status, fg=TEXT, bg=BG, font=("Segoe UI", 9), anchor="w", justify="left", wraplength=1000).pack(fill="x", pady=(6, 0))
        tk.Label(bottom, textvariable=self.encoder_label, fg=MUTED, bg=BG, font=("Segoe UI", 8), anchor="w").pack(fill="x")

    def _section(self, parent: tk.Widget, title: str) -> None:
        tk.Label(parent, text=title.upper(), fg=ACCENT2, bg=BG, font=("Segoe UI Semibold", 9)).pack(anchor="w", pady=(10, 2))

    def _btn(self, parent: tk.Widget, text: str, cmd) -> tk.Button:
        return tk.Button(
            parent, text=text, command=cmd, bg=CARD2, fg=TEXT, activebackground=LINE,
            activeforeground=TEXT, relief="flat", font=("Segoe UI", 10), cursor="hand2", pady=7, bd=0,
        )

    def _detect_encoder(self) -> None:
        try:
            enc = pick_encoder()
            msg = f"Encoder: {enc.label} · originals are never overwritten"
        except Exception as exc:
            msg = str(exc)
        self.after(0, lambda: self.encoder_label.set(msg))

    # ---------- file loading ----------

    def _on_drop(self, paths: list[str]) -> None:
        vids = [p for p in paths if os.path.splitext(p)[1].lower() in VIDEO_EXTS and os.path.isfile(p)]
        if vids:
            self.load(vids[0])

    def open_file(self) -> None:
        if self.busy:
            return
        path = filedialog.askopenfilename(
            title="Choose video",
            filetypes=[("Video", "*.mp4 *.mov *.m4v *.mkv *.webm *.avi *.3gp *.mts *.m2ts *.wmv"), ("All files", "*.*")],
        )
        if path:
            self.load(path)

    def load(self, path: str) -> None:
        try:
            media = probe(path)
        except Exception as exc:
            messagebox.showerror("Video Editor", str(exc))
            return
        self.media = media
        self.deg = 0
        self.crop = None
        self.t = min(1.0, media.duration / 10 if media.duration else 0)
        self.seek.configure(to=max(media.duration, 0.1))
        self.seek.set(self.t)
        self.name_label.configure(text=f"{os.path.basename(path)}  ·  {media.display_w}×{media.display_h}  ·  {fmt_duration(media.duration)}")
        self.status.set("Ready. Rotate, crop, pick a canvas, then Export.")
        self._update_info()
        self._render_preview()

    # ---------- geometry helpers ----------

    def rot_dims(self) -> tuple[int, int]:
        assert self.media
        w, h = self.media.display_w, self.media.display_h
        return (h, w) if self.deg in (90, 270) else (w, h)

    def content_dims(self) -> tuple[int, int]:
        if self.crop:
            return self.crop[2], self.crop[3]
        return self.rot_dims()

    def out_dims(self) -> tuple[int, int]:
        w, h = self.content_dims()
        mode = self.canvas_mode.get()
        if mode in CANVAS_RATIO:
            return pad_dims(w, h, CANVAS_RATIO[mode])
        return even(w), even(h)

    def build_vf(self, final: bool) -> str:
        parts: list[str] = []
        if self.deg:
            parts.append(filter_for(self.deg))
        if self.crop:
            x, y, w, h = self.crop
            parts.append(f"crop={w}:{h}:{x}:{y}")
        mode = self.canvas_mode.get()
        if mode in CANVAS_RATIO:
            cw, ch = self.content_dims()
            ow, oh = pad_dims(cw, ch, CANVAS_RATIO[mode])
            if (ow, oh) != (cw, ch):
                parts.append(f"pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2:color=black")
        if final:
            parts.append("scale=trunc(iw/2)*2:trunc(ih/2)*2")
            parts.append("setsar=1")
        return ",".join(parts)

    def build_af(self) -> str | None:
        if self.noise_on.get():
            return f"afftdn=nr={self.noise_db.get()}:nf=-25"
        return None

    # ---------- preview ----------

    def _on_seek(self, value: str) -> None:
        try:
            self.t = float(value)
        except ValueError:
            return
        if self.media:
            self.time_label.configure(text=f"{fmt_duration(self.t)} / {fmt_duration(self.media.duration)}")
        self._schedule_seek_render(180)

    def _schedule_seek_render(self, delay: int) -> None:
        if self._seek_job:
            self.after_cancel(self._seek_job)
        self._seek_job = self.after(delay, self._render_preview)

    def _render_preview(self) -> None:
        self._seek_job = None
        if not self.media:
            return
        self._preview_token += 1
        token = self._preview_token
        cw = max(self.canvas.winfo_width(), 200) - self.PREVIEW_PAD * 2
        ch = max(self.canvas.winfo_height(), 200) - self.PREVIEW_PAD * 2
        vf = self.build_vf(final=False) if self.show_result.get() else (filter_for(self.deg) if self.deg else "")
        src, t = self.media.path, self.t

        def work() -> None:
            try:
                png = grab_frame_png(src, t, vf, cw, ch)
            except Exception as exc:
                self.after(0, lambda: self.status.set(f"Preview: {exc}"))
                return
            data = base64.b64encode(png).decode("ascii")
            self.after(0, lambda: self._show_frame(token, data))

        threading.Thread(target=work, daemon=True).start()

    def _show_frame(self, token: int, data: str) -> None:
        if token != self._preview_token:
            return
        try:
            img = tk.PhotoImage(data=data)
        except tk.TclError:
            return
        self._img = img
        cw, ch = self.canvas.winfo_width(), self.canvas.winfo_height()
        iw, ih = img.width(), img.height()
        ox, oy = (cw - iw) // 2, (ch - ih) // 2
        self._img_box = (ox, oy, iw, ih)
        self.canvas.delete("all")
        self.canvas.create_image(ox, oy, image=img, anchor="nw")
        self._draw_overlay()

    def _draw_overlay(self, temp_rect: tuple[float, float, float, float] | None = None) -> None:
        self.canvas.delete("overlay")
        if self.show_result.get() or not self.media:
            return
        ox, oy, iw, ih = self._img_box
        if iw <= 0:
            return
        rect = temp_rect
        if rect is None and self.crop:
            rw, _rh = self.rot_dims()
            s = iw / rw
            x, y, w, h = self.crop
            rect = (ox + x * s, oy + y * s, ox + (x + w) * s, oy + (y + h) * s)
        if rect is None:
            return
        x0, y0, x1, y1 = rect
        kw = {"fill": "#000000", "stipple": "gray50", "outline": "", "tags": "overlay"}
        self.canvas.create_rectangle(ox, oy, ox + iw, y0, **kw)
        self.canvas.create_rectangle(ox, y1, ox + iw, oy + ih, **kw)
        self.canvas.create_rectangle(ox, y0, x0, y1, **kw)
        self.canvas.create_rectangle(x1, y0, ox + iw, y1, **kw)
        self.canvas.create_rectangle(x0, y0, x1, y1, outline=ACCENT, width=2, tags="overlay")

    # ---------- crop interaction ----------

    def _crop_press(self, e: tk.Event) -> None:
        if not self.media or self.show_result.get() or self.busy:
            return
        ox, oy, iw, ih = self._img_box
        if iw <= 0 or not (ox <= e.x <= ox + iw and oy <= e.y <= oy + ih):
            self._drag = None
            return
        mode = "draw"
        anchor = (e.x, e.y)
        if self.crop:
            rw, _ = self.rot_dims()
            s = iw / rw
            x, y, w, h = self.crop
            px0, py0, px1, py1 = ox + x * s, oy + y * s, ox + (x + w) * s, oy + (y + h) * s
            if px0 <= e.x <= px1 and py0 <= e.y <= py1:
                mode = "move"
                anchor = (e.x - px0, e.y - py0)
        self._drag = {"mode": mode, "anchor": anchor, "cur": (e.x, e.y)}

    def _crop_drag(self, e: tk.Event) -> None:
        if not self._drag:
            return
        ox, oy, iw, ih = self._img_box
        x = min(max(e.x, ox), ox + iw)
        y = min(max(e.y, oy), oy + ih)
        self._drag["cur"] = (x, y)
        if self._drag["mode"] == "draw":
            ax, ay = self._drag["anchor"]
            self._draw_overlay((min(ax, x), min(ay, y), max(ax, x), max(ay, y)))
        else:
            rw, _ = self.rot_dims()
            s = iw / rw
            _, _, w, h = self.crop  # type: ignore[misc]
            pw, ph = w * s, h * s
            axo, ayo = self._drag["anchor"]
            nx0 = min(max(x - axo, ox), ox + iw - pw)
            ny0 = min(max(y - ayo, oy), oy + ih - ph)
            self._draw_overlay((nx0, ny0, nx0 + pw, ny0 + ph))

    def _crop_release(self, e: tk.Event) -> None:
        drag = self._drag
        self._drag = None
        if not drag or not self.media:
            return
        ox, oy, iw, ih = self._img_box
        rw, rh = self.rot_dims()
        s = iw / rw
        x, y = drag["cur"]
        if drag["mode"] == "draw":
            ax, ay = drag["anchor"]
            if abs(x - ax) < 6 and abs(y - ay) < 6:
                self._draw_overlay()
                return
            x0, y0 = min(ax, x), min(ay, y)
            x1, y1 = max(ax, x), max(ay, y)
            cx, cy = (x0 - ox) / s, (y0 - oy) / s
            cw_, ch_ = (x1 - x0) / s, (y1 - y0) / s
        else:
            _, _, w, h = self.crop  # type: ignore[misc]
            pw, ph = w * s, h * s
            axo, ayo = drag["anchor"]
            nx0 = min(max(x - axo, ox), ox + iw - pw)
            ny0 = min(max(y - ayo, oy), oy + ih - ph)
            cx, cy = (nx0 - ox) / s, (ny0 - oy) / s
            cw_, ch_ = w, h
        cx = max(0, min(int(cx) // 2 * 2, rw - 16))
        cy = max(0, min(int(cy) // 2 * 2, rh - 16))
        w2 = max(16, even(min(cw_, rw - cx)))
        h2 = max(16, even(min(ch_, rh - cy)))
        self.crop = (cx, cy, w2, h2)
        self._update_info()
        self._draw_overlay()

    def reset_crop(self) -> None:
        self.crop = None
        self._update_info()
        if self.show_result.get():
            self._render_preview()
        else:
            self._draw_overlay()

    # ---------- edits ----------

    def rotate(self, delta: int) -> None:
        if not self.media:
            return
        self.deg = (self.deg + delta) % 360
        self.crop = None
        self._update_info()
        self._render_preview()

    def rotate_canvas(self) -> None:
        """Swap the canvas orientation (16:9 ↔ 9:16, 4:3 ↔ 3:4)."""
        flip = {"16:9": "9:16", "9:16": "16:9", "4:3": "3:4", "3:4": "4:3", "1:1": "1:1"}
        mode = self.canvas_mode.get()
        if mode == "auto":
            w, h = self.content_dims() if self.media else (16, 9)
            self.canvas_mode.set("9:16" if w >= h else "16:9")
        else:
            self.canvas_mode.set(flip[mode])
        self._on_canvas_mode()

    def _on_canvas_mode(self) -> None:
        self._update_info()
        if self.show_result.get():
            self._render_preview()

    def _update_info(self) -> None:
        if not self.media:
            self.info.set("")
            return
        ow, oh = self.out_dims()
        bits = [f"Output {ow}×{oh}"]
        if self.deg:
            bits.append(f"video rotated {self.deg}°")
        if self.crop:
            bits.append(f"crop {self.crop[2]}×{self.crop[3]}")
        if self.canvas_mode.get() != "auto":
            bits.append(f"canvas {self.canvas_mode.get()}")
        if self.noise_on.get():
            bits.append(f"noise removal {self.noise_db.get()} dB")
        self.info.set("  ·  ".join(bits))

    # ---------- processing ----------

    def _run_job(self, dest: str, duration: float, extra_in: list[str] | None, open_result: bool) -> None:
        assert self.media
        self.busy = True
        self.progress.set(0)
        self.status.set("Processing…")
        vf = self.build_vf(final=True)
        af = self.build_af()
        src = self.media.path
        progress_q: queue.Queue = queue.Queue()

        def pump() -> None:
            latest = None
            while True:
                try:
                    latest = progress_q.get_nowait()
                except queue.Empty:
                    break
            if latest is not None:
                self.progress.set(latest * 100)
            if self.busy:
                self.after(100, pump)

        self.after(0, pump)

        def work() -> None:
            started = time.perf_counter()
            try:
                encoder = pick_encoder()
                used = transcode_with_fallback(src, dest, vf, encoder, duration, progress_q, af, extra_in)
                elapsed = time.perf_counter() - started
                self.after(0, lambda: self._job_done(dest, elapsed, used.label, open_result))
            except Exception as exc:
                self.after(0, lambda: self._job_fail(str(exc)))

        threading.Thread(target=work, daemon=True).start()

    def _job_done(self, dest: str, elapsed: float, enc_label: str, open_result: bool) -> None:
        self.busy = False
        self.progress.set(100)
        self.status.set(f"Done in {elapsed:.1f}s → {dest}")
        self.encoder_label.set(f"Encoder: {enc_label} · originals are never overwritten")
        if open_result:
            self._try(os.startfile, dest)  # type: ignore[attr-defined]
        else:
            self._try(os.startfile, os.path.dirname(dest))  # type: ignore[attr-defined]

    def _job_fail(self, message: str) -> None:
        self.busy = False
        self.status.set(message)
        messagebox.showerror("Video Editor", message)

    def export(self) -> None:
        if not self.media or self.busy:
            return
        stem = os.path.splitext(self.media.path)[0]
        dest = unique_path(stem + "_edited.mp4")
        self._run_job(dest, self.media.duration, None, open_result=False)

    def preview_clip(self) -> None:
        """Render 5 seconds from the current position and open it — quick check for noise removal etc."""
        if not self.media or self.busy:
            return
        stem = os.path.splitext(self.media.path)[0]
        dest = unique_path(stem + "_preview5s.mp4")
        start = max(0.0, min(self.t, max(self.media.duration - 5, 0)))
        self._run_job(dest, min(5.0, self.media.duration or 5.0), ["-ss", f"{start:.3f}", "-t", "5"], open_result=True)


def main() -> int:
    if os.name == "nt":
        try:
            import ctypes

            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    app = Editor()
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        app.after(100, lambda: app.load(sys.argv[1]))
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
