@echo off
rem Apre il Gestionale Farmacia in una finestra a se' stante di Microsoft Edge (presente in Windows 10 e 11).
rem In alternativa si puo' aprire index.html con Edge o Chrome.
start "" msedge --app="file:///%~dp0index.html"
