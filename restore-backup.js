/**
 * Restaure la base depuis un fichier .db (arrêter le serveur avant si possible)
 *
 * Usage :
 *   npm run restore-backup -- "backups/database_2025-03-30T12-00-00.db" --confirm
 *   npm run restore-backup -- "backups/full_2025-03-30T12-00-00/database.db" --confirm
 */

const fs = require('fs');
const path = require('path');
const { DB_PATH, BACKUP_DIR } = require('./db');

const args = process.argv.slice(2);
const confirm = args.indexOf('--confirm') >= 0;
const sourceArg = args.filter((a) => a !== '--confirm')[0];

if (!sourceArg) {
    console.error('❌ Indiquez le fichier source, ex. :');
    console.error('   npm run restore-backup -- "' + path.join(BACKUP_DIR, 'database_....db') + '" --confirm');
    process.exit(1);
}
if (!confirm) {
    console.error('❌ Ajoutez --confirm pour écraser la base actuelle (' + DB_PATH + ').');
    process.exit(1);
}

const src = path.isAbsolute(sourceArg) ? sourceArg : path.resolve(process.cwd(), sourceArg);
if (!fs.existsSync(src)) {
    console.error('❌ Fichier introuvable :', src);
    process.exit(1);
}

const dest = path.resolve(DB_PATH);
const safety = dest + '.pre-restore-' + Date.now();
try {
    if (fs.existsSync(dest)) {
        fs.copyFileSync(dest, safety);
        console.log('ℹ️ Copie de secours de l’état actuel :', safety);
    }
    fs.copyFileSync(src, dest);
    console.log('✅ Base restaurée depuis :', src);
    console.log('   →', dest);
    if (fs.existsSync(dest + '-wal')) console.log('ℹ️ Pensez à supprimer manuellement', dest + '-wal', 'et', dest + '-shm', 'si la base ne s’ouvre pas (fichiers WAL orphelins).');
} catch (e) {
    console.error('❌', e.message);
    process.exit(1);
}
