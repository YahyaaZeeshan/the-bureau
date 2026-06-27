@echo off
REM One-shot run of the office (server + web). Exits when the server idle-shuts
REM down after the browser closes — no background restart loop.
title The Bureau
cd /d "%~dp0"
call npm run dev
