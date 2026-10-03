# Portable Video Editor

A CapCut-style video editor for Windows that runs fully offline. The UI is plain HTML/JS in a WebView2 window; a small Python server drives FFmpeg for previews and export. Nothing is uploaded anywhere.

## Download (no install)

1. Go to [Releases](../../releases/latest) and download `VideoEditor-portable-win64.zip`.
2. Extract it anywhere (keep the whole `VideoEditor` folder together).
3. Double-click `VideoEditor.exe`.

The ZIP already contains everything: embeddable Python, pywebview, and a full FFmpeg build. It only needs the Microsoft Edge **WebView2 Runtime**, which ships with Windows 10/11.

## Features

- Multi-track timeline: video tracks, overlay (picture-in-picture) tracks, music, text, shapes, images, subtitles
- Drag a video onto the Overlay lane (or use **Use as overlay**) to turn it into picture-in-picture
- Free layout: move, resize, crop-to-fill, rotate, flip, rounded corners
- Speed 0.25×–4×, fades, volume, denoise, auto-cut silence
- Color adjustments, LUTs (`luts/`), saveable presets
- Multi-line text with line-gap control, custom fonts, Bengali/complex scripts
- SRT import, subtitle styling
- Drag-and-drop import from Explorer, screenshot-to-media, undo/redo

## Run from source

Requirements:

- Windows 10/11
- Python 3.10+
- FFmpeg + FFprobe — either put `ffmpeg.exe` and `ffprobe.exe` in a `bin\` folder at the repo root, or install them on PATH (`winget install Gyan.FFmpeg`)

```bat
pip install -r requirements.txt

:: browser UI
run.cmd

:: desktop window (WebView2)
portable\run-dev.cmd
```

## Build the portable folder yourself

```bat
powershell -ExecutionPolicy Bypass -File portable\build.ps1
```

Output goes to `portable\dist\VideoEditor\`. The script downloads embeddable Python and the full FFmpeg build (7-Zip helps extract it). See [portable/README.md](portable/README.md).

## Project layout

| Path | Purpose |
|------|---------|
| `server.py` | Local HTTP server: media import, previews, FFmpeg export |
| `app.py` | FFmpeg helpers |
| `static/` | Editor UI (`index.html`, `app.js`, `style.css`) |
| `luts/` | Bundled `.cube` color LUTs |
| `portable/` | WebView2 host, launcher EXE, build script, icons |

## Third-party

The release ZIP bundles a full FFmpeg build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), licensed under the GPL. FFmpeg source code is available at [ffmpeg.org](https://ffmpeg.org/download.html).
