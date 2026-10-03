@echo off
cd /d "%~dp0"
py -3 "%~dp0server.py" 2>nul || python "%~dp0server.py"
