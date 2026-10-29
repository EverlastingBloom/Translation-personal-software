@echo off
rem Double-click to open the Translation Editor in your browser.
rem Keep this window open while you work; close it to stop the editor.
cd /d "%~dp0"
python translator.py
if errorlevel 1 pause
