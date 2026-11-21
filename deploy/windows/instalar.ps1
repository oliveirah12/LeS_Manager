# Installs LeS Manager on a Windows server, without Docker. Safe to run again.
# -Backup: .dump to restore into an empty database.  -EnvAntigo: old .env, to keep CONFIG_ENCRYPTION_KEY.
# -TunelDir: folder with config.yml and the tunnel .json.  -LigarTunel: publishes the site on this server.
param([string]$Backup, [string]$EnvAntigo, [string]$TunelDir, [switch]$LigarTunel)
. (Join-Path $PSScriptRoot 'comum.ps1')

function New-Secret {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $bytes
}

function Invoke-AdminSql([string]$Sql) {
  $Sql | & (Join-Path $PgBin 'psql.exe') -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -tA
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao configurar o PostgreSQL. Confira a senha do usuario postgres.' }
}

Assert-Admin

Write-Step 'Conferindo os programas'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared -and (Test-Path 'C:\Program Files (x86)\cloudflared\cloudflared.exe')) { $cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
if (-not $node) { throw 'Instale o Node.js 22 LTS.' }
if ([version](& $node -p 'process.versions.node') -lt [version]'22.18.0') { throw 'O app exige Node.js 22.18 ou superior.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Instale o Git.' }
if (-not (Test-Path (Join-Path $PgBin 'psql.exe'))) { throw 'Instale o PostgreSQL 17.' }
if ($LigarTunel -and -not $cloudflared) { throw 'Instale o cloudflared.' }
if ($LigarTunel -and -not $TunelDir -and -not (Test-Path (Join-Path $Base 'cloudflared\config.yml'))) { throw 'Informe -TunelDir.' }
if ($Backup -and -not (Test-Path -LiteralPath $Backup)) { throw 'Backup nao encontrado.' }

Write-Step 'Preparando a pasta de dados'
foreach ($folder in $Base, $Releases, $Backups, $Logs) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
# Only SYSTEM and administrators read the .env, the backups and the tunnel credentials.
Invoke-Tool 'icacls.exe' @($Base, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/q')

if (-not (Test-Path -LiteralPath $EnvFile)) {
  $key = if ($EnvAntigo) { (Read-EnvFile $EnvAntigo)['CONFIG_ENCRYPTION_KEY'] } else { [Convert]::ToBase64String((New-Secret)) }
  if (-not $key) { throw 'CONFIG_ENCRYPTION_KEY ausente no .env antigo.' }
  $password = -join ((New-Secret) | ForEach-Object { $_.ToString('x2') })
  Write-TextFile $EnvFile ("DATABASE_URL=postgresql://les:$password@127.0.0.1:5432/les_manager`nPORT=3000`nCOOKIE_SECURE=true`nTRUST_PROXY=1`nCONFIG_ENCRYPTION_KEY=$key`n")
}

Write-Step 'Configurando o banco'
Use-Database
$appPassword = $env:PGPASSWORD
$secure = Read-Host 'Senha do usuario postgres (definida na instalacao do PostgreSQL)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
$verb = if (Invoke-AdminSql "SELECT 1 FROM pg_roles WHERE rolname = 'les'") { 'ALTER' } else { 'CREATE' }
Invoke-AdminSql "$verb ROLE les LOGIN PASSWORD '$appPassword'"
if (-not (Invoke-AdminSql "SELECT 1 FROM pg_database WHERE datname = 'les_manager'")) {
  Invoke-AdminSql "CREATE DATABASE les_manager OWNER les ENCODING 'UTF8' TEMPLATE template0"
}
Use-Database

if ($Backup) {
  Write-Step 'Restaurando o backup'
  $used = 'SELECT to_regclass(''public."User"'')' | & (Join-Path $PgBin 'psql.exe') -tA
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao consultar o banco.' }
  if ("$used".Trim()) { throw 'O banco ja tem dados, entao o backup nao foi restaurado.' }
  Invoke-Tool (Join-Path $PgBin 'pg_restore.exe') @('--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', '-d', $env:PGDATABASE, (Resolve-Path -LiteralPath $Backup).Path)
}

# A second run only adds what is missing. New versions go through the updater, which backs up first.
$release = Get-ActiveRelease
if (-not $release) {
  Write-Step 'Gerando a versao atual da main'
  Invoke-Git @('fetch', 'origin', 'main')
  $commit = (& git -c 'safe.directory=*' -C $Repo rev-parse origin/main).Trim()
  $release = New-Release $commit

  Write-Step 'Aplicando as migracoes'
  Push-Location -LiteralPath $release
  try { Invoke-Tool 'node' @($Prisma, 'migrate', 'deploy') } finally { Pop-Location }
  Set-ActiveRelease $release
}

Write-Step 'Ligando o app'
$appScript = Join-Path $Base 'iniciar-app.cmd'
Write-LoopScript $appScript $Current "`"$node`" --env-file=`"$EnvFile`" dist\api\main.js" (Join-Path $Logs 'app.log')
Register-BootTask $AppTask $appScript
if (-not (Test-Health)) { Start-App }

$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Atualizar LeS Manager.lnk'))
$shortcut.TargetPath = Join-Path $PSScriptRoot 'Atualizar LeS Manager.bat'
$shortcut.Save()

if ($LigarTunel) {
  Write-Step 'Ligando o tunel'
  $tunnelDir = Join-Path $Base 'cloudflared'
  $config = Join-Path $tunnelDir 'config.yml'
  if ($TunelDir) {
    New-Item -ItemType Directory -Force -Path $tunnelDir | Out-Null
    Copy-Item -Path (Join-Path $TunelDir '*.json') -Destination $tunnelDir -Force
    $text = Get-Content -LiteralPath (Join-Path $TunelDir 'config.yml') -Raw -Encoding UTF8
    $credentials = (Get-ChildItem -LiteralPath $tunnelDir -Filter '*.json' | Select-Object -First 1).FullName
    Write-TextFile $config ($text -replace '(?m)^credentials-file:.*$', ("credentials-file: $credentials" -replace '\$', '$$$$'))
  }
  $tunnelScript = Join-Path $Base 'iniciar-tunel.cmd'
  Write-LoopScript $tunnelScript $tunnelDir "`"$cloudflared`" tunnel --config `"$config`" run" (Join-Path $Logs 'tunel.log')
  Register-BootTask $TunnelTask $tunnelScript
  Start-ScheduledTask -TaskName $TunnelTask
}

Write-Host "`nInstalacao concluida na versao $(Split-Path $release -Leaf)." -ForegroundColor Green
if (-not $LigarTunel) { Write-Host 'O site ainda nao esta publicado. Confira http://localhost:3000 e rode de novo com -LigarTunel.' }
