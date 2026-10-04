# Portable Video Editor

A CapCut-style video editor for Windows that runs fully offline. The UI is plain HTML/JS in a WebView2 window; a small Python server drives FFmpeg for previews and export. Nothing is uploaded anywhere.

## Download and install

No installer and nothing else to set up. Python and FFmpeg are already inside the download.

1. Go to the [latest release](../../releases/latest) and download **`VideoEditor-portable-win64.zip`** (about 250 MB).
2. Right-click the ZIP, choose **Extract All…**, and pick a location, for example your Desktop or `D:\Apps`. Don't run it from inside the ZIP.
3. Open the extracted `VideoEditor` folder and double-click **`VideoEditor.exe`**.
4. The first time, Windows may show **"Windows protected your PC"**. This happens because the app isn't code-signed. Click **More info**, then **Run anyway**. You'll only see this once.
5. Optional: once the window is open, right-click its taskbar icon and choose **Pin to taskbar**.

Good to know:

- Works offline. Your videos stay on your PC and nothing is uploaded.
- Keep the whole `VideoEditor` folder together. `VideoEditor.exe` starts the files beside it, so copying the `.exe` on its own won't work.
- To uninstall, delete the folder.
- Requires Windows 10/11 with the Microsoft Edge **WebView2 Runtime**, which Windows already includes.

## How to use

### 1. Import your media

Click **+ Import** in the media panel on the left, or drag files from File Explorer into the window. Video, audio, images, and `.srt` subtitle files are supported.

### 2. Put clips on the timeline

Drag items from the media panel onto the timeline at the bottom, or click **Add** on a media card.

- **Picture-in-picture:** click a video's **Overlay** button, or drag a clip onto the **Overlay** lane. To turn a clip that's already on the timeline into an overlay, select it and click **Use as overlay**.
- Clips can sit on several tracks, and you can leave gaps between them.

### 3. Edit

- **Settings:** click any item and its options appear in the right panel: size, position, speed, volume, fades, color adjustments, LUTs, and more.
- **Move and resize:** drag the item on the preview. Side handles stretch, corners keep the shape, and the top handle rotates.
- **Trim:** drag the left or right edge of a block on the timeline.
- **Text and shapes:** use **+ Text** and **+ Shape** in the top bar. Text can span several lines (press Enter), and the **Line gap** slider sets the spacing between lines.
- **Timeline tools** (buttons above the timeline): split at the playhead, duplicate, delete, and screenshot the current frame into your media.

### 4. Preview

Press **Space** to play or pause. Click anywhere on the timeline to jump to that point.

### 5. Export

Click **Export** in the top-right, choose your settings, then **Choose location & export…**. The finished video is saved where you choose.

### 6. Save your project

**💾 Save** stores your edit as a project file so you can keep working later. **📂 Open** reopens it.

### Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Play / pause | Space |
| Split at playhead | S |
| Delete selected | Del |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Duplicate | Ctrl+D |
| Copy / paste | Ctrl+C / Ctrl+V |
| Save project | Ctrl+S |

## Troubleshooting

- **"Windows protected your PC":** click **More info**, then **Run anyway**. The app is safe; it just isn't code-signed.
- **The app doesn't open:** make sure you extracted the ZIP first and are running `VideoEditor.exe` from inside the extracted `VideoEditor` folder.
- **A blank or white window:** install the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/), then start the app again.
- **The taskbar pin shows a Python icon:** unpin it, start `VideoEditor.exe`, wait for the window, and pin it again.

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
