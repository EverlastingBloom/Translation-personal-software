@echo off
rem Double-click to open the Translation Editor AND let teammates on the same Wi-Fi / network join.
rem The window shows a link to send them. Keep it open while you work; close it to stop the editor.
cd /d "%~dp0"
python translator.py --share
if errorlevel 1 pause
