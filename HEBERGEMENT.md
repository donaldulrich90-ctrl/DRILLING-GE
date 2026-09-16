# Hébergement en ligne et comptes clients — GOOD ENGINEERS-DRILL

## Lancer la plateforme depuis le dossier (Windows)

1. Installez [Node.js LTS](https://nodejs.org) si ce n’est pas déjà fait.
2. Double-cliquez sur **`LANCER.bat`** dans le dossier du projet  
   **ou** ouvrez un terminal dans ce dossier et exécutez :
   ```bash
   npm install
   npm run init-db
   npm start
   ```
3. Ouvrez votre navigateur sur **http://localhost:3000** (le port par défaut est `3000`).

> Ne pas ouvrir seulement `plateforme-forage.html` en double-clic : l’API ne fonctionnera pas sans le serveur Node.

---

## Utilisation en ligne (Internet)

L’application est servie par **un seul serveur** (page HTML + API `/api`).  
Le fichier **`api-client.js`** appelle automatiquement la même origine que le site  
(ex. `https://votredomaine.com` → API `https://votredomaine.com/api`).

### Déploiement recommandé

- **VPS ou machine Windows/Linux** avec Node.js ou **Docker** (`docker-compose up -d --build`).
- Pointez un nom de domaine vers l’IP du serveur.
- Mettez **HTTPS** devant le serveur avec **Nginx**, **Caddy** ou le panneau de votre hébergeur.

Exemple de variables utiles :

| Variable | Rôle |
|----------|------|
| `PORT` | Port d’écoute (souvent `3000` en interne, Nginx écoute 80/443) |
| `TRUST_PROXY=1` | À activer si vous êtes derrière un reverse proxy (HTTPS) |
| `DEPLOYMENT_MODE` | `dedicated` = une instance par client ; `shared` = plusieurs entreprises sur la même instance |
| `DB_PATH` | Chemin du fichier SQLite (ex. sous Docker `/data/database.db`) |
| `JWT_SECRET` | **Obligatoire en production** : clé secrète longue et aléatoire pour signer les tokens de session |
| `JWT_EXPIRES_IN` | Durée du token (défaut : `7d`) |

Après mise à jour du code, exécutez **`npm run migrate`** sur le serveur (ou laissez le conteneur Docker lancer les migrations au démarrage). Cela applique les évolutions de schéma (mots de passe hachés, colonnes `dailyDataRecords`, etc.). Les anciens mots de passe en clair restent valides une fois : au premier login réussi, un hash est enregistré.

### Mettre à jour une instance déjà en ligne

**Avec Docker** (recommandé, même machine que le développement) :

1. Copiez le dossier projet à jour sur le serveur (Git, FTP, clé USB, etc.) — **ne remplacez pas** le volume ou le fichier `database.db` de production par une copie locale vide.
2. Dans le dossier qui contient `docker-compose.yml` :
   - Windows : `.\scripts\deploy-docker.ps1`
   - Linux/macOS : `./scripts/deploy-docker.sh`
3. Ou manuellement : `docker compose up -d --build` puis `docker compose exec app sh -c "cd /app && node migrate-db.js"`.

Le `Dockerfile` relance aussi `migrate-db.js` au démarrage du conteneur ; le script PowerShell/shell exécute une migration explicite après le build.

**Sans Docker** (Node.js installé sur le VPS ou le serveur) :

1. Sauvegardez la base : `npm run backup` ou copie de `database.db`.
2. Déployez les fichiers (Git `pull`, ou copie des sources) **sans écraser** `database.db` sur le serveur.
3. `npm ci --omit=dev` (ou `npm install --omit=dev`).
4. `npm run migrate`
5. Redémarrez le processus (`pm2 restart`, service systemd, ou arrêt/relance de `node server.js`).

En production, définissez `JWT_SECRET`, `TRUST_PROXY=1` derrière HTTPS, et gardez des sauvegardes régulières de la base.

### API sur un autre sous-domaine (optionnel)

Si l’API est sur un autre hôte, avant le chargement de `api-client.js`, dans `plateforme-forage.html` :

```html
<script>window.__FORAGE_API_URL__ = 'https://api.votredomaine.com';</script>
<script src="api-client.js"></script>
```

---

## Donner des comptes d’utilisation à vos clients

### Instance dédiée par client (`DEPLOYMENT_MODE=dedicated`)

- Chaque client a un **serveur** (ou conteneur) distinct avec sa base.
- Connectez-vous avec un compte **administrateur de l’entreprise** (rôle `admin`, créé pour ce client) → section **Comptes** : ajoutez les autres utilisateurs du client.
- Vous communiquez le **lien** (ex. `https://forage-client-a.entreprise.com`) et leurs **identifiants**.

### Plusieurs clients sur une même plateforme (`DEPLOYMENT_MODE=shared`)

- Une seule installation ; plusieurs **entreprises** dans la base.
- Compte **gestion abonnements** (`gestion_abonnements` après `npm run init-db` ou `npm run migrate`) : création d’entreprises, abonnements, suppression (rôle `platform_owner`). Le mot de passe initial vient de `INITIAL_PLATFORM_PASSWORD` ou est généré lors de l’initialisation. Le compte **`admin` super_admin n’est plus créé** ; supprimez-le en base si vous l’aviez encore (`npm run migrate` le retire).
- Pour chaque entreprise : créez les **utilisateurs** liés à l’`enterpriseId` correspondant (via l’interface Comptes ou l’API `POST /api/users`).
- Chaque client se connecte avec **son** compte et ne voit que les données de son entreprise (selon les rôles et restrictions).

### Sécurité en production

- Définissez `JWT_SECRET`, `INITIAL_PLATFORM_PASSWORD` et `CORS_ORIGINS` avant le déploiement.
- Utilisez **HTTPS** uniquement.
- Sauvegardez la base : `npm run backup` ou copie de `database.db`.

---

## Docker (rappel)

```bash
docker-compose up -d --build
```

Voir **DOCKER.md** pour les volumes et la persistance des données.
