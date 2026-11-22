# Replaces the database and the attachments with a backup. Takes a safety backup first and returns to it if anything fails.
param([Parameter(Mandatory = $true)][string]$Arquivo)
. (Join-Path $PSScriptRoot 'comum.ps1')

function Invoke-Migrations {
  Push-Location -LiteralPath $Current
  try { Invoke-Tool 'node' @($Prisma, 'migrate', 'deploy') } finally { Pop-Location }
}

try {
  Assert-Admin
  if (-not (Test-Path -LiteralPath $Arquivo -PathType Leaf)) { throw 'Backup nao encontrado.' }
  $file = (Resolve-Path -LiteralPath $Arquivo).ProviderPath
  Assert-BackupReadable $file
  Use-Database
  # The file copy sits next to the dump. Dumps made by the updater use the one from the daily backup.
  $dailyPool = Join-Path $DailyBackups 'arquivos'
  $filePools = @((Join-Path (Split-Path $file -Parent) 'arquivos'), $dailyPool)

  Write-Host "`nO banco e os arquivos atuais serao substituidos por: $file" -ForegroundColor Yellow
  Write-Host 'Tudo o que foi feito depois desse backup deixara de aparecer no site.'
  if ((Read-Host 'Digite RESTAURAR para continuar') -cne 'RESTAURAR') { Write-Host 'Nada foi alterado.'; return }

  Write-Step 'Parando o site'
  Stop-App
  $safety = $null
  try {
    Write-Step 'Fazendo backup de seguranca'
    $safety = Backup-Database
    Write-Host "Backup de seguranca: $safety"
    # Current files go to the copy first, so going back to the safety backup can bring them all back.
    Sync-Files $Files $dailyPool | Out-Null
    Write-Step 'Restaurando'
    Restore-Database $file
    # An older backup may lack the tables of the installed version.
    Invoke-Migrations
    Write-Step 'Restaurando os arquivos'
    Restore-Files (Get-StoredFileKeys) $filePools
    Start-App
  } catch {
    $failure = $_.Exception.Message
    Write-Host "`nFalha: $failure" -ForegroundColor Red
    if ($safety) {
      Write-Step 'Voltando ao banco anterior'
      Stop-App
      Restore-Database $safety
      # The database is back, so a missing attachment must not keep the site offline.
      try { Restore-Files (Get-StoredFileKeys) $filePools } catch { Write-Host "Aviso: $($_.Exception.Message)" -ForegroundColor Yellow }
    }
    Start-App
    throw "A restauracao foi desfeita. Motivo: $failure"
  }
  Write-Host "`nBackup restaurado e site no ar." -ForegroundColor Green
} catch {
  Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
