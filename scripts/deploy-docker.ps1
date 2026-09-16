# Déploiement Docker — GOOD ENGINEERS-DRILL (Windows / PowerShell)
# Exécuter depuis la racine du dépôt (là où se trouve docker-compose.yml).
#
# Usage :
#   .\scripts\deploy-docker.ps1
#   .\scripts\deploy-docker.ps1 -NoBuild
#   .\scripts\deploy-docker.ps1 -MigrateOnly

param(
    [switch]$NoBuild,
    [switch]$MigrateOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$composeFile = if ($env:COMPOSE_FILE) { $env:COMPOSE_FILE } else { "docker-compose.yml" }
$service = if ($env:DOCKER_SERVICE) { $env:DOCKER_SERVICE } else { "app" }

if (-not (Test-Path $composeFile)) {
    Write-Error "Fichier introuvable : $composeFile (répertoire : $Root)"
}

if ($MigrateOnly) {
    Write-Host ">>> Migration (service: $service)..."
    docker compose -f $composeFile exec $service sh -c "cd /app && node migrate-db.js"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host ">>> OK."
    exit 0
}

if ($NoBuild) {
    Write-Host ">>> docker compose up -d (sans rebuild)..."
    docker compose -f $composeFile up -d
} else {
    Write-Host ">>> docker compose up -d --build..."
    docker compose -f $composeFile up -d --build
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ">>> Migrations (node migrate-db.js)..."
docker compose -f $composeFile exec $service sh -c "cd /app && node migrate-db.js"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ">>> État des conteneurs :"
docker compose -f $composeFile ps

Write-Host ">>> Déploiement terminé."
