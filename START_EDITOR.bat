@echo off
rem Double-click to open the Translation Editor for the Chained Echoes project.
rem Keep this window open while you work; close it to stop the editor.
cd /d "%~dp0"
python translator.py projects\chained-echoes.json
if errorlevel 1 pause
