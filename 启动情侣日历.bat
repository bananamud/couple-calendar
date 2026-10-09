@echo off
chcp 65001 >nul
title Couple Calendar
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "tools\launch.ps1"
pause >nul
