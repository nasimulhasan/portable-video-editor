# Portable Windows Video Editor (WebView2 window)

## Quick test (dev)

From the repo, with Python already installed:

```bat
portable\run-dev.cmd
```

This starts the editor in its own window (not a browser tab).

## Build a shareable portable folder

```bat
powershell -ExecutionPolicy Bypass -File portable\build.ps1
```

Output: `portable\dist\VideoEditor\`

Double-click **`VideoEditor.exe`** to start (WebView window).

That folder is self-contained:

| Path | Purpose |
|------|---------|
| `VideoEditor.exe` | App launcher (no console) |
| `VideoEditor.cmd` / `.vbs` | Alternate launchers |
| `host.py` | WebView2 shell |
| `server.py`, `app.py`, `static\`, `luts\` | Editor |
| `python\` | Embeddable Python + pywebview |
| `bin\ffmpeg.exe`, `bin\ffprobe.exe` | Full FFmpeg build |

Copy the whole `VideoEditor` folder to another PC and run `VideoEditor.exe`.

### Notes

- Requires **WebView2 Runtime** (normal on Win10/11).
- Build downloads Python embeddable + FFmpeg full (~large). 7-Zip helps extract FFmpeg; if missing, the script can reuse a winget-installed FFmpeg.
- Expected size on disk: about **450–550 MB** with full FFmpeg.
