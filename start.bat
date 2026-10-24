@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js。请安装 Node.js 20 或更高版本后重新运行。
  pause
  exit /b 1
)

if not exist "node_modules\ws\package.json" (
  echo 正在安装运行依赖...
  call npm.cmd install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo.
echo 正在启动微光护老，请保持此窗口开启。
echo.
node server.js
echo.
echo 服务已停止。
pause
