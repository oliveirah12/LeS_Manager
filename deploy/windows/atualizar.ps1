# Updates the site to the latest main. The build runs with the site online; it only stops for the
# backup, the migrations and the switch. Any failure there brings the previous version back.
. (Join-Path $PSScriptRoot 'comum.ps1')

function Test-PendingMigrations([string]$Release) {
  Push-Location -LiteralPath $Release
  try {
    cmd /c "node $Prisma migrate status >nul 2>&1"
    $LASTEXITCODE -ne 0
  } finally { Pop-Location }
}

function Remove-OldReleases([string]$Keep, [string]$Previous) {
  $kept = @($Keep, $Previous) | Where-Object { $_ } | ForEach-Object { (Split-Path $_ -Leaf) }
  foreach ($folder in Get-ChildItem -LiteralPath $Releases -Directory) {
    if ($kept -notcontains $folder.Name) { Invoke-Git @('worktree', 'remove', '--force', $folder.FullName) }
  }
}

try {
  Assert-Admin
  Use-Database
  Write-Step 'Procurando atualizacao'
  Invoke-Git @('fetch', 'origin', 'main')
  $commit = (& git -c 'safe.directory=*' -C $Repo rev-parse origin/main).Trim()
  $previous = Get-ActiveRelease
  if (-not $previous) { throw 'Instalacao nao encontrada. Rode o instalar.ps1.' }
  if ((Split-Path $previous -Leaf) -eq $commit.Substring(0, 12)) {
    if (-not (Test-Health)) { Write-Step 'Religando o app'; Start-App }
    Write-Host "`nJa esta na versao mais recente." -ForegroundColor Green
    return
  }

  Write-Step 'Gerando a nova versao (o site continua no ar)'
  $release = New-Release $commit
  $migrate = Test-PendingMigrations $release

  Write-Step 'Parando o site'
  Stop-App
  $backup = $null
  $migrated = $false
  try {
    if ($migrate) {
      Write-Step 'Fazendo backup do banco'
      $backup = Backup-Database
      Write-Host "Backup: $backup"
      Write-Step 'Aplicando as migracoes'
      $migrated = $true
      Push-Location -LiteralPath $release
      try { Invoke-Tool 'node' @($Prisma, 'migrate', 'deploy') } finally { Pop-Location }
    }
    Write-Step 'Subindo a nova versao'
    Set-ActiveRelease $release
    Start-App
  } catch {
    $failure = $_.Exception.Message
    Write-Host "`nFalha: $failure" -ForegroundColor Red
    Write-Step 'Voltando para a versao anterior'
    Stop-App
    # The site stayed down since the backup, so restoring it loses no data.
    if ($migrated) { Restore-Database $backup }
    Set-ActiveRelease $previous
    Start-App
    throw "A atualizacao foi desfeita e o site voltou na versao anterior. Motivo: $failure"
  }

  Remove-OldReleases $release $previous
  if ((& git -c 'safe.directory=*' -C $Repo branch --show-current) -eq 'main') { Invoke-Git @('merge', '--ff-only', 'origin/main') }
  Write-Host "`nSite atualizado para a versao $($commit.Substring(0, 12))." -ForegroundColor Green
} catch {
  Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
