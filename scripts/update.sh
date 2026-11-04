#!/bin/sh
# ── Mise à jour du logiciel GEDRILLING (instance LOCALE) ──────────────────────
# À lancer QUAND INTERNET EST DISPONIBLE. Récupère la dernière version depuis
# GitHub, reconstruit et relance. N'efface JAMAIS la base de données (/data).
#
#   Usage :  ./scripts/update.sh            (mode Docker, par défaut)
#            ./scripts/update.sh node       (mode sans Docker)
set -e
cd "$(dirname "$0")/.."
MODE="${1:-docker}"

echo "→ Sauvegarde de sécurité de la base avant mise à jour…"
if [ -f ./backup-db.js ]; then node backup-db.js 2>/dev/null || true; fi

echo "→ Récupération de la dernière version (git pull)…"
git fetch --all
git reset --hard origin/main

if [ "$MODE" = "node" ]; then
  echo "→ Installation des dépendances + build…"
  npm ci
  npm run build
  echo "✅ Mise à jour terminée. Relancez le serveur :  DB_PATH=./data/database.db PORT=3000 node server.js"
else
  echo "→ Reconstruction de l'image Docker…"
  docker build -t gedrilling .
  echo "→ Redémarrage du conteneur (la base /data est conservée)…"
  docker stop gedrilling 2>/dev/null || true
  docker rm gedrilling 2>/dev/null || true
  docker run -d -p 3000:3000 -v "$(pwd)/data:/data" --name gedrilling gedrilling
  echo "✅ Mise à jour terminée. La plateforme locale tourne sur http://IP-DU-SERVEUR:3000"
fi
