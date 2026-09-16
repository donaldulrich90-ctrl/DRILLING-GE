# Base de Données - GOOD ENGINEERS-DRILL

## Installation

### 1. Installer Node.js
Téléchargez et installez Node.js depuis https://nodejs.org/ (version 16 ou supérieure)

### 2. Installer les dépendances
```bash
npm install
```

### 3. Initialiser la base de données
```bash
npm run init-db
```

Cette commande va :
- Créer le fichier `database.db` (SQLite)
- Créer toutes les tables nécessaires
- Insérer les données par défaut (utilisateur admin, machines de démo)

### 4. Démarrer le serveur
```bash
npm start
```

Le serveur API sera accessible sur : **http://localhost:3000**

## Structure de la Base de Données

### Tables principales :
- **users** - Utilisateurs et comptes
- **drills** - Machines de forage
- **clients** - Clients/entreprises
- **contracts** - Contrats signés
- **employees** - Employés (foreurs, ingénieurs, etc.)
- **assignments** - Assignations machines/opérateurs
- **invoices** - Factures
- **inventory** - Inventaire/stock
- **dailyDataRecords** - Données journalières
- **companyInfo** - Informations de l'entreprise
- **stockMovements** - Mouvements de stock
- **maintenanceSchedules** - Planifications de maintenance
- **maintenanceHistory** - Historique de maintenance
- **miscellaneousExpenses** - Dépenses diverses

## API Endpoints

### Utilisateurs
- `GET /api/users` - Liste des utilisateurs
- `POST /api/users` - Créer un utilisateur
- `PUT /api/users/:username` - Modifier un utilisateur
- `DELETE /api/users/:username` - Supprimer un utilisateur

### Machines
- `GET /api/drills` - Liste des machines
- `POST /api/drills` - Créer une machine
- `PUT /api/drills/:id` - Modifier une machine

### Clients
- `GET /api/clients` - Liste des clients
- `POST /api/clients` - Créer un client
- `PUT /api/clients/:id` - Modifier un client
- `DELETE /api/clients/:id` - Supprimer un client

### Contrats
- `GET /api/contracts` - Liste des contrats
- `POST /api/contracts` - Créer un contrat
- `PUT /api/contracts/:id` - Modifier un contrat
- `DELETE /api/contracts/:id` - Supprimer un contrat

### Employés
- `GET /api/employees` - Liste des employés
- `POST /api/employees` - Créer un employé
- `PUT /api/employees/:id` - Modifier un employé
- `DELETE /api/employees/:id` - Supprimer un employé

### Assignations
- `GET /api/assignments` - Liste des assignations
- `POST /api/assignments` - Créer une assignation
- `PUT /api/assignments/:id` - Modifier une assignation
- `DELETE /api/assignments/:id` - Supprimer une assignation

### Factures
- `GET /api/invoices` - Liste des factures
- `POST /api/invoices` - Créer une facture
- `PUT /api/invoices/:id` - Modifier une facture

### Inventaire
- `GET /api/inventory` - Liste de l'inventaire
- `POST /api/inventory` - Ajouter un article
- `PUT /api/inventory/:id` - Modifier un article

### Données Journalières
- `GET /api/daily-data?date=YYYY-MM-DD&machineId=XXX` - Récupérer les données
- `POST /api/daily-data` - Enregistrer/mettre à jour les données

### Entreprise
- `GET /api/company` - Informations de l'entreprise
- `POST /api/company` - Mettre à jour les informations
- `POST /api/company/logo` - Mettre à jour le logo

### Santé
- `GET /api/health` - Vérifier l'état du serveur

## Migration depuis localStorage

Pour migrer les données existantes depuis localStorage vers la base de données, vous devrez :

1. Exporter les données depuis localStorage (via la console du navigateur)
2. Utiliser les endpoints API pour importer les données

## Développement

Pour le développement avec rechargement automatique :
```bash
npm run dev
```

## Production

Pour la production, vous pouvez :
1. Utiliser SQLite (actuel) - Simple mais limité
2. Migrer vers PostgreSQL ou MySQL pour plus de performance
3. Utiliser un service cloud (Firebase, Supabase, etc.)

## Notes

- La base de données SQLite est stockée dans `database.db`
- Les données JSON complexes sont stockées en tant que TEXT et parsées automatiquement
- Le serveur sauvegarde automatiquement toutes les modifications
- Pour la production, envisagez d'ajouter l'authentification JWT

