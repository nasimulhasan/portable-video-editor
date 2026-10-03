@echo off
cd /d "%~dp0"
set VE_NO_BROWSER=1
py -3 -c "import webview" 2>nul
if errorlevel 1 (
  echo Installing pywebview...
  py -3 -m pip install -r "%~dp0requirements.txt"
)
py -3 "%~dp0host.py"
