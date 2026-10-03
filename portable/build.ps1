# Build a portable Windows Video Editor (WebView2 window + full FFmpeg).
# Output: portable\dist\VideoEditor\
#
# Requirements to run this script:
#   - PowerShell 5+
#   - Internet (downloads embeddable Python + FFmpeg full build)
#   - WebView2 Runtime (usually already on Windows 10/11)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File portable\build.ps1

$ErrorActionPreference = "Stop"

$PortableRoot = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $PortableRoot
$Out = Join-Path $PortableRoot "dist\VideoEditor"
$Temp = Join-Path $PortableRoot "_build_tmp"

$PythonVer = "3.12.8"
$PythonZip = "python-$PythonVer-embed-amd64.zip"
$PythonUrl = "https://www.python.org/ftp/python/$PythonVer/$PythonZip"
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"
# Full static build (ffmpeg.exe + ffprobe.exe)
$FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

function Ensure-Dir($p) {
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null }
}

function Download-File($Url, $Dest) {
  if (Test-Path $Dest) {
    Write-Host "    already have $(Split-Path $Dest -Leaf)"
    return
  }
  Write-Host "    downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
}

Write-Step "Preparing folders"
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
Ensure-Dir $Out
Ensure-Dir $Temp
Ensure-Dir (Join-Path $Out "bin")
Ensure-Dir (Join-Path $Out "python")
Ensure-Dir (Join-Path $Out "static")
Ensure-Dir (Join-Path $Out "luts")

Write-Step "Copying app files"
$copyFiles = @("server.py", "app.py", "editor.py")
foreach ($f in $copyFiles) {
  $src = Join-Path $ProjectRoot $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $Out $f) -Force }
}
Copy-Item (Join-Path $PortableRoot "host.py") (Join-Path $Out "host.py") -Force
Copy-Item (Join-Path $ProjectRoot "static\*") (Join-Path $Out "static") -Recurse -Force
if (Test-Path (Join-Path $ProjectRoot "luts")) {
  Copy-Item (Join-Path $ProjectRoot "luts\*") (Join-Path $Out "luts") -Recurse -Force
}

Write-Step "Fetching embeddable Python $PythonVer"
$pyZipPath = Join-Path $Temp $PythonZip
Download-File $PythonUrl $pyZipPath
Expand-Archive -Path $pyZipPath -DestinationPath (Join-Path $Out "python") -Force

# Allow pip / site-packages imports
$pth = Get-ChildItem (Join-Path $Out "python") -Filter "python*._pth" | Select-Object -First 1
if (-not $pth) { throw "python*._pth not found in embeddable package" }
$zipName = (Get-ChildItem (Join-Path $Out "python") -Filter "python*.zip" | Select-Object -First 1).Name
$pthText = @"
$zipName
.
Lib\site-packages
import site
"@
Set-Content -Path $pth.FullName -Value $pthText -Encoding ASCII

Write-Step "Installing pip + pywebview into portable Python"
$pyExe = Join-Path $Out "python\python.exe"
$getPip = Join-Path $Temp "get-pip.py"
Download-File $GetPipUrl $getPip
& $pyExe $getPip --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw "get-pip failed" }
# Embeddable Python needs setuptools/wheel before packages that build from sdist
& $pyExe -m pip install --no-warn-script-location --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) { throw "pip install setuptools failed" }
& $pyExe -m pip install --no-warn-script-location -r (Join-Path $PortableRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install pywebview failed" }

Write-Step "Bundling FFmpeg (full build)"
$ff7z = Join-Path $Temp "ffmpeg-release-full.7z"
$ffExtract = Join-Path $Temp "ffmpeg_extract"
Download-File $FfmpegUrl $ff7z

# Prefer system 7z / tar; fall back to Expand-Archive won't work for 7z
$extracted = $false
$sevenZip = @(
  "${env:ProgramFiles}\7-Zip\7z.exe",
  "${env:ProgramFiles(x86)}\7-Zip\7z.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($sevenZip) {
  Ensure-Dir $ffExtract
  & $sevenZip x -y "-o$ffExtract" $ff7z | Out-Null
  $extracted = $true
} else {
  # Try winget-installed FFmpeg full build on this machine
  $wingetFf = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "full_build|ffmpeg" } |
    Select-Object -First 1
  if ($wingetFf) {
    Write-Host "    using local winget FFmpeg: $($wingetFf.DirectoryName)"
    Copy-Item (Join-Path $wingetFf.DirectoryName "ffmpeg.exe") (Join-Path $Out "bin\ffmpeg.exe") -Force
    $probe = Join-Path $wingetFf.DirectoryName "ffprobe.exe"
    if (Test-Path $probe) { Copy-Item $probe (Join-Path $Out "bin\ffprobe.exe") -Force }
    $extracted = $false
  } else {
    throw "Need 7-Zip to extract FFmpeg full.7z, or install FFmpeg via winget first.`nInstall 7-Zip, then re-run this script."
  }
}

if ($extracted) {
  $ffBin = Get-ChildItem $ffExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
  if (-not $ffBin) { throw "ffmpeg.exe not found inside archive" }
  Copy-Item $ffBin.FullName (Join-Path $Out "bin\ffmpeg.exe") -Force
  $probeSrc = Join-Path $ffBin.DirectoryName "ffprobe.exe"
  if (Test-Path $probeSrc) {
    Copy-Item $probeSrc (Join-Path $Out "bin\ffprobe.exe") -Force
  }
}

if (-not (Test-Path (Join-Path $Out "bin\ffmpeg.exe"))) {
  throw "bin\ffmpeg.exe missing after bundling step"
}

Write-Step "Writing launchers"
Copy-Item (Join-Path $PortableRoot "launcher.py") (Join-Path $Out "launcher.py") -Force
$cmd = @"
@echo off
cd /d "%~dp0"
set VE_NO_BROWSER=1
set PYTHONUTF8=1
set VE_APP_ID=Local.VideoEditor.App
set VE_LAUNCHER_EXE=%~dp0VideoEditor.exe
if exist "%~dp0python\VideoEditorHost.exe" (
  "%~dp0python\VideoEditorHost.exe" "%~dp0host.py"
) else (
  "%~dp0python\pythonw.exe" "%~dp0host.py"
)
"@
Set-Content -Path (Join-Path $Out "VideoEditor.cmd") -Value $cmd -Encoding ASCII

# Optional: double-clickable VBS with no console flash (waits so a pin stays alive)
$vbs = @"
Set sh = CreateObject("WScript.Shell")
Dim root: root = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root
sh.Environment("Process")("VE_NO_BROWSER") = "1"
sh.Environment("Process")("PYTHONUTF8") = "1"
sh.Environment("Process")("VE_APP_ID") = "Local.VideoEditor.App"
sh.Environment("Process")("VE_LAUNCHER_EXE") = root & "\VideoEditor.exe"
Dim hostExe: hostExe = root & "\python\VideoEditorHost.exe"
If Not CreateObject("Scripting.FileSystemObject").FileExists(hostExe) Then hostExe = root & "\python\pythonw.exe"
sh.Run """" & hostExe & """ """ & root & "\host.py""", 0, True
"@
Set-Content -Path (Join-Path $Out "VideoEditor.vbs") -Value $vbs -Encoding ASCII

Write-Step "Branding host EXE icon (so pins are not Python)"
& $pyExe -m pip install --no-warn-script-location pywin32
$rcedit = Join-Path $Temp "rcedit-x64.exe"
if (-not (Test-Path $rcedit)) {
  Download-File "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe" $rcedit
}
$hostExe = Join-Path $Out "python\VideoEditorHost.exe"
Copy-Item (Join-Path $Out "python\pythonw.exe") $hostExe -Force
$iconSrc = Join-Path $PortableRoot "icons\app.ico"
if (Test-Path $iconSrc) {
  & $rcedit $hostExe --set-icon $iconSrc
}

Write-Step "Building VideoEditor.exe (no console)"
& $pyExe -m pip install --no-warn-script-location pyinstaller
if ($LASTEXITCODE -ne 0) { throw "pip install pyinstaller failed" }
$launchWork = Join-Path $Temp "launcher_build"
if (Test-Path $launchWork) { Remove-Item -Recurse -Force $launchWork }
Ensure-Dir $launchWork
Push-Location $launchWork
try {
  & $pyExe -m PyInstaller `
    --noconfirm --clean --onefile --noconsole `
    --name VideoEditor `
    --icon (Join-Path $PortableRoot "icons\app.ico") `
    --distpath $Out `
    --workpath (Join-Path $launchWork "work") `
    --specpath $launchWork `
    (Join-Path $PortableRoot "launcher.py")
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
  # Keep icon next to the EXE for runtime window branding
  if (Test-Path $iconSrc) {
    Copy-Item $iconSrc (Join-Path $Out "app.ico") -Force
  }
  # Pin-friendly shortcut
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path $Out "Video Editor.lnk"))
  $lnk.TargetPath = Join-Path $Out "VideoEditor.exe"
  $lnk.WorkingDirectory = $Out
  $lnk.IconLocation = (Join-Path $Out "VideoEditor.exe") + ",0"
  $lnk.Description = "Video Editor"
  $lnk.Save()
} finally {
  Pop-Location
}

$readme = @"
Video Editor — portable Windows build
=====================================

Double-click VideoEditor.exe to start.

Taskbar pin:
  1. Unpin any old Python icon from the taskbar.
  2. Start VideoEditor.exe, wait for the window, THEN pin from the taskbar
     (or right-click VideoEditor.exe / "Video Editor.lnk" → Pin to taskbar).
  The pin should show the clapperboard icon and reopen VideoEditor.exe.

Needs Microsoft Edge WebView2 Runtime (included with Windows 10/11).
FFmpeg full build is in bin\.
All data stays on this PC; nothing is uploaded.

Folder size is large because of the full FFmpeg build (~400–500 MB).
Keep this whole folder together — the .exe is a launcher for the files beside it.
"@
Set-Content -Path (Join-Path $Out "README.txt") -Value $readme -Encoding UTF8

Write-Step "Done"
Write-Host "Portable app: $Out"
Write-Host "Launch with:  $Out\VideoEditor.exe"
$size = (Get-ChildItem $Out -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("Approximate size: {0:N1} MB" -f ($size / 1MB))
