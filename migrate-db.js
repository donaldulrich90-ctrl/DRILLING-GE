/**
 * Script de migration - Multi-entreprises + Administrateur général
 * Usage: npm run migrate
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { ensureDailyDataRecordsSchema } = require('./ensure-daily-data-schema');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.db');
const initialPlatformPassword = process.env.INITIAL_PLATFORM_PASSWORD || crypto.randomBytes(18).toString('base64url');
const initialPlatformHash = bcrypt.hashSync(initialPlatformPassword, 10);

if (!fs.existsSync(DB_PATH)) {
    console.log('❌ Base de données non trouvée. Exécutez d\'abord: npm run init-db');
    process.exit(1);
}

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌ Erreur de connexion:', err.message);
        process.exit(1);
    }
    console.log('✅ Connecté à la base de données');
});

db.run('PRAGMA foreign_keys = OFF'); // Désactiver temporairement pour les ALTER
db.run('PRAGMA journal_mode = WAL');

const migrations = [
    { name: 'enterprises.table', sql: `CREATE TABLE IF NOT EXISTS enterprises (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE,
        legalName TEXT,
        address TEXT DEFAULT '',
        city TEXT DEFAULT '',
        country TEXT DEFAULT '',
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        logo TEXT DEFAULT '',
        currency TEXT DEFAULT 'EUR',
        isActive INTEGER DEFAULT 1,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    )` },
    { name: 'users.enterpriseId', sql: 'ALTER TABLE users ADD COLUMN enterpriseId INTEGER DEFAULT NULL' },
    { name: 'clients.enterpriseId', sql: 'ALTER TABLE clients ADD COLUMN enterpriseId INTEGER DEFAULT 1' },
    { name: 'sites.enterpriseId', sql: 'ALTER TABLE sites ADD COLUMN enterpriseId INTEGER DEFAULT 1' },
    { name: 'contracts.enterpriseId', sql: 'ALTER TABLE contracts ADD COLUMN enterpriseId INTEGER DEFAULT 1' },
    { name: 'drills.enterpriseId', sql: 'ALTER TABLE drills ADD COLUMN enterpriseId INTEGER DEFAULT 1' },
    { name: 'employees.enterpriseId', sql: 'ALTER TABLE employees ADD COLUMN enterpriseId INTEGER DEFAULT 1' },
    { name: 'invoices.enterpriseId', sql: 'ALTER TABLE invoices ADD COLUMN enterpriseId INTEGER DEFAULT 1' },
    { name: 'inventory.enterpriseId', sql: 'ALTER TABLE inventory ADD COLUMN enterpriseId INTEGER DEFAULT 1' },
    { name: 'companyInfo.enterpriseId', sql: 'ALTER TABLE companyInfo ADD COLUMN enterpriseId INTEGER DEFAULT 1' },
    { name: 'miscellaneousExpenses.enterpriseId', sql: 'ALTER TABLE miscellaneousExpenses ADD COLUMN enterpriseId INTEGER DEFAULT 1' },
    { name: 'contracts.siteId', sql: 'ALTER TABLE contracts ADD COLUMN siteId INTEGER DEFAULT NULL' },
    { name: 'drills.siteId', sql: 'ALTER TABLE drills ADD COLUMN siteId INTEGER DEFAULT NULL' },
    { name: 'drills.contractId', sql: 'ALTER TABLE drills ADD COLUMN contractId TEXT DEFAULT NULL' },
    { name: 'assignments.contractId', sql: 'ALTER TABLE assignments ADD COLUMN contractId TEXT DEFAULT NULL' },
    { name: 'assignments.clientId', sql: 'ALTER TABLE assignments ADD COLUMN clientId INTEGER DEFAULT NULL' },
    { name: 'users.siteIds', sql: 'ALTER TABLE users ADD COLUMN siteIds TEXT DEFAULT \'[]\'' },
    { name: 'miscellaneousExpenses.notes', sql: 'ALTER TABLE miscellaneousExpenses ADD COLUMN notes TEXT DEFAULT \'\'' },
    { name: 'enterprises.plan', sql: 'ALTER TABLE enterprises ADD COLUMN plan TEXT DEFAULT \'free\'' },
    { name: 'enterprises.subscriptionStartDate', sql: 'ALTER TABLE enterprises ADD COLUMN subscriptionStartDate TEXT DEFAULT NULL' },
    { name: 'enterprises.subscriptionEndDate', sql: 'ALTER TABLE enterprises ADD COLUMN subscriptionEndDate TEXT DEFAULT NULL' },
    { name: 'enterprises.subscriptionStatus', sql: 'ALTER TABLE enterprises ADD COLUMN subscriptionStatus TEXT DEFAULT \'active\'' },
    { name: 'enterprises.maxUsers', sql: 'ALTER TABLE enterprises ADD COLUMN maxUsers INTEGER DEFAULT 5' },
    { name: 'enterprises.maxDrills', sql: 'ALTER TABLE enterprises ADD COLUMN maxDrills INTEGER DEFAULT 10' },
    { name: 'companyInfo.ifu', sql: 'ALTER TABLE companyInfo ADD COLUMN ifu TEXT DEFAULT \'\'' },
    { name: 'companyInfo.rccm', sql: 'ALTER TABLE companyInfo ADD COLUMN rccm TEXT DEFAULT \'\'' },
    { name: 'companyInfo.tvaRate', sql: 'ALTER TABLE companyInfo ADD COLUMN tvaRate REAL DEFAULT 18' },
    { name: 'companyInfo.retenueSourceRate', sql: 'ALTER TABLE companyInfo ADD COLUMN retenueSourceRate REAL DEFAULT 5' },
    { name: 'companyInfo.currency', sql: 'ALTER TABLE companyInfo ADD COLUMN currency TEXT DEFAULT \'XOF\'' },
    { name: 'dailyDataRecords.shift', run: (database, done) => {
        database.get("SELECT name FROM sqlite_master WHERE type='table' AND name='dailyDataRecords'", (err, row) => {
            if (err || !row) {
                console.log('⏭ dailyDataRecords.shift (table absente)');
                return done();
            }
            ensureDailyDataRecordsSchema(database, (fixErr) => {
                if (fixErr) {
                    console.error('❌ dailyDataRecords.shift:', fixErr.message);
                    process.exit(1);
                }
                done();
            });
        });
    } },
    { name: 'stockMovements.authorizedBy', sql: 'ALTER TABLE stockMovements ADD COLUMN authorizedBy TEXT DEFAULT \'\'' },
    { name: 'stockMovements.authorizedById', sql: 'ALTER TABLE stockMovements ADD COLUMN authorizedById INTEGER DEFAULT NULL' },
    { name: 'users.passwordHash', sql: 'ALTER TABLE users ADD COLUMN passwordHash TEXT DEFAULT NULL' },
    { name: 'enterprises.allowedRoles', sql: 'ALTER TABLE enterprises ADD COLUMN allowedRoles TEXT DEFAULT NULL' },
    { name: 'subscription_plan_catalog', sql: `CREATE TABLE IF NOT EXISTS subscription_plan_catalog (
        plan TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        monthlyPrice REAL NOT NULL DEFAULT 0,
        yearlyPrice REAL DEFAULT NULL,
        currency TEXT NOT NULL DEFAULT 'EUR',
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    )` },
    { name: 'subscription_plan_catalog.seed', run: (database, done) => {
        const rows = [
            ['free', 'Gratuit', 0, 0, 'EUR'],
            ['basic', 'Basic', 49, 490, 'EUR'],
            ['premium', 'Premium', 149, 1490, 'EUR'],
            ['enterprise', 'Enterprise', 499, 4990, 'EUR']
        ];
        let n = 0;
        rows.forEach((r) => {
            database.run(
                'INSERT OR IGNORE INTO subscription_plan_catalog (plan, label, monthlyPrice, yearlyPrice, currency) VALUES (?,?,?,?,?)',
                r,
                () => {
                    n++;
                    if (n === rows.length) done();
                }
            );
        });
    } },
    { name: 'enterprises.subscriptionCustomMonthly', sql: 'ALTER TABLE enterprises ADD COLUMN subscriptionCustomMonthly REAL DEFAULT NULL' },
    { name: 'enterprises.subscriptionCustomYearly', sql: 'ALTER TABLE enterprises ADD COLUMN subscriptionCustomYearly REAL DEFAULT NULL' },
    { name: 'enterprises.subscriptionCustomCurrency', sql: 'ALTER TABLE enterprises ADD COLUMN subscriptionCustomCurrency TEXT DEFAULT NULL' },
    { name: 'contracts.fuelPriceCurrency', sql: 'ALTER TABLE contracts ADD COLUMN fuelPriceCurrency TEXT DEFAULT NULL' },
    { name: 'dailyDataRecords.enteredByUsername', sql: 'ALTER TABLE dailyDataRecords ADD COLUMN enteredByUsername TEXT DEFAULT \'\'' },
    { name: 'dailyDataRecords.enteredByName', sql: 'ALTER TABLE dailyDataRecords ADD COLUMN enteredByName TEXT DEFAULT \'\'' },
    { name: 'dailyDataRecords.enteredAt', sql: 'ALTER TABLE dailyDataRecords ADD COLUMN enteredAt TEXT DEFAULT NULL' },
    { name: 'dailyDataRecords.lastModifiedByUsername', sql: 'ALTER TABLE dailyDataRecords ADD COLUMN lastModifiedByUsername TEXT DEFAULT \'\'' },
    { name: 'dailyDataRecords.lastModifiedByName', sql: 'ALTER TABLE dailyDataRecords ADD COLUMN lastModifiedByName TEXT DEFAULT \'\'' },
    { name: 'dailyDataRecords.lastModifiedAt', sql: 'ALTER TABLE dailyDataRecords ADD COLUMN lastModifiedAt TEXT DEFAULT NULL' },
    { name: 'enterprises.maxSites', sql: 'ALTER TABLE enterprises ADD COLUMN maxSites INTEGER DEFAULT 1' },
    { name: 'enterprises.allowedTabs', sql: 'ALTER TABLE enterprises ADD COLUMN allowedTabs TEXT DEFAULT NULL' },
    { name: 'subscription_plan_catalog.defaultAllowedTabs', sql: 'ALTER TABLE subscription_plan_catalog ADD COLUMN defaultAllowedTabs TEXT DEFAULT NULL' },
    {
        name: 'subscription_plan_catalog.defaultAllowedTabs.seed',
        run: (database, done) => {
            try {
                const pr = require('./plan-roles');
                const keys = Object.keys(pr.DEFAULT_TABS_BY_PLAN);
                let i = 0;
                function next() {
                    if (i >= keys.length) return done();
                    const p = keys[i++];
                    const json = JSON.stringify(pr.DEFAULT_TABS_BY_PLAN[p]);
                    database.run(
                        `UPDATE subscription_plan_catalog SET defaultAllowedTabs = ? WHERE plan = ? AND (defaultAllowedTabs IS NULL OR TRIM(COALESCE(defaultAllowedTabs,'')) = '')`,
                        [json, p],
                        () => next()
                    );
                }
                next();
            } catch (e) {
                done();
            }
        }
    },
    { name: 'enterprises.maxSites.alignExisting', run: (database, done) => {
        database.all('SELECT id FROM enterprises', (err, rows) => {
            if (err || !rows || rows.length === 0) return done();
            let i = 0;
            function next() {
                if (i >= rows.length) return done();
                const entId = rows[i++].id;
                database.get('SELECT COUNT(*) as n FROM sites WHERE enterpriseId = ?', [entId], (e2, r2) => {
                    const need = Math.max(1, r2 && r2.n != null ? parseInt(r2.n, 10) : 1);
                    database.run(
                        'UPDATE enterprises SET maxSites = MAX(COALESCE(maxSites, 1), ?) WHERE id = ?',
                        [need, entId],
                        () => next()
                    );
                });
            }
            next();
        });
    } },
    { name: 'users.email', sql: 'ALTER TABLE users ADD COLUMN email TEXT DEFAULT NULL' },
    { name: 'worker_chat_messages', sql: `CREATE TABLE IF NOT EXISTS worker_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        fromUserId INTEGER NOT NULL,
        toUserId INTEGER,
        body TEXT DEFAULT '',
        filePath TEXT,
        fileOriginalName TEXT,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
    )` },
    { name: 'company_info_posts', sql: `CREATE TABLE IF NOT EXISTS company_info_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        authorUserId INTEGER,
        pinned INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
    )` },
    { name: 'report_distributions', sql: `CREATE TABLE IF NOT EXISTS report_distributions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        fromUserId INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        reportData TEXT,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
    )` },
    { name: 'report_distribution_emails', sql: `CREATE TABLE IF NOT EXISTS report_distribution_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        distributionId INTEGER NOT NULL,
        email TEXT NOT NULL,
        FOREIGN KEY (distributionId) REFERENCES report_distributions(id) ON DELETE CASCADE
    )` },
    {
        name: 'assignments.dedupe_one_active_per_drill',
        run: (database, done) => {
            database.run(
                `DELETE FROM assignments
                 WHERE status = 'active'
                 AND EXISTS (
                   SELECT 1 FROM assignments b
                   WHERE b.drillId = assignments.drillId
                     AND b.status = 'active'
                     AND b.id > assignments.id
                 )`,
                (err) => {
                    if (err) console.error('assignments.dedupe:', err.message);
                    database.run(
                        `CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_one_active_per_drill ON assignments(drillId) WHERE status = 'active'`,
                        (err2) => {
                            if (err2 && !String(err2.message || '').includes('already exists')) {
                                console.error('assignments unique index:', err2.message);
                            }
                            done();
                        }
                    );
                }
            );
        }
    },
    { name: 'drills.parkReason', sql: 'ALTER TABLE drills ADD COLUMN parkReason TEXT DEFAULT NULL' },
    { name: 'drills.expectedReturnDate', sql: 'ALTER TABLE drills ADD COLUMN expectedReturnDate TEXT DEFAULT NULL' },
    { name: 'drills.parkLocation', sql: 'ALTER TABLE drills ADD COLUMN parkLocation TEXT DEFAULT NULL' },
    { name: 'drill_plans.table', sql: `CREATE TABLE IF NOT EXISTS drill_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL DEFAULT 1,
        siteId INTEGER,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        zoneLabel TEXT DEFAULT '',
        gridType TEXT DEFAULT 'cartesian',
        originX REAL DEFAULT 0,
        originY REAL DEFAULT 0,
        scale REAL DEFAULT 1,
        totalHoles INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    )` },
    { name: 'drill_plan_holes.table', sql: `CREATE TABLE IF NOT EXISTS drill_plan_holes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        planId INTEGER NOT NULL,
        holeId TEXT NOT NULL,
        x REAL DEFAULT 0,
        y REAL DEFAULT 0,
        row TEXT DEFAULT '',
        col TEXT DEFAULT '',
        zone TEXT DEFAULT '',
        blockId TEXT DEFAULT '',
        source TEXT DEFAULT '',
        plannedDepth REAL DEFAULT 0,
        actualDepth REAL DEFAULT 0,
        status TEXT DEFAULT 'planned',
        drilledDate TEXT DEFAULT NULL,
        machineId TEXT DEFAULT NULL,
        notes TEXT DEFAULT '',
        FOREIGN KEY (planId) REFERENCES drill_plans(id) ON DELETE CASCADE
    )` },
    { name: 'enterprises.claudeApiKey', sql: 'ALTER TABLE enterprises ADD COLUMN claudeApiKey TEXT DEFAULT NULL' },
    { name: 'contracts.billRedrill', sql: 'ALTER TABLE contracts ADD COLUMN billRedrill INTEGER DEFAULT 0' },
    { name: 'companyInfo.fosses', sql: "ALTER TABLE companyInfo ADD COLUMN fosses TEXT DEFAULT '[]'" },
    { name: 'companyInfo.matriculePrefix', sql: "ALTER TABLE companyInfo ADD COLUMN matriculePrefix TEXT DEFAULT 'EMP'" },
    { name: 'companyInfo.matriculeIncludeYear', sql: 'ALTER TABLE companyInfo ADD COLUMN matriculeIncludeYear INTEGER DEFAULT 1' },
    { name: 'companyInfo.matriculeSeparator', sql: "ALTER TABLE companyInfo ADD COLUMN matriculeSeparator TEXT DEFAULT '-'" },
    { name: 'companyInfo.matriculePadding', sql: 'ALTER TABLE companyInfo ADD COLUMN matriculePadding INTEGER DEFAULT 3' },
    { name: 'sites.miningCutoffDay', sql: 'ALTER TABLE sites ADD COLUMN miningCutoffDay INTEGER DEFAULT 1' },
    // Domaines d'activité de l'entreprise (JSON : ["ciel_ouvert","souterrain","carriere"]).
    { name: 'enterprises.activityDomains', sql: 'ALTER TABLE enterprises ADD COLUMN activityDomains TEXT DEFAULT NULL' },
    // Devise du stock (prix d'achat en XOF/USD/EUR)
    { name: 'inventory.priceCurrency', sql: "ALTER TABLE inventory ADD COLUMN priceCurrency TEXT DEFAULT 'XOF'" },
    { name: 'stockMovements.priceCurrency', sql: "ALTER TABLE stockMovements ADD COLUMN priceCurrency TEXT DEFAULT 'XOF'" },
    // État de module générique (persistance des modules local-first)
    { name: 'module_state.table', sql: `CREATE TABLE IF NOT EXISTS module_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL DEFAULT 1,
        moduleKey TEXT NOT NULL,
        data TEXT,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        updatedBy TEXT DEFAULT '',
        UNIQUE(enterpriseId, moduleKey)
    )` },
    // Clôture d'un mois minier complet (archive figée des totaux du mois)
    { name: 'mining_month_closures.table', sql: `CREATE TABLE IF NOT EXISTS mining_month_closures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL DEFAULT 1,
        siteId TEXT DEFAULT '',
        yearMonth TEXT NOT NULL,
        snapshot TEXT DEFAULT '',
        closedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        closedBy TEXT DEFAULT '',
        UNIQUE(enterpriseId, siteId, yearMonth)
    )` },
    // Module paiements
    { name: 'payments.table', sql: `CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        enterpriseId INTEGER NOT NULL DEFAULT 1,
        invoiceId TEXT NOT NULL,
        date TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        currency TEXT DEFAULT 'XOF',
        method TEXT DEFAULT 'cash',
        reference TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        receivedBy TEXT DEFAULT '',
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id),
        FOREIGN KEY (invoiceId) REFERENCES invoices(id)
    )` },
    // Rapport hebdomadaire configurable (Item B)
    { name: 'weeklyReportConfigs.table', sql: `CREATE TABLE IF NOT EXISTS weeklyReportConfigs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        reportDay INTEGER DEFAULT 5,
        includeSections TEXT DEFAULT '["alerts","production","maintenance","stock","finance"]',
        recipientName TEXT DEFAULT '',
        whatsappNumber TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
    )` },
    { name: 'weeklyReports.table', sql: `CREATE TABLE IF NOT EXISTS weeklyReports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        weekStart TEXT NOT NULL,
        weekEnd TEXT NOT NULL,
        generatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        generatedBy TEXT DEFAULT '',
        htmlContent TEXT DEFAULT '',
        summary TEXT DEFAULT '{}',
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
    )` },
    // ─── Stock multi-sites : Bureau central (Ouagadougou) + Magasins de chantier ───
    // Chaque article (inventory) et chaque mouvement (stockMovements) est désormais
    // rattaché à une location. Le bureau central reçoit les commandes fournisseurs
    // et expédie vers les sites ; les sites reçoivent, consomment, et remontent
    // des demandes de réapprovisionnement quand ils passent sous le seuil.
    { name: 'stock_locations.table', sql: `CREATE TABLE IF NOT EXISTS stock_locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'site',
        siteId INTEGER,
        address TEXT DEFAULT '',
        managerUserId INTEGER,
        isActive INTEGER NOT NULL DEFAULT 1,
        notes TEXT DEFAULT '',
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id),
        FOREIGN KEY (siteId) REFERENCES sites(id),
        FOREIGN KEY (managerUserId) REFERENCES users(id)
    )` },
    { name: 'inventory.locationId', sql: `ALTER TABLE inventory ADD COLUMN locationId INTEGER` },
    { name: 'stockMovements.locationId', sql: `ALTER TABLE stockMovements ADD COLUMN locationId INTEGER` },
    { name: 'stock_transfers.table', sql: `CREATE TABLE IF NOT EXISTS stock_transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        transferNumber TEXT NOT NULL,
        fromLocationId INTEGER NOT NULL,
        toLocationId INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        sentDate TEXT,
        receivedDate TEXT,
        sentByUsername TEXT DEFAULT '',
        receivedByUsername TEXT DEFAULT '',
        carrier TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id),
        FOREIGN KEY (fromLocationId) REFERENCES stock_locations(id),
        FOREIGN KEY (toLocationId) REFERENCES stock_locations(id)
    )` },
    { name: 'stock_transfer_items.table', sql: `CREATE TABLE IF NOT EXISTS stock_transfer_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transferId INTEGER NOT NULL,
        itemName TEXT NOT NULL,
        itemCategory TEXT DEFAULT '',
        unit TEXT DEFAULT '',
        quantity REAL NOT NULL,
        unitPrice REAL DEFAULT 0,
        priceCurrency TEXT DEFAULT 'XOF',
        notes TEXT DEFAULT '',
        FOREIGN KEY (transferId) REFERENCES stock_transfers(id) ON DELETE CASCADE
    )` },
    { name: 'stock_replenishment_requests.table', sql: `CREATE TABLE IF NOT EXISTS stock_replenishment_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        requestNumber TEXT NOT NULL,
        siteLocationId INTEGER NOT NULL,
        requestedByUsername TEXT DEFAULT '',
        requestedByName TEXT DEFAULT '',
        requestDate TEXT DEFAULT (date('now')),
        status TEXT NOT NULL DEFAULT 'pending',
        urgency TEXT DEFAULT 'normal',
        decidedByUsername TEXT DEFAULT '',
        decidedAt TEXT,
        decisionNotes TEXT DEFAULT '',
        fulfilledByTransferId INTEGER,
        notes TEXT DEFAULT '',
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id),
        FOREIGN KEY (siteLocationId) REFERENCES stock_locations(id),
        FOREIGN KEY (fulfilledByTransferId) REFERENCES stock_transfers(id)
    )` },
    { name: 'stock_replenishment_items.table', sql: `CREATE TABLE IF NOT EXISTS stock_replenishment_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requestId INTEGER NOT NULL,
        itemName TEXT NOT NULL,
        itemCategory TEXT DEFAULT '',
        unit TEXT DEFAULT '',
        currentQuantity REAL DEFAULT 0,
        minStock REAL DEFAULT 0,
        requestedQty REAL NOT NULL,
        approvedQty REAL,
        notes TEXT DEFAULT '',
        FOREIGN KEY (requestId) REFERENCES stock_replenishment_requests(id) ON DELETE CASCADE
    )` },
    { name: 'stock_locations.seedCentral', sql: `
        INSERT INTO stock_locations (enterpriseId, name, kind, siteId, isActive, notes)
        SELECT e.id,
               'Bureau central (Ouagadougou)',
               'central',
               NULL,
               1,
               'Créé automatiquement pour la gestion multi-sites. Reçoit les commandes fournisseurs et expédie vers les magasins de chantier.'
        FROM enterprises e
        WHERE NOT EXISTS (
            SELECT 1 FROM stock_locations l WHERE l.enterpriseId = e.id AND l.kind = 'central'
        )` },
    { name: 'stock_locations.seedSites', sql: `
        INSERT INTO stock_locations (enterpriseId, name, kind, siteId, isActive, notes)
        SELECT s.enterpriseId,
               'Magasin ' || COALESCE(NULLIF(TRIM(s.name), ''), 'site ' || s.id),
               'site',
               s.id,
               1,
               'Créé automatiquement — stock sur chantier, reçoit du bureau central et gère les consommations.'
        FROM sites s
        WHERE NOT EXISTS (
            SELECT 1 FROM stock_locations l WHERE l.enterpriseId = s.enterpriseId AND l.siteId = s.id
        )` },
    { name: 'inventory.locationId.backfill', sql: `
        UPDATE inventory
        SET locationId = (SELECT l.id FROM stock_locations l WHERE l.enterpriseId = inventory.enterpriseId AND l.kind = 'central' LIMIT 1)
        WHERE locationId IS NULL` },
    { name: 'stockMovements.locationId.backfill', sql: `
        UPDATE stockMovements
        SET locationId = (SELECT l.id FROM stock_locations l WHERE l.enterpriseId = stockMovements.enterpriseId AND l.kind = 'central' LIMIT 1)
        WHERE locationId IS NULL` }
];

let completed = 0;
function checkDone() {
    completed++;
    if (completed === migrations.length) {
        db.run(`INSERT OR IGNORE INTO enterprises (id, name, slug, currency) VALUES (1, 'GOOD ENGINEERS-DRILL', 'good-engineers', 'EUR')`, function() {
            db.run(`DELETE FROM users WHERE username = 'admin'`, function() {
                db.run(`INSERT OR IGNORE INTO users (username, password, passwordHash, role, name, enterpriseId, restrictions, notes) VALUES (?, '', ?, 'platform_owner', 'Gestion abonnements SaaS', NULL, '{}', 'Créer entreprises, abonnements et utilisateurs plateforme (mode partagé)')`, ['gestion_abonnements', initialPlatformHash], function() {
                    db.run(`INSERT OR IGNORE INTO users (username, password, passwordHash, role, name, enterpriseId, restrictions, notes) VALUES (?, '', ?, 'platform_owner', 'Propriétaire plateforme', NULL, '{}', 'Gestion des abonnements entreprises')`, ['proprietaire', initialPlatformHash], function() {
                        function finishPlatform() {
                            db.run('PRAGMA foreign_keys = ON');
                            db.close((err) => {
                                if (err) console.error('Erreur fermeture:', err);
                                else {
                                    console.log('\n✨ Migration terminée! Mot de passe plateforme fourni par INITIAL_PLATFORM_PASSWORD.');
                                    if (!process.env.INITIAL_PLATFORM_PASSWORD) console.log('Mot de passe initial généré : ' + initialPlatformPassword);
                                }
                            });
                        }
                        // --- Récupération de l'accès propriétaire plateforme ---
                        // (a) Si RESET_PLATFORM_OWNER est défini : sa valeur devient le nouveau
                        //     mot de passe (ou INITIAL_PLATFORM_PASSWORD si c'est un simple
                        //     drapeau 1/true/on/yes, sinon le mot de passe de secours).
                        // (b) Sinon : réinitialisation AUTOMATIQUE, UNE SEULE FOIS, vers un mot
                        //     de passe de secours connu, tant qu'un marqueur n'existe pas sur le
                        //     volume de données. Une fois appliquée, elle n'est plus jamais
                        //     rejouée (le marqueur est écrit) et n'écrase donc pas un mot de
                        //     passe que vous changerez ensuite.
                        // N'altère aucune donnée métier : UPDATE du seul passwordHash de 2 comptes.
                        var _resetMarker = path.join(path.dirname(DB_PATH), '.owner_reset_v1');
                        var _RECOVERY_PWD = 'GEDrilling2026';
                        function _applyOwnerReset(newPass, note, markerPath) {
                            var hash = bcrypt.hashSync(newPass, 10);
                            db.run(
                                "UPDATE users SET passwordHash = ?, password = '' WHERE username IN ('proprietaire','gestion_abonnements')",
                                [hash],
                                function (uErr) {
                                    if (uErr) console.error('🔑 Réinitialisation propriétaire échouée:', uErr.message);
                                    else {
                                        console.log('🔑 ' + note + ' (' + this.changes + ' compte(s)).');
                                        if (markerPath) { try { fs.writeFileSync(markerPath, new Date().toISOString() + '\n'); } catch (e) {} }
                                    }
                                    finishPlatform();
                                }
                            );
                        }
                        var _rpo = process.env.RESET_PLATFORM_OWNER ? String(process.env.RESET_PLATFORM_OWNER) : '';
                        if (_rpo && _rpo.toLowerCase() !== 'off') {
                            var _isFlag = ['1', 'true', 'on', 'yes'].indexOf(_rpo.toLowerCase()) >= 0;
                            var _newPass = _isFlag ? (process.env.INITIAL_PLATFORM_PASSWORD || _RECOVERY_PWD) : _rpo;
                            _applyOwnerReset(_newPass, "Mot de passe plateforme réinitialisé via RESET_PLATFORM_OWNER — connectez-vous puis retirez la variable", null);
                        } else if (!fs.existsSync(_resetMarker)) {
                            _applyOwnerReset(_RECOVERY_PWD, "Réinitialisation automatique unique — identifiant 'proprietaire', mot de passe '" + _RECOVERY_PWD + "' (À CHANGER après connexion)", _resetMarker);
                        } else {
                            finishPlatform();
                        }
                    });
                });
            });
        });
    }
}

migrations.forEach((m) => {
    const { name, sql, run } = m;
    if (run) {
        run(db, () => {
            console.log('✅', name);
            checkDone();
        });
    } else {
        db.run(sql, (err) => {
            if (err && !err.message.includes('duplicate column') && !err.message.includes('already exists') && !err.message.includes('UNIQUE')) {
                console.error('Erreur', name, ':', err.message);
            } else {
                console.log('✅', name);
            }
            checkDone();
        });
    }
});
