@echo off
rem Start harness-mcp. Double-click this file, or run start.cmd from cmd or PowerShell
rem (it avoids PowerShell's block on npm.ps1). Stop it with Ctrl+C or by closing the window.
title harness-mcp
cd /d "%~dp0"
node src\main.ts
if errorlevel 1 (
  echo.
  echo harness-mcp stopped with an error. Read the message above.
  pause
)
