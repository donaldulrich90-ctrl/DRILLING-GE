# ── Stage 1 : build React + install deps ──────────────────────────────────────
FROM node:20-alpine AS builder

# Outils natifs pour la compilation de sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./

# Toutes les dépendances (devDeps nécessaires pour vite build)
RUN npm ci --include=dev

COPY . .

# Compiler le frontend React → dist/
RUN npm run build

# Supprimer les devDependencies après le build
RUN npm prune --omit=dev

# ── Stage 2 : image de production ─────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Code source (node_modules et dist exclus via .dockerignore)
COPY . .
# Écraser avec les artefacts compilés du builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist

# Répertoire pour la base de données (volume persistant Coolify)
RUN mkdir -p /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENV NODE_ENV=production
ENV DEPLOYMENT_MODE=dedicated
ENV DB_PATH=/data/database.db
ENV PORT=3000
ENV TRUST_PROXY=1

# Init DB si première création, puis lancer
CMD sh -c "node init-db.js 2>/dev/null || true; node migrate-db.js 2>/dev/null || true; node server.js"
