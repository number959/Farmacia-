# Gestionale Farmacia - toglie l'avvio automatico e la regola del firewall. I dati (cartella "dati") restano.
$ErrorActionPreference = 'Stop'
$nome = 'Gestionale Farmacia'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Serve avviare come amministratore.' -ForegroundColor Red
  exit 1
}
if (Get-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $nome -Confirm:$false
  Write-Host 'Avvio automatico tolto.'
}
Get-NetFirewallRule -DisplayName $nome -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-Process -Name 'GestionaleFarmacia' -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host 'Fatto. I dati nella cartella "dati" non sono stati toccati.' -ForegroundColor Green
