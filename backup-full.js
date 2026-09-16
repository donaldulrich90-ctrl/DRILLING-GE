/**
 * Sauvegarde complète : base SQLite + dossier uploads (pièces jointes chat, etc.)
 *
 * Usage : npm run backup:full
 * Dossier créé : backups/full_<horodatage>/database.db + uploads/
 */

const fs = require('fs');
const path = require('path');
const { backup, close, BACKUP_DIR } = require('./db');

const UPLOADS_DIR = path.join(__dirname, 'uploads');

async function main() {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const bundleDir = path.join(BACKUP_DIR, `full_${timestamp}`);
        fs.mkdirSync(bundleDir, { recursive: true });

        const dbDest = path.join(bundleDir, 'database.db');
        await backup(dbDest);

        const uploadsDest = path.join(bundleDir, 'uploads');
        if (fs.existsSync(UPLOADS_DIR)) {
            fs.cpSync(UPLOADS_DIR, uploadsDest, { recursive: true });
            console.log('✅ Dossier uploads copié →', uploadsDest);
        } else {
            fs.mkdirSync(uploadsDest, { recursive: true });
            console.log('ℹ️ Dossier uploads absent : créé un dossier vide dans la sauvegarde.');
        }

        const manifest = {
            createdAt: new Date().toISOString(),
            databaseFile: 'database.db',
            uploadsDir: 'uploads',
            note: 'Restauration : npm run restore-backup -- "<chemin>/database.db" --confirm'
        };
        fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

        console.log('✅ Sauvegarde complète terminée :', bundleDir);
    } catch (err) {
        console.error('❌ Erreur :', err.message);
        process.exit(1);
    } finally {
        close();
    }
}

main();
