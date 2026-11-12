@echo off
setlocal
title ChatKeepsake
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 请安装 Node.js 24 LTS 的 Windows x64 版
  echo https://nodejs.org/en/download
  echo 安装完成后关闭此窗口，再双击启动 ChatKeepsake。
  pause
  exit /b 1
)
node.exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo 请更新到 Node.js 24 LTS，再双击启动 ChatKeepsake。
  pause
  exit /b 1
)
node.exe "%~dp0server.js"
if errorlevel 1 (
  echo.
  echo ChatKeepsake 没能打开，请查看上面的提示。
  pause
  exit /b 1
)
