#!/bin/sh
# ── Démarrage du SERVEUR LOCAL (au site) avec synchro automatique ────────────
# 1) Copiez .env.local.example en .env.local et remplissez l'URL + le mot de passe.
# 2) (option) Pour partir des données EN LIGNE sans rien reconfigurer : téléchargez
#    une sauvegarde depuis le serveur en ligne (Entreprises → Télécharger une
#    sauvegarde), renommez-la « seed.db » et placez-la ici. Elle sera utilisée au
#    premier démarrage.
# 3) Lancez : ./scripts/start-local.sh
set -e
cd "$(dirname "$0")/.."
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; else echo "⚠️  .env.local manquant — copiez .env.local.example en .env.local et remplissez-le."; exit 1; fi
mkdir -p data
if [ ! -d node_modules ]; then echo "→ Installation des dépendances (une seule fois, patientez)…"; npm ci || npm install; fi
if [ ! -f data/database.db ] && [ -f seed.db ]; then cp seed.db data/database.db; echo "→ Base initialisée depuis seed.db (données du serveur en ligne)."; fi
export SYNC_ENABLED=true
export DB_PATH="${DB_PATH:-./data/database.db}"
export PORT="${PORT:-3000}"
export DEPLOYMENT_MODE="${DEPLOYMENT_MODE:-dedicated}"
node init-db.js 2>/dev/null || true
node migrate-db.js 2>/dev/null || true
echo "→ Serveur local démarré sur http://IP-DU-SERVEUR:${PORT}  (synchro auto → ${SYNC_REMOTE_URL})"
node server.js
