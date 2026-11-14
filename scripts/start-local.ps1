# Démarrage du SERVEUR LOCAL (Windows). Remplissez .env.local puis lancez ce script.
Set-Location (Join-Path $PSScriptRoot "..")
if (!(Test-Path .env.local)) { Write-Host "⚠️  .env.local manquant — copiez .env.local.example en .env.local."; exit 1 }
Get-Content .env.local | ForEach-Object { if ($_ -match '^\s*([^#][^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim()) } }
New-Item -ItemType Directory -Force -Path data | Out-Null
if (!(Test-Path node_modules)) { Write-Host "-> Installation des dependances (une seule fois, patientez)..."; npm ci; if ($LASTEXITCODE -ne 0) { npm install } }
if (!(Test-Path data/database.db) -and (Test-Path seed.db)) { Copy-Item seed.db data/database.db; Write-Host "→ Base initialisee depuis seed.db" }
[Environment]::SetEnvironmentVariable('SYNC_ENABLED','true')
if (-not $env:DB_PATH) { [Environment]::SetEnvironmentVariable('DB_PATH','./data/database.db') }
if (-not $env:PORT) { [Environment]::SetEnvironmentVariable('PORT','3000') }
if (-not $env:DEPLOYMENT_MODE) { [Environment]::SetEnvironmentVariable('DEPLOYMENT_MODE','dedicated') }
node init-db.js 2>$null
node migrate-db.js 2>$null
Write-Host "→ Serveur local demarre (synchro auto -> $env:SYNC_REMOTE_URL)"
node server.js
