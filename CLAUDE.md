# CLAUDE.md — Projet GEDRILLING (GOOD ENGINEERS — Operations Control)

Ce fichier est lu automatiquement par Claude Code. Il donne le contexte, les
conventions et la feuille de route du projet. **Répondre en français.** Prendre
l'initiative et livrer un travail complet et actionnable.

Porteur du projet : **Donald (Ouedraogo Pengdwende Ulrich Donald)**, ingénieur
des mines et géologue, basé à **Ouagadougou (Burkina Faso)**.

## 1. Stack & architecture
- **Dépôt** : `donaldulrich90-ctrl/DRILLING-GE`.
- **Front** : application monopage `plateforme-forage.html` (HTML + JS « vanilla »,
  Tailwind, Chart.js). C'est le gros fichier (~2 Mo) ; la plupart de la logique UI
  y est en scripts inline.
- **Back** : **Node/Express** — `server.js` (point d'entrée), `routes/*.js`,
  `routes-collab.js`, client API `api-client.js`.
- **DB** : **SQLite** — `init-db.js` (schéma), `migrate-db.js` (migrations).
  En production la base est dans le volume Coolify `/data`.
- **Persistance générique** : table `module_state` (utilisée par les modules
  souterrain et HSE ; réutiliser ce modèle pour tout nouveau module).
- **Multi-tenant** : scoping systématique par `enterpriseId` (multi-entreprise /
  multi-site).

## 2. Conventions (à respecter)
- Interface et libellés **en français**.
- Devises : **FCFA (XOF) par défaut**, plus USD et EUR.
- **« Mois minier »** : jour de coupure configurable par site (≠ mois calendaire).
- Paie **CNSS Burkina Faso** : part salarié 5,5 %, heures sup 40 h/sem avec
  majorations +15 % / +35 %.
- **Ne jamais inventer de données** : n'afficher que les saisies réelles. Pas
  d'arrondi trompeur — montrer les chiffres réels.
- Les saisies journalières sont clé-ées par `(machineId = drill.id, date, shift)`.
  Toute logique de saisie/affichage doit matcher la foreuse par `drillIdsMatch`
  (correspondance exacte d'`id`), jamais de façon approximative.

## 3. Méthode de travail (workflow Git)
1. Créer une **branche** par changement.
2. **Vérifier la syntaxe avant toute PR** :
   - HTML (scripts inline) : `node scripts/check-inline-scripts.js`
   - Fichiers JS serveur : `node --check <fichier.js>`
   - Tests utiles : `node scripts/smoke-test.js`, `scripts/test-daily-entry.js`.
3. Commit → **Pull Request** → **squash merge** → synchroniser `main`.
   (Le proxy peut bloquer `gh pr` en GraphQL ; utiliser `gh api ...` en REST si besoin.)
4. **Toujours rappeler à Donald de redéployer sur Coolify** après merge
   (bouton **Redeploy** de l'app, qui reconstruit depuis `main`). Voir `HANDOFF.md`
   pour les URLs Coolify, les apps et le déploiement.
5. Après déploiement, **vérifier en ligne** sur https://gedrilling.duckdns.org
   (penser au rechargement forcé Ctrl+Maj+R pour contourner le cache navigateur).

## 4. Déjà construit (ne pas refaire)
- **Opérations** : tableau de bord, plan de forage (blocs/trous, planifié vs
  réalisé), saisie journalière par poste (foreuse changeable dans le formulaire,
  données rattachées à la foreuse choisie), télémétrie, affectations, maintenance
  (révisions, alertes), affûtage des bits, consommables, stock multi-devise (prix
  moyen pondéré), HSE.
- **Finance/commercial** : revenus estimés, rentabilité au jour et au mois minier,
  facturation, paiements, contrats (plusieurs foreuses par contrat), clients,
  dépenses, repas chantier, sous-traitants, clôture de mois minier (archive figée).
- **RH** : employés, pointage, heures supplémentaires, paie CNSS.
- **Rapports & pilotage** : rapports journalier/hebdo/mensuel/synthèse exécutive ;
  bilan hebdomadaire configurable + alertes (production sous objectif, marge, stock,
  maintenance, factures) avec rappel à la connexion et distribution interne ; vue
  Performance (ROP par type de roche, coût réel au mètre par foreuse, MTBF/MTTR,
  planifié vs réalisé).
- **IA** : assistant avec accès interactif aux données (tool-use, ~11 outils) +
  analyse de fichiers joints (PDF, images, Excel, CSV) et des rapports générés.
- **Mine souterraine** (onglets, persistés via `module_state`) : Galeries (niveaux,
  avancement, soutènement), Abattage (stopes, méthode, tonnage, cycle), Sécurité du
  fond (ventilation/gaz avec seuils, registre entrée/sortie du personnel au fond).
- **Plateforme** : multi-entreprise, comptes & accès par cases à cocher (modèle
  d'autorisation explicite : `restrictions.allowedViews`), messagerie d'équipe,
  mode en ligne + local avec synchronisation, navigation avec recherche de module
  et sections repliables.

## 5. Reste à faire (feuille de route, par priorité)
1. **Module Carrières** (même modèle onglets + `module_state` ou tables dédiées) :
   extraction (gradins/fronts, foration des trous de mine, plan de tir maille/charge,
   volume abattu BCM, facteur de poudre, fragmentation) ; traitement (concassage
   primaire/secondaire, rendement, temps de marche) ; stocks de granulats par
   granulométrie (0/4, 4/8, 8/16, 16/25, tout-venant…) avec bilan entrées/sorties ;
   pesée/bascule (ticket entrée/tare/net, ventes au m³/tonne, bons de livraison,
   rapprochement production↔ventes↔stock) ; pilotage (coût au m³/tonne, conso
   explosif/gasoil au m³, alertes stock bas / écart production-vente / fin de réserve).
2. **Interopérabilité** suites minières : import plan de fosse / modèle de blocs
   (Deswik, Datamine, Micromine) ; export des réalisés, teneurs saisies, coordonnées
   de trous.
3. **Envoi e-mail réel** du bilan hebdomadaire : SMTP (identifiants à fournir par
   Donald, ou service type SendGrid) + planification serveur (aujourd'hui : rappel
   et distribution internes seulement).
4. **Approfondissement souterrain** : brancher les alertes gaz critiques au centre
   d'alertes du tableau de bord ; cycle complet foration-tir-marinage ; soutènement
   consommé rattaché au stock ; persistance multi-utilisateur fine.
5. **BI avancé** : prévisions (fin de plan, tendances), benchmark multi-sites,
   tableau de bord direction consolidé multi-entreprises, tableaux de bord par rôle.
6. **Migration serveur** : vérifier qu'aucun module ne reste « local-only » et
   migrer tout nouveau module vers `module_state`.

## 6. Positionnement produit
Les suites Datamine / Deswik / Vulcan / Micromine / RPM MinePlanner sont des outils
de **géologie / modélisation 3D / planification** (bureau d'études). GEDRILLING est
une plateforme d'**exécution et de gestion d'opérations** (terrain + équipements +
RH + finance). Métiers **complémentaires**, pas concurrents frontaux.

Ne pas chercher à refaire la modélisation 3D. Viser à être **la meilleure couche
d'exécution et de gestion d'opérations minières d'Afrique francophone** et à
**s'intégrer** à ces suites. Différenciateurs à défendre : terrain d'abord
(mobile + hors-ligne), local par conception (FCFA, CNSS, mois minier, français),
IA intégrée, tout-en-un, accessible (coût), ouverte/interopérable.

## 7. Première action d'une nouvelle session
Demander à Donald par quel point de la feuille de route (section 5) commencer —
proposer par défaut le **module Carrières** — puis avancer en incréments livrables
(branche → PR → squash merge), en respectant les conventions ci-dessus, et en lui
rappelant de **redéployer sur Coolify** après chaque merge.
