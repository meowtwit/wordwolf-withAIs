@echo off
rem ===== Tsukiyo no Word Wolf : open the admin page =====
setlocal
cd /d "%~dp0"

set "PORT=3939"
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

rem --- Is this game's server already running? (0 = yes, 1 = nothing there, 2 = another app uses the port) ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:%PORT%/api/health; if ($r.app -eq 'tsukiyo-wordwolf-kiosk') { exit 0 } else { exit 2 } } catch { if ($_.Exception.Response) { exit 2 } else { exit 1 } }"
if errorlevel 2 (
  echo [ERROR] Another program is using port %PORT%.
  echo Restart the PC, or close the other program, then run this file again.
  pause
  exit /b 1
)
if errorlevel 1 (
  start "WordWolf-Server" /min "%NODE%" "%~dp0server.js"
)

rem --- Wait until the server answers (up to 20 seconds) ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "for ($i = 0; $i -lt 40; $i++) { try { $r = Invoke-RestMethod -TimeoutSec 1 http://127.0.0.1:%PORT%/api/health; if ($r.app -eq 'tsukiyo-wordwolf-kiosk') { exit 0 } } catch { }; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
  echo [ERROR] The game server did not start.
  echo Open the "WordWolf-Server" window on the taskbar to see the error.
  pause
  exit /b 1
)

start "" msedge --new-window "http://localhost:%PORT%/admin.html"
if errorlevel 1 start "" "http://localhost:%PORT%/admin.html"
exit /b 0
