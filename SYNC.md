# Synchronisation local ⇄ en ligne

Deux modes, au choix.

## 1. Mode fichier (manuel, aucune config)
Dans la plateforme → **Comptes** → panneau « 🔄 Synchronisation local ⇄ en ligne » :
- **⬇️ Exporter (fichier)** : télécharge un `.json` des données de l'entreprise.
- **⬆️ Importer / fusionner** : charge un fichier exporté de l'autre instance.

La fusion est **additive** : insère le nouveau, met à jour seulement si plus
récent, n'efface jamais.

## 2. Mode automatique (l'instance LOCALE pousse/tire toute seule)
À activer **uniquement sur l'instance locale** (jamais en ligne), par variables
d'environnement :

| Variable | Rôle | Exemple |
|---|---|---|
| `SYNC_ENABLED` | Active la synchro auto | `true` |
| `SYNC_REMOTE_URL` | URL du serveur en ligne | `https://forage.waudrilling.com` |
| `SYNC_USERNAME` | Compte **admin** de l'entreprise en ligne | `admin_bombore` |
| `SYNC_PASSWORD` | Mot de passe de ce compte | `••••••` |
| `SYNC_INTERVAL_MINUTES` | Fréquence (défaut 15) | `15` |
| `SYNC_ENTERPRISE_ID` | (optionnel) entreprise locale | `1` |

Exemple Docker :
```
docker run -d -p 3000:3000 -v "$(pwd)/data:/data" \
  -e SYNC_ENABLED=true \
  -e SYNC_REMOTE_URL=https://forage.waudrilling.com \
  -e SYNC_USERNAME=admin_bombore -e SYNC_PASSWORD=secret \
  -e SYNC_INTERVAL_MINUTES=15 \
  --name gedrilling gedrilling
```

À chaque cycle (et dès qu'internet est joignable), l'instance locale **tire**
les données en ligne puis **pousse** les siennes. Bouton **« 🔄 Synchroniser
maintenant »** dans Comptes pour forcer un cycle, et un statut y est affiché.

### Ce qui est synchronisé
Les **saisies journalières** et les **patterns** (photos hachurées). La
configuration (sites, fosses, foreuses, contrats, comptes) se fait en ligne et
doit déjà exister des deux côtés — une saisie dont la foreuse n'existe pas dans
l'entreprise cible est ignorée (sécurité anti-mélange entre entreprises).
