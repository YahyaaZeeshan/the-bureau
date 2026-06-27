@echo off
title The Bureau
cd /d "%~dp0"
echo.
echo  ===========================================
echo    PIXEL OFFICE - starting up...
echo  ===========================================
echo.
echo  Keep THIS window open while you use the app.
echo  When ready, open in Chrome:  http://localhost:5180
echo.
echo  (Closing this window stops the office.)
echo.
call npm run dev
echo.
echo  Office stopped. Press any key to close.
pause >nul
