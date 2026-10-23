@echo off
rem ===== Tsukiyo no Word Wolf : stop the game server =====
taskkill /FI "WINDOWTITLE eq WordWolf-Server*" /T /F >nul 2>nul
echo The game server has been stopped.
echo (If the game screen is still open, press Alt+F4 to close it.)
timeout /t 3 >nul
