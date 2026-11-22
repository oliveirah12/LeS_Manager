# Shared helpers for the Windows server install and update. Messages stay in ASCII because
# Windows PowerShell 5.1 reads scripts without a BOM in the system code page.
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Base = Join-Path (Split-Path $Repo -Parent) 'LeS_Manager_dados'
$Releases = Join-Path $Base 'versoes'
$Current = Join-Path $Base 'atual'
$Backups = Join-Path $Base 'backups'
$Files = Join-Path $Base 'arquivos'
$Logs = Join-Path $Base 'logs'
$EnvFile = Join-Path $Base '.env'
$AppTask = 'LeS Manager - App'
$TunnelTask = 'LeS Manager - Tunel'
$BackupTask = 'LeS Manager - Backup diario'
$DailyBackups = Join-Path $Backups 'diarios'
$PgBin = 'C:\Program Files\PostgreSQL\17\bin'
$Prisma = 'node_modules\prisma\build\index.js'

function Write-Step([string]$Text) { Write-Host "`n>> $Text" -ForegroundColor Cyan }

function Assert-Admin {
  $identity = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Execute como administrador.' }
}

function Invoke-Tool([string]$File, [string[]]$Arguments) {
  & $File @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Falha ao executar $(Split-Path $File -Leaf) $($Arguments[0])." }
}

function Invoke-Git([string[]]$Arguments) { Invoke-Tool 'git' (@('-c', 'safe.directory=*', '-C', $Repo) + $Arguments) }

function Write-TextFile([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Read-EnvFile([string]$Path) {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim().Trim('"') }
  }
  $values
}

# Exposes the connection to Prisma and the PostgreSQL tools without placing the password in any argument.
function Use-Database {
  $url = (Read-EnvFile $EnvFile)['DATABASE_URL']
  if (-not $url) { throw 'DATABASE_URL ausente no .env.' }
  $uri = [Uri]$url
  $user, $password = $uri.UserInfo -split ':', 2
  $env:DATABASE_URL = $url
  $env:PGHOST = $uri.Host
  $env:PGPORT = [string]$uri.Port
  $env:PGUSER = [Uri]::UnescapeDataString($user)
  $env:PGPASSWORD = [Uri]::UnescapeDataString($password)
  $env:PGDATABASE = $uri.AbsolutePath.TrimStart('/')
}

function Get-AppPort {
  $port = (Read-EnvFile $EnvFile)['PORT']
  if ($port) { [int]$port } else { 3000 }
}

function Test-Health {
  try {
    (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$(Get-AppPort)/api/health").StatusCode -eq 200
  } catch { $false }
}

function Get-ActiveRelease {
  if (Test-Path -LiteralPath $Current) { (Get-Item -LiteralPath $Current).Target | Select-Object -First 1 }
}

# Builds the version in its own folder, so the running site is untouched until the switch.
function New-Release([string]$Commit) {
  $path = Join-Path $Releases $Commit.Substring(0, 12)
  $done = Join-Path $path '.versao-pronta'
  if (Test-Path -LiteralPath $done) { return $path }
  if (Test-Path -LiteralPath $path) { Invoke-Git @('worktree', 'remove', '--force', $path) }
  Invoke-Git @('worktree', 'prune')
  Invoke-Git @('worktree', 'add', '--detach', $path, $Commit)
  Push-Location -LiteralPath $path
  try {
    Invoke-Tool 'npm.cmd' @('ci', '--no-audit', '--no-fund')
    Invoke-Tool 'node' @($Prisma, 'generate')
    Invoke-Tool 'npm.cmd' @('run', 'build')
  } finally { Pop-Location }
  Write-TextFile $done $Commit
  $path
}

# Directory.Delete without recursion removes only the junction, never the version it points to.
function Set-ActiveRelease([string]$Path) {
  if (Test-Path -LiteralPath $Current) { [IO.Directory]::Delete($Current) }
  New-Item -ItemType Junction -Path $Current -Target $Path | Out-Null
}

function Start-App {
  $log = Join-Path $Logs 'app.log'
  if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 20MB) { Move-Item -LiteralPath $log "$log.anterior" -Force }
  Start-ScheduledTask -TaskName $AppTask
  foreach ($attempt in 1..30) {
    if (Test-Health) { return }
    Start-Sleep -Seconds 2
  }
  throw "O app nao respondeu. Veja $log."
}

# Stops the restart loop first, then only the process of this app that holds the port.
function Stop-App {
  Stop-ScheduledTask -TaskName $AppTask
  $port = Get-AppPort
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
    if ($process.CommandLine -notlike '*dist\api\main.js*') { throw "A porta $port pertence a outro programa." }
    Stop-Process -Id $process.ProcessId -Force
    foreach ($attempt in 1..20) {
      if (-not (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) { return }
      Start-Sleep -Milliseconds 500
    }
    throw "A porta $port continua ocupada."
  }
}

# The final name only appears after pg_restore reads the whole archive, so a cut dump never counts as a backup.
function Backup-Database([string]$Folder = $Backups) {
  $file = Join-Path $Folder ('les_manager_' + (Get-Date -Format 'yyyy-MM-dd_HHmmss') + '.dump')
  $partial = "$file.parcial"
  try {
    Invoke-Tool (Join-Path $PgBin 'pg_dump.exe') @('-Fc', '-f', $partial)
    if ((Get-Item -LiteralPath $partial).Length -lt 100) { throw 'O backup ficou vazio.' }
    Assert-BackupReadable $partial
    Move-Item -LiteralPath $partial -Destination $file
  } finally {
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
  }
  $file
}

function Assert-BackupReadable([string]$File) {
  & (Join-Path $PgBin 'pg_restore.exe') --list $File | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "O arquivo de backup esta ilegivel: $File" }
}

# Drops what a failed migration created, then rebuilds the database from the backup in one transaction.
function Restore-Database([string]$File) {
  'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' | & (Join-Path $PgBin 'psql.exe') -v ON_ERROR_STOP=1 -q
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao preparar o banco para restaurar.' }
  Invoke-Tool (Join-Path $PgBin 'pg_restore.exe') @('--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', '-d', $env:PGDATABASE, $File)
}

# Points the app to the attachments folder once. Returns $true when a running app must restart to read it.
function Set-FileStorage {
  New-Item -ItemType Directory -Force -Path $Files | Out-Null
  if ((Read-EnvFile $EnvFile)['FILE_STORAGE_DIR']) { return $false }
  $text = [IO.File]::ReadAllText($EnvFile)
  if ($text -and -not $text.EndsWith("`n")) { $text += "`n" }
  Write-TextFile $EnvFile ($text + "FILE_STORAGE_DIR=$Files`n")
  $true
}

function Copy-Verified([string]$File, [string]$Folder) {
  New-Item -ItemType Directory -Force -Path $Folder | Out-Null
  $target = Join-Path $Folder (Split-Path $File -Leaf)
  $partial = "$target.parcial"
  try {
    Copy-Item -LiteralPath $File -Destination $partial -Force
    if ((Get-FileHash -LiteralPath $File).Hash -ne (Get-FileHash -LiteralPath $partial).Hash) { throw 'A copia ficou diferente do original.' }
    Move-Item -LiteralPath $partial -Destination $target -Force
  } finally {
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
  }
}

# Only names the app generates, which leaves out the temporary folder and partial copies.
function Get-StoredFiles([string]$Folder) {
  if (-not (Test-Path -LiteralPath $Folder)) { return }
  Get-ChildItem -LiteralPath $Folder -Directory | Where-Object { $_.Name -match '^[0-9a-f]{2}$' } | ForEach-Object {
    Get-ChildItem -LiteralPath $_.FullName -File | Where-Object { $_.Name -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }
  }
}

# A stored file never changes, so the copy only adds what is new and keeps deleted files for older dumps.
function Sync-Files([string]$Source, [string]$Target) {
  $copied = 0
  foreach ($file in @(Get-StoredFiles $Source)) {
    $folder = Join-Path $Target $file.Directory.Name
    $existing = Join-Path $folder $file.Name
    if ((Test-Path -LiteralPath $existing) -and (Get-Item -LiteralPath $existing).Length -eq $file.Length) { continue }
    try {
      Copy-Verified $file.FullName $folder
      $copied++
    } catch {
      # The daily backup runs with the site online, so a file may be deleted during the copy.
      if (Test-Path -LiteralPath $file.FullName) { throw }
    }
  }
  $copied
}

function Get-StoredFileKeys {
  $psql = Join-Path $PgBin 'psql.exe'
  $table = 'SELECT to_regclass(''public."StoredFile"'')' | & $psql -v ON_ERROR_STOP=1 -q -tA
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao consultar o banco.' }
  if (-not "$table".Trim()) { return @() }
  $rows = 'SELECT "storageKey" FROM "StoredFile" WHERE available' | & $psql -v ON_ERROR_STOP=1 -q -tA
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao listar os arquivos do banco.' }
  @($rows | Where-Object { $_ } | ForEach-Object { "$_".Trim() })
}

# Makes the folder match the restored database. Nothing is removed unless every file it needs was found.
function Restore-Files([string[]]$Keys, [string[]]$Pools, [string]$Target = $Files) {
  $missing = 0
  $wanted = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($key in @($Keys)) {
    if ($key -notmatch '^[0-9a-f]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Chave de arquivo invalida no banco.' }
    $relative = $key -replace '/', '\'
    [void]$wanted.Add($relative)
    $path = Join-Path $Target $relative
    if (Test-Path -LiteralPath $path) { continue }
    $source = @($Pools) | ForEach-Object { Join-Path $_ $relative } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($source) { Copy-Verified $source (Split-Path $path -Parent) } else { $missing++ }
  }
  if ($missing) { throw "Faltam $missing arquivo(s) na copia de arquivos do backup." }
  foreach ($file in @(Get-StoredFiles $Target)) {
    if (-not $wanted.Contains((Join-Path $file.Directory.Name $file.Name))) { Remove-Item -LiteralPath $file.FullName -Force }
  }
}

# Runs a command forever, so the app and the tunnel come back after a crash or before the database is up.
function Write-LoopScript([string]$Path, [string]$WorkDir, [string]$Command, [string]$Log) {
  Write-TextFile $Path ("@echo off`r`nchcp 65001 >nul`r`ncd /d `"$WorkDir`"`r`n:loop`r`n$Command >> `"$Log`" 2>&1`r`nping -n 11 127.0.0.1 >nul`r`ngoto loop`r`n")
}

function Register-BootTask([string]$Name, [string]$Script) {
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$Script`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}
