@echo off
chcp 65001 >nul
title Fix Tunnel DNS
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "tools\fix-tunnel-dns.ps1"
pause >nul
