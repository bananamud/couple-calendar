@echo off
chcp 65001 >nul
title Couple Calendar (public share)
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "tools\launch.ps1" -Share
pause >nul
