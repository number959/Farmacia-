# Gestionale Farmacia - installa l'avvio automatico sul server Windows.
# Crea un'attività pianificata che avvia GestionaleFarmacia.exe all'accensione del server (anche senza nessuno collegato),
# lo riavvia se si ferma e apre la porta nel firewall di Windows.
# Uso (PowerShell come amministratore):  .\installa-servizio.ps1 [-Porta 8080]
param([int]$Porta = 8080)

$ErrorActionPreference = 'Stop'
$nome = 'Gestionale Farmacia'
$cartella = $PSScriptRoot
$exe = Join-Path $cartella 'GestionaleFarmacia.exe'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Serve avviare l''installazione come amministratore (tasto destro su "Installa servizio.bat" > Esegui come amministratore).' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $exe)) {
  Write-Host "Non trovo $exe" -ForegroundColor Red
  exit 1
}

Write-Host "Installo l'avvio automatico di $exe sulla porta $Porta..."

# se c'era già, lo fermo e lo sostituisco
$esistente = Get-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue
if ($esistente) {
  Stop-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $nome -Confirm:$false
}

$azione = New-ScheduledTaskAction -Execute $exe -Argument "--porta $Porta" -WorkingDirectory $cartella
$avvio = New-ScheduledTaskTrigger -AtStartup
$impostazioni = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$utente = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $nome -Action $azione -Trigger $avvio -Settings $impostazioni -Principal $utente `
  -Description 'Gestionale Farmacia della Clinica Posillipo: server per le postazioni della rete.' | Out-Null

# firewall: porta aperta in ingresso
Get-NetFirewallRule -DisplayName $nome -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $nome -Direction Inbound -Protocol TCP -LocalPort $Porta -Action Allow -Profile Any | Out-Null

Start-ScheduledTask -TaskName $nome
Write-Host 'Avvio in corso...'
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-WebRequest -Uri "http://localhost:$Porta/api/stato" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $ok = $true
  } catch { }
}
if ($ok) {
  Write-Host ''
  Write-Host 'Fatto. Il Gestionale Farmacia è in funzione e partirà da solo a ogni accensione del server.' -ForegroundColor Green
  Write-Host "Su questo server:     http://localhost:$Porta/"
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object {
    Write-Host "Dalle postazioni:     http://$($_.IPAddress):$Porta/"
  }
  Write-Host ''
  Write-Host "Al primo avvio apri http://localhost:$Porta/ su questo server e crea l'amministratore."
} else {
  Write-Host "L'attività è installata ma il programma non risponde. Controlla i file in $cartella\dati\log" -ForegroundColor Yellow
}
