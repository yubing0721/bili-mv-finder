@echo off
chcp 65001 >nul
title 寻影姬 BiliTune

rem ─────────────────────────────────────────────────────────────
rem  如果环境里带着 ELECTRON_RUN_AS_NODE，Electron 会以纯 Node 模式启动而崩溃。
rem  main.js 里有自愈逻辑（会重新拉起自己），这里再显式清一次，双保险。
rem ─────────────────────────────────────────────────────────────
set ELECTRON_RUN_AS_NODE=

cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   首次运行，正在安装依赖（约 120MB，请稍候）...
  echo.
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   依赖安装失败。请确认已安装 Node.js 后重试。
    echo.
    pause
    exit /b 1
  )
  rem npm 11 的 allow-scripts 可能拦截 electron 的下载脚本，这里补一次
  if not exist "node_modules\electron\dist\electron.exe" (
    if exist "node_modules\electron\install.js" (
      echo   正在补齐 Electron 运行时...
      node "node_modules\electron\install.js"
    )
  )
)

start "" "node_modules\electron\dist\electron.exe" .
