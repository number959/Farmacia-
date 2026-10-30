@echo off
rem Toglie l avvio automatico del Gestionale Farmacia (va eseguito come amministratore). I dati restano.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0disinstalla-servizio.ps1"
pause
