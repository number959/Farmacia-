# Gestionale Farmacia - installa l'avvio automatico sul server Windows.
# Crea un'attività pianificata che avvia GestionaleFarmacia.exe all'accensione del server (anche senza nessuno collegato)
# e lo riavvia entro 5 minuti se si ferma, limita i permessi della cartella e apre la porta nel firewall di Windows.
# Uso: "Installa servizio.bat" come amministratore; per un'altra porta, da un prompt dei comandi come amministratore:
#      "Installa servizio.bat" -Porta 8443
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

# se c'era già, lo fermo e lo sostituisco; fermo anche le copie avviate a mano (occuperebbero la porta)
$esistente = Get-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue
if ($esistente) {
  Stop-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $nome -Confirm:$false
}
Get-Process -Name 'GestionaleFarmacia' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

# permessi della cartella: solo amministratori e SYSTEM. Il programma gira come SYSTEM: nessun altro utente
# del server deve poter sostituire l'exe o leggere i database (con gli hash delle password)
New-Item -ItemType Directory -Force -Path (Join-Path $cartella 'dati') | Out-Null
# 1) la cartella: niente permessi ereditati da C:\, solo SYSTEM e Administrators (anche per quello che contiene)
& icacls.exe "$cartella" /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /C /Q | Out-Null
$esito1 = $LASTEXITCODE
# 2) file e sottocartelle già presenti: tornano a ereditare dalla cartella (le opzioni (OI)(CI) valgono solo per le cartelle)
& icacls.exe (Join-Path $cartella '*') /reset /T /C /Q | Out-Null
if ($esito1 -ne 0 -or $LASTEXITCODE -ne 0) { Write-Host 'Attenzione: non sono riuscito a limitare i permessi della cartella (icacls).' -ForegroundColor Yellow }

$azione = New-ScheduledTaskAction -Execute $exe -Argument "--porta $Porta --servizio" -WorkingDirectory $cartella
# all'accensione, e poi ogni 5 minuti: se il programma si è fermato riparte (se è già in esecuzione non succede niente)
$avvio = New-ScheduledTaskTrigger -AtStartup
$controllo = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$impostazioni = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$utente = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $nome -Action $azione -Trigger @($avvio, $controllo) -Settings $impostazioni -Principal $utente `
  -Description 'Gestionale Farmacia della Clinica Posillipo: server per le postazioni della rete.' | Out-Null

# firewall: porta aperta in ingresso
Get-NetFirewallRule -DisplayName $nome -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $nome -Direction Inbound -Protocol TCP -LocalPort $Porta -Action Allow -Profile Any | Out-Null

Start-ScheduledTask -TaskName $nome
Write-Host 'Avvio in corso...'
# controllo che la porta risponda (vale sia con HTTP sia con HTTPS)
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  Start-Sleep -Seconds 1
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    $tcp.Connect('127.0.0.1', $Porta)
    $ok = $tcp.Connected
  } catch { } finally { $tcp.Close() }
}
$schema = 'http'
$conf = Join-Path $cartella 'dati\configurazione.json'
if ((Test-Path $conf) -and ((Get-Content $conf -Raw) -match '"https"\s*:')) { $schema = 'https' }
if ($ok) {
  Write-Host ''
  Write-Host 'Fatto. Il Gestionale Farmacia è in funzione e partirà da solo a ogni accensione del server.' -ForegroundColor Green
  Write-Host "Su questo server:     ${schema}://localhost:$Porta/"
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object {
    Write-Host "Dalle postazioni:     ${schema}://$($_.IPAddress):$Porta/"
  }
  Write-Host ''
  Write-Host "Al primo avvio apri ${schema}://localhost:$Porta/ su questo server e crea l'amministratore."
} else {
  Write-Host "L'attività è installata ma il programma non risponde sulla porta $Porta." -ForegroundColor Yellow
  $info = Get-ScheduledTaskInfo -TaskName $nome -ErrorAction SilentlyContinue
  if ($info) { Write-Host ("Esito dell'ultimo avvio dell'attività: 0x{0:X}" -f $info.LastTaskResult) -ForegroundColor Yellow }
  $log = Join-Path $cartella 'dati\log'
  Get-ChildItem $log -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "--- $($_.Name) (ultime righe)"
    Get-Content $_.FullName -Tail 15
  }
  Write-Host "I registri sono in $log" -ForegroundColor Yellow
  exit 2
}
