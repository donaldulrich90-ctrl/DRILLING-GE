#!/usr/bin/env sh
# Déploiement Docker — GOOD ENGINEERS-DRILL
# Exécuter sur la machine où se trouve docker-compose.yml (souvent le serveur Linux).
#
# Usage (depuis la racine du projet) :
#   chmod +x scripts/deploy-docker.sh
#   ./scripts/deploy-docker.sh
#   ./scripts/deploy-docker.sh --no-build          # redémarrage sans reconstruire l'image
#   ./scripts/deploy-docker.sh --migrate-only      # uniquement node migrate-db.js dans le conteneur
#
# Variables optionnelles :
#   COMPOSE_FILE=docker-compose.yml (défaut)
#   DOCKER_SERVICE=app              (nom du service dans compose, défaut: app)

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
SERVICE="${DOCKER_SERVICE:-app}"

NO_BUILD=0
MIGRATE_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --migrate-only) MIGRATE_ONLY=1 ;;
    -h|--help)
      echo "Usage: $0 [--no-build] [--migrate-only]"
      echo "  --no-build     docker compose up -d sans --build"
      echo "  --migrate-only exécute seulement migrate-db.js dans le service"
      exit 0
      ;;
  esac
done

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Erreur : $COMPOSE_FILE introuvable dans $ROOT"
  exit 1
fi

if [ "$MIGRATE_ONLY" = 1 ]; then
  echo ">>> Migration (service: $SERVICE)..."
  compose exec "$SERVICE" sh -c "cd /app && node migrate-db.js"
  echo ">>> OK."
  exit 0
fi

if [ "$NO_BUILD" = 1 ]; then
  echo ">>> docker compose up -d (sans rebuild)..."
  compose up -d
else
  echo ">>> docker compose up -d --build..."
  compose up -d --build
fi

echo ">>> Migrations explicites (node migrate-db.js)..."
compose exec "$SERVICE" sh -c "cd /app && node migrate-db.js"

echo ">>> État des conteneurs :"
compose ps

echo ">>> Déploiement terminé."
