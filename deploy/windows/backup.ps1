# Daily backup, run by the scheduled task with the site online: pg_dump reads a consistent snapshot.
# -Destino: folder on another disk that receives a verified copy.  -Manter: how many daily backups to keep.
param([string]$Destino, [ValidateRange(1, 365)][int]$Manter = 30)
. (Join-Path $PSScriptRoot 'comum.ps1')

function Write-BackupLog([string]$Text) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Text
  Add-Content -LiteralPath (Join-Path $Logs 'backup.log') -Value $line -Encoding UTF8
  Write-Host $line
}

# Counts files instead of days, so a long run of failures never erases the last good backups.
function Remove-OldBackups([string]$Folder) {
  Get-ChildItem -LiteralPath $Folder -File -Filter 'les_manager_*.dump' |
    Sort-Object Name -Descending |
    Select-Object -Skip $Manter |
    Remove-Item -Force
}

try {
  New-Item -ItemType Directory -Force -Path $DailyBackups | Out-Null
  Use-Database
  # Copied before and after the dump, so every file the dump lists is in the backup, even one sent meanwhile.
  $filePool = Join-Path $DailyBackups 'arquivos'
  $newFiles = Sync-Files $Files $filePool
  $file = Backup-Database $DailyBackups
  $newFiles += Sync-Files $Files $filePool
  $size = [Math]::Round((Get-Item -LiteralPath $file).Length / 1MB, 2)
  Remove-OldBackups $DailyBackups
  Write-BackupLog "OK local: $(Split-Path $file -Leaf) ($size MB), $newFiles arquivo(s) novo(s)"
  if ($Destino) {
    Copy-Verified $file $Destino
    $copiedFiles = Sync-Files $filePool (Join-Path $Destino 'arquivos')
    Remove-OldBackups $Destino
    Write-BackupLog "OK copia: $Destino, $copiedFiles arquivo(s) novo(s)"
  }
} catch {
  Write-BackupLog "FALHA: $($_.Exception.Message)"
  exit 1
}
