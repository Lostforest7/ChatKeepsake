@echo off
setlocal DisableDelayedExpansion
title ChatKeepsake
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0app\" goto portable
if not exist "%~dp0server.js" goto incomplete

node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>nul
if not "%errorlevel%"=="0" goto source
set "CHATKEEPSAKE_NODE_EXE=node.exe"
set "CHATKEEPSAKE_ENTRY=%~dp0server.js"
goto launch

:portable
if not exist "%~dp0app\node.exe" goto incomplete
if not exist "%~dp0app\server.js" goto incomplete
set "NODE_OPTIONS="
set "NODE_PATH="
set "CHATKEEPSAKE_NODE_EXE=%~dp0app\node.exe"
set "CHATKEEPSAKE_ENTRY=%~dp0app\server.js"

:launch
"%CHATKEEPSAKE_NODE_EXE%" "%CHATKEEPSAKE_ENTRY%"
if "%errorlevel%"=="0" exit /b 0
echo.
echo ChatKeepsake 没能打开，请查看上面的提示。
pause
exit /b 1

:source
echo 你打开的是源码版。请到项目首页点击「下载 Windows 免安装版」。
echo https://github.com/Lostforest7/ChatKeepsake
pause
exit /b 1

:incomplete
echo 程序文件不完整。请右键下载的 ZIP，选择「全部解压缩」，再双击启动文件。
pause
exit /b 1
