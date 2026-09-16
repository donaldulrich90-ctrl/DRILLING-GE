# Déploiement Docker - GOOD ENGINEERS-DRILL

Chaque entreprise peut déployer sa propre instance sur son serveur.

## Démarrage rapide

1. Définissez les secrets dans un fichier `.env` placé à côté de `docker-compose.yml` :

```dotenv
JWT_SECRET=remplacez-par-une-longue-valeur-aleatoire
INITIAL_PLATFORM_PASSWORD=remplacez-par-un-mot-de-passe-fort
CORS_ORIGINS=http://localhost:3000
```

Vous pouvez générer une valeur JWT avec `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

2. Construisez et démarrez l’application :

```bash
docker compose up -d --build
```

L'application sera accessible sur **http://localhost:3000**

## Configuration

### Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `DEPLOYMENT_MODE` | `dedicated` | `dedicated` = 1 instance/entreprise, `shared` = multi-tenant |
| `DB_PATH` | `/data/database.db` | Chemin du fichier SQLite |
| `PORT` | `3000` | Port du serveur |
| `JWT_SECRET` | aucun | Secret long obligatoire pour signer les sessions JWT |
| `INITIAL_PLATFORM_PASSWORD` | généré si absent | Mot de passe initial du compte plateforme lors de la première création de la base |
| `CORS_ORIGINS` | `http://localhost:3000` | Origines autorisées, séparées par des virgules |

### Personnalisation par entreprise

Modifiez `docker-compose.yml` pour ajouter des variables :

```yaml
environment:
  - DEPLOYMENT_MODE=dedicated
  - ENTERPRISE_NAME=Mon Entreprise
```

## Persistance des données

Le volume `drill-data` conserve la base de données entre les redémarrages.

## Commandes utiles

```bash
# Démarrer
docker-compose up -d --build

# Voir les logs et l’état de santé
docker compose logs -f
docker compose ps

# Arrêter
docker compose down

# Réinitialiser la base (supprime les données)
docker compose down -v
docker compose up -d --build
```

`docker compose down -v` supprime le volume SQLite. Ne l’utilisez qu’après une sauvegarde et seulement si vous voulez réellement effacer les données.

## Première connexion

- **Identifiant plateforme :** `gestion_abonnements`
- **Mot de passe :** valeur de `INITIAL_PLATFORM_PASSWORD`

Aucun compte métier de démonstration n’est créé. Ajoutez l’entreprise et son premier administrateur depuis l’écran de gestion des abonnements.

La sonde `GET /api/health` est utilisée par Docker pour vérifier que l’API et SQLite sont prêts.
