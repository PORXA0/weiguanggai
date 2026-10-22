@echo off
chcp 65001 >nul
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   请先关掉这个窗口，然后右键这个文件，
  echo   选择「以管理员身份运行」。
  echo.
  pause
  exit /b
)

echo.
echo   正在放行 8080 端口，让手机可以访问...
echo.
netsh advfirewall firewall delete rule name="微光护老服务" >nul 2>&1
netsh advfirewall firewall add rule name="微光护老服务" dir=in action=allow protocol=TCP localport=8080
echo.
echo   ------------------------------------------------
echo    做好了。手机现在应该可以打开：
echo    http://电脑的IP:8080
echo   ------------------------------------------------
echo.
pause
