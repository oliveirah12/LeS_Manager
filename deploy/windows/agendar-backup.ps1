# Schedules the daily backup and runs it once, proving that the SYSTEM account reaches the destination.
# -Destino: another disk or network share. Mapped drive letters do not exist for SYSTEM, so use a UNC path.
param(
  [Parameter(Mandatory = $true)][string]$Destino,
  [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')][string]$Hora = '03:00',
  [ValidateRange(1, 365)][int]$Manter = 30
)
. (Join-Path $PSScriptRoot 'comum.ps1')

try {
  Assert-Admin
  if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'Instalacao nao encontrada. Rode o instalar.ps1.' }
  if (-not (Test-Path -LiteralPath $Destino -PathType Container)) { throw "Destino nao encontrado: $Destino" }
  $root = (Resolve-Path -LiteralPath $Destino).ProviderPath
  if ([IO.Path]::GetPathRoot($root) -eq [IO.Path]::GetPathRoot($Base)) { throw 'O destino precisa estar em outro disco, ou uma falha no disco levaria o banco e o backup juntos.' }
  # The subfolder also avoids a path ending in a backslash, which would break the task's quoted argument.
  $folder = Join-Path $root 'LeS_Manager_backups'

  $script = Join-Path $PSScriptRoot 'backup.ps1'
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Destino `"$folder`" -Manter $Manter"
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -Daily -At $Hora
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  # StartWhenAvailable runs a missed backup as soon as the PC is back on.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  Register-ScheduledTask -TaskName $BackupTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

  Write-Step 'Rodando o primeiro backup'
  Start-ScheduledTask -TaskName $BackupTask
  Start-Sleep -Seconds 2
  while ((Get-ScheduledTask -TaskName $BackupTask).State -eq 'Running') { Start-Sleep -Seconds 2 }
  if ((Get-ScheduledTaskInfo -TaskName $BackupTask).LastTaskResult -ne 0) { throw "O primeiro backup falhou. Veja $(Join-Path $Logs 'backup.log')." }
  Write-Host "`nBackup agendado todo dia as $Hora, com copia em $folder." -ForegroundColor Green
} catch {
  Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
