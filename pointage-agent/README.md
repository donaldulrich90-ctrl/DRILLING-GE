# Agent local de pointage — GOOD ENGINEERS (Forage)

Petit programme à installer sur **le poste kiosque** (le PC où est branché le
lecteur d'empreinte USB ZKTeco). Il relie le lecteur à la page de pointage de la
plateforme via un canal local `ws://127.0.0.1:9955`. Il ne communique avec aucun
serveur externe : c'est la page (déjà connectée) qui enregistre les pointages.

## Installation (poste kiosque, Windows)

1. Installer **Node.js 18+** (https://nodejs.org).
2. Copier ce dossier `pointage-agent/` sur le poste.
3. Dans ce dossier, ouvrir une invite de commande et lancer :
   ```
   npm install
   ```

## Lancer

- **Pour tester tout de suite, sans lecteur** (simulateur) :
  ```
  npm run start:sim
  ```
- **Avec le vrai lecteur ZKTeco USB** (après avoir configuré le pilote, voir plus bas) :
  ```
  npm start
  ```

Laisser la fenêtre ouverte pendant les pointages. L'agent affiche
`prêt sur ws://127.0.0.1:9955`.

Dans la plateforme : onglet **RH → Pointage**, vérifier que le bandeau indique
« Agent connecté », puis enrôler les empreintes (**RH → Pointage → Gérer les
empreintes**) et pointer.

## Brancher le vrai lecteur ZKTeco

Le lecteur USB fait sa capture et sa comparaison via le **SDK ZKFinger** du
fabricant (bibliothèque native Windows, ou petit service local fourni par
ZKTeco). Ce SDK ne peut pas être inclus ici. Une fois installé sur le poste :

1. Ouvrir `drivers/zkteco-usb.js`.
2. Remplir les trois crochets : `init()`, `captureTemplate()`, `matchScore(a, b)`
   (deux exemples sont donnés : addon Node natif, ou appel au service local ZKFinger).
3. Lancer avec `GE_AGENT_DRIVER=zkteco-usb npm start` (ou définir la variable
   d'environnement `GE_AGENT_DRIVER=zkteco-usb` de façon permanente).

> Donnez-moi le **modèle exact** de votre lecteur (ex. ZK4500, SLK20R) et je
> finalise ce pilote pour vous.

## Options

| Variable | Défaut | Rôle |
|---|---|---|
| `GE_AGENT_PORT` | `9955` | Port local d'écoute |
| `GE_AGENT_DRIVER` | `simulator` | `simulator` ou `zkteco-usb` |
| `GE_ZK_DEVICE` | `ZK-USB` | Identifiant du lecteur, inscrit sur les pointages |

## Protocole (pour information)

Messages JSON sur WebSocket, un `id` de corrélation par requête :

```
→ {id, cmd:"ping"}                     ← {id, ok:true, driver, device}
→ {id, cmd:"enroll"}                   ← {id, ok:true, template, finger, format, quality}
→ {id, cmd:"identify", templates:[…]}  ← {id, ok:true, employeeId, score} | {id, ok:false, reason}
```

L'agent n'écoute que sur `127.0.0.1` ; il n'est jamais exposé au réseau.
