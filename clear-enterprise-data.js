/**
 * Efface toutes les données opérationnelles d’une entreprise (SQLite),
 * en conservant l’enregistrement entreprise et les utilisateurs (comptes).
 *
 * Usage :
 *   node clear-enterprise-data.js --enterprise=1 --confirm
 *   set ENTERPRISE_ID=1 && node clear-enterprise-data.js --confirm
 *
 * Sauvegardez la base avant : npm run backup
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.db');
const args = process.argv.slice(2);
let entArg = process.env.ENTERPRISE_ID;
for (var i = 0; i < args.length; i++) {
    if (args[i] === '--confirm') continue;
    var m = args[i].match(/^--enterprise=(\d+)$/);
    if (m) entArg = m[1];
}
const confirm = args.indexOf('--confirm') >= 0;
const eid = entArg != null && entArg !== '' ? parseInt(entArg, 10) : NaN;

if (!Number.isFinite(eid) || eid < 1) {
    console.error('❌ Indiquez l’entreprise : node clear-enterprise-data.js --enterprise=1 --confirm');
    process.exit(1);
}
if (!confirm) {
    console.error('❌ Ajoutez --confirm pour exécuter (données métier supprimées, comptes conservés).');
    process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
    console.error('❌ Base introuvable :', DB_PATH);
    process.exit(1);
}

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌', err.message);
        process.exit(1);
    }
});

const steps = [
    ['DELETE FROM report_distribution_emails WHERE distributionId IN (SELECT id FROM report_distributions WHERE enterpriseId = ?)', [eid]],
    ['DELETE FROM report_distributions WHERE enterpriseId = ?', [eid]],
    ['DELETE FROM company_info_posts WHERE enterpriseId = ?', [eid]],
    ['DELETE FROM worker_chat_messages WHERE enterpriseId = ?', [eid]],
    ['DELETE FROM stockMovements WHERE articleId IN (SELECT id FROM inventory WHERE enterpriseId = ?)', [eid]],
    ['DELETE FROM maintenanceHistory WHERE machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)', [eid]],
    ['DELETE FROM maintenanceSchedules WHERE machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)', [eid]],
    ['DELETE FROM assignments WHERE drillId IN (SELECT id FROM drills WHERE enterpriseId = ?)', [eid]],
    ['DELETE FROM dailyDataRecords WHERE machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)', [eid]],
    ['DELETE FROM invoices WHERE enterpriseId = ?', [eid]],
    ['DELETE FROM drills WHERE enterpriseId = ?', [eid]],
    ['DELETE FROM contracts WHERE enterpriseId = ?', [eid]],
    ['DELETE FROM sites WHERE enterpriseId = ?', [eid]],
    ['DELETE FROM clients WHERE enterpriseId = ?', [eid]],
    ['DELETE FROM employees WHERE enterpriseId = ?', [eid]],
    ['DELETE FROM miscellaneousExpenses WHERE enterpriseId = ?', [eid]],
    ['DELETE FROM companyInfo WHERE enterpriseId = ?', [eid]],
    ['DELETE FROM inventory WHERE enterpriseId = ?', [eid]]
];

db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON');
    db.run('BEGIN IMMEDIATE');
    let idx = 0;
    function next(err) {
        if (err) {
            db.run('ROLLBACK', () => {
                console.error('❌ Erreur :', err.message);
                db.close(() => process.exit(1));
            });
            return;
        }
        if (idx >= steps.length) {
            db.run('COMMIT', (errC) => {
                if (errC) {
                    console.error('❌ COMMIT :', errC.message);
                    process.exit(1);
                }
                console.log('✅ Données opérationnelles effacées pour enterpriseId =', eid, '(utilisateurs et fiche entreprise conservés).');
                db.close();
            });
            return;
        }
        const st = steps[idx++];
        db.run(st[0], st[1], next);
    }
    next(null);
});
