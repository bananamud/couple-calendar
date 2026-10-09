@echo off
chcp 65001 >nul
title Make Package
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "tools\launch.ps1" -Package
