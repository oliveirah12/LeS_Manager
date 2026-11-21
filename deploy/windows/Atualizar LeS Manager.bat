@echo off
title Atualizar LeS Manager
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
net session >nul 2>&1 || ("%PS%" -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" & exit /b)
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0atualizar.ps1"
pause
