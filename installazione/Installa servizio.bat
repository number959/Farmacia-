@echo off
rem Installa l avvio automatico del Gestionale Farmacia (va eseguito come amministratore).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installa-servizio.ps1" %*
pause
