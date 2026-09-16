/**
 * Liste les sauvegardes dans backups/
 * Usage : npm run backup:list
 */

const fs = require('fs');
const path = require('path');
const { BACKUP_DIR } = require('./db');

function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' o';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko';
    return (bytes / (1024 * 1024)).toFixed(2) + ' Mo';
}

function main() {
    if (!fs.existsSync(BACKUP_DIR)) {
        console.log('Aucun dossier backups/ pour l’instant. Lancez npm run backup');
        return;
    }
    const items = fs.readdirSync(BACKUP_DIR, { withFileTypes: true });
    const rows = [];
    for (const ent of items) {
        const full = path.join(BACKUP_DIR, ent.name);
        const st = fs.statSync(full);
        let extra = '';
        if (ent.isDirectory() && ent.name.startsWith('full_')) {
            const dbp = path.join(full, 'database.db');
            if (fs.existsSync(dbp)) extra = ' (base + uploads)';
        } else if (ent.isFile() && ent.name.endsWith('.db')) {
            extra = ' (' + fmtSize(st.size) + ')';
        }
        rows.push({ name: ent.name, mtime: st.mtime, isDir: ent.isDirectory(), extra });
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    if (rows.length === 0) {
        console.log('Dossier backups/ vide.');
        return;
    }
    console.log('Sauvegardes dans', BACKUP_DIR, '\n');
    rows.forEach((r) => {
        console.log(
            r.mtime.toISOString().slice(0, 19).replace('T', ' '),
            ' ',
            r.isDir ? '📁' : '📄',
            r.name + r.extra
        );
    });
}

main();
