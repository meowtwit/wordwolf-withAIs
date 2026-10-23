@echo off
rem ===== Tsukiyo no Word Wolf : start the game (full screen) =====
setlocal
cd /d "%~dp0"

set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] node\node.exe was not found.
    echo Extract the whole ZIP file first, then run this file again.
    pause
    exit /b 1
  )
  set "NODE=node"
)

rem --- Start the game server if it is not running yet ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:3000/api/health | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "WordWolf-Server" /min "%NODE%" "%~dp0server.js"
)

rem --- Wait until the server answers (up to 20 seconds) ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "for ($i = 0; $i -lt 40; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:3000/api/health | Out-Null; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
if errorlevel 1 (
  echo [ERROR] The game server did not start.
  echo Open the "WordWolf-Server" window on the taskbar to see the error.
  pause
  exit /b 1
)

rem --- Open the game in full screen (Microsoft Edge kiosk mode). Close it with Alt+F4. ---
start "" msedge --kiosk "http://localhost:3000/" --edge-kiosk-type=fullscreen --no-first-run --user-data-dir="%~dp0data\edge-kiosk"
if errorlevel 1 start "" "http://localhost:3000/"
exit /b 0
