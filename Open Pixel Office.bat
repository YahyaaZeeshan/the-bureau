@echo off
REM Opens The Bureau: starts the server only if it isn't already running,
REM then opens it in your browser. When you close the browser, the server
REM shuts itself down (~45s) — nothing is left running in the background.
cd /d "%~dp0"

REM is the web app already up on 5180?
powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('localhost',5180); $c.Close(); exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Starting The Bureau...
  start "" wscript.exe "%~dp0office-hidden.vbs"
  echo Warming up ^(first start takes ~15s^)...
  powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){ try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('localhost',5180); $c.Close(); break } catch { Start-Sleep -Milliseconds 750 } }"
)

start "" http://localhost:5180
