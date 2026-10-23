@echo off
chcp 65001 >nul
cd /d %~dp0..\..
title 智慧树自动刷课 · 控制台
node tools\auto-study\src\console.mjs
echo.
pause
