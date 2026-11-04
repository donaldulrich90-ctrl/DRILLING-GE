# Mise à jour du logiciel GEDRILLING (instance LOCALE) — Windows PowerShell.
# À lancer QUAND INTERNET EST DISPONIBLE. N'efface jamais la base (dossier data).
#   Usage :  .\scripts\update.ps1           (Docker)
#            .\scripts\update.ps1 node      (sans Docker)
param([string]$Mode = "docker")
Set-Location (Join-Path $PSScriptRoot "..")
Write-Host "→ Sauvegarde de securite de la base…"
if (Test-Path ./backup-db.js) { node backup-db.js } 
Write-Host "→ Recuperation de la derniere version…"
git fetch --all
git reset --hard origin/main
if ($Mode -eq "node") {
  npm ci
  npm run build
  Write-Host "✅ Termine. Relancez : node server.js"
} else {
  docker build -t gedrilling .
  docker stop gedrilling 2>$null
  docker rm gedrilling 2>$null
  docker run -d -p 3000:3000 -v "$((Get-Location).Path)/data:/data" --name gedrilling gedrilling
  Write-Host "✅ Termine. http://IP-DU-SERVEUR:3000"
}
