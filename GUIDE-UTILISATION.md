# Guide d'utilisation — GEDRILLING
### Plateforme de gestion des opérations de forage minier

---

## Table des matières

1. [Présentation de la plateforme](#1-présentation)
2. [Démarrage rapide](#2-démarrage-rapide)
3. [Connexion et rôles utilisateurs](#3-connexion-et-rôles)
4. [Navigation générale](#4-navigation-générale)
5. [Modules de la plateforme](#5-modules)
   - [Tableau de bord](#51-tableau-de-bord)
   - [Foreuses et connexions](#52-foreuses-et-connexions)
   - [Assignations](#53-assignations)
   - [Clients](#54-clients)
   - [Sites](#55-sites)
   - [Contrats](#56-contrats)
   - [Factures](#57-factures)
   - [Revenus](#58-revenus)
   - [Consommables et Stocks](#59-consommables-et-stocks)
   - [Ressources Humaines](#510-ressources-humaines)
   - [Maintenance](#511-maintenance)
   - [Plan de Forage](#512-plan-de-forage)
   - [Pilotage projet](#513-pilotage-projet)
   - [Rentabilité Consommables](#514-rentabilité-consommables)
   - [Dépenses PM](#515-dépenses-pm)
   - [Performance (Analytics)](#516-performance-analytics)
   - [Santé & Sécurité (HSE)](#517-santé--sécurité-hse)
   - [Rapports](#518-rapports)
   - [Repas chantier](#519-repas-chantier)
   - [Traducteur](#520-traducteur)
   - [Équipe (Chat)](#521-équipe-chat)
   - [Infos entreprise](#522-infos-entreprise)
   - [Comptes utilisateurs](#523-comptes-utilisateurs)
   - [Entreprises (admin plateforme)](#524-entreprises-admin-plateforme)
6. [Fiche opérateur — Saisie journalière](#6-fiche-opérateur)
7. [Gestion multi-entreprises](#7-multi-entreprises)
8. [Sauvegarde et restauration](#8-sauvegarde-et-restauration)
9. [Hébergement et déploiement](#9-hébergement-et-déploiement)
10. [Dépannage](#10-dépannage)

---

## 1. Présentation

**GEDRILLING** (Good Engineers Drilling) est une plateforme web complète de gestion des opérations de forage minier. Elle couvre :

- La gestion des **foreuses** (machines) et de leur état
- Le suivi des **chantiers / sites** et des **clients**
- La gestion des **contrats** et des **factures**
- Le suivi des **consommables** et des **stocks**
- La gestion des **ressources humaines** et des **salaires**
- Le suivi de la **maintenance** des équipements
- La planification et le pilotage des **plans de forage**
- Les indicateurs de **performance** et de **rentabilité**
- La gestion **HSE** (Hygiène, Sécurité, Environnement)
- Un système multi-entreprises avec gestion des **abonnements**

---

## 2. Démarrage rapide

### Prérequis

- [Node.js](https://nodejs.org) version 16 ou supérieure

### Lancement sous Windows (méthode simple)

Double-cliquez sur le fichier **`LANCER.bat`** dans le dossier du projet.

### Lancement manuel (terminal)

```bash
# 1. Installer les dépendances
npm install

# 2. Initialiser la base de données (première fois uniquement)
npm run init-db

# 3. Démarrer le serveur
npm start
```

Ouvrez ensuite votre navigateur sur : **http://localhost:3000**

> **Important** : ne pas ouvrir `plateforme-forage.html` directement en double-clic — l'API ne fonctionnera pas sans le serveur Node.

---

## 3. Connexion et rôles

### Accès à la page de connexion

L'application affiche un écran de connexion au démarrage. Saisissez votre **nom d'utilisateur** et votre **mot de passe**.

### Rôles disponibles

| Rôle | Accès |
|------|-------|
| `super_admin` / `admin` | Accès total à toutes les fonctionnalités de l'entreprise |
| `platform_owner` / `gestion_abonnements` | Gestion de toutes les entreprises (multi-tenant) |
| `gestionnaire_site` | Gestion des sites et opérations terrain |
| `foreur` | Saisie des données opérationnelles, fiche journalière |
| Utilisateur restreint | Accès limité aux onglets autorisés par l'administrateur |

### Création du premier compte (après `npm run init-db`)

| Mode | Identifiant | Mot de passe initial |
|------|-------------|--------------|
| Mode dédié (1 entreprise) | Créé par l’administrateur | Défini via `INITIAL_PLATFORM_PASSWORD` |
| Mode partagé (multi-tenant) | `gestion_abonnements` | Défini via `INITIAL_PLATFORM_PASSWORD` |
| Opérateur terrain | Créé dans l’interface | Défini lors de la création |

> Ne placez jamais de mot de passe réel dans cette documentation. Utilisez une variable d’environnement ou le gestionnaire de comptes.

### Sélecteur d'entreprise (mode multi-tenant)

L'en-tête affiche un menu déroulant **"Entreprise"** permettant à l'administrateur plateforme de basculer entre les entreprises clientes.

---

## 4. Navigation générale

L'interface est composée de :

- **Barre latérale gauche (sidebar)** : menu de navigation principal avec tous les modules
- **En-tête (header)** : logo, sélecteur d'entreprise, langue, informations utilisateur
- **Zone de travail centrale** : contenu du module sélectionné

Cliquez sur n'importe quel élément du menu latéral pour changer de section. L'élément actif est surligné en jaune.

---

## 5. Modules

### 5.1 Tableau de bord

Vue d'ensemble synthétique de l'activité :

- **KPI principaux** : nombre de foreuses actives, chiffre d'affaires, contrats en cours
- **Graphiques** : suivi des revenus, de la production, des alertes maintenance
- **Activité récente** : dernières opérations enregistrées

### 5.2 Foreuses et connexions

**Connexions** : liste et état de toutes les foreuses (machines de forage) :

- Ajout, modification et suppression de foreuses
- Statut de chaque machine (active, en maintenance, hors service)
- Affectation d'une machine à un site et à un opérateur

Pour ajouter une foreuse :
1. Aller dans **Connexions**
2. Cliquer **Ajouter une foreuse**
3. Renseigner : nom, modèle, numéro de série, site affecté
4. Valider

### 5.3 Assignations

Gestion des affectations employé ↔ machine ↔ site :

- Assigner un opérateur à une foreuse pour une période donnée
- Visualiser l'historique des assignations
- Éviter les conflits de planning

### 5.4 Clients

Répertoire des clients (entreprises minières) :

- Nom, contact, adresse, informations légales
- Contrats associés à chaque client
- Historique des factures par client

### 5.5 Sites

Gestion des chantiers de forage :

- Nom du site, localisation géographique
- Foreuses et équipes affectées
- Contrats et paramètres de production liés au site

### 5.6 Contrats

Suivi complet des contrats clients :

- Création d'un contrat : client, site, dates, prix unitaires
- Suivi de l'avancement (mètres forés vs contractés)
- Alertes de dépassement ou de fin de contrat

### 5.7 Factures

Facturation des prestations :

- Génération automatique depuis un contrat
- Personnalisation : lignes de facturation, taxes, remises
- Impression / export PDF de la facture
- Suivi du statut de paiement (émise, payée, en retard)

### 5.8 Revenus

Tableau de bord financier détaillé :

- Revenus par mois / trimestre / année
- Répartition par client et par site
- Comparaison budget vs réalisé

### 5.9 Consommables et Stocks

**Consommables** : suivi de la consommation des fournitures de forage :

- Bits (trépans), tiges, carburant, produits chimiques, etc.
- Saisie des entrées et sorties de stock
- Alertes de niveau minimum

**Stocks** : état du stock en temps réel, valorisation, mouvements.

### 5.10 Ressources Humaines

Gestion du personnel :

- Fichier des employés : nom, poste, qualifications, contact
- **Salaires** : calcul des fiches de paie, cotisations sociales
- Suivi des présences et absences
- Impression de bulletins de salaire

### 5.11 Maintenance

Suivi de la maintenance préventive et corrective :

- Planification des révisions périodiques (par heure-machine ou par date)
- Enregistrement des interventions : date, technicien, pièces changées, coût
- Alertes de maintenance à venir
- Historique complet par équipement

### 5.12 Plan de Forage

Planification et suivi du programme de forage :

- Saisie du plan de forage (trous, profondeurs cibles, azimuts)
- Suivi de l'avancement trou par trou
- Comparaison plan vs réalisé

### 5.13 Pilotage projet

Vue de pilotage pour les responsables :

- Avancement global du projet
- Indicateurs clés : mètres forés, productivité, taux de disponibilité
- Alertes sur les dérives calendaires ou budgétaires

### 5.14 Rentabilité Consommables

Analyse de la rentabilité des consommables :

- Coût réel par mètre foré
- Comparaison des prix fournisseurs
- Identification des postes de dépenses excessifs

### 5.15 Dépenses PM

Suivi des dépenses par poste de maintenance (PM = Preventive Maintenance) :

- Coût des pièces et main-d'œuvre par machine
- Tendances de dépenses dans le temps
- Budget maintenance vs réalisé

### 5.16 Performance (Analytics)

Indicateurs de performance opérationnelle :

- ROP (Rate of Penetration / Vitesse de pénétration)
- Taux de disponibilité des machines
- Temps non-productifs (arrêts, pannes, météo)
- Graphiques sur les 24 dernières heures et sur des périodes personnalisées

### 5.17 Santé & Sécurité (HSE)

Module de gestion HSE :

- Enregistrement des incidents et accidents
- Fiches de sécurité par type d'opération
- Suivi des formations et habilitations du personnel
- Statistiques sécurité (taux de fréquence, gravité)

### 5.18 Rapports

Génération de rapports exportables :

- Rapport journalier de production
- Rapport mensuel de facturation
- Rapport de maintenance
- Export vers PDF ou impression directe

### 5.19 Repas chantier

Gestion des repas sur site :

- Saisie du nombre de repas par jour et par équipe
- Suivi des coûts de restauration
- Reporting mensuel

### 5.20 Traducteur

Outil de traduction intégré pour les documents et communications :

- Traduction automatique via DeepL (si clé API configurée), LibreTranslate ou MyMemory
- Langues supportées : français, anglais, arabe et autres
- Traduction de textes libres ou de champs de formulaire

Pour utiliser DeepL, configurez la variable d'environnement `DEEPL_API_KEY` sur le serveur.

### 5.21 Équipe (Chat)

Messagerie interne pour l'équipe :

- Discussions en temps réel entre les membres connectés
- Envoi de messages courts, partage d'informations terrain
- Historique des échanges

### 5.22 Infos entreprise

Paramètres et informations de l'entreprise :

- Nom, logo, adresse, coordonnées
- Paramètres de facturation (devise, TVA, mentions légales)
- Logo affiché sur les factures et les fiches de paie

### 5.23 Comptes utilisateurs

Gestion des accès à la plateforme :

- Création, modification et suppression de comptes
- Attribution des rôles et des onglets autorisés
- Réinitialisation des mots de passe
- Restriction d'accès par site

Pour créer un utilisateur :
1. Aller dans **Comptes**
2. Cliquer **Ajouter un compte**
3. Saisir identifiant, mot de passe, rôle
4. Cocher les onglets auxquels l'utilisateur a accès
5. Valider

### 5.24 Entreprises (admin plateforme)

Visible uniquement pour le rôle `platform_owner` / `gestion_abonnements` :

- Liste de toutes les entreprises clientes hébergées
- Création d'une nouvelle entreprise (abonnement)
- Gestion des quotas : nombre de sites, d'utilisateurs, d'onglets accessibles
- Suspension ou suppression d'un compte entreprise

---

## 6. Fiche opérateur — Saisie journalière

Le fichier `fiche-operateur-saisie-journaliere.html` est une **fiche de saisie terrain imprimable au format A4**.

### Utilisation

1. Ouvrez `fiche-operateur-saisie-journaliere.html` dans un navigateur
2. Remplissez les champs : date, machine, opérateur, site, trous forés, profondeurs, incidents
3. Imprimez (Ctrl+P) ou générez un PDF via l'imprimante de votre navigateur
4. L'opérateur signe la fiche, puis les données sont ressaisies dans la plateforme

### Contenu de la fiche

- Informations générales (machine, site, équipe, date)
- Tableau des trous forés dans la journée (profondeur, azimut, inclinaison)
- Suivi des consommables utilisés
- Incidents / arrêts (raison, durée)
- Vérifications HSE quotidiennes (check-list)
- Signature de l'opérateur et du superviseur

---

## 7. Multi-entreprises

### Mode dédié (`DEPLOYMENT_MODE=dedicated`)

Une instance par client. Chaque client a son propre serveur (ou conteneur Docker) avec sa propre base de données. C'est le mode par défaut.

### Mode partagé (`DEPLOYMENT_MODE=shared`)

Plusieurs entreprises partagent la même installation. Le compte `gestion_abonnements` gère les entreprises depuis l'onglet **Entreprises**.

Workflow :
1. Se connecter en tant que `gestion_abonnements`
2. Aller dans **Entreprises** → **Ajouter une entreprise**
3. Définir les quotas (sites, utilisateurs, onglets)
4. Créer les comptes utilisateurs pour cette entreprise (onglet **Comptes**, avec l'`enterpriseId` correspondant)
5. Communiquer les identifiants au client

---

## 8. Sauvegarde et restauration

### Sauvegarder la base de données

```bash
# Sauvegarde rapide (copie du fichier SQLite)
npm run backup

# Sauvegarde complète avec compression
npm run backup:full

# Lister les sauvegardes disponibles
npm run backup:list

# Supprimer les anciennes sauvegardes
npm run backup:prune
```

Les sauvegardes sont stockées dans le dossier **`backups/`**.

### Restaurer une sauvegarde

```bash
npm run restore-backup
```

Le script vous demande de choisir la sauvegarde à restaurer parmi la liste disponible.

### Bonnes pratiques

- Effectuez une sauvegarde avant toute mise à jour
- En production, automatisez les sauvegardes (tâche planifiée ou cron)
- Conservez des copies hors site (cloud, autre machine)

---

## 9. Hébergement et déploiement

### Variables d'environnement importantes

| Variable | Description | Défaut |
|----------|-------------|--------|
| `PORT` | Port d'écoute du serveur | `3000` |
| `JWT_SECRET` | Clé secrète pour les tokens de session — **obligatoire en production** | (non sécurisé) |
| `JWT_EXPIRES_IN` | Durée de validité des sessions | `7d` |
| `TRUST_PROXY` | Mettre à `1` derrière Nginx/Cloudflare | — |
| `DEPLOYMENT_MODE` | `dedicated` ou `shared` | `dedicated` |
| `DB_PATH` | Chemin du fichier SQLite | `./database.db` |
| `DEEPL_API_KEY` | Clé API DeepL pour le traducteur | — |

### Avec Docker

```bash
# Démarrer (première fois ou après mise à jour)
docker-compose up -d --build

# Voir les logs
docker-compose logs -f

# Arrêter
docker-compose down
```

Voir **`DOCKER.md`** pour les détails sur les volumes et la persistance.

### Mise à jour d'une instance existante

```bash
# 1. Sauvegarder la base
npm run backup

# 2. Déployer les nouveaux fichiers (sans écraser database.db)

# 3. Mettre à jour les dépendances
npm ci --omit=dev

# 4. Appliquer les migrations de base de données
npm run migrate

# 5. Redémarrer le serveur (pm2, systemd, etc.)
```

---

## 10. Dépannage

### Le serveur ne démarre pas

```bash
# Vérifier Node.js
node --version   # doit afficher v16 ou supérieur

# Vérifier les dépendances
npm list --depth=0

# Réinstaller si nécessaire
npm install
```

### La base de données n'existe pas

```bash
npm run init-db
```

### Erreur "Cannot find module"

```bash
npm install
```

### L'application charge mais les données ne s'affichent pas

1. Vérifiez que le serveur Node tourne (`npm start` dans le terminal)
2. Ouvrez la console du navigateur (F12 → Console)
3. Recherchez des erreurs réseau ou des messages d'API
4. Vérifiez que `useAPI = true` dans `plateforme-forage.html` si vous utilisez la base de données

### Mot de passe oublié

L'administrateur peut réinitialiser le mot de passe de n'importe quel utilisateur depuis **Comptes** → modifier l'utilisateur → nouveau mot de passe.

Si l'administrateur lui-même est bloqué, modifiez directement la base :

```bash
# Utiliser un client SQLite (ex. DB Browser for SQLite)
# Mettre à jour le champ password dans la table users
```

### Réinitialiser toutes les données d'une entreprise

```bash
npm run clear-enterprise-data
```

> Opération irréversible — sauvegardez d'abord avec `npm run backup`.

---

*Guide préparé pour GEDRILLING — Good Engineers Drilling. Version plateforme : 1.0.0*
