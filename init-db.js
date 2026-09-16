/**
 * Initialisation de la base de données GOOD ENGINEERS-DRILL
 * Usage: node init-db.js          → Crée les tables si elles n'existent pas
 *        node init-db.js --force  → Supprime et recrée la base (ATTENTION: perte de données)
 */

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const planRoles = require('./plan-roles');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.db');
const FORCE = process.argv.includes('--force');
const initialPlatformPassword = process.env.INITIAL_PLATFORM_PASSWORD || crypto.randomBytes(18).toString('base64url');
const initialPlatformHash = bcrypt.hashSync(initialPlatformPassword, 10);

if (FORCE && fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    const walPath = DB_PATH + '-wal';
    const shmPath = DB_PATH + '-shm';
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
    console.log('🗑️  Ancienne base de données supprimée');
}

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌ Erreur de connexion:', err.message);
        process.exit(1);
    }
    console.log('✅ Base de données créée/connectée');
});

// Configuration robuste
db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON');
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = FULL');

    // Table des entreprises (multi-tenant) et abonnements
    db.run(`
        CREATE TABLE IF NOT EXISTS enterprises (
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
            plan TEXT DEFAULT 'free',
            subscriptionStartDate TEXT DEFAULT NULL,
            subscriptionEndDate TEXT DEFAULT NULL,
            subscriptionStatus TEXT DEFAULT 'active',
            maxUsers INTEGER DEFAULT 5,
            maxDrills INTEGER DEFAULT 10,
            maxSites INTEGER DEFAULT 1,
            allowedRoles TEXT DEFAULT NULL,
            subscriptionCustomMonthly REAL DEFAULT NULL,
            subscriptionCustomYearly REAL DEFAULT NULL,
            subscriptionCustomCurrency TEXT DEFAULT NULL,
            allowedTabs TEXT DEFAULT NULL,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('Erreur table enterprises:', err);
        else console.log('✅ Table enterprises');
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS subscription_plan_catalog (
            plan TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            monthlyPrice REAL NOT NULL DEFAULT 0,
            yearlyPrice REAL DEFAULT NULL,
            currency TEXT NOT NULL DEFAULT 'EUR',
            defaultAllowedTabs TEXT DEFAULT NULL,
            updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('Erreur table subscription_plan_catalog:', err);
        else console.log('✅ Table subscription_plan_catalog');
    });
    db.run(`INSERT OR IGNORE INTO subscription_plan_catalog (plan, label, monthlyPrice, yearlyPrice, currency) VALUES ('free', 'Gratuit', 0, 0, 'EUR')`);
    db.run(`INSERT OR IGNORE INTO subscription_plan_catalog (plan, label, monthlyPrice, yearlyPrice, currency) VALUES ('basic', 'Basic', 49, 490, 'EUR')`);
    db.run(`INSERT OR IGNORE INTO subscription_plan_catalog (plan, label, monthlyPrice, yearlyPrice, currency) VALUES ('premium', 'Premium', 149, 1490, 'EUR')`);
    db.run(`INSERT OR IGNORE INTO subscription_plan_catalog (plan, label, monthlyPrice, yearlyPrice, currency) VALUES ('enterprise', 'Enterprise', 499, 4990, 'EUR')`);

    db.run('ALTER TABLE subscription_plan_catalog ADD COLUMN defaultAllowedTabs TEXT DEFAULT NULL', (aerr) => {
        if (aerr && !String(aerr.message || '').includes('duplicate column')) {
            console.warn('Migration subscription_plan_catalog.defaultAllowedTabs:', aerr.message);
        }
        Object.keys(planRoles.DEFAULT_TABS_BY_PLAN).forEach((p) => {
            const json = JSON.stringify(planRoles.DEFAULT_TABS_BY_PLAN[p]);
            db.run(
                'UPDATE subscription_plan_catalog SET defaultAllowedTabs = ? WHERE plan = ? AND (defaultAllowedTabs IS NULL OR TRIM(COALESCE(defaultAllowedTabs,\'\')) = \'\')',
                [json, p]
            );
        });
    });

    // Table des utilisateurs (enterpriseId NULL = administrateur général)
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            passwordHash TEXT DEFAULT NULL,
            role TEXT NOT NULL,
            name TEXT NOT NULL,
            enterpriseId INTEGER DEFAULT NULL,
            email TEXT DEFAULT NULL,
            restrictions TEXT DEFAULT '{}',
            siteIds TEXT DEFAULT '[]',
            notes TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
        )
    `, (err) => {
        if (err) console.error('Erreur table users:', err);
        else console.log('✅ Table users');
    });

    // Table des clients
    db.run(`
        CREATE TABLE IF NOT EXISTS clients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL DEFAULT 1,
            name TEXT NOT NULL,
            legalName TEXT,
            address TEXT,
            city TEXT,
            postalCode TEXT,
            country TEXT,
            taxId TEXT,
            vatNumber TEXT,
            email TEXT,
            phone TEXT,
            website TEXT,
            logo TEXT DEFAULT '',
            currency TEXT DEFAULT 'EUR',
            paymentTerms TEXT,
            notes TEXT DEFAULT '',
            machines TEXT DEFAULT '[]',
            monthlyMeters TEXT DEFAULT '{}',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
        )
    `, (err) => {
        if (err) console.error('Erreur table clients:', err);
        else console.log('✅ Table clients');
    });

    // Table des sites
    db.run(`
        CREATE TABLE IF NOT EXISTS sites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL DEFAULT 1,
            name TEXT NOT NULL,
            address TEXT DEFAULT '',
            city TEXT DEFAULT '',
            region TEXT DEFAULT '',
            country TEXT DEFAULT '',
            clientId INTEGER NOT NULL,
            coordinates TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id),
            FOREIGN KEY (clientId) REFERENCES clients(id)
        )
    `, (err) => {
        if (err) console.error('Erreur table sites:', err);
        else console.log('✅ Table sites');
    });

    // Table des contrats
    db.run(`
        CREATE TABLE IF NOT EXISTS contracts (
            id TEXT PRIMARY KEY,
            enterpriseId INTEGER NOT NULL DEFAULT 1,
            clientId INTEGER NOT NULL,
            siteId INTEGER DEFAULT NULL,
            startDate TEXT NOT NULL,
            endDate TEXT NOT NULL,
            value REAL NOT NULL,
            currency TEXT DEFAULT 'EUR',
            status TEXT DEFAULT 'active',
            description TEXT,
            paymentTerms TEXT,
            billingMonthDefinition TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            fuelPrice REAL DEFAULT 1.20,
            fuelPriceCurrency TEXT DEFAULT NULL,
            rates TEXT DEFAULT '[]',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id),
            FOREIGN KEY (clientId) REFERENCES clients(id),
            FOREIGN KEY (siteId) REFERENCES sites(id)
        )
    `, (err) => {
        if (err) console.error('Erreur table contracts:', err);
        else console.log('✅ Table contracts');
    });

    // Table des machines
    db.run(`
        CREATE TABLE IF NOT EXISTS drills (
            id TEXT PRIMARY KEY,
            enterpriseId INTEGER NOT NULL DEFAULT 1,
            location TEXT NOT NULL,
            status TEXT NOT NULL,
            siteId INTEGER DEFAULT NULL,
            contractId TEXT DEFAULT NULL,
            telemetry TEXT DEFAULT '{}',
            maintenance INTEGER DEFAULT 100,
            fuel TEXT DEFAULT '{}',
            rods TEXT DEFAULT '{}',
            consumables TEXT DEFAULT '{}',
            connectionMode TEXT DEFAULT 'manual',
            connectionStatus TEXT DEFAULT 'disconnected',
            connectionConfig TEXT DEFAULT '{}',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id),
            FOREIGN KEY (siteId) REFERENCES sites(id),
            FOREIGN KEY (contractId) REFERENCES contracts(id)
        )
    `, (err) => {
        if (err) console.error('Erreur table drills:', err);
        else console.log('✅ Table drills');
    });

    // Table des employés
    db.run(`
        CREATE TABLE IF NOT EXISTS employees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL DEFAULT 1,
            employeeNumber TEXT NOT NULL,
            name TEXT NOT NULL,
            role TEXT NOT NULL,
            email TEXT,
            phone TEXT,
            status TEXT DEFAULT 'active',
            salary REAL DEFAULT 0,
            startDate TEXT,
            address TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            takenLeave INTEGER DEFAULT 0,
            payslips TEXT DEFAULT '[]',
            siteId INTEGER,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id),
            FOREIGN KEY (siteId) REFERENCES sites(id),
            UNIQUE(enterpriseId, employeeNumber)
        )
    `, (err) => {
        if (err) console.error('Erreur table employees:', err);
        else console.log('✅ Table employees');
    });

    // Table des assignations
    db.run(`
        CREATE TABLE IF NOT EXISTS assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            drillId TEXT NOT NULL,
            operatorId INTEGER NOT NULL,
            operatorName TEXT NOT NULL,
            helpers TEXT DEFAULT '[]',
            startDate TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            clientId INTEGER,
            contractId TEXT DEFAULT NULL,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (drillId) REFERENCES drills(id),
            FOREIGN KEY (operatorId) REFERENCES employees(id),
            FOREIGN KEY (contractId) REFERENCES contracts(id)
        )
    `, (err) => {
        if (err) console.error('Erreur table assignments:', err);
        else {
            console.log('✅ Table assignments');
            db.run(
                `CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_one_active_per_drill ON assignments(drillId) WHERE status = 'active'`,
                (eIdx) => {
                    if (eIdx) console.error('Index assignments (active/drill):', eIdx.message);
                }
            );
        }
    });

    // Table des factures
    db.run(`
        CREATE TABLE IF NOT EXISTS invoices (
            id TEXT PRIMARY KEY,
            enterpriseId INTEGER NOT NULL DEFAULT 1,
            invoiceNumber TEXT NOT NULL,
            date TEXT NOT NULL,
            dueDate TEXT,
            clientId INTEGER NOT NULL,
            items TEXT DEFAULT '[]',
            subtotal REAL DEFAULT 0,
            taxRate REAL DEFAULT 0,
            taxAmount REAL DEFAULT 0,
            total REAL DEFAULT 0,
            currency TEXT DEFAULT 'EUR',
            status TEXT DEFAULT 'pending',
            notes TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id),
            FOREIGN KEY (clientId) REFERENCES clients(id),
            UNIQUE(enterpriseId, invoiceNumber)
        )
    `, (err) => {
        if (err) console.error('Erreur table invoices:', err);
        else console.log('✅ Table invoices');
    });

    // Table de l'inventaire
    db.run(`
        CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL DEFAULT 1,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            quantity INTEGER DEFAULT 0,
            minStock INTEGER DEFAULT 0,
            unit TEXT DEFAULT 'unité',
            price REAL DEFAULT 0,
            alert INTEGER DEFAULT 0,
            averagePrice REAL DEFAULT 0,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.error('Erreur table inventory:', err);
        else console.log('✅ Table inventory');
    });

    // Table des données journalières (shift: '' = journée complète, '1'/'2'/'3' = équipes)
    db.run(`
        CREATE TABLE IF NOT EXISTS dailyDataRecords (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            machineId TEXT NOT NULL,
            shift TEXT DEFAULT '',
            data TEXT DEFAULT '{}',
            notes TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            enteredByUsername TEXT DEFAULT '',
            enteredByName TEXT DEFAULT '',
            enteredAt TEXT DEFAULT NULL,
            lastModifiedByUsername TEXT DEFAULT '',
            lastModifiedByName TEXT DEFAULT '',
            lastModifiedAt TEXT DEFAULT NULL,
            workflowStatus TEXT NOT NULL DEFAULT 'draft',
            submittedByUsername TEXT DEFAULT '',
            submittedAt TEXT DEFAULT NULL,
            reviewedByUsername TEXT DEFAULT '',
            reviewedByName TEXT DEFAULT '',
            reviewedAt TEXT DEFAULT NULL,
            reviewComment TEXT DEFAULT '',
            workflowVersion INTEGER NOT NULL DEFAULT 0,
            UNIQUE(date, machineId, shift)
        )
    `, (err) => {
        if (err) console.error('Erreur table dailyDataRecords:', err);
        else console.log('✅ Table dailyDataRecords');
    });

    // Plan de forage centralisé : blocs et trous structurés par entreprise.
    db.run(`CREATE TABLE IF NOT EXISTS drilling_plan_meta (
        enterpriseId INTEGER PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 0,
        updatedByUsername TEXT DEFAULT '',
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS drilling_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        spacing TEXT DEFAULT '',
        burden REAL DEFAULT NULL,
        cols INTEGER DEFAULT 5,
        siteId INTEGER DEFAULT NULL,
        contractId TEXT DEFAULT NULL,
        description TEXT DEFAULT '',
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(enterpriseId, code),
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS drilling_holes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        blockId INTEGER NOT NULL,
        code TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PLANIFIÉ',
        plannedDepth REAL DEFAULT 0,
        actualDepth REAL DEFAULT 0,
        diameterMm REAL DEFAULT NULL,
        azimuth REAL DEFAULT 0,
        inclination REAL DEFAULT 90,
        easting REAL DEFAULT NULL,
        northing REAL DEFAULT NULL,
        elevation REAL DEFAULT NULL,
        geology TEXT DEFAULT '',
        waterEncountered INTEGER DEFAULT 0,
        waterDepth REAL DEFAULT NULL,
        drillId TEXT DEFAULT NULL,
        operatorName TEXT DEFAULT '',
        startDate TEXT DEFAULT '',
        endDate TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(blockId, code),
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id) ON DELETE CASCADE,
        FOREIGN KEY (blockId) REFERENCES drilling_blocks(id) ON DELETE CASCADE
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_drilling_blocks_enterprise ON drilling_blocks(enterpriseId)');
    db.run('CREATE INDEX IF NOT EXISTS idx_drilling_holes_enterprise_block ON drilling_holes(enterpriseId, blockId)');

    // Table des informations de l'entreprise
    db.run(`
        CREATE TABLE IF NOT EXISTS companyInfo (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL DEFAULT 1,
            name TEXT,
            legalName TEXT,
            address TEXT,
            city TEXT,
            country TEXT DEFAULT 'Burkina Faso',
            postalCode TEXT,
            taxId TEXT,
            siret TEXT,
            ifu TEXT DEFAULT '',
            rccm TEXT DEFAULT '',
            phone TEXT,
            email TEXT,
            website TEXT,
            bankName TEXT,
            iban TEXT,
            bic TEXT,
            vatNumber TEXT,
            tvaRate REAL DEFAULT 18,
            retenueSourceRate REAL DEFAULT 5,
            currency TEXT DEFAULT 'XOF',
            logo TEXT DEFAULT '',
            updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
        )
    `, (err) => {
        if (err) console.error('Erreur table companyInfo:', err);
        else console.log('✅ Table companyInfo');
    });

    // Table des consommables utilisés par jour/machine (alignés avec production)
    db.run(`
        CREATE TABLE IF NOT EXISTS dailyConsumables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            machineId TEXT NOT NULL,
            shift TEXT DEFAULT '',
            consumableId INTEGER NOT NULL,
            quantityUsed REAL NOT NULL,
            unitPrice REAL DEFAULT 0,
            totalCost REAL DEFAULT 0,
            currency TEXT DEFAULT 'XOF',
            notes TEXT DEFAULT '',
            enteredByUsername TEXT DEFAULT '',
            enteredByName TEXT DEFAULT '',
            enteredAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (consumableId) REFERENCES inventory(id),
            UNIQUE(date, machineId, shift, consumableId)
        )
    `, (err) => {
        if (err) console.error('Erreur table dailyConsumables:', err);
        else console.log('✅ Table dailyConsumables');
    });

    // Table des mouvements de stock
    db.run(`
        CREATE TABLE IF NOT EXISTS stockMovements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            articleId INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            unitPrice REAL DEFAULT 0,
            total REAL DEFAULT 0,
            date TEXT NOT NULL,
            supplier TEXT DEFAULT '',
            person TEXT DEFAULT '',
            personId INTEGER,
            authorizedBy TEXT DEFAULT '',
            authorizedById INTEGER DEFAULT NULL,
            reason TEXT DEFAULT '',
            machineId TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (articleId) REFERENCES inventory(id)
        )
    `, (err) => {
        if (err) console.error('Erreur table stockMovements:', err);
        else console.log('✅ Table stockMovements');
    });

    // Table des planifications de maintenance
    db.run(`
        CREATE TABLE IF NOT EXISTS maintenanceSchedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            machineId TEXT NOT NULL,
            type TEXT NOT NULL,
            description TEXT,
            intervalType TEXT,
            intervalValue INTEGER,
            lastMaintenanceDate TEXT,
            lastMaintenanceHours INTEGER DEFAULT 0,
            nextMaintenanceDate TEXT,
            nextMaintenanceHours INTEGER DEFAULT 0,
            cost REAL DEFAULT 0,
            status TEXT DEFAULT 'scheduled',
            priority TEXT DEFAULT 'medium',
            assignedTo TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (machineId) REFERENCES drills(id)
        )
    `, (err) => {
        if (err) console.error('Erreur table maintenanceSchedules:', err);
        else console.log('✅ Table maintenanceSchedules');
    });

    // Table de l'historique de maintenance
    db.run(`
        CREATE TABLE IF NOT EXISTS maintenanceHistory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scheduleId INTEGER,
            machineId TEXT NOT NULL,
            date TEXT NOT NULL,
            type TEXT,
            description TEXT,
            cost REAL DEFAULT 0,
            duration REAL DEFAULT 0,
            technician TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (scheduleId) REFERENCES maintenanceSchedules(id),
            FOREIGN KEY (machineId) REFERENCES drills(id)
        )
    `, (err) => {
        if (err) console.error('Erreur table maintenanceHistory:', err);
        else console.log('✅ Table maintenanceHistory');
    });

    // Table des dépenses diverses
    db.run(`
        CREATE TABLE IF NOT EXISTS miscellaneousExpenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL DEFAULT 1,
            date TEXT NOT NULL,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            category TEXT DEFAULT 'Autre',
            notes TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
        )
    `, (err) => {
        if (err) console.error('Erreur table miscellaneousExpenses:', err);
        else console.log('✅ Table miscellaneousExpenses');
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS worker_chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            fromUserId INTEGER NOT NULL,
            toUserId INTEGER,
            body TEXT DEFAULT '',
            filePath TEXT,
            fileOriginalName TEXT,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
        )
    `, (err) => {
        if (err) console.error('Erreur worker_chat_messages:', err);
        else console.log('✅ Table worker_chat_messages');
    });
    db.run(`
        CREATE TABLE IF NOT EXISTS company_info_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            authorUserId INTEGER,
            pinned INTEGER DEFAULT 0,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
        )
    `, (err) => {
        if (err) console.error('Erreur company_info_posts:', err);
        else console.log('✅ Table company_info_posts');
    });
    db.run(`
        CREATE TABLE IF NOT EXISTS report_distributions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            fromUserId INTEGER NOT NULL,
            title TEXT NOT NULL,
            body TEXT,
            reportData TEXT,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
        )
    `, (err) => {
        if (err) console.error('Erreur report_distributions:', err);
        else console.log('✅ Table report_distributions');
    });
    db.run(`
        CREATE TABLE IF NOT EXISTS report_distribution_emails (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            distributionId INTEGER NOT NULL,
            email TEXT NOT NULL,
            FOREIGN KEY (distributionId) REFERENCES report_distributions(id) ON DELETE CASCADE
        )
    `, (err) => {
        if (err) console.error('Erreur report_distribution_emails:', err);
        else console.log('✅ Table report_distribution_emails');
    });

    function migrateIgnoreDup(sql, label) {
        db.run(sql, (e) => {
            if (
                e &&
                !String(e.message || '').toLowerCase().includes('duplicate') &&
                !String(e.message || '').includes('already exists')
            ) {
                console.warn('Migration ' + label + ':', e.message);
            }
        });
    }
    migrateIgnoreDup("ALTER TABLE companyInfo ADD COLUMN signatoryFirstName TEXT DEFAULT ''", 'companyInfo.signatoryFirstName');
    migrateIgnoreDup("ALTER TABLE companyInfo ADD COLUMN signatoryLastName TEXT DEFAULT ''", 'companyInfo.signatoryLastName');
    migrateIgnoreDup("ALTER TABLE companyInfo ADD COLUMN signatoryTitle TEXT DEFAULT ''", 'companyInfo.signatoryTitle');
    migrateIgnoreDup("ALTER TABLE clients ADD COLUMN signatoryFirstName TEXT DEFAULT ''", 'clients.signatoryFirstName');
    migrateIgnoreDup("ALTER TABLE clients ADD COLUMN signatoryLastName TEXT DEFAULT ''", 'clients.signatoryLastName');
    migrateIgnoreDup("ALTER TABLE clients ADD COLUMN signatoryTitle TEXT DEFAULT ''", 'clients.signatoryTitle');
    migrateIgnoreDup("ALTER TABLE invoices ADD COLUMN billingMonth TEXT DEFAULT ''", 'invoices.billingMonth');
    migrateIgnoreDup("ALTER TABLE invoices ADD COLUMN signProviderJson TEXT DEFAULT ''", 'invoices.signProviderJson');
    migrateIgnoreDup("ALTER TABLE invoices ADD COLUMN signClientJson TEXT DEFAULT ''", 'invoices.signClientJson');
    migrateIgnoreDup("ALTER TABLE contracts ADD COLUMN billingMonthDefinition TEXT DEFAULT ''", 'contracts.billingMonthDefinition');

    db.run(
        `
        CREATE TABLE IF NOT EXISTS drill_month_billing (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            drillId TEXT NOT NULL,
            yearMonth TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'closed_arret',
            invoiceId TEXT,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(enterpriseId, drillId, yearMonth),
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
        )
    `,
        (err) => {
            if (err) console.error('Erreur drill_month_billing:', err);
            else console.log('✅ Table drill_month_billing');
        }
    );

    // Entreprise initiale minimale (sans client ni foreuse fictifs — tout est à créer depuis l’app)
    db.get('SELECT COUNT(*) as n FROM enterprises', [], (err, row) => {
        const n = row ? row.n : 1;
        if (err || n === 0) {
            db.run(`INSERT OR IGNORE INTO enterprises (id, name, slug, currency) VALUES (1, 'Mon organisation', 'mon-organisation', 'XOF')`);
        }
    });

    db.get('SELECT COUNT(*) as n FROM users', [], (err, row) => {
        const userCount = row ? row.n : 1;
        if (err || userCount === 0) {
            db.run(`
                INSERT OR IGNORE INTO users (username, password, passwordHash, role, name, enterpriseId, restrictions, notes)
                VALUES (?, '', ?, 'platform_owner', 'Gestion abonnements SaaS', NULL, '{}', 'Créer entreprises, abonnements et utilisateurs plateforme (mode partagé)')
            `, ['gestion_abonnements', initialPlatformHash], (e) => {
                if (!e) console.log('✅ Compte plateforme créé. Utilisez INITIAL_PLATFORM_PASSWORD (ou le mot de passe généré affiché ci-dessous) pour la première connexion.');
                if (!e && !process.env.INITIAL_PLATFORM_PASSWORD) console.log('Mot de passe initial généré : ' + initialPlatformPassword);
                finishInit();
            });
        } else {
            db.run(`INSERT OR IGNORE INTO users (username, password, passwordHash, role, name, enterpriseId, restrictions, notes) VALUES (?, '', ?, 'platform_owner', 'Gestion abonnements SaaS', NULL, '{}', 'Créer entreprises, abonnements et utilisateurs plateforme (mode partagé)')`, ['gestion_abonnements', initialPlatformHash], () => {
                db.run(`INSERT OR IGNORE INTO users (username, password, passwordHash, role, name, enterpriseId, restrictions, notes) VALUES (?, '', ?, 'platform_owner', 'Propriétaire plateforme', NULL, '{}', 'Gestion des abonnements entreprises')`, ['proprietaire', initialPlatformHash], () => {
                    db.run(`DELETE FROM users WHERE username = 'admin'`, () => finishInit());
                });
            });
        }
    });

    // Aucun client ni donnée métier fictive : les tenants créent clients, sites et foreuses dans l’interface.

    db.get('SELECT COUNT(*) as n FROM drills', [], () => {
        // Pas de foreuses fictives : l’entreprise les ajoute depuis le tableau de bord.
        finishInit();
    });
});

let initTasks = 2; // users + drills
let initTasksDone = 0;
function finishInit() {
    initTasksDone++;
    if (initTasksDone >= initTasks) {
        db.close(doClose);
    }
}

function doClose(err) {
    if (err) console.error('❌ Erreur fermeture:', err.message);
    else {
        console.log('\n✨ Base de données initialisée avec succès!');
        console.log('📊 Fichier: ' + DB_PATH);
        console.log('\n🚀 Pour démarrer: npm start');
        console.log('💾 Pour sauvegarder: npm run backup');
    }
}
