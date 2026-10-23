@echo off
chcp 65001 >nul
cd /d %~dp0..\..
echo ==========================================
echo   智慧树自动刷课
echo ==========================================
echo.
echo  1. 只刷一门课（职业生涯规划）
echo  2. 全部课程排队刷（6 门，含智慧课程）
echo  3. 先看课程队列
echo  4. 停止当前任务
echo  5. 关闭独立 Edge 浏览器
echo  6. 无人值守模式（全部课程 + 卡死自动重启）
echo.
set /p choice=请选择 [1-6]: 

if "%choice%"=="1" node tools\auto-study\src\cli.mjs watch --course 职业生涯规划
if "%choice%"=="2" node tools\auto-study\src\cli.mjs watch
if "%choice%"=="3" node tools\auto-study\src\cli.mjs queue
if "%choice%"=="4" node tools\auto-study\src\cli.mjs stop
if "%choice%"=="5" node tools\auto-study\src\cli.mjs shutdown
if "%choice%"=="6" node tools\auto-study\src\supervisor.mjs watch
echo.
pause
