@echo off
cd /d "%~dp0"
set HTTP_ONLY=1
echo.
echo   微光护老 · 自动重启版
echo.
echo   改完 server.js 会自动重启，不用再手动关窗口。
echo   启动后请不要关闭这个窗口。按 Ctrl + C 可停止。
echo.
node watch-server.js
echo.
echo   服务已停止。
pause
