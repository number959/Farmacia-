@echo off
rem Ferma il Gestionale Farmacia avviato come servizio (per esempio prima di un aggiornamento).
schtasks /End /TN "Gestionale Farmacia"
pause
