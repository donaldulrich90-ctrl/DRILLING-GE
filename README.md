# Plateforme de Monitoring - Forage Minier

Plateforme de monitoring en temps réel pour les opérations de forage minier.

## Fonctionnalités

- **Monitoring en temps réel** : Affichage des données de télémétrie (pression de rotation, température hydraulique, profondeur)
- **Graphiques de performance** : Visualisation de la vitesse de pénétration (ROP) sur les dernières 24 heures
- **Alertes** : Notifications pour les révisions de maintenance

## Installation

1. Installer les dépendances :
```bash
npm install
```

## Démarrage

Pour lancer l’API et l’application principale en mode développement :

```bash
npm run dev
```

L’application principale sera accessible à l’adresse `http://localhost:3000`.

Pour lancer séparément le tableau de monitoring React avec Vite :

```bash
npm run dev:frontend
```

Le serveur Vite sera alors accessible à l’adresse `http://localhost:5173`.

## Build pour production

Pour créer une version de production :

```bash
npm run build
```

Pour prévisualiser la version de production :

```bash
npm run preview
```

## Vérification rapide

Le test d’intégration démarre l’API sur un port libre avec une base SQLite temporaire. Il ne modifie pas `database.db`.

```bash
npm run test:smoke
```

Il vérifie la santé de l’API, l’authentification JWT, l’isolation entre entreprises, les droits de gestion des comptes et l’absence de mots de passe stockés en clair.

Pour exécuter aussi les contrôles de syntaxe :

```bash
npm test
```

## Technologies utilisées

- React 18
- Vite
- Recharts (graphiques)
- Tailwind CSS (styles)


