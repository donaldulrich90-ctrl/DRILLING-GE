# Instructions d'Installation - Base de Données

## 🚀 Installation Rapide

### Étape 1 : Installer Node.js
Téléchargez et installez Node.js depuis https://nodejs.org/ (version 16 ou supérieure)

### Étape 2 : Installer les dépendances
Ouvrez un terminal dans le dossier du projet et exécutez :
```bash
npm install
```

### Étape 3 : Initialiser la base de données
```bash
npm run init-db
```

Cette commande va créer le fichier `database.db` avec toutes les tables nécessaires.

### Étape 4 : Démarrer le serveur API
```bash
npm start
```

Le serveur sera accessible sur **http://localhost:3000**

### Étape 5 : Activer l'API dans le frontend
1. Ouvrez `plateforme-forage.html` dans un éditeur
2. Cherchez la ligne : `var useAPI = false;`
3. Changez-la en : `var useAPI = true;`
4. Sauvegardez le fichier

### Étape 6 : Ouvrir l'application
Ouvrez `plateforme-forage.html` dans votre navigateur.

## 📋 Vérification

Pour vérifier que tout fonctionne :
1. Le serveur API doit afficher : `✅ Connecté à la base de données SQLite`
2. Dans la console du navigateur, vous devriez voir : `✅ API disponible, utilisation de la base de données`
3. Les données doivent se charger depuis l'API au lieu de localStorage

## 🔧 Dépannage

### Le serveur ne démarre pas
- Vérifiez que Node.js est installé : `node --version`
- Vérifiez que les dépendances sont installées : `npm list`

### L'API n'est pas accessible
- Vérifiez que le serveur tourne sur le port 3000
- Vérifiez les erreurs dans la console du serveur
- Assurez-vous que `useAPI = true` dans `plateforme-forage.html`

### Les données ne se chargent pas
- Vérifiez la console du navigateur pour les erreurs
- Vérifiez que `api-client.js` est bien chargé
- Si l'API n'est pas disponible, l'application utilisera automatiquement localStorage

## 📝 Notes

- Par défaut, l'application utilise localStorage (mode compatible)
- Pour utiliser la base de données, activez `useAPI = true`
- Les données sont sauvegardées automatiquement dans la base de données
- Le fichier `database.db` contient toutes vos données

## 👤 Administrateur général

**Identifiants :** `admin` / `admin`

L'administrateur général peut :
- Voir et gérer **toutes les entreprises**
- Choisir l'entreprise à afficher via le sélecteur "Entreprise" dans l'en-tête
- Créer de nouvelles entreprises (onglet Entreprises)
- Accéder à toutes les fonctionnalités

## 🏢 Multi-entreprises

Chaque entreprise a ses propres :
- Clients, Sites, Contrats
- Machines (foreuses), Employés, Assignations
- Factures, Inventaire, Paramètres

## 🔄 Migration vers multi-sites / multi-entreprises (base existante)

Si vous avez déjà une base de données :

```bash
npm run migrate
```

Cette commande ajoute les tables et colonnes nécessaires (sites, enterprises, enterpriseId) sans perdre vos données.

## 🔄 Migration des données

Si vous avez des données dans localStorage et voulez les migrer vers la base de données :

1. Gardez `useAPI = false` temporairement
2. Ouvrez l'application et laissez-la charger les données depuis localStorage
3. Changez `useAPI = true`
4. Les données seront automatiquement sauvegardées dans la base de données lors de la prochaine modification

