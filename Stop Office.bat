@echo off
REM Stops the running office (the background supervisor + its server/web).
echo Stopping The Bureau...

REM kill the supervisor cmd windows
taskkill /F /FI "WINDOWTITLE eq The Bureau (supervisor)" >nul 2>&1

REM free the two ports (server 4317, web 5180)
for %%P in (4317 5180) do (
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%P" ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
)

echo Done. (Autostart stays installed — it will start again at next login unless you run "Remove Autostart.bat".)
pause
