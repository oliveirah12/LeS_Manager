# Replaces the database with a backup. Takes a safety backup first and returns to it if anything fails.
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

  Write-Host "`nO banco atual sera substituido por: $file" -ForegroundColor Yellow
  Write-Host 'Tudo o que foi feito depois desse backup deixara de aparecer no site.'
  if ((Read-Host 'Digite RESTAURAR para continuar') -cne 'RESTAURAR') { Write-Host 'Nada foi alterado.'; return }

  Write-Step 'Parando o site'
  Stop-App
  $safety = $null
  try {
    Write-Step 'Fazendo backup de seguranca'
    $safety = Backup-Database
    Write-Host "Backup de seguranca: $safety"
    Write-Step 'Restaurando'
    Restore-Database $file
    # An older backup may lack the tables of the installed version.
    Invoke-Migrations
    Start-App
  } catch {
    $failure = $_.Exception.Message
    Write-Host "`nFalha: $failure" -ForegroundColor Red
    if ($safety) {
      Write-Step 'Voltando ao banco anterior'
      Stop-App
      Restore-Database $safety
    }
    Start-App
    throw "A restauracao foi desfeita. Motivo: $failure"
  }
  Write-Host "`nBackup restaurado e site no ar." -ForegroundColor Green
} catch {
  Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
