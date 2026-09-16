/**
 * Script de sauvegarde de la base de données
 * Usage: npm run backup
 */

const { backup, getDb, close } = require('./db');

async function main() {
    try {
        const backupPath = await backup();
        console.log('✅ Sauvegarde terminée:', backupPath);
    } catch (err) {
        console.error('❌ Erreur lors de la sauvegarde:', err.message);
        process.exit(1);
    } finally {
        close();
    }
}

main();
