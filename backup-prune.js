/**
 * Supprime les anciennes sauvegardes (garde les N plus récentes par catégorie)
 *
 * Usage :
 *   npm run backup:prune
 *   node backup-prune.js --keep=10
 *
 * Variables d’environnement : BACKUP_KEEP (défaut 20)
 */

const fs = require('fs');
const path = require('path');
const { BACKUP_DIR } = require('./db');

function parseKeep() {
    const args = process.argv.slice(2);
    for (const a of args) {
        const m = a.match(/^--keep=(\d+)$/);
        if (m) return Math.max(1, parseInt(m[1], 10));
    }
    const env = process.env.BACKUP_KEEP;
    if (env != null && env !== '') {
        const n = parseInt(env, 10);
        if (Number.isFinite(n) && n >= 1) return n;
    }
    return 20;
}

function rmRecursive(p) {
    fs.rmSync(p, { recursive: true, force: true });
}

function main() {
    const keep = parseKeep();
    if (!fs.existsSync(BACKUP_DIR)) {
        console.log('Rien à nettoyer (pas de dossier backups/).');
        return;
    }

    const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true });
    const dbFiles = [];
    const fullDirs = [];
    for (const ent of entries) {
        const full = path.join(BACKUP_DIR, ent.name);
        if (ent.isFile() && /^database_.+\.db$/.test(ent.name)) {
            dbFiles.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        } else if (ent.isDirectory() && ent.name.startsWith('full_')) {
            fullDirs.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        }
    }

    dbFiles.sort((a, b) => b.mtime - a.mtime);
    fullDirs.sort((a, b) => b.mtime - a.mtime);

    let removed = 0;
    dbFiles.slice(keep).forEach((x) => {
        fs.unlinkSync(x.path);
        console.log('Supprimé :', path.basename(x.path));
        removed++;
    });
    fullDirs.slice(keep).forEach((x) => {
        rmRecursive(x.path);
        console.log('Supprimé :', path.basename(x.path) + '/');
        removed++;
    });

    if (removed === 0) {
        console.log('Aucune sauvegarde à supprimer (≤ ' + keep + ' fichiers database_* et ≤ ' + keep + ' dossiers full_*).');
    } else {
        console.log('✅ Nettoyage terminé (' + removed + ' élément(s) supprimé(s)). Conservation des ' + keep + ' plus récents par type.');
    }
}

main();
