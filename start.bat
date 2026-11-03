@echo off
title StageTimer
cd /d "%~dp0"

rem Opsional: start.bat 8080
if not "%~1"=="" set PORT=%~1

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js belum terpasang.
  echo   Install dari https://nodejs.org lalu jalankan file ini lagi.
  echo.
  pause
  exit /b 1
)

node server.js
pause
