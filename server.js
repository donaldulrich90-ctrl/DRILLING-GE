const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { getDb, backup, DB_PATH, BACKUP_DIR } = require('./db');
const { verifyAuth, requirePlatformAdmin } = require('./middleware/saas-auth');
const planRoles = require('./plan-roles');
const { ensureDailyDataRecordsSchema } = require('./ensure-daily-data-schema');
// Portail GOOD ENGINEERS : connexion unique (SSO) et API de métriques.
const { registerSso } = require('./ge-sso');
const { registerMetrics } = require('./ge-metrics');

// ── Upload logo entreprise ─────────────────────────────────────────────────
const enterpriseLogoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'uploads', 'enterprises', String(req.params.id));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.png';
        cb(null, 'logo' + ext);
    }
});
const enterpriseLogoUpload = multer({
    storage: enterpriseLogoStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Seules les images sont acceptées (PNG, JPG, SVG…)'));
    }
});

const app = express();
const PORT = process.env.PORT || 3000;

// Derrière un reverse proxy (Nginx, Cloudflare) : HTTPS et IP client corrects
if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
}

// Mode de déploiement : 'dedicated' = une instance par entreprise (défaut) | 'shared' = multi-tenant
const DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE || 'dedicated';

// Middleware
const allowedCorsOrigins = new Set(
    String(process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
);
// En-têtes de sécurité HTTP (XSS, clickjacking, MIME sniffing, etc.)
app.use(helmet({
    contentSecurityPolicy: false // désactivé car la plateforme charge CDN externes (Chart.js, Tailwind, Google Fonts)
}));

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedCorsOrigins.has(origin)) return callback(null, true);
        return callback(new Error('Origine CORS non autorisée'));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Enterprise-Id']
}));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

// ── Portail GOOD ENGINEERS ─────────────────────────────────────────────────
// Montées AVANT le gardien « JWT requis pour /api » : /sso est publique et
// /api/service/* a sa propre vérification (clé de service X-Service-Key).
registerSso(app);
registerMetrics(app);

// Rate limiting anti brute-force sur le login
const loginRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,                   // 20 tentatives par IP par fenêtre
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.' }
});

// ── Routes explicites AVANT les middlewares statiques ──────────────────────
// (express.static('dist') servirait dist/index.html à '/' sinon)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'plateforme-forage.html')));
app.get('/plateforme-forage.html', (req, res) => res.sendFile(path.join(__dirname, 'plateforme-forage.html')));
app.get('/api-client.js', (req, res) => res.sendFile(path.join(__dirname, 'api-client.js')));
app.get('/i18n.js', (req, res) => res.sendFile(path.join(__dirname, 'i18n.js')));
// Moniteur forage React (accès direct via /monitor)
app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

// ── Fichiers statiques ─────────────────────────────────────────────────────
app.use(express.static('dist')); // Assets JS/CSS du build React
app.use(express.static('public'));
// Fichiers statiques servis explicitement — pas de express.static(__dirname)
// pour éviter d'exposer database.db, server.js, etc.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/logo-good-engineers.png', (req, res) => res.sendFile(path.join(__dirname, 'logo-good-engineers.png')));
app.get('/logo-sahara-mining-services.png', (req, res) => res.sendFile(path.join(__dirname, 'logo-sahara-mining-services.png')));
app.get('/logo-client-vital.svg', (req, res) => res.sendFile(path.join(__dirname, 'logo-client-vital.svg')));
app.get('/logo-client-vital.png', (req, res) => {
    const p = path.join(__dirname, 'logo-client-vital.png');
    if (fs.existsSync(p)) return res.sendFile(p);
    res.sendFile(path.join(__dirname, 'logo-client-vital.svg'));
});

// Connexion à la base de données (module db.js : WAL, clés étrangères, intégrité)
if (!fs.existsSync(DB_PATH)) {
    console.log('⚠️ Base de données non trouvée. Exécutez: npm run init-db');
}
const db = getDb();

// --- Filet de sécurité : sauvegarde automatique au démarrage + rotation ---
// Désactivable avec AUTO_BACKUP=off. Conserve les BACKUP_KEEP dernières (def. 30).
(function autoBackupOnStartup() {
    if (String(process.env.AUTO_BACKUP || '').toLowerCase() === 'off') return;
    try {
        if (!fs.existsSync(DB_PATH)) return;
        const keep = parseInt(process.env.BACKUP_KEEP, 10) > 0 ? parseInt(process.env.BACKUP_KEEP, 10) : 30;
        setTimeout(function () {
            backup().then(function () {
                try {
                    const files = fs.readdirSync(BACKUP_DIR)
                        .filter(function (f) { return /^database_.*\.db$/.test(f); })
                        .sort();
                    const excess = files.length - keep;
                    for (let i = 0; i < excess; i++) {
                        try { fs.unlinkSync(path.join(BACKUP_DIR, files[i])); } catch (e) {}
                    }
                } catch (e) {}
            }).catch(function (e) { console.warn('Sauvegarde au démarrage échouée:', e.message); });
        }, 3000);
    } catch (e) { console.warn('Auto-backup:', e.message); }
})();

/** siteIds en JSON dans la BDD → tableau d’identifiants numériques */
function parseUserSiteIds(raw) {
    if (raw == null || raw === '') return [];
    try {
        const a = JSON.parse(raw);
        if (!Array.isArray(a)) return [];
        return a.map((x) => parseInt(x, 10)).filter((n) => !Number.isNaN(n));
    } catch (_) {
        return [];
    }
}

function canManageSitesWrite(req) {
    if (!req.auth) return false;
    if (req.auth.isSuperAdmin || req.auth.isPlatformOwner) return true;
    if (req.auth.role === 'platform_owner') return true;
    if (req.auth.role === 'admin' || req.auth.role === 'gestionnaire_site') return true;
    return false;
}

/** La gestion des comptes est réservée aux administrateurs du tenant et à la plateforme. */
function requireUserManagementRole(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'Non authentifié' });
    if (req.auth.isSuperAdmin || req.auth.isPlatformOwner) return next();
    if (['platform_owner', 'admin', 'gestionnaire', 'gestionnaire_site'].includes(req.auth.role)) return next();
    return res.status(403).json({ error: 'Accès réservé aux gestionnaires et administrateurs' });
}

function enrichEnterpriseRows(rows) {
    const list = rows || [];
    return list.map((row) => {
        // Ne jamais exposer la clé API Claude en clair : on remplace par un booléen.
        const { claudeApiKey, ...safe } = row;
        return {
            ...safe,
            claudeApiKeySet: !!(claudeApiKey && String(claudeApiKey).trim()),
            effectiveAllowedTabs: planRoles.getEffectiveAllowedTabs(row)
        };
    });
}

function alignEnterpriseMaxSitesWithSiteCounts(dbConn, cb) {
    dbConn.all('SELECT id FROM enterprises', (err, rows) => {
        if (err || !rows || rows.length === 0) return cb && cb();
        let i = 0;
        function step() {
            if (i >= rows.length) return cb && cb();
            const entId = rows[i++].id;
            dbConn.get('SELECT COUNT(*) as n FROM sites WHERE enterpriseId = ?', [entId], (e2, r2) => {
                if (e2) return step();
                const need = Math.max(1, parseInt(r2 && r2.n, 10) || 0);
                dbConn.run(
                    'UPDATE enterprises SET maxSites = MAX(COALESCE(maxSites, 1), ?) WHERE id = ?',
                    [need, entId],
                    () => step()
                );
            });
        }
        step();
    });
}

// Migration : site d’affectation par employé (bases créées avant ce champ)
db.run('ALTER TABLE employees ADD COLUMN siteId INTEGER', (err) => {
    if (err && !String(err.message || '').includes('duplicate column')) {
        console.warn('Migration employees.siteId:', err.message);
    }
});

// Migration : section/service de la mine (renseigné surtout pour stagiaire / « Autre »)
db.run('ALTER TABLE employees ADD COLUMN section TEXT DEFAULT NULL', (err) => {
    if (err && !String(err.message || '').includes('duplicate column')) {
        console.warn('Migration employees.section:', err.message);
    }
});

// Migration : affectation (équipe, rotation, type d'engin opéré)
['team', 'rotation', 'enginType'].forEach((col) => {
    db.run('ALTER TABLE employees ADD COLUMN ' + col + ' TEXT DEFAULT NULL', (err) => {
        if (err && !String(err.message || '').includes('duplicate column')) {
            console.warn('Migration employees.' + col + ':', err.message);
        }
    });
});

db.run('ALTER TABLE enterprises ADD COLUMN allowedTabs TEXT DEFAULT NULL', (err) => {
    if (err && !String(err.message || '').includes('duplicate column')) {
        console.warn('Migration enterprises.allowedTabs:', err.message);
    }
});

// Quota sites par abonnement (entreprise) — aligne le plafond ≥ nombre de sites existants à chaque démarrage
db.run('ALTER TABLE enterprises ADD COLUMN maxSites INTEGER DEFAULT 1', (err) => {
    if (err && !String(err.message || '').includes('duplicate column')) {
        console.warn('Migration enterprises.maxSites:', err.message);
    }
    alignEnterpriseMaxSitesWithSiteCounts(db, () => {});
});

db.run('ALTER TABLE users ADD COLUMN email TEXT DEFAULT NULL', (err) => {
    if (err && !String(err.message || '').includes('duplicate column')) {
        console.warn('Migration users.email:', err.message);
    }
});

db.run('ALTER TABLE subscription_plan_catalog ADD COLUMN defaultAllowedTabs TEXT DEFAULT NULL', (err) => {
    if (err && !String(err.message || '').includes('duplicate column')) {
        console.warn('Migration subscription_plan_catalog.defaultAllowedTabs:', err.message);
    }
});

db.run('ALTER TABLE drills ADD COLUMN model TEXT DEFAULT NULL', (err) => {
    if (err && !String(err.message || '').includes('duplicate column')) {
        console.warn('Migration drills.model:', err.message);
    }
});

db.run('ALTER TABLE drills ADD COLUMN operator TEXT DEFAULT NULL', (err) => {
    if (err && !String(err.message || '').includes('duplicate column')) {
        console.warn('Migration drills.operator:', err.message);
    }
});

// Allocation d'une foreuse à un sous-traitant propriétaire (optionnel).
db.run('ALTER TABLE drills ADD COLUMN subcontractorId INTEGER DEFAULT NULL', (err) => {
    if (err && !String(err.message || '').includes('duplicate column')) {
        console.warn('Migration drills.subcontractorId:', err.message);
    }
});

function loadPlanDefaultTabsFromDb() {
    db.all('SELECT plan, defaultAllowedTabs FROM subscription_plan_catalog', [], (err, rows) => {
        if (err) {
            console.warn('Chargement onglets par formule:', err.message);
            return;
        }
        const map = {};
        (rows || []).forEach((r) => {
            const parsed = planRoles.parseAllowedTabsJson(r.defaultAllowedTabs);
            if (parsed && parsed.length) {
                const cleaned = parsed.filter((x) => planRoles.TENANT_MAIN_VIEWS.includes(String(x)));
                if (cleaned.length) map[r.plan] = cleaned;
            }
        });
        planRoles.setPlanDefaultTabsFromDatabase(Object.keys(map).length ? map : null);
    });
}
db.run(
    `CREATE TABLE IF NOT EXISTS worker_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        fromUserId INTEGER NOT NULL,
        toUserId INTEGER,
        body TEXT DEFAULT '',
        filePath TEXT,
        fileOriginalName TEXT,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
    )`,
    (err) => {
        if (err) console.warn('worker_chat_messages:', err.message);
    }
);
db.run(
    `CREATE TABLE IF NOT EXISTS company_info_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        authorUserId INTEGER,
        pinned INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
    )`,
    (err) => {
        if (err) console.warn('company_info_posts:', err.message);
    }
);
db.run(
    `CREATE TABLE IF NOT EXISTS report_distributions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        enterpriseId INTEGER NOT NULL,
        fromUserId INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        reportData TEXT,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (enterpriseId) REFERENCES enterprises(id)
    )`,
    (err) => {
        if (err) console.warn('report_distributions:', err.message);
    }
);
db.run(
    `CREATE TABLE IF NOT EXISTS report_distribution_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        distributionId INTEGER NOT NULL,
        email TEXT NOT NULL,
        FOREIGN KEY (distributionId) REFERENCES report_distributions(id) ON DELETE CASCADE
    )`,
    (err) => {
        if (err) console.warn('report_distribution_emails:', err.message);
    }
);

// Traçabilité et circuit opérateur → superviseur pour les données journalières.
const dailyDataColumnDefinitions = {
    enteredByUsername: "TEXT DEFAULT ''",
    enteredByName: "TEXT DEFAULT ''",
    enteredAt: 'TEXT DEFAULT NULL',
    lastModifiedByUsername: "TEXT DEFAULT ''",
    lastModifiedByName: "TEXT DEFAULT ''",
    lastModifiedAt: 'TEXT DEFAULT NULL',
    workflowStatus: "TEXT NOT NULL DEFAULT 'draft'",
    submittedByUsername: "TEXT DEFAULT ''",
    submittedAt: 'TEXT DEFAULT NULL',
    reviewedByUsername: "TEXT DEFAULT ''",
    reviewedByName: "TEXT DEFAULT ''",
    reviewedAt: 'TEXT DEFAULT NULL',
    reviewComment: "TEXT DEFAULT ''",
    workflowVersion: 'INTEGER NOT NULL DEFAULT 0'
};
Object.keys(dailyDataColumnDefinitions).forEach((col) => {
    const def = dailyDataColumnDefinitions[col];
    db.run('ALTER TABLE dailyDataRecords ADD COLUMN ' + col + ' ' + def, (err) => {
        if (err && !String(err.message || '').includes('duplicate column')) {
            console.warn('Migration dailyDataRecords.' + col + ':', err.message);
        }
    });
});

function dailyDataElevatedRoleFromAuth(auth) {
    if (!auth) return false;
    if (auth.isSuperAdmin || auth.isPlatformOwner) return true;
    const r = auth.role || '';
    return ['admin', 'super_admin', 'gestionnaire', 'gestionnaire_site', 'superviseur', 'ingenieur', 'platform_owner'].includes(r);
}

// Saisie des données journalières : réservée aux ingénieurs (et à la direction).
// Le tableau de bord reste consultable par tous les rôles ; seule l'écriture est bridée.
function dailyDataCanEnterFromAuth(auth) {
    if (!auth) return false;
    if (auth.isSuperAdmin || auth.isPlatformOwner) return true;
    const r = auth.role || '';
    return ['ingenieur', 'admin', 'super_admin', 'gestionnaire', 'gestionnaire_site', 'platform_owner'].includes(r);
}

function normalizeDailyWorkflowStatus(value) {
    const status = String(value || 'draft').toLowerCase();
    return ['draft', 'submitted', 'approved', 'rejected'].includes(status) ? status : 'draft';
}

function dailyDataHasValue(value) {
    return value != null && !(typeof value === 'string' && value.trim() === '');
}

function dailyDataValidNonnegativeNumber(value) {
    return (typeof value === 'number' || typeof value === 'string') &&
        dailyDataHasValue(value) && Number.isFinite(Number(value)) && Number(value) >= 0;
}

function dailyStopTimeMinutes(value) {
    if (typeof value !== 'string' || !/^\d{1,2}:\d{2}$/.test(value)) return null;
    const [hours, minutes] = value.split(':').map(Number);
    return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

// Un brouillon conserve les champs vides : un zéro saisi reste distinct d'une donnée absente.
// Les contrôles de cohérence du poste entier s'appliquent seulement à sa clôture.
function validateDailyDataValues(data, complete = false) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Les données du poste doivent être un objet.';
    if (data.entryStage != null && !['draft', 'complete'].includes(data.entryStage)) return 'État de saisie invalide.';
    if (data.shift != null && !['', 'day', 'night'].includes(data.shift)) return 'Shift invalide.';
    const numericFields = ['metersDrilled', 'hours', 'redrillMeters', 'flushingMeters', 'fuelAdded', 'fuelPrice',
        'counterStart', 'counterEnd', 'hammerCounterStart', 'hammerCounterEnd', 'hoursCounterStart', 'hoursCounterEnd'];
    for (const field of numericFields) {
        if (dailyDataHasValue(data[field]) && !dailyDataValidNonnegativeNumber(data[field])) {
            return `La valeur du champ ${field} doit être un nombre positif ou nul.`;
        }
    }
    for (const field of ['holesWorked', 'stoppages']) {
        if (data[field] != null && !Array.isArray(data[field])) return `Le champ ${field} doit être une liste.`;
    }
    for (const hole of data.holesWorked || []) {
        if (!hole || typeof hole !== 'object' || Array.isArray(hole)) return 'Une ligne de trou est invalide.';
        if (hole.source != null && !['plan', 'manual', 'automatic'].includes(hole.source)) return 'Origine du trou invalide.';
        if (hole.source === 'manual' || hole.source === 'automatic') {
            if (String(hole.blockId || '').trim()) return 'Un trou saisi hors plan ne doit pas référencer un bloc du plan.';
        }
        if (hole.holeId != null && (typeof hole.holeId !== 'string' || hole.holeId.length > 100)) return 'Identifiant de trou invalide (100 caractères maximum).';
        for (const field of ['meters', 'finalDepth']) {
            if (dailyDataHasValue(hole[field]) && !dailyDataValidNonnegativeNumber(hole[field])) return 'Un métrage ou une profondeur de trou est invalide.';
        }
    }
    for (const stop of data.stoppages || []) {
        if (!stop || typeof stop !== 'object' || Array.isArray(stop)) return 'Une ligne d’arrêt est invalide.';
        const hasHours = dailyDataHasValue(stop.hours);
        if (hasHours && !dailyDataValidNonnegativeNumber(stop.hours)) return 'Une durée d’arrêt est invalide.';
        const hasStart = dailyDataHasValue(stop.timeStart);
        const hasEnd = dailyDataHasValue(stop.timeEnd);
        const start = hasStart ? dailyStopTimeMinutes(stop.timeStart) : null;
        const end = hasEnd ? dailyStopTimeMinutes(stop.timeEnd) : null;
        if ((hasStart && start == null) || (hasEnd && end == null)) return 'Un horaire d’arrêt est invalide (HH:MM attendu).';
        if (hasStart && hasEnd && hasHours) {
            const elapsedHours = (end - start + (end < start ? 1440 : 0)) / 60;
            if (Math.abs(Number(stop.hours) - elapsedHours) > 0.000001) return 'La durée d’arrêt doit correspondre aux horaires de début et de fin.';
        }
        if (complete) {
            if (!String(stop.reason || '').trim()) return 'Renseignez le motif de chaque arrêt avant de terminer le poste.';
            if (!hasHours) return 'Complétez la durée de chaque arrêt avant de terminer le poste.';
            if (hasStart !== hasEnd) return 'Complétez les horaires de l’arrêt en cours ou utilisez une durée sans horaires.';
        }
    }
    return null;
}

function validateDailyDataForSubmission(row) {
    let data;
    try {
        data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : (row.data || {});
    } catch (_) {
        return 'Les données du poste ne sont pas lisibles.';
    }
    const valuesError = validateDailyDataValues(data, true);
    if (valuesError) return valuesError;
    if (data.entryStage === 'draft') return 'Ce poste est préenregistré. Complétez-le et terminez la saisie avant de le soumettre.';
    if (!dailyDataHasValue(data.metersDrilled)) return 'Le métrage foré doit être renseigné avant soumission (0 si aucun mètre).';
    if (!dailyDataHasValue(data.hours)) return 'Les heures machine doivent être renseignées avant soumission (0 si la machine n’a pas fonctionné).';
    const meters = Number(data.metersDrilled);
    const machineHours = Number(data.hours);
    if (!Number.isFinite(meters) || meters < 0) return 'Le métrage foré est invalide.';
    if (!Number.isFinite(machineHours) || machineHours < 0) return 'Les heures machine sont invalides.';
    if (!String(data.location || '').trim()) return 'Le lieu de forage est requis avant soumission.';
    if (!String(data.drillingType || '').trim()) return 'Le type de forage est requis avant soumission.';
    if (!String(data.materialType || '').trim()) return 'Le type de roche ou matériau est requis avant soumission.';
    if (!String(data.bitType || '').trim()) return 'Le type de trépan est requis avant soumission.';

    const holes = Array.isArray(data.holesWorked) ? data.holesWorked.filter(h => {
        const hid = String(h && h.holeId || '').trim();
        return hid && h.meters != null;
    }) : [];
    data.holesWorked = holes;
    const seenHoles = new Set();
    for (const hole of holes) {
        const holeId = String(hole.holeId || '').trim();
        const unplanned = hole.source === 'manual' || hole.source === 'automatic';
        if (!unplanned && !String(hole.blockId || '').trim()) return 'Pour les trous du plan, un bloc est requis.';
        const key = `${String(hole.blockId || '').trim()}::${holeId}`.toLowerCase();
        if (seenHoles.has(key)) return `Le trou ${holeId} est présent plusieurs fois.`;
        seenHoles.add(key);
        const worked = Number(hole.meters);
        if (!Number.isFinite(worked) || worked < 0) return `Le métrage du trou ${holeId} est invalide.`;
        const finalDepth = hole.finalDepth == null || hole.finalDepth === '' ? null : Number(hole.finalDepth);
        if (finalDepth != null && (!Number.isFinite(finalDepth) || finalDepth < 0)) {
            return `La profondeur finale du trou ${holeId} est invalide.`;
        }
    }

    const stoppages = Array.isArray(data.stoppages) ? data.stoppages : [];
    let downtime = 0;
    for (const stop of stoppages) {
        const hours = Number(stop.hours);
        if (!Number.isFinite(hours) || hours < 0) return 'Une durée d’arrêt est invalide.';
        downtime += hours;
    }
    const shift = String(row.shift != null ? row.shift : (data.shift || ''));
    const nominalHours = shift === 'day' || shift === 'night' ? 12 : 24;
    if (Math.abs(machineHours + downtime - nominalHours) > 0.02) {
        return `Le bilan du poste doit totaliser ${nominalHours} h (heures machine + arrêts).`;
    }
    return null;
}

function parseDailyHolesWorked(row) {
    try {
        const data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : (row.data || {});
        return Array.isArray(data.holesWorked) ? data.holesWorked : [];
    } catch (_) {
        return [];
    }
}

function validateDailyHoleReferences(req, row, cb) {
    const holes = parseDailyHolesWorked(row).filter(hole => hole.source !== 'manual' && hole.source !== 'automatic');
    if (holes.length === 0) return cb(null);
    const enterpriseId = getEnterpriseId(req);
    if (enterpriseId == null) return cb(new Error('Contexte entreprise requis pour contrôler les trous du poste.'));
    let index = 0;
    const next = () => {
        if (index >= holes.length) return cb(null);
        const worked = holes[index++];
        db.get(
            `SELECT h.id FROM drilling_holes h
             JOIN drilling_blocks b ON b.id = h.blockId
             WHERE h.enterpriseId = ? AND b.enterpriseId = ? AND b.code = ? AND h.code = ?`,
            [enterpriseId, enterpriseId, String(worked.blockId || '').trim(), String(worked.holeId || '').trim()],
            (err, found) => {
                if (err) return cb(err);
                if (!found) return cb(null, `Le trou ${worked.blockId || '—'} / ${worked.holeId || '—'} n’existe pas dans le plan actif.`);
                return next();
            }
        );
    };
    next();
}

function applyApprovedDailyHoleProgress(req, row, actorUsername, cb) {
    // Les identifiants hors plan restent tracés dans le poste sans modifier un trou du plan.
    const holes = parseDailyHolesWorked(row).filter(hole => hole.source !== 'manual' && hole.source !== 'automatic');
    if (holes.length === 0) return cb(null);
    const enterpriseId = getEnterpriseId(req);
    if (enterpriseId == null) return cb(new Error('Contexte entreprise requis pour mettre à jour le plan.'));
    let index = 0;
    const now = new Date().toISOString();
    const next = () => {
        if (index >= holes.length) {
            return db.run(
                `UPDATE drilling_plan_meta SET version = version + 1, updatedByUsername = ?, updatedAt = ? WHERE enterpriseId = ?`,
                [actorUsername || '', now, enterpriseId],
                cb
            );
        }
        const worked = holes[index++];
        const finalDepth = worked.finalDepth == null || worked.finalDepth === '' ? null : Number(worked.finalDepth);
        db.get(
            `SELECT h.id, h.plannedDepth, h.actualDepth, h.status FROM drilling_holes h
             JOIN drilling_blocks b ON b.id = h.blockId
             WHERE h.enterpriseId = ? AND b.enterpriseId = ? AND b.code = ? AND h.code = ?`,
            [enterpriseId, enterpriseId, String(worked.blockId || '').trim(), String(worked.holeId || '').trim()],
            (lookupError, holeRow) => {
                if (lookupError) return cb(lookupError);
                if (!holeRow) return cb(new Error(`Trou introuvable pendant l’approbation : ${worked.holeId || '—'}`));
                const actualDepth = Number.isFinite(finalDepth) ? finalDepth : Number(holeRow.actualDepth || 0);
                const plannedDepth = Number(holeRow.plannedDepth || 0);
                const isComplete = plannedDepth > 0 && actualDepth >= plannedDepth - 0.05;
                const nextStatus = isComplete ? 'COMPLETÉ' : ((Number(worked.meters) || 0) > 0 ? 'EN COURS' : holeRow.status);
                db.run(
                    `UPDATE drilling_holes SET actualDepth = ?, status = ?, drillId = COALESCE(NULLIF(drillId, ''), ?),
                     startDate = CASE WHEN COALESCE(startDate, '') = '' THEN ? ELSE startDate END,
                     endDate = CASE WHEN ? = 1 THEN ? ELSE endDate END, updatedAt = ? WHERE id = ?`,
                    [actualDepth, nextStatus, row.machineId, row.date, isComplete ? 1 : 0, row.date, now, holeRow.id],
                    (updateError) => updateError ? cb(updateError) : next()
                );
            }
        );
    };
    next();
}

/** Prix carburant / L : uniquement USD ou XOF (CFA). Anciennes valeurs (ex. EUR) → USD. */
function normalizeContractFuelPriceCurrency(code, contractCurrency) {
    const c = String(code || '').toUpperCase();
    if (c === 'XOF' || c === 'CFA') return 'XOF';
    if (c === 'USD') return 'USD';
    const cc = String(contractCurrency || '').toUpperCase();
    if (cc === 'XOF' || cc === 'CFA') return 'XOF';
    if (cc === 'USD') return 'USD';
    return 'USD';
}

function getDailyDataActorFromRequest(req, cb) {
    if (!req.auth || req.auth.sub == null) {
        return cb(null, { username: '', name: '' });
    }
    db.get('SELECT username, name FROM users WHERE id = ?', [req.auth.sub], (err, row) => {
        if (err) return cb(err);
        const username = row ? String(row.username || '').trim() : String(req.auth.username || '').trim();
        const name = row && row.name && String(row.name).trim() ? String(row.name).trim() : username;
        cb(null, { username, name });
    });
}

// Rate limit appliqué sur la route login uniquement
app.use('/api/auth/login', loginRateLimit);

// JWT requis pour toutes les routes /api sauf login et health
app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    if (req.path === '/api/auth/login' || req.path === '/api/auth/logout' || req.path === '/api/health') return next();
    return verifyAuth(req, res, () => {
        const isPlatform = !!(
            req.auth &&
            (req.auth.isSuperAdmin || req.auth.isPlatformOwner || req.auth.role === 'platform_owner')
        );
        if (
            DEPLOYMENT_MODE === 'shared' &&
            !isPlatform &&
            (req.auth.enterpriseId == null || req.auth.enterpriseId === '')
        ) {
            return res.status(403).json({ error: 'Compte sans entreprise attribuée' });
        }
        return next();
    });
});

/** État minimal pour les sondes Docker / hébergeur, sans divulguer la configuration. */
app.get('/api/health', (req, res) => {
    db.get('SELECT 1 AS ok', [], (err, row) => {
        if (err || !row || row.ok !== 1) {
            return res.status(503).json({ status: 'degraded', database: 'unavailable' });
        }
        return res.json({
            status: 'ok',
            database: 'ready',
            deploymentMode: DEPLOYMENT_MODE,
            uptimeSeconds: Math.floor(process.uptime())
        });
    });
});

/** Tenant effectif : issu du JWT ; header X-Enterprise-Id uniquement pour super_admin / platform_owner (mode shared) */
const getEnterpriseId = (req) => {
    if (!req.auth) return null;
    if (DEPLOYMENT_MODE === 'dedicated') {
        if (req.auth.enterpriseId != null && req.auth.enterpriseId !== '') {
            return parseInt(req.auth.enterpriseId, 10);
        }
        return 1;
    }
    if (req.auth.isSuperAdmin || req.auth.isPlatformOwner) {
        const raw = req.headers['x-enterprise-id'] || req.query.enterpriseId;
        if (raw !== undefined && raw !== null && raw !== '') {
            const n = parseInt(raw, 10);
            return isNaN(n) ? null : n;
        }
        if (req.auth.enterpriseId != null && req.auth.enterpriseId !== '') {
            const n = parseInt(req.auth.enterpriseId, 10);
            if (!isNaN(n)) return n;
        }
        return null;
    }
    const e = req.auth.enterpriseId;
    if (e == null || e === '') return null;
    const n = parseInt(e, 10);
    return Number.isNaN(n) ? null : n;
};

function assertDrillBelongsToTenant(dbConn, machineId, enterpriseId, cb) {
    if (enterpriseId == null) return cb(null, true);
    dbConn.get('SELECT enterpriseId FROM drills WHERE id = ?', [machineId], (err, row) => {
        if (err) return cb(err);
        if (!row) return cb(null, false);
        cb(null, parseInt(row.enterpriseId, 10) === parseInt(enterpriseId, 10));
    });
}

/** enterpriseId pour INSERT : jamais écrasant par le body pour un utilisateur de tenant */
function resolveCreateEnterpriseId(req, body) {
    const fromCtx = getEnterpriseId(req);
    if (fromCtx !== null) return fromCtx;
    if (req.auth.isSuperAdmin || req.auth.isPlatformOwner) {
        const b = body && body.enterpriseId;
        if (b != null && b !== '') return parseInt(b, 10);
        return 1;
    }
    return 1;
}

/** Tarif d'abonnement spécifique à l'entreprise (sinon grille catalogue). Retour { ok, monthly, yearly, currency } ou { error } */
function parseEnterpriseSubscriptionCustom(body) {
    const rawM = body.subscriptionCustomMonthly;
    const rawY = body.subscriptionCustomYearly;
    const rawC = body.subscriptionCustomCurrency;
    const absent = rawM === undefined && rawY === undefined && rawC === undefined;
    if (absent) {
        return { ok: true, monthly: null, yearly: null, currency: null };
    }
    let monthly = null;
    if (rawM !== undefined && rawM !== null && rawM !== '') {
        const m = parseFloat(rawM);
        if (Number.isNaN(m) || m < 0) return { error: 'subscriptionCustomMonthly invalide (nombre ≥ 0)' };
        monthly = m;
    }
    let yearly = null;
    if (rawY !== undefined && rawY !== null && rawY !== '') {
        const y = parseFloat(rawY);
        if (Number.isNaN(y) || y < 0) return { error: 'subscriptionCustomYearly invalide (nombre ≥ 0)' };
        yearly = y;
    }
    let currency = null;
    if (rawC !== undefined && rawC !== null && rawC !== '') {
        currency = String(rawC).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || null;
    }
    if (monthly === null && yearly === null) {
        return { ok: true, monthly: null, yearly: null, currency: null };
    }
    if (!currency) {
        const fallback = body.currency ? String(body.currency).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) : '';
        currency = fallback || 'EUR';
    }
    return { ok: true, monthly, yearly, currency };
}

function sendRolePolicyForEnterprise(entId, res) {
    db.get(
        'SELECT id, plan, subscriptionStatus, isActive, maxUsers, maxDrills, maxSites, allowedRoles, allowedTabs FROM enterprises WHERE id = ?',
        [entId],
        (err, ent) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!ent) return res.status(404).json({ error: 'Entreprise introuvable' });
            db.get('SELECT COUNT(*) as n FROM users WHERE enterpriseId = ?', [entId], (e2, rowU) => {
                if (e2) return res.status(500).json({ error: e2.message });
                db.get('SELECT COUNT(*) as n FROM sites WHERE enterpriseId = ?', [entId], (e3, rowS) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    const management = planRoles.enterpriseAllowsUserManagement(ent);
                    const maxSitesRaw = ent.maxSites != null && ent.maxSites !== '' ? parseInt(ent.maxSites, 10) : 1;
                    const maxSites = Number.isNaN(maxSitesRaw) ? 1 : Math.max(1, maxSitesRaw);
                    const effectiveAllowedTabs = planRoles.getEffectiveAllowedTabs(ent);
                    res.json({
                        enterpriseId: entId,
                        plan: ent.plan,
                        subscriptionStatus: ent.subscriptionStatus,
                        isActive: ent.isActive,
                        maxUsers: ent.maxUsers,
                        maxDrills: ent.maxDrills,
                        maxSites,
                        siteCount: rowS.n,
                        userCount: rowU.n,
                        effectiveAllowedTabs,
                        allowedRolesCustom: planRoles.parseAllowedRolesJson(ent.allowedRoles),
                        effectiveAllowedRoles: planRoles.getEffectiveAllowedRoles(ent),
                        defaultRolesForPlan: planRoles.getDefaultRolesForPlan(ent.plan),
                        defaultTabsForPlan: planRoles.getDefaultTabsForPlan(ent.plan),
                        management
                    });
                });
            });
        }
    );
}

/** Validation création / changement de rôle pour un utilisateur rattaché à une entreprise */
/** Rôle par défaut pour le premier compte créé avec une nouvelle entreprise (privilège le plus élevé autorisé par le plan) */
function pickDefaultFirstUserRole(entRow) {
    const allowed = planRoles.getEffectiveAllowedRoles(entRow);
    const priority = ['admin', 'gestionnaire', 'gestionnaire_site', 'ingenieur', 'superviseur', 'santesecurite', 'foreur', 'aideforeur'];
    for (let i = 0; i < priority.length; i++) {
        if (allowed.includes(priority[i])) return priority[i];
    }
    return allowed[0] || 'superviseur';
}

function validateTenantUserAssignment(dbConn, enterpriseId, role, isNewUser, cb) {
    if (enterpriseId == null || enterpriseId === '') return cb(null);
    if (!role) return cb(new Error('Rôle requis'));
    if (planRoles.PLATFORM_ROLES.includes(role)) {
        return cb(new Error('Ce rôle est réservé à la plateforme'));
    }
    dbConn.get('SELECT id, plan, subscriptionStatus, isActive, maxUsers, allowedRoles FROM enterprises WHERE id = ?', [enterpriseId], (err, ent) => {
        if (err) return cb(err);
        if (!ent) return cb(new Error('Entreprise introuvable'));
        const mg = planRoles.enterpriseAllowsUserManagement(ent);
        if (!mg.ok) return cb(new Error(mg.reason));
        if (!planRoles.isRoleAllowedForEnterprise(role, ent)) {
            const eff = planRoles.getEffectiveAllowedRoles(ent);
            return cb(new Error(`Rôle « ${role} » non autorisé pour cet abonnement. Rôles possibles : ${eff.join(', ')}`));
        }
        if (!isNewUser) return cb(null);
        dbConn.get('SELECT COUNT(*) as n FROM users WHERE enterpriseId = ?', [enterpriseId], (e2, row) => {
            if (e2) return cb(e2);
            if (row.n >= parseInt(ent.maxUsers, 10)) {
                return cb(new Error(`Quota utilisateurs atteint (${ent.maxUsers}) pour cette entreprise.`));
            }
            cb(null);
        });
    });
}

/** Suppression en cascade (admin plateforme). L’entreprise id 1 est protégée. */
function deleteEnterpriseCascade(enterpriseId, cb) {
    const eid = parseInt(enterpriseId, 10);
    const steps = [
        ['DELETE FROM stockMovements WHERE articleId IN (SELECT id FROM inventory WHERE enterpriseId = ?)', [eid]],
        ['DELETE FROM maintenanceHistory WHERE machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)', [eid]],
        ['DELETE FROM maintenanceSchedules WHERE machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)', [eid]],
        ['DELETE FROM assignments WHERE drillId IN (SELECT id FROM drills WHERE enterpriseId = ?)', [eid]],
        ['DELETE FROM dailyDataRecords WHERE machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)', [eid]],
        ['DELETE FROM payments WHERE enterpriseId = ?', [eid]],
        ['DELETE FROM invoices WHERE enterpriseId = ?', [eid]],
        ['DELETE FROM drills WHERE enterpriseId = ?', [eid]],
        ['DELETE FROM contracts WHERE enterpriseId = ?', [eid]],
        ['DELETE FROM sites WHERE enterpriseId = ?', [eid]],
        ['DELETE FROM clients WHERE enterpriseId = ?', [eid]],
        ['DELETE FROM employees WHERE enterpriseId = ?', [eid]],
        ['DELETE FROM miscellaneousExpenses WHERE enterpriseId = ?', [eid]],
        ['DELETE FROM companyInfo WHERE enterpriseId = ?', [eid]],
        ['DELETE FROM inventory WHERE enterpriseId = ?', [eid]],
        ['DELETE FROM users WHERE enterpriseId = ?', [eid]],
        ['DELETE FROM enterprises WHERE id = ?', [eid]]
    ];
    let i = 0;
    function next(err) {
        if (err) return cb(err);
        if (i >= steps.length) return cb(null);
        const step = steps[i++];
        db.run(step[0], step[1], next);
    }
    next(null);
}

// ============================================
// ROUTES API - AUTHENTIFICATION
// ============================================
require('./routes/auth')(app, {
    db,
    deploymentMode: DEPLOYMENT_MODE,
    parseUserSiteIds
});

// ============================================
// ROUTES API - ENTREPRISES
// ============================================
app.get('/api/enterprises', (req, res) => {
    if (req.auth.isSuperAdmin || req.auth.isPlatformOwner) {
        db.all('SELECT * FROM enterprises ORDER BY name', [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            return res.json(enrichEnterpriseRows(rows || []));
        });
        return;
    }
    const eid = req.auth.enterpriseId;
    if (!eid) return res.json([]);
    db.all('SELECT * FROM enterprises WHERE id = ?', [eid], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(enrichEnterpriseRows(rows || []));
    });
});

app.get('/api/plan-roles/defaults', (req, res) => {
    const tabsByPlan = {};
    Object.keys(planRoles.DEFAULT_TABS_BY_PLAN).forEach((p) => {
        tabsByPlan[p] = planRoles.getDefaultTabsForPlan(p);
    });
    res.json({ plans: planRoles.DEFAULT_ROLES_BY_PLAN, allTenantRoles: planRoles.ALL_TENANT_ROLES, tabsByPlan });
});

const SUBSCRIPTION_CATALOG_PLANS = ['free', 'basic', 'premium', 'enterprise'];

app.get('/api/subscription-plans', (req, res) => {
    db.all(
        `SELECT * FROM subscription_plan_catalog ORDER BY CASE plan
            WHEN 'free' THEN 1 WHEN 'basic' THEN 2 WHEN 'premium' THEN 3 WHEN 'enterprise' THEN 4 ELSE 5 END`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const out = (rows || []).map((r) => ({
                ...r,
                defaultAllowedTabs: planRoles.parseAllowedTabsJson(r.defaultAllowedTabs)
            }));
            res.json(out);
        }
    );
});

app.put('/api/subscription-plans/:plan', requirePlatformAdmin, (req, res) => {
    const plan = String(req.params.plan || '').toLowerCase();
    if (!SUBSCRIPTION_CATALOG_PLANS.includes(plan)) {
        return res.status(400).json({ error: 'Plan inconnu (free, basic, premium, enterprise)' });
    }
    const body = req.body || {};
    const updates = [];
    const values = [];
    if (body.label !== undefined) {
        updates.push('label = ?');
        values.push(String(body.label));
    }
    if (body.monthlyPrice !== undefined) {
        const m = parseFloat(body.monthlyPrice);
        if (Number.isNaN(m) || m < 0) {
            return res.status(400).json({ error: 'monthlyPrice invalide (nombre ≥ 0)' });
        }
        updates.push('monthlyPrice = ?');
        values.push(m);
    }
    if (body.yearlyPrice !== undefined) {
        if (body.yearlyPrice === null || body.yearlyPrice === '') {
            updates.push('yearlyPrice = NULL');
        } else {
            const y = parseFloat(body.yearlyPrice);
            if (Number.isNaN(y) || y < 0) {
                return res.status(400).json({ error: 'yearlyPrice invalide (nombre ≥ 0 ou vide)' });
            }
            updates.push('yearlyPrice = ?');
            values.push(y);
        }
    }
    if (body.currency !== undefined) {
        updates.push('currency = ?');
        values.push(String(body.currency || 'EUR').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'EUR');
    }
    if (body.defaultAllowedTabs !== undefined) {
        if (body.defaultAllowedTabs === null || body.defaultAllowedTabs === '') {
            updates.push('defaultAllowedTabs = NULL');
        } else {
            try {
                const parsed =
                    typeof body.defaultAllowedTabs === 'string'
                        ? JSON.parse(body.defaultAllowedTabs)
                        : body.defaultAllowedTabs;
                if (!Array.isArray(parsed) || parsed.length === 0) {
                    return res.status(400).json({
                        error: 'defaultAllowedTabs : tableau d’onglets non vide, ou null pour défaut programme'
                    });
                }
                const bad = parsed.find((t) => !planRoles.TENANT_MAIN_VIEWS.includes(String(t)));
                if (bad) return res.status(400).json({ error: `Onglet inconnu dans defaultAllowedTabs : ${bad}` });
                updates.push('defaultAllowedTabs = ?');
                values.push(JSON.stringify(parsed.map(String)));
            } catch (e) {
                return res.status(400).json({ error: 'defaultAllowedTabs : JSON invalide' });
            }
        }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });
    updates.push('updatedAt = CURRENT_TIMESTAMP');
    values.push(plan);
    db.run(`UPDATE subscription_plan_catalog SET ${updates.join(', ')} WHERE plan = ?`, values, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Catalogue introuvable — exécutez npm run migrate' });
        }
        loadPlanDefaultTabsFromDb();
        res.json({ message: 'Catalogue mis à jour', plan });
    });
});

app.get('/api/enterprise-role-policy', (req, res) => {
    const eid = getEnterpriseId(req);
    if (eid == null) {
        return res.status(400).json({ error: 'Contexte entreprise requis (sélectionnez une organisation ou connectez-vous avec un compte client).' });
    }
    sendRolePolicyForEnterprise(eid, res);
});

app.get('/api/enterprises/:id/role-policy', (req, res) => {
    const entId = parseInt(req.params.id, 10);
    const platform = req.auth.isSuperAdmin || req.auth.isPlatformOwner;
    const sameOrg = req.auth.enterpriseId && parseInt(req.auth.enterpriseId, 10) === entId;
    if (!platform && !sameOrg) {
        return res.status(403).json({ error: 'Non autorisé' });
    }
    sendRolePolicyForEnterprise(entId, res);
});

app.put('/api/enterprises/:id', (req, res) => {
    const { id } = req.params;
    const entId = parseInt(id, 10);
    const platform = !!(req.auth.isSuperAdmin || req.auth.isPlatformOwner || req.auth.role === 'platform_owner');
    const sameOrg = req.auth.enterpriseId && parseInt(req.auth.enterpriseId, 10) === entId;
    if (!platform && !sameOrg) {
        return res.status(403).json({ error: 'Non autorisé à modifier cette entreprise' });
    }
    if (!platform && sameOrg) {
        const body = req.body || {};
        if (body.plan !== undefined || body.subscriptionStartDate !== undefined || body.subscriptionEndDate !== undefined ||
            body.subscriptionStatus !== undefined || body.maxUsers !== undefined || body.maxDrills !== undefined || body.maxSites !== undefined || body.isActive !== undefined) {
            return res.status(403).json({ error: 'Seule la plateforme peut modifier l’abonnement ou le statut' });
        }
        if (body.allowedRoles !== undefined) {
            return res.status(403).json({ error: 'Seule la plateforme peut définir les rôles autorisés par abonnement' });
        }
        if (body.subscriptionCustomMonthly !== undefined || body.subscriptionCustomYearly !== undefined || body.subscriptionCustomCurrency !== undefined) {
            return res.status(403).json({ error: 'Seule la plateforme peut définir le tarif d’abonnement personnalisé' });
        }
        if (body.allowedTabs !== undefined) {
            return res.status(403).json({ error: 'Seule la plateforme peut définir les onglets de l’abonnement' });
        }
    }
    const {
        name, address, city, country, email, phone, legalName, slug, currency,
        isActive, plan, subscriptionStartDate, subscriptionEndDate, subscriptionStatus, maxUsers, maxDrills, maxSites, allowedRoles
    } = req.body || {};
    var updates = [];
    var values = [];
    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (legalName !== undefined) { updates.push('legalName = ?'); values.push(legalName); }
    if (slug !== undefined) {
        const raw = slug === null || slug === false ? '' : String(slug).trim();
        const slugVal = raw === '' ? null : raw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        updates.push('slug = ?');
        values.push(slugVal);
    }
    if (currency !== undefined) {
        updates.push('currency = ?');
        values.push(String(currency || 'EUR').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'EUR');
    }
    if (address !== undefined) { updates.push('address = ?'); values.push(address); }
    if (city !== undefined) { updates.push('city = ?'); values.push(city); }
    if (country !== undefined) { updates.push('country = ?'); values.push(country); }
    if (email !== undefined) { updates.push('email = ?'); values.push(email); }
    if (phone !== undefined) { updates.push('phone = ?'); values.push(phone); }
    if (isActive !== undefined) { updates.push('isActive = ?'); values.push(isActive ? 1 : 0); }
    if (plan !== undefined) { updates.push('plan = ?'); values.push(plan); }
    if (subscriptionStartDate !== undefined) { updates.push('subscriptionStartDate = ?'); values.push(subscriptionStartDate); }
    if (subscriptionEndDate !== undefined) { updates.push('subscriptionEndDate = ?'); values.push(subscriptionEndDate); }
    if (subscriptionStatus !== undefined) { updates.push('subscriptionStatus = ?'); values.push(subscriptionStatus); }
    if (maxUsers !== undefined) { updates.push('maxUsers = ?'); values.push(maxUsers); }
    if (maxDrills !== undefined) { updates.push('maxDrills = ?'); values.push(maxDrills); }
    if (maxSites !== undefined) {
        const ms = parseInt(maxSites, 10);
        if (Number.isNaN(ms) || ms < 1) {
            return res.status(400).json({ error: 'maxSites doit être un entier ≥ 1' });
        }
        updates.push('maxSites = ?');
        values.push(ms);
    }
    if (platform && allowedRoles !== undefined) {
        if (allowedRoles === null || allowedRoles === '') {
            updates.push('allowedRoles = NULL');
        } else {
            try {
                const parsed = typeof allowedRoles === 'string' ? JSON.parse(allowedRoles) : allowedRoles;
                if (!Array.isArray(parsed)) {
                    return res.status(400).json({ error: 'allowedRoles doit être un tableau de rôles (ex. ["foreur","superviseur"])' });
                }
                updates.push('allowedRoles = ?');
                values.push(JSON.stringify(parsed));
            } catch (e) {
                return res.status(400).json({ error: 'allowedRoles : JSON invalide' });
            }
        }
    }
    if (platform && req.body && req.body.allowedTabs !== undefined) {
        const atRaw = req.body.allowedTabs;
        if (atRaw === null || atRaw === '') {
            updates.push('allowedTabs = NULL');
        } else {
            try {
                const parsed = typeof atRaw === 'string' ? JSON.parse(atRaw) : atRaw;
                if (!Array.isArray(parsed) || parsed.length === 0) {
                    return res.status(400).json({ error: 'allowedTabs : tableau d’identifiants d’onglets non vide, ou null pour le défaut du plan' });
                }
                const bad = parsed.find((t) => !planRoles.TENANT_MAIN_VIEWS.includes(String(t)));
                if (bad) return res.status(400).json({ error: `Onglet inconnu dans allowedTabs : ${bad}` });
                updates.push('allowedTabs = ?');
                values.push(JSON.stringify(parsed.map(String)));
            } catch (e) {
                return res.status(400).json({ error: 'allowedTabs : JSON invalide' });
            }
        }
    }
    if (platform) {
        const bodyPlat = req.body || {};
        const subTouched = bodyPlat.subscriptionCustomMonthly !== undefined ||
            bodyPlat.subscriptionCustomYearly !== undefined ||
            bodyPlat.subscriptionCustomCurrency !== undefined;
        if (subTouched) {
            const subCustom = parseEnterpriseSubscriptionCustom(bodyPlat);
            if (subCustom.error) return res.status(400).json({ error: subCustom.error });
            updates.push('subscriptionCustomMonthly = ?');
            values.push(subCustom.monthly);
            updates.push('subscriptionCustomYearly = ?');
            values.push(subCustom.yearly);
            updates.push('subscriptionCustomCurrency = ?');
            values.push(subCustom.currency);
        }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'Aucune donnée à mettre à jour' });

    const runEnterpriseUpdate = () => {
        const vals = values.slice();
        vals.push(id);
        db.run('UPDATE enterprises SET ' + updates.join(', ') + ', updatedAt = CURRENT_TIMESTAMP WHERE id = ?', vals, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Entreprise mise à jour', changes: this.changes });
        });
    };

    if (slug !== undefined) {
        const raw = slug === null || slug === false ? '' : String(slug).trim();
        const slugVal = raw === '' ? null : raw.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        if (slugVal != null) {
            db.get('SELECT id FROM enterprises WHERE slug = ? AND id != ?', [slugVal, entId], (errS, rowS) => {
                if (errS) return res.status(500).json({ error: errS.message });
                if (rowS) return res.status(400).json({ error: 'Identifiant URL (slug) déjà utilisé par une autre entreprise.' });
                runEnterpriseUpdate();
            });
            return;
        }
    }
    runEnterpriseUpdate();
});

app.post('/api/enterprises', requirePlatformAdmin, (req, res) => {
    const body = req.body || {};
    const { name, slug, legalName, address, city, country, email, phone, currency, plan, allowedRoles } = body;
    const firstUserUsername = body.firstUserUsername != null ? String(body.firstUserUsername).trim().toLowerCase() : '';
    const firstUserPassword = body.firstUserPassword != null ? String(body.firstUserPassword) : '';
    const firstUserName = body.firstUserName != null ? String(body.firstUserName).trim() : '';
    const firstUserRoleRaw = body.firstUserRole != null ? String(body.firstUserRole).trim().toLowerCase() : '';

    if (!name) return res.status(400).json({ error: 'Nom requis' });
    if ((firstUserUsername && !firstUserPassword) || (!firstUserUsername && firstUserPassword)) {
        return res.status(400).json({ error: 'Premier utilisateur : indiquez à la fois l’identifiant et le mot de passe, ou laissez les deux vides.' });
    }
    if (firstUserUsername && firstUserPassword.length < 6) {
        return res.status(400).json({ error: 'Mot de passe du premier utilisateur : minimum 6 caractères.' });
    }
    const subCustom = parseEnterpriseSubscriptionCustom(body);
    if (subCustom.error) return res.status(400).json({ error: subCustom.error });
    const slugVal = slug || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    let allowedJson = null;
    if (allowedRoles !== undefined && allowedRoles !== null && allowedRoles !== '') {
        try {
            const parsed = typeof allowedRoles === 'string' ? JSON.parse(allowedRoles) : allowedRoles;
            if (!Array.isArray(parsed)) {
                return res.status(400).json({ error: 'allowedRoles doit être un tableau de rôles' });
            }
            allowedJson = JSON.stringify(parsed);
        } catch (e) {
            return res.status(400).json({ error: 'allowedRoles : JSON invalide' });
        }
    }
    const planVal = plan || 'free';
    const muQ = body.maxUsers != null ? parseInt(body.maxUsers, 10) : NaN;
    const mdQ = body.maxDrills != null ? parseInt(body.maxDrills, 10) : NaN;
    const msQ = body.maxSites != null ? parseInt(body.maxSites, 10) : NaN;
    const insMaxUsers = !Number.isNaN(muQ) && muQ >= 1 ? muQ : 5;
    const insMaxDrills = !Number.isNaN(mdQ) && mdQ >= 1 ? mdQ : 10;
    const insMaxSites = !Number.isNaN(msQ) && msQ >= 1 ? msQ : 1;

    function finishSuccess(entId, firstUserOut) {
        const out = { id: entId, message: 'Entreprise créée' };
        if (firstUserOut) out.firstUser = firstUserOut;
        res.json(out);
    }

    if (!firstUserUsername) {
        db.run(
            `INSERT INTO enterprises (name, slug, legalName, address, city, country, email, phone, currency, plan, maxUsers, maxDrills, maxSites, allowedRoles, subscriptionCustomMonthly, subscriptionCustomYearly, subscriptionCustomCurrency)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name, slugVal, legalName || '', address || '', city || '', country || '', email || '', phone || '',
                currency || 'EUR', planVal, insMaxUsers, insMaxDrills, insMaxSites, allowedJson,
                subCustom.monthly, subCustom.yearly, subCustom.currency
            ],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                finishSuccess(this.lastID, null);
            }
        );
        return;
    }

    db.serialize(() => {
        db.run('BEGIN IMMEDIATE TRANSACTION');
        db.run(
            `INSERT INTO enterprises (name, slug, legalName, address, city, country, email, phone, currency, plan, maxUsers, maxDrills, maxSites, allowedRoles, subscriptionCustomMonthly, subscriptionCustomYearly, subscriptionCustomCurrency)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                name, slugVal, legalName || '', address || '', city || '', country || '', email || '', phone || '',
                currency || 'EUR', planVal, insMaxUsers, insMaxDrills, insMaxSites, allowedJson,
                subCustom.monthly, subCustom.yearly, subCustom.currency
            ],
            function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: err.message });
                }
                const entId = this.lastID;
                db.get(
                    'SELECT id, plan, subscriptionStatus, isActive, maxUsers, allowedRoles FROM enterprises WHERE id = ?',
                    [entId],
                    (errEnt, entRow) => {
                        if (errEnt || !entRow) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: errEnt ? errEnt.message : 'Entreprise introuvable après création' });
                        }
                        const roleToUse = firstUserRoleRaw || pickDefaultFirstUserRole(entRow);
                        if (!planRoles.isRoleAllowedForEnterprise(roleToUse, entRow)) {
                            db.run('ROLLBACK');
                            const eff = planRoles.getEffectiveAllowedRoles(entRow);
                            return res.status(400).json({
                                error: `Rôle « ${roleToUse} » non autorisé pour ce plan.`,
                                allowedRoles: eff
                            });
                        }
                        validateTenantUserAssignment(db, entId, roleToUse, true, (vErr) => {
                            if (vErr) {
                                db.run('ROLLBACK');
                                return res.status(403).json({ error: vErr.message });
                            }
                            db.get('SELECT id FROM users WHERE LOWER(TRIM(username)) = LOWER(?)', [firstUserUsername], (errU, urow) => {
                                if (errU) {
                                    db.run('ROLLBACK');
                                    return res.status(500).json({ error: errU.message });
                                }
                                if (urow) {
                                    db.run('ROLLBACK');
                                    return res.status(400).json({ error: 'Ce nom d’utilisateur existe déjà.' });
                                }
                                const displayName = firstUserName || name;
                                const hash = bcrypt.hashSync(firstUserPassword, 10);
                                const restrictionsJson = '{}';
                                db.run(
                                    'INSERT INTO users (username, password, passwordHash, role, name, enterpriseId, restrictions, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                                    [firstUserUsername, '', hash, roleToUse, displayName, entId, restrictionsJson, 'Compte créé avec la nouvelle entreprise'],
                                    function(errI) {
                                        if (errI) {
                                            db.run('ROLLBACK');
                                            return res.status(500).json({ error: errI.message });
                                        }
                                        db.run('COMMIT', (errC) => {
                                            if (errC) return res.status(500).json({ error: errC.message });
                                            finishSuccess(entId, { username: firstUserUsername, role: roleToUse, name: displayName });
                                        });
                                    }
                                );
                            });
                        });
                    }
                );
            }
        );
    });
});

app.delete('/api/enterprises/:id', requirePlatformAdmin, (req, res) => {
    const entId = parseInt(req.params.id, 10);
    if (!Number.isFinite(entId)) return res.status(400).json({ error: 'Identifiant invalide' });
    if (entId === 1) {
        return res.status(400).json({ error: 'Impossible de supprimer l’entreprise système (id 1).' });
    }
    db.get('SELECT id FROM enterprises WHERE id = ?', [entId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Entreprise introuvable' });
        deleteEnterpriseCascade(entId, (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ message: 'Entreprise supprimée' });
        });
    });
});

// POST /api/enterprises/:id/logo — importer le logo d'une entreprise
app.post('/api/enterprises/:id/logo', requirePlatformAdmin, (req, res) => {
    const entId = parseInt(req.params.id, 10);
    if (!Number.isFinite(entId)) return res.status(400).json({ error: 'Identifiant invalide' });
    db.get('SELECT id, logo FROM enterprises WHERE id = ?', [entId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Entreprise introuvable' });
        // Supprimer l'ancien fichier logo si présent
        if (row.logo && row.logo.startsWith('/uploads/')) {
            const oldPath = path.join(__dirname, row.logo.replace(/^\//, ''));
            try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (_) {}
        }
        enterpriseLogoUpload.single('logo')(req, res, (uploadErr) => {
            if (uploadErr) return res.status(400).json({ error: uploadErr.message });
            if (!req.file) return res.status(400).json({ error: 'Fichier logo manquant' });
            const logoUrl = '/uploads/enterprises/' + entId + '/' + req.file.filename;
            db.run('UPDATE enterprises SET logo = ? WHERE id = ?', [logoUrl, entId], function(err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({ logo: logoUrl });
            });
        });
    });
});

// DELETE /api/enterprises/:id/logo — supprimer le logo d'une entreprise
app.delete('/api/enterprises/:id/logo', requirePlatformAdmin, (req, res) => {
    const entId = parseInt(req.params.id, 10);
    if (!Number.isFinite(entId)) return res.status(400).json({ error: 'Identifiant invalide' });
    db.get('SELECT id, logo FROM enterprises WHERE id = ?', [entId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Entreprise introuvable' });
        if (row.logo && row.logo.startsWith('/uploads/')) {
            const oldPath = path.join(__dirname, row.logo.replace(/^\//, ''));
            try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (_) {}
        }
        db.run('UPDATE enterprises SET logo = NULL WHERE id = ?', [entId], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ ok: true });
        });
    });
});

// ============================================
// ROUTES API - UTILISATEURS
// ============================================
require('./routes/users')(app, {
    db,
    getEnterpriseId,
    parseUserSiteIds,
    requireUserManagementRole,
    validateTenantUserAssignment
});

require('./routes/drilling-plan')(app, { db, getEnterpriseId });
require('./routes/planification')(app, { db, getEnterpriseId });
require('./routes/besoins')(app, { db, getEnterpriseId });
require('./routes/soustraitants')(app, { db, getEnterpriseId });
require('./routes/attendance')(app, { db, getEnterpriseId });

// ============================================
// ROUTES API - MACHINES (DRILLS)
// ============================================
app.get('/api/drills', (req, res) => {
    const enterpriseId = getEnterpriseId(req);
    let query = 'SELECT * FROM drills';
    const params = [];
    if (enterpriseId !== null) {
        query += ' WHERE enterpriseId = ?';
        params.push(enterpriseId);
    }
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows.map(row => ({
            ...row,
            telemetry: JSON.parse(row.telemetry || '{}'),
            fuel: JSON.parse(row.fuel || '{}'),
            rods: JSON.parse(row.rods || '{}'),
            consumables: JSON.parse(row.consumables || '{}'),
            connectionConfig: JSON.parse(row.connectionConfig || '{}')
        })));
    });
});

app.post('/api/drills', (req, res) => {
    const { id, location, status, siteId, contractId, telemetry, maintenance, fuel, rods, consumables, connectionMode, connectionStatus, connectionConfig, subcontractorId, parkReason, parkLocation, expectedReturnDate } = req.body;
    const entId = resolveCreateEnterpriseId(req, req.body);
    const subId = (subcontractorId === '' || subcontractorId == null) ? null : parseInt(subcontractorId, 10);
    db.run(
        `INSERT INTO drills (id, enterpriseId, location, status, siteId, contractId, telemetry, maintenance, fuel, rods, consumables, connectionMode, connectionStatus, connectionConfig, subcontractorId, parkReason, parkLocation, expectedReturnDate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id, entId, location, status, siteId || null, contractId || null,
            JSON.stringify(telemetry || {}),
            maintenance || 100,
            JSON.stringify(fuel || {}),
            JSON.stringify(rods || {}),
            JSON.stringify(consumables || {}),
            connectionMode || 'manual',
            connectionStatus || 'disconnected',
            JSON.stringify(connectionConfig || {}),
            Number.isFinite(subId) ? subId : null,
            parkReason || null,
            parkLocation || null,
            expectedReturnDate || null
        ],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id, message: 'Machine créée' });
        }
    );
});

app.put('/api/drills/:id', (req, res) => {
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    const { location, status, siteId, contractId, telemetry, maintenance, fuel, rods, consumables, connectionMode, connectionStatus, connectionConfig, parkReason, parkLocation, expectedReturnDate } = req.body;
    let sql = `UPDATE drills SET
            location = ?, status = ?, siteId = ?, contractId = ?, telemetry = ?, maintenance = ?,
            fuel = ?, rods = ?, consumables = ?, connectionMode = ?,
            connectionStatus = ?, connectionConfig = ?,
            parkReason = ?, parkLocation = ?, expectedReturnDate = ?
         WHERE id = ?`;
    const vals = [
        location, status, siteId || null, contractId || null,
        JSON.stringify(telemetry || {}),
        maintenance,
        JSON.stringify(fuel || {}),
        JSON.stringify(rods || {}),
        JSON.stringify(consumables || {}),
        connectionMode,
        connectionStatus,
        JSON.stringify(connectionConfig || {}),
        parkReason || null,
        parkLocation || null,
        expectedReturnDate || null,
        id
    ];
    if (entId !== null) {
        sql += ' AND enterpriseId = ?';
        vals.push(entId);
    }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Machine introuvable ou accès refusé' });
        res.json({ message: 'Machine mise à jour', changes: this.changes });
    });
});

// Allouer (ou retirer) le sous-traitant propriétaire d'une foreuse — mise à
// jour ciblée, sans toucher aux autres champs de la machine.
app.put('/api/drills/:id/subcontractor', (req, res) => {
    const id = req.params.id;
    const entId = getEnterpriseId(req);
    const raw = req.body ? req.body.subcontractorId : null;
    const subId = (raw === '' || raw == null) ? null : parseInt(raw, 10);
    const val = Number.isFinite(subId) ? subId : null;
    let sql = 'UPDATE drills SET subcontractorId = ? WHERE id = ?';
    const vals = [val, id];
    if (entId !== null) { sql += ' AND enterpriseId = ?'; vals.push(entId); }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Machine introuvable ou accès refusé' });
        res.json({ message: 'Allocation mise à jour', subcontractorId: val });
    });
});

app.delete('/api/drills/:id', (req, res) => {
    const id = req.params.id;
    const entId = getEnterpriseId(req);
    const whereEnt = entId != null ? ' AND enterpriseId = ?' : '';
    const params = entId != null ? [id, entId] : [id];
    db.get('SELECT id FROM drills WHERE id = ?' + whereEnt, params, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Machine introuvable ou accès refusé' });
        const steps = [
            ['DELETE FROM maintenanceHistory WHERE machineId = ?', [id]],
            ['DELETE FROM maintenanceSchedules WHERE machineId = ?', [id]],
            ['DELETE FROM assignments WHERE drillId = ?', [id]],
            ['DELETE FROM dailyDataRecords WHERE machineId = ?', [id]],
            ['DELETE FROM drills WHERE id = ?' + whereEnt, entId != null ? [id, entId] : [id]]
        ];
        let i = 0;
        function next(e) {
            if (e) return res.status(500).json({ error: e.message });
            if (i >= steps.length) return res.json({ message: 'Machine supprimée' });
            const st = steps[i++];
            db.run(st[0], st[1], next);
        }
        next(null);
    });
});

// ============================================
// ROUTES API - PLANS DE FORAGE
// ============================================

// Liste des plans
app.get('/api/drill-plans', (req, res) => {
    const entId = getEnterpriseId(req);
    const where = entId != null ? ' WHERE enterpriseId = ?' : '';
    const params = entId != null ? [entId] : [];
    db.all('SELECT * FROM drill_plans' + where + ' ORDER BY updatedAt DESC', params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Créer un plan
app.post('/api/drill-plans', (req, res) => {
    const entId = getEnterpriseId(req);
    const { name, description, siteId, zoneLabel, gridType, originX, originY, scale } = req.body;
    if (!name) return res.status(400).json({ error: 'Le nom du plan est requis' });
    db.run(`INSERT INTO drill_plans (enterpriseId, siteId, name, description, zoneLabel, gridType, originX, originY, scale)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [entId || 1, siteId || null, name, description || '', zoneLabel || '', gridType || 'cartesian', originX || 0, originY || 0, scale || 1],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, message: 'Plan créé' });
        }
    );
});

// Modifier un plan
app.put('/api/drill-plans/:id', (req, res) => {
    const entId = getEnterpriseId(req);
    const { name, description, siteId, zoneLabel, gridType, originX, originY, scale, status } = req.body;
    const whereEnt = entId != null ? ' AND enterpriseId = ?' : '';
    const params = [name, description || '', siteId || null, zoneLabel || '', gridType || 'cartesian',
                    originX || 0, originY || 0, scale || 1, status || 'active', req.params.id];
    if (entId != null) params.push(entId);
    db.run(`UPDATE drill_plans SET name=?, description=?, siteId=?, zoneLabel=?, gridType=?, originX=?, originY=?, scale=?, status=?, updatedAt=CURRENT_TIMESTAMP
            WHERE id=?` + whereEnt, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Plan introuvable' });
        res.json({ message: 'Plan mis à jour' });
    });
});

// Supprimer un plan (et ses trous)
app.delete('/api/drill-plans/:id', (req, res) => {
    const entId = getEnterpriseId(req);
    const whereEnt = entId != null ? ' AND enterpriseId = ?' : '';
    const params = [req.params.id];
    if (entId != null) params.push(entId);
    db.run('DELETE FROM drill_plans WHERE id = ?' + whereEnt, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Plan introuvable' });
        res.json({ message: 'Plan supprimé' });
    });
});

// Récupérer les trous d'un plan
app.get('/api/drill-plans/:id/holes', (req, res) => {
    const entId = getEnterpriseId(req);
    const whereEnt = entId != null ? ' AND dp.enterpriseId = ?' : '';
    const params = [req.params.id];
    if (entId != null) params.push(entId);
    db.all(`SELECT dph.* FROM drill_plan_holes dph
            JOIN drill_plans dp ON dph.planId = dp.id
            WHERE dph.planId = ?` + whereEnt + ` ORDER BY dph.holeId`, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Récupérer un plan avec ses trous
app.get('/api/drill-plans/:id/full', (req, res) => {
    const entId = getEnterpriseId(req);
    const whereEnt = entId != null ? ' AND enterpriseId = ?' : '';
    const params = [req.params.id];
    if (entId != null) params.push(entId);
    db.get('SELECT * FROM drill_plans WHERE id = ?' + whereEnt, params, (err, plan) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!plan) return res.status(404).json({ error: 'Plan introuvable' });
        db.all('SELECT * FROM drill_plan_holes WHERE planId = ? ORDER BY holeId', [plan.id], (err2, holes) => {
            if (err2) return res.status(500).json({ error: err2.message });
            plan.holes = holes || [];
            res.json(plan);
        });
    });
});

// Importer des trous dans un plan (bulk)
app.post('/api/drill-plans/:id/holes', (req, res) => {
    const entId = getEnterpriseId(req);
    const planId = req.params.id;
    const whereEnt = entId != null ? ' AND enterpriseId = ?' : '';
    const pCheck = [planId];
    if (entId != null) pCheck.push(entId);
    db.get('SELECT id FROM drill_plans WHERE id = ?' + whereEnt, pCheck, (err, plan) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!plan) return res.status(404).json({ error: 'Plan introuvable' });
        const holes = req.body.holes || [];
        if (!Array.isArray(holes) || holes.length === 0) return res.status(400).json({ error: 'Aucun trou à importer' });
        const stmt = db.prepare(`INSERT INTO drill_plan_holes (planId, holeId, x, y, row, col, zone, blockId, source, plannedDepth, status)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        let inserted = 0;
        holes.forEach(h => {
            stmt.run([planId, h.holeId || '', h.x || 0, h.y || 0, h.row || '', h.col || '', h.zone || '', h.blockId || '', h.source || '', h.plannedDepth || 0, h.status || 'planned'], function(e) {
                if (!e) inserted++;
            });
        });
        stmt.finalize(function() {
            db.run('UPDATE drill_plans SET totalHoles = (SELECT COUNT(*) FROM drill_plan_holes WHERE planId = ?), updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [planId, planId]);
            res.json({ message: inserted + ' trous importés', inserted: inserted });
        });
    });
});

// Mettre à jour un trou
app.put('/api/drill-plan-holes/:id', (req, res) => {
    const { holeId, x, y, row, col, zone, blockId, source, plannedDepth, actualDepth, status, drilledDate, machineId, notes } = req.body;
    db.run(`UPDATE drill_plan_holes SET holeId=?, x=?, y=?, row=?, col=?, zone=?, blockId=?, source=?, plannedDepth=?, actualDepth=?, status=?, drilledDate=?, machineId=?, notes=?
            WHERE id=?`,
        [holeId, x || 0, y || 0, row || '', col || '', zone || '', blockId || '', source || '', plannedDepth || 0, actualDepth || 0, status || 'planned', drilledDate || null, machineId || null, notes || '', req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Trou introuvable' });
            res.json({ message: 'Trou mis à jour' });
        }
    );
});

// Supprimer un trou
app.delete('/api/drill-plan-holes/:id', (req, res) => {
    db.run('DELETE FROM drill_plan_holes WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Trou supprimé' });
    });
});

// Synchroniser les trous avec les saisies journalières
app.post('/api/drill-plans/:id/sync', (req, res) => {
    const entId = getEnterpriseId(req);
    const planId = req.params.id;
    const whereEnt = entId != null ? ' AND dp.enterpriseId = ?' : '';
    const params = [planId];
    if (entId != null) params.push(entId);
    db.all(`SELECT dph.id, dph.holeId, dph.status FROM drill_plan_holes dph
            JOIN drill_plans dp ON dph.planId = dp.id
            WHERE dph.planId = ?` + whereEnt, params, (err, holes) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!holes || holes.length === 0) return res.json({ message: 'Aucun trou', updated: 0 });
        // Récupérer toutes les saisies journalières de cette entreprise
        const entWhere = entId != null ? ' WHERE enterpriseId = ?' : '';
        const entP = entId != null ? [entId] : [];
        db.all('SELECT * FROM dailyDataRecords' + entWhere, entP, (err2, records) => {
            if (err2) return res.status(500).json({ error: err2.message });
            // Construire un index des trous forés depuis les saisies
            var drilledHoles = {};
            (records || []).forEach(function(r) {
                var data = r.data;
                if (typeof data === 'string') { try { data = JSON.parse(data); } catch(e) { return; } }
                if (!data) return;
                (data.holesWorked || []).forEach(function(hw) {
                    if (hw.holeId) {
                        var key = String(hw.holeId).trim().toUpperCase();
                        if (!drilledHoles[key]) drilledHoles[key] = { meters: 0, machine: '', date: r.date, isRedrill: false };
                        drilledHoles[key].meters += parseFloat(hw.meters) || 0;
                        drilledHoles[key].machine = r.machineId || drilledHoles[key].machine;
                        drilledHoles[key].date = r.date || drilledHoles[key].date;
                        if (hw.source && /refor/i.test(String(hw.source))) drilledHoles[key].isRedrill = true;
                    }
                });
            });
            // Mettre à jour les statuts
            let updated = 0;
            const stmt = db.prepare('UPDATE drill_plan_holes SET status = ?, actualDepth = ?, drilledDate = ?, machineId = ? WHERE id = ?');
            holes.forEach(h => {
                var key = String(h.holeId).trim().toUpperCase();
                var match = drilledHoles[key];
                if (match) {
                    var newStatus = match.isRedrill ? 'redrilled' : 'drilled';
                    stmt.run([newStatus, match.meters, match.date, match.machine, h.id]);
                    updated++;
                }
            });
            stmt.finalize(function() {
                res.json({ message: updated + ' trous mis à jour depuis les saisies', updated: updated, totalDrilled: Object.keys(drilledHoles).length });
            });
        });
    });
});

// Vider tous les trous d'un plan
app.delete('/api/drill-plans/:id/holes', (req, res) => {
    const entId = getEnterpriseId(req);
    const whereEnt = entId != null ? ' AND enterpriseId = ?' : '';
    const params = [req.params.id];
    if (entId != null) params.push(entId);
    db.get('SELECT id FROM drill_plans WHERE id = ?' + whereEnt, params, (err, plan) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!plan) return res.status(404).json({ error: 'Plan introuvable' });
        db.run('DELETE FROM drill_plan_holes WHERE planId = ?', [plan.id], function(e) {
            if (e) return res.status(500).json({ error: e.message });
            db.run('UPDATE drill_plans SET totalHoles = 0, updatedAt = CURRENT_TIMESTAMP WHERE id = ?', [plan.id]);
            res.json({ message: 'Trous supprimés', deleted: this.changes });
        });
    });
});

// Proxy Claude API (optionnel — utilise la clé API stockée dans l'entreprise)
app.post('/api/claude-ai/parse-plan', (req, res) => {
    const entId = getEnterpriseId(req);
    if (entId == null) return res.status(400).json({ error: 'Entreprise requise' });
    db.get('SELECT claudeApiKey FROM enterprises WHERE id = ?', [entId], async (err, ent) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ent || !ent.claudeApiKey) return res.status(400).json({ error: 'Clé API Claude non configurée. Allez dans Paramètres > Entreprise pour ajouter votre clé.' });
        const { imageBase64, prompt } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'Image requise' });
        try {
            const fetch = globalThis.fetch;
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ent.claudeApiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-5-5',
                    max_tokens: 4096,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
                            { type: 'text', text: prompt || 'Analyse ce plan de forage. Extrais tous les trous avec leurs identifiants, positions (rangée, colonne ou coordonnées X,Y), zone et bloc si visible. Retourne un JSON avec un tableau "holes" contenant des objets {holeId, x, y, row, col, zone, blockId, plannedDepth}. Ne retourne QUE le JSON, sans texte autour.' }
                        ]
                    }]
                })
            });
            const data = await response.json();
            if (data.error) return res.status(400).json({ error: data.error.message || 'Erreur API Claude' });
            const text = data.content && data.content[0] && data.content[0].text || '';
            // Essayer d'extraire le JSON
            let parsed = null;
            try {
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
            } catch(e) {}
            res.json({ raw: text, parsed: parsed });
        } catch(e) {
            res.status(500).json({ error: 'Erreur appel API Claude: ' + e.message });
        }
    });
});

// Extraction de données d'un rapport depuis une photo (OCR/Vision IA)
app.post('/api/claude-ai/extract-report', (req, res) => {
    const entId = getEnterpriseId(req);
    if (entId == null) return res.status(400).json({ error: 'Entreprise requise' });
    db.get('SELECT claudeApiKey FROM enterprises WHERE id = ?', [entId], async (err, ent) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ent || !ent.claudeApiKey) return res.status(400).json({ error: 'Clé API Claude non configurée. Allez dans Paramètres > Entreprise pour ajouter votre clé.' });
        const { imageBase64, mediaType } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'Image requise' });
        const mime = mediaType || 'image/jpeg';
        try {
            const fetch = globalThis.fetch;
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ent.claudeApiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-5-5',
                    max_tokens: 4096,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'image', source: { type: 'base64', media_type: mime, data: imageBase64 } },
                            { type: 'text', text: `Analyse cette photo d'une « Fiche de foration — Opérateur » remplie à la main (daily drilling field sheet).

STRUCTURE DE LA FICHE (repère-toi dessus) :
- En-tête : « Machine », « Site », « Date » (souvent pré-imprimés en bleu), case « Poste : Jour / Nuit » à cocher, « Opérateur », « Foreur ».
- Section 1 « Programme du jour & trous forés » : un tableau. Les colonnes « Zone (prévu) », « Trou (prévu) » et « Prof. prévue (m) » sont PRÉ-IMPRIMÉES (le programme) — NE PAS les confondre avec le réalisé. Les colonnes écrites à la main sont « Mètres forés », « Prof. finale (m) », « Début », « Fin », « Observations ».
  → Pour chaque ligne où l'opérateur a écrit quelque chose : holeId = la valeur de « Trou », meters = « Mètres forés » (la valeur MANUSCRITE, PAS « Prof. prévue »). Ignore les lignes entièrement vides.
- Section 2 « Compteurs & carburant » : Horamètre début/fin, Heures travaillées, Compteur marteau début/fin, Carburant ajouté (L).
- Section 3 « Arrêts & pannes » : tableau Motif / Heure début / Heure fin / Durée (h) / Détail. Le motif indique la nature : panne, standby (manque de trous, météo…), service.
- Section 4 « Changements / consommables » : cases Taillant / Tiges / Huile / Filtre + Détails.
- Section 5 « Observations générales ».

Extrais TOUTES les données MANUSCRITES visibles et retourne UNIQUEMENT un objet JSON (sans texte autour), null si non trouvé :
{
  "date": "YYYY-MM-DD",
  "machineName": "valeur du champ Machine",
  "shift": "day" | "night" | null,
  "drillingType": "exploration" | "production" | "drainage" | "injection" | "geotechnique" | "eau" | "autre" | null,
  "materialType": "FrM" | "TrM" | "OxM" | null,
  "location": "Site / lieu de forage",
  "meters": somme des « Mètres forés » manuscrits (mètres nouveaux),
  "redrillMeters": mètres reforés si indiqués,
  "hours": « Heures travaillées » (fonctionnement machine),
  "fuelAdded": « Carburant ajouté (L) »,
  "fuelPrice": prix du litre si présent,
  "counterStart": null,
  "counterEnd": null,
  "hammerStart": « Compteur marteau début »,
  "hammerEnd": « Compteur marteau fin »,
  "hoursCounterStart": « Horamètre début »,
  "hoursCounterEnd": « Horamètre fin »,
  "bitChanged": case Taillant cochée (true/false),
  "rodChanged": case Tiges cochée,
  "oilChanged": case Huile cochée,
  "filterChanged": case Filtre cochée,
  "changesDetails": "Détails des changements",
  "notes": "Observations générales",
  "holes": [{"holeId": "valeur colonne Trou", "meters": valeur MANUSCRITE Mètres forés, "finalDepth": Prof. finale}],
  "stoppages": [{"reason": "Motif", "duration": Durée en heures, "startTime": "HH:MM", "endTime": "HH:MM", "detail": "Détail"}]
}
RÈGLES : n'utilise JAMAIS « Prof. prévue » comme mètres forés (c'est le plan, pas le réalisé). Si une ligne de trou n'a aucune valeur manuscrite, ne l'inclus pas. Sois précis avec les nombres ; déchiffre l'écriture manuscrite au mieux. Retourne UNIQUEMENT le JSON.` }
                        ]
                    }]
                })
            });
            const data = await response.json();
            if (data.error) return res.status(400).json({ error: data.error.message || 'Erreur API Claude' });
            const text = data.content && data.content[0] && data.content[0].text || '';
            let parsed = null;
            try {
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
            } catch(e) {}
            res.json({ raw: text, parsed: parsed });
        } catch(e) {
            res.status(500).json({ error: 'Erreur appel API Claude: ' + e.message });
        }
    });
});

// Chat IA conversationnel — assistant ingénierie, comptabilité, planification
app.post('/api/claude-ai/chat', (req, res) => {
    const entId = getEnterpriseId(req);
    if (entId == null) return res.status(400).json({ error: 'Entreprise requise' });
    db.get('SELECT claudeApiKey, name FROM enterprises WHERE id = ?', [entId], async (err, ent) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ent || !ent.claudeApiKey) return res.status(400).json({ error: 'Clé API Claude non configurée. Allez dans Paramètres > Entreprise pour ajouter votre clé.' });
        const { messages, context } = req.body;
        if (!messages || !Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'Messages requis' });
        try {
            // Collecter le contexte de l'entreprise
            const contextData = await new Promise((resolve) => {
                const ctx = { enterprise: ent.name };
                db.all('SELECT id, name FROM sites WHERE enterpriseId = ?', [entId], (e, sites) => {
                    ctx.sites = (sites || []).map(s => s.name);
                    db.all('SELECT id, name, status, type FROM drills WHERE enterpriseId = ?', [entId], (e2, drills) => {
                        ctx.machines = (drills || []).map(d => ({ name: d.name, status: d.status, type: d.type }));
                        ctx.machineCount = (drills || []).length;
                        ctx.activeMachines = (drills || []).filter(d => d.status === 'active').length;
                        db.all('SELECT id, name, totalHoles, status FROM drill_plans WHERE enterpriseId = ?', [entId], (e3, plans) => {
                            ctx.drillPlans = (plans || []).map(p => ({ name: p.name, totalHoles: p.totalHoles, status: p.status }));
                            db.get('SELECT COUNT(*) as cnt FROM dailyDataRecords WHERE enterpriseId = ?', [entId], (e4, ddr) => {
                                ctx.totalDailyRecords = ddr ? ddr.cnt : 0;
                                db.all('SELECT id, fullName, role FROM employees WHERE enterpriseId = ? LIMIT 50', [entId], (e5, emps) => {
                                    ctx.employeeCount = (emps || []).length;
                                    resolve(ctx);
                                });
                            });
                        });
                    });
                });
            });

            const systemPrompt = `Tu es l'assistant IA de la plateforme GOOD ENGINEERS - GEDRILLING, un système de gestion de forage et sondage minier. Tu travailles pour l'entreprise "${contextData.enterprise}".

CONTEXTE DE L'ENTREPRISE :
- Sites : ${contextData.sites.length > 0 ? contextData.sites.join(', ') : 'aucun site'}
- Machines/foreuses : ${contextData.machineCount} (${contextData.activeMachines} actives)
- Plans de forage : ${contextData.drillPlans.length > 0 ? contextData.drillPlans.map(p => p.name + ' (' + p.totalHoles + ' trous, ' + p.status + ')').join('; ') : 'aucun'}
- Saisies journalières : ${contextData.totalDailyRecords} enregistrements
- Employés : ${contextData.employeeCount}

TES DOMAINES D'EXPERTISE :
1. INGÉNIERIE DE FORAGE : plans de forage, positionnement des trous, profondeurs, types de sondage (RC, DD, RAB), optimisation du patron de trous, rendements machines, métrages, gestion du reforage
2. COMPTABILITÉ & FINANCES : facturation des métrages forés, calcul de rentabilité par contrat, suivi des dépenses (carburant, consommables, maintenance), marges opérationnelles, back-charges sous-traitants
3. PLANIFICATION & LOGISTIQUE : affectation machines aux sites, planification des shifts, gestion de la maintenance préventive, prévision de production (Forecast vs Actuel), suivi d'avancement des plans
4. SÉCURITÉ & CONFORMITÉ : procédures de sécurité minière, incidents, reporting HSE
5. RESSOURCES HUMAINES : planning du personnel, pointage, rotation d'équipes

RÈGLES :
- Réponds en français sauf si on te parle en anglais
- Sois concis mais complet
- Utilise les données de l'entreprise quand c'est pertinent
- Propose des solutions pratiques et actionables
- Si tu ne connais pas une donnée spécifique, dis-le clairement
- Tu peux faire des calculs, des estimations et des recommandations`;

            const fetch = globalThis.fetch;
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ent.claudeApiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-5-5',
                    max_tokens: 4096,
                    system: systemPrompt,
                    messages: messages.slice(-20) // Garder les 20 derniers messages pour le contexte
                })
            });
            const data = await response.json();
            if (!response.ok || data.error) {
                const msg = (data && data.error && data.error.message) || ('Erreur API Claude (HTTP ' + response.status + ')');
                console.error('[claude-ai/chat] API error:', response.status, JSON.stringify(data && data.error || data).slice(0, 500));
                return res.status(400).json({ error: msg });
            }
            // Concatène TOUS les blocs de texte (certains modèles renvoient d'abord
            // un bloc non-texte, d'où une réponse vide si on ne lit que content[0]).
            let text = '';
            if (Array.isArray(data.content)) {
                text = data.content
                    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
                    .map(b => b.text)
                    .join('\n')
                    .trim();
            }
            if (!text) {
                console.error('[claude-ai/chat] Réponse sans texte. stop_reason=', data.stop_reason,
                    'content types=', JSON.stringify((data.content || []).map(b => b && b.type)));
                text = data.stop_reason === 'refusal'
                    ? "Je ne peux pas répondre à cette demande."
                    : "Je n'ai pas pu générer de réponse" +
                      (data.stop_reason ? ' (raison : ' + data.stop_reason + ')' : '') +
                      ". Réessayez ou reformulez votre question.";
            }
            res.json({ reply: text });
        } catch(e) {
            console.error('[claude-ai/chat] Exception:', e && e.message);
            res.status(500).json({ error: 'Erreur appel API Claude: ' + e.message });
        }
    });
});

// Sauvegarder la clé API Claude
// Statut de la clé API Claude (jamais la clé en clair : booléen + indice masqué)
app.get('/api/enterprises/:id/claude-key', (req, res) => {
    const isAdmin = req.auth && (req.auth.isSuperAdmin || req.auth.isPlatformOwner);
    const ownId = getEnterpriseId(req);
    const targetId = isAdmin ? parseInt(req.params.id, 10) : ownId;
    if (targetId == null || isNaN(targetId)) return res.status(400).json({ error: 'Entreprise non résolue.' });
    db.get('SELECT claudeApiKey FROM enterprises WHERE id = ?', [targetId], (err, ent) => {
        if (err) return res.status(500).json({ error: err.message });
        const key = ent && ent.claudeApiKey ? String(ent.claudeApiKey).trim() : '';
        const hint = key ? (key.slice(0, 7) + '…' + key.slice(-4)) : '';
        res.json({ configured: !!key, hint });
    });
});

app.put('/api/enterprises/:id/claude-key', (req, res) => {
    const { claudeApiKey } = req.body;
    // Un utilisateur ne peut écrire que sur sa propre entreprise ; l'admin plateforme peut cibler via l'URL.
    const isAdmin = req.auth && (req.auth.isSuperAdmin || req.auth.isPlatformOwner);
    const ownId = getEnterpriseId(req);
    const targetId = isAdmin ? parseInt(req.params.id, 10) : ownId;
    if (targetId == null || isNaN(targetId)) return res.status(400).json({ error: 'Entreprise non résolue.' });
    const key = claudeApiKey == null ? '' : String(claudeApiKey).trim();
    if (key && !/^sk-ant-/.test(key)) {
        return res.status(400).json({ error: 'Clé API Claude invalide : elle doit commencer par « sk-ant- ».' });
    }
    db.run('UPDATE enterprises SET claudeApiKey = ? WHERE id = ?', [key || null, targetId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: key ? 'Clé API sauvegardée' : 'Clé API supprimée' });
    });
});

// ============================================
// SÉCURITÉ DES DONNÉES — sauvegarde téléchargeable (propriétaire plateforme)
// Crée une sauvegarde fraîche de la base et la renvoie en téléchargement.
// Réservé au super_admin / propriétaire plateforme (contient toutes les entreprises).
// ============================================
app.get('/api/admin/db-backup', (req, res) => {
    if (!req.auth || !(req.auth.isSuperAdmin || req.auth.isPlatformOwner)) {
        return res.status(403).json({ error: 'Réservé au propriétaire de la plateforme.' });
    }
    backup().then((backupPath) => {
        const name = 'sauvegarde_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.db';
        res.download(backupPath, name, (err) => {
            if (err && !res.headersSent) res.status(500).json({ error: 'Téléchargement impossible.' });
        });
    }).catch((e) => res.status(500).json({ error: 'Sauvegarde impossible : ' + e.message }));
});

// ============================================
// PATTERNS (photo hachurée par fosse/zone et par jour)
// ============================================
db.run(`CREATE TABLE IF NOT EXISTS pattern_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    enterpriseId INTEGER NOT NULL DEFAULT 1,
    siteId INTEGER,
    date TEXT NOT NULL,
    zone TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL,
    source TEXT DEFAULT 'photo',
    createdAt TEXT DEFAULT CURRENT_TIMESTAMP
)`, (e) => {
    if (e) console.warn('pattern_photos:', e.message);
    // Hachurage sur photo : photo d'origine (sans hachures) + positions des trous hachurés.
    ['baseImage TEXT', 'marks TEXT', 'updatedAt TEXT'].forEach((col) => {
        db.run('ALTER TABLE pattern_photos ADD COLUMN ' + col, (err) => {
            if (err && !/duplicate column/i.test(err.message)) console.warn('pattern_photos.' + col + ':', err.message);
        });
    });
});

const PATTERN_IMAGE_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const PATTERN_MARK_TYPES = new Set(['drilled', 'previous', 'redrilled', 'abandoned', 'planned']);
const PATTERN_LEGEND_POSITIONS = ['bl', 'br', 'tl', 'tr'];
// Normalise l'état du hachurage (points en coordonnées relatives 0..1) avant stockage.
function sanitizePatternMarks(raw) {
    let st = raw;
    if (typeof st === 'string') { try { st = JSON.parse(st); } catch (e) { return null; } }
    if (Array.isArray(st)) st = { marks: st };
    if (!st || typeof st !== 'object') return null;
    const marks = (Array.isArray(st.marks) ? st.marks : []).slice(0, 2000).map((m) => {
        if (!m || typeof m !== 'object') return null;
        const x = Number(m.x), y = Number(m.y);
        let r = Number(m.r);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
        if (!Number.isFinite(r) || r <= 0) r = 0.012;
        r = Math.min(0.08, Math.max(0.002, r));
        return {
            x: +x.toFixed(5), y: +y.toFixed(5), r: +r.toFixed(5),
            t: PATTERN_MARK_TYPES.has(m.t) ? m.t : 'drilled',
            id: m.id == null ? '' : String(m.id).trim().slice(0, 40)
        };
    }).filter(Boolean);
    const lg = st.legend && typeof st.legend === 'object' ? st.legend : {};
    return { v: 1, marks, labels: st.labels !== false, legend: { show: lg.show !== false, pos: PATTERN_LEGEND_POSITIONS.includes(lg.pos) ? lg.pos : 'bl' } };
}
function parsePatternMarks(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
}

app.get('/api/pattern-photos', (req, res) => {
    const entId = getEnterpriseId(req);
    const { date, siteId } = req.query;
    // La photo d'origine (baseImage) n'est pas renvoyée en liste : elle ne sert qu'à l'éditeur.
    let sql = 'SELECT id, enterpriseId, siteId, date, zone, image, source, marks, createdAt, updatedAt FROM pattern_photos WHERE 1=1';
    const params = [];
    if (entId !== null) { sql += ' AND enterpriseId = ?'; params.push(entId); }
    if (date) { sql += ' AND date = ?'; params.push(date); }
    if (siteId !== undefined && siteId !== '' && siteId !== 'null') { sql += ' AND siteId = ?'; params.push(parseInt(siteId, 10)); }
    sql += ' ORDER BY zone';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json((rows || []).map((r) => ({ ...r, marks: parsePatternMarks(r.marks) })));
    });
});

// Dernier plan photo d'une fosse avant une date (pour « Reprendre la veille »).
app.get('/api/pattern-photos/previous', (req, res) => {
    const entId = getEnterpriseId(req);
    const zone = String(req.query.zone || '').trim().slice(0, 160);
    const before = String(req.query.before || '').slice(0, 10);
    const { siteId } = req.query;
    if (!zone || !/^\d{4}-\d{2}-\d{2}$/.test(before)) return res.status(400).json({ error: 'Fosse et date (AAAA-MM-JJ) requises' });
    let sql = "SELECT id, siteId, date, zone, image, baseImage, source, marks FROM pattern_photos WHERE TRIM(zone) = ? COLLATE NOCASE AND date < ? AND IFNULL(source, 'photo') = 'photo'";
    const params = [zone, before];
    if (entId !== null) { sql += ' AND enterpriseId = ?'; params.push(entId); }
    if (siteId !== undefined && siteId !== '' && siteId !== 'null') { sql += ' AND siteId = ?'; params.push(parseInt(siteId, 10)); }
    sql += ' ORDER BY date DESC, id DESC LIMIT 1';
    db.get(sql, params, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.json(null);
        res.json({ ...row, marks: parsePatternMarks(row.marks) });
    });
});

app.get('/api/pattern-photos/:id', (req, res) => {
    const entId = getEnterpriseId(req);
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Identifiant invalide' });
    let sql = 'SELECT id, siteId, date, zone, image, baseImage, source, marks, createdAt, updatedAt FROM pattern_photos WHERE id = ?';
    const params = [id];
    if (entId !== null) { sql += ' AND enterpriseId = ?'; params.push(entId); }
    db.get(sql, params, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Pattern introuvable' });
        res.json({ ...row, marks: parsePatternMarks(row.marks) });
    });
});

app.post('/api/pattern-photos', (req, res) => {
    const entId = getEnterpriseId(req);
    const b = req.body || {};
    const date = (b.date || '').slice(0, 10);
    const zone = (b.zone == null ? '' : String(b.zone)).trim().slice(0, 160);
    const image = typeof b.image === 'string' ? b.image : '';
    const source = b.source === 'auto' ? 'auto' : 'photo';
    const siteId = (b.siteId === '' || b.siteId == null) ? null : parseInt(b.siteId, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date AAAA-MM-JJ requise' });
    if (!zone) return res.status(400).json({ error: 'Zone / fosse requise' });
    if (!image || !PATTERN_IMAGE_RE.test(image)) return res.status(400).json({ error: 'Image requise (format data:image en base64)' });
    if (image.length > 5000000) return res.status(400).json({ error: 'Image trop lourde (réduisez-la).' });
    let baseImage = null;
    if (b.baseImage != null && b.baseImage !== '') {
        if (typeof b.baseImage !== 'string' || !PATTERN_IMAGE_RE.test(b.baseImage)) return res.status(400).json({ error: 'Photo d\'origine invalide (format data:image en base64)' });
        if (b.baseImage.length > 5000000) return res.status(400).json({ error: 'Photo d\'origine trop lourde (réduisez-la).' });
        baseImage = b.baseImage;
    }
    const marksState = b.marks == null ? null : sanitizePatternMarks(b.marks);
    const marksText = marksState ? JSON.stringify(marksState) : null;
    const entVal = entId == null ? 1 : entId;
    // Un seul pattern par (entreprise, site, date, zone) : on remplace l'existant.
    db.run('DELETE FROM pattern_photos WHERE enterpriseId = ? AND date = ? AND zone = ? AND IFNULL(siteId,-1) = IFNULL(?,-1)',
        [entVal, date, zone, siteId], (delErr) => {
            if (delErr) return res.status(500).json({ error: delErr.message });
            db.run('INSERT INTO pattern_photos (enterpriseId, siteId, date, zone, image, source, baseImage, marks, updatedAt) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)',
                [entVal, siteId, date, zone, image, source, baseImage, marksText], function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ id: this.lastID, message: 'Pattern enregistré', marks: marksState ? marksState.marks.length : 0 });
                });
        });
});

app.delete('/api/pattern-photos/:id', (req, res) => {
    const entId = getEnterpriseId(req);
    let sql = 'DELETE FROM pattern_photos WHERE id = ?';
    const params = [parseInt(req.params.id, 10)];
    if (entId !== null) { sql += ' AND enterpriseId = ?'; params.push(entId); }
    db.run(sql, params, function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true, changes: this.changes });
    });
});

// ============================================
// ROUTES API - SITES
// ============================================
app.get('/api/sites', (req, res) => {
    const { clientId } = req.query;
    const enterpriseId = getEnterpriseId(req);
    let query = 'SELECT * FROM sites';
    const params = [];
    if (enterpriseId !== null) {
        query += ' WHERE enterpriseId = ?';
        params.push(enterpriseId);
    }
    if (clientId) {
        query += (params.length ? ' AND' : ' WHERE') + ' clientId = ?';
        params.push(clientId);
    }
    query += ' ORDER BY name';
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows || []);
    });
});

app.post('/api/sites', (req, res) => {
    if (!canManageSitesWrite(req)) {
        return res.status(403).json({ error: 'Seuls l’administrateur de l’entreprise, le rôle « gestionnaire de site » ou la plateforme peuvent créer un site.' });
    }
    const { name, address, city, region, country, clientId, coordinates, notes } = req.body;
    const cutoffDay = (function(v){ var n = parseInt(v, 10); if (Number.isNaN(n)) return 1; return Math.min(31, Math.max(1, n)); })(req.body.miningCutoffDay);
    const entId = resolveCreateEnterpriseId(req, req.body);
    if (entId == null || entId === '') {
        return res.status(400).json({ error: 'Contexte entreprise requis pour créer un site' });
    }
    db.get('SELECT maxSites FROM enterprises WHERE id = ?', [entId], (errEnt, entRow) => {
        if (errEnt) return res.status(500).json({ error: errEnt.message });
        const capRaw = entRow && entRow.maxSites != null && entRow.maxSites !== '' ? parseInt(entRow.maxSites, 10) : 1;
        const cap = Number.isNaN(capRaw) ? 1 : Math.max(1, capRaw);
        db.get('SELECT COUNT(*) as n FROM sites WHERE enterpriseId = ?', [entId], (errC, rowC) => {
            if (errC) return res.status(500).json({ error: errC.message });
            if (rowC.n >= cap) {
                return res.status(403).json({
                    error: `Quota sites atteint pour cet abonnement (${rowC.n}/${cap}). Augmentez « max. sites » dans la fiche entreprise (plateforme) ou libérez un site.`
                });
            }
            db.run(
                `INSERT INTO sites (enterpriseId, name, address, city, region, country, clientId, coordinates, notes, miningCutoffDay)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [entId, name || '', address || '', city || '', region || '', country || '', clientId, coordinates || '', notes || '', cutoffDay],
                function(err) {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return;
                    }
                    res.json({ id: this.lastID, message: 'Site créé' });
                }
            );
        });
    });
});

app.put('/api/sites/:id', (req, res) => {
    if (!canManageSitesWrite(req)) {
        return res.status(403).json({ error: 'Seuls l’administrateur de l’entreprise, le rôle « gestionnaire de site » ou la plateforme peuvent modifier un site.' });
    }
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    const { name, address, city, region, country, clientId, coordinates, notes } = req.body;
    const cutoffDay = (function(v){ var n = parseInt(v, 10); if (Number.isNaN(n)) return 1; return Math.min(31, Math.max(1, n)); })(req.body.miningCutoffDay);
    let sql = `UPDATE sites SET name = ?, address = ?, city = ?, region = ?, country = ?, clientId = ?, coordinates = ?, notes = ?, miningCutoffDay = ? WHERE id = ?`;
    const vals = [name || '', address || '', city || '', region || '', country || '', clientId, coordinates || '', notes || '', cutoffDay, id];
    if (entId !== null) {
        sql += ' AND enterpriseId = ?';
        vals.push(entId);
    }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Site introuvable ou accès refusé' });
        res.json({ message: 'Site mis à jour', changes: this.changes });
    });
});

app.delete('/api/sites/:id', (req, res) => {
    if (!canManageSitesWrite(req)) {
        return res.status(403).json({ error: 'Seuls l’administrateur de l’entreprise, le rôle « gestionnaire de site » ou la plateforme peuvent supprimer un site.' });
    }
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    let sql = 'DELETE FROM sites WHERE id = ?';
    const vals = [id];
    if (entId !== null) {
        sql += ' AND enterpriseId = ?';
        vals.push(entId);
    }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Site introuvable ou accès refusé' });
        res.json({ message: 'Site supprimé', changes: this.changes });
    });
});

// ============================================
// ROUTES API - CLIENTS
// ============================================
app.get('/api/clients', (req, res) => {
    const enterpriseId = getEnterpriseId(req);
    let query = 'SELECT * FROM clients';
    const params = [];
    if (enterpriseId !== null) {
        query += ' WHERE enterpriseId = ?';
        params.push(enterpriseId);
    }
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows.map(row => ({
            ...row,
            machines: JSON.parse(row.machines || '[]'),
            monthlyMeters: JSON.parse(row.monthlyMeters || '{}')
        })));
    });
});

app.post('/api/clients', (req, res) => {
    const client = req.body;
    const entId = resolveCreateEnterpriseId(req, client);
    db.run(
        `INSERT INTO clients (id, enterpriseId, name, legalName, address, city, postalCode, country, taxId, vatNumber, 
         email, phone, website, logo, currency, paymentTerms, notes, machines, monthlyMeters,
         signatoryFirstName, signatoryLastName, signatoryTitle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            client.id, entId, client.name, client.legalName, client.address, client.city, client.postalCode,
            client.country, client.taxId, client.vatNumber, client.email, client.phone, client.website,
            client.logo || '', client.currency, client.paymentTerms, client.notes || '',
            JSON.stringify(client.machines || []),
            JSON.stringify(client.monthlyMeters || {}),
            client.signatoryFirstName || '',
            client.signatoryLastName || '',
            client.signatoryTitle || ''
        ],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: client.id, message: 'Client créé' });
        }
    );
});

app.put('/api/clients/:id', (req, res) => {
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    const client = req.body;
    let sql = `UPDATE clients SET name = ?, legalName = ?, address = ?, city = ?, postalCode = ?, country = ?,
         taxId = ?, vatNumber = ?, email = ?, phone = ?, website = ?, logo = ?, currency = ?,
         paymentTerms = ?, notes = ?, machines = ?, monthlyMeters = ?,
         signatoryFirstName = ?, signatoryLastName = ?, signatoryTitle = ?
         WHERE id = ?`;
    const vals = [
        client.name, client.legalName, client.address, client.city, client.postalCode, client.country,
        client.taxId, client.vatNumber, client.email, client.phone, client.website, client.logo || '',
        client.currency, client.paymentTerms, client.notes || '',
        JSON.stringify(client.machines || []),
        JSON.stringify(client.monthlyMeters || {}),
        client.signatoryFirstName || '',
        client.signatoryLastName || '',
        client.signatoryTitle || '',
        id
    ];
    if (entId !== null) {
        sql += ' AND enterpriseId = ?';
        vals.push(entId);
    }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Client introuvable ou accès refusé' });
        res.json({ message: 'Client mis à jour', changes: this.changes });
    });
});

app.delete('/api/clients/:id', (req, res) => {
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    let sql = 'DELETE FROM clients WHERE id = ?';
    const vals = [id];
    if (entId !== null) {
        sql += ' AND enterpriseId = ?';
        vals.push(entId);
    }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Client introuvable ou accès refusé' });
        res.json({ message: 'Client supprimé', changes: this.changes });
    });
});

// ============================================
// ROUTES API - CONTRATS
// ============================================
app.get('/api/contracts', (req, res) => {
    const enterpriseId = getEnterpriseId(req);
    let query = 'SELECT * FROM contracts';
    const params = [];
    if (enterpriseId !== null) {
        query += ' WHERE enterpriseId = ?';
        params.push(enterpriseId);
    }
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows.map(row => ({
            ...row,
            rates: JSON.parse(row.rates || '[]'),
            fgm: JSON.parse(row.fgm || '[]'),
            fuelPrice: row.fuelPrice || 1.20,
            fuelPriceCurrency: normalizeContractFuelPriceCurrency(row.fuelPriceCurrency, row.currency)
        })));
    });
});

app.post('/api/contracts', (req, res) => {
    const contract = req.body;
    const entId = resolveCreateEnterpriseId(req, contract);
    db.run(
        `INSERT INTO contracts (id, enterpriseId, clientId, siteId, startDate, endDate, value, currency, status, description,
         paymentTerms, billingMonthDefinition, notes, fuelPrice, fuelPriceCurrency, rates, fgm, billRedrill)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            contract.id, entId, contract.clientId, contract.siteId || null, contract.startDate, contract.endDate,
            contract.value, contract.currency, contract.status, contract.description,
            contract.paymentTerms, contract.billingMonthDefinition || '', contract.notes || '', contract.fuelPrice || 1.20,
            normalizeContractFuelPriceCurrency(contract.fuelPriceCurrency, contract.currency),
            JSON.stringify(contract.rates || []),
            JSON.stringify(contract.fgm || []),
            contract.billRedrill ? 1 : 0
        ],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: contract.id, message: 'Contrat créé' });
        }
    );
});

app.put('/api/contracts/:id', (req, res) => {
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    const contract = req.body;
    let sql = `UPDATE contracts SET clientId = ?, siteId = ?, startDate = ?, endDate = ?, value = ?, currency = ?,
         status = ?, description = ?, paymentTerms = ?, billingMonthDefinition = ?, notes = ?, fuelPrice = ?, fuelPriceCurrency = ?, rates = ?, fgm = ?, billRedrill = ?
         WHERE id = ?`;
    const vals = [
        contract.clientId, contract.siteId || null, contract.startDate, contract.endDate, contract.value, contract.currency,
        contract.status, contract.description, contract.paymentTerms, contract.billingMonthDefinition || '',
        contract.notes || '',
        contract.fuelPrice || 1.20,
        normalizeContractFuelPriceCurrency(contract.fuelPriceCurrency, contract.currency),
        JSON.stringify(contract.rates || []),
        JSON.stringify(contract.fgm || []),
        contract.billRedrill ? 1 : 0, id
    ];
    if (entId !== null) {
        sql += ' AND enterpriseId = ?';
        vals.push(entId);
    }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Contrat introuvable ou accès refusé' });
        res.json({ message: 'Contrat mis à jour', changes: this.changes });
    });
});

app.delete('/api/contracts/:id', (req, res) => {
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    let sql = 'DELETE FROM contracts WHERE id = ?';
    const vals = [id];
    if (entId !== null) {
        sql += ' AND enterpriseId = ?';
        vals.push(entId);
    }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Contrat introuvable ou accès refusé' });
        res.json({ message: 'Contrat supprimé', changes: this.changes });
    });
});

// ============================================
// ROUTES API - EMPLOYEES
// ============================================
app.get('/api/employees', (req, res) => {
    const enterpriseId = getEnterpriseId(req);
    let query = 'SELECT * FROM employees';
    const params = [];
    if (enterpriseId !== null) {
        query += ' WHERE enterpriseId = ?';
        params.push(enterpriseId);
    }
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows.map(row => ({
            ...row,
            payslips: JSON.parse(row.payslips || '[]')
        })));
    });
});

app.post('/api/employees', (req, res) => {
    const employee = req.body || {};
    const entId = resolveCreateEnterpriseId(req, employee);
    // Ne pas insérer l'id client : évite SQLITE_CONSTRAINT UNIQUE quand la liste en mémoire
    // ne reflète pas tous les ids déjà présents en base. SQLite attribue le prochain id AUTOINCREMENT.
    db.run(
        `INSERT INTO employees (enterpriseId, employeeNumber, name, role, email, phone, status, salary, startDate,
         address, notes, takenLeave, payslips, siteId, section, team, rotation, enginType)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            entId, employee.employeeNumber, employee.name, employee.role, employee.email,
            employee.phone, employee.status, employee.salary, employee.startDate,
            employee.address || '', employee.notes || '', employee.takenLeave || 0,
            JSON.stringify(employee.payslips || []),
            employee.siteId != null && employee.siteId !== '' ? parseInt(employee.siteId, 10) : null,
            employee.section || null,
            employee.team || null, employee.rotation || null, employee.enginType || null
        ],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: this.lastID, message: 'Employé créé' });
        }
    );
});

app.put('/api/employees/:id', (req, res) => {
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    const employee = req.body;
    let sql = `UPDATE employees SET employeeNumber = ?, name = ?, role = ?, email = ?, phone = ?,
         status = ?, salary = ?, startDate = ?, address = ?, notes = ?, takenLeave = ?, payslips = ?, siteId = ?, section = ?, team = ?, rotation = ?, enginType = ?
         WHERE id = ?`;
    const vals = [
        employee.employeeNumber, employee.name, employee.role, employee.email, employee.phone,
        employee.status, employee.salary, employee.startDate, employee.address || '',
        employee.notes || '', employee.takenLeave || 0,
        JSON.stringify(employee.payslips || []),
        employee.siteId != null && employee.siteId !== '' ? parseInt(employee.siteId, 10) : null,
        employee.section || null,
        employee.team || null, employee.rotation || null, employee.enginType || null,
        id
    ];
    if (entId !== null) {
        sql += ' AND enterpriseId = ?';
        vals.push(entId);
    }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Employé introuvable ou accès refusé' });
        res.json({ message: 'Employé mis à jour', changes: this.changes });
    });
});

app.delete('/api/employees/:id', (req, res) => {
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    let sql = 'DELETE FROM employees WHERE id = ?';
    const vals = [id];
    if (entId !== null) {
        sql += ' AND enterpriseId = ?';
        vals.push(entId);
    }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Employé introuvable ou accès refusé' });
        res.json({ message: 'Employé supprimé', changes: this.changes });
    });
});

// ============================================
// ROUTES API - ASSIGNMENTS
// ============================================
app.get('/api/assignments', (req, res) => {
    const enterpriseId = getEnterpriseId(req);
    let query = 'SELECT a.* FROM assignments a';
    const params = [];
    if (enterpriseId !== null) {
        query += ' JOIN drills d ON a.drillId = d.id WHERE d.enterpriseId = ?';
        params.push(enterpriseId);
    }
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows.map(row => ({
            ...row,
            helpers: JSON.parse(row.helpers || '[]')
        })));
    });
});

app.post('/api/assignments', (req, res) => {
    const assignment = req.body;
    const entId = getEnterpriseId(req);
    assertDrillBelongsToTenant(db, assignment.drillId, entId, (err, ok) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ok) return res.status(403).json({ error: 'Machine invalide pour cette entreprise' });
        const st = assignment.status || 'active';
        const runInsert = () => {
            db.run(
                `INSERT INTO assignments (drillId, operatorId, operatorName, helpers, startDate, status, contractId)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    assignment.drillId, assignment.operatorId, assignment.operatorName,
                    JSON.stringify(assignment.helpers || []), assignment.startDate, st,
                    assignment.contractId || null
                ],
                function(err2) {
                    if (err2) {
                        const em = String(err2.message || '');
                        if (em.includes('UNIQUE') || em.includes('constraint')) {
                            return res.status(409).json({ error: 'Une assignation active existe déjà pour cette foreuse.' });
                        }
                        return res.status(500).json({ error: err2.message });
                    }
                    res.json({ id: this.lastID, message: 'Assignation créée' });
                }
            );
        };
        if (st === 'active') {
            let q = `SELECT a.id FROM assignments a INNER JOIN drills d ON d.id = a.drillId
                WHERE a.drillId = ? AND a.status = 'active'`;
            const par = [assignment.drillId];
            if (entId != null) {
                q += ' AND d.enterpriseId = ?';
                par.push(entId);
            }
            db.get(q, par, (eDup, rowDup) => {
                if (eDup) return res.status(500).json({ error: eDup.message });
                if (rowDup) {
                    return res.status(409).json({ error: 'Une assignation active existe déjà pour cette foreuse.' });
                }
                runInsert();
            });
        } else {
            runInsert();
        }
    });
});

app.put('/api/assignments/:id', (req, res) => {
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    const assignment = req.body;
    assertDrillBelongsToTenant(db, assignment.drillId, entId, (err, ok) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!ok) return res.status(403).json({ error: 'Machine invalide pour cette entreprise' });
        let sql = `UPDATE assignments SET drillId = ?, operatorId = ?, operatorName = ?, helpers = ?,
         startDate = ?, status = ?, contractId = ? WHERE id = ?`;
        const vals = [
            assignment.drillId, assignment.operatorId, assignment.operatorName,
            JSON.stringify(assignment.helpers || []), assignment.startDate, assignment.status || 'active',
            assignment.contractId || null, id
        ];
        if (entId !== null) {
            sql += ' AND drillId IN (SELECT id FROM drills WHERE enterpriseId = ?)';
            vals.push(entId);
        }
        db.run(sql, vals, function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Assignation introuvable ou accès refusé' });
            res.json({ message: 'Assignation mise à jour', changes: this.changes });
        });
    });
});

app.delete('/api/assignments/:id', (req, res) => {
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    let sql = 'DELETE FROM assignments WHERE id = ?';
    const vals = [id];
    if (entId !== null) {
        sql += ' AND drillId IN (SELECT id FROM drills WHERE enterpriseId = ?)';
        vals.push(entId);
    }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Assignation introuvable ou accès refusé' });
        res.json({ message: 'Assignation supprimée', changes: this.changes });
    });
});

// ============================================
// ROUTES API - INVOICES
// ============================================

/** Normalise l’id facture (URL, tirets « typographiques », espaces). */
function normalizeInvoiceIdForLookup(raw) {
    if (raw == null) return '';
    let s = String(raw).trim();
    try {
        s = decodeURIComponent(s);
    } catch (e) {
        /* déjà décodé ou invalide */
    }
    try {
        s = s.normalize('NFKC');
    } catch (e2) {
        /* environnement sans normalize */
    }
    return s.replace(/[\u2010\u2011\u2012\u2013\u2014\uFE58\uFE63\uFF0D\u2212]/g, '-').trim();
}

/**
 * Résout la ligne facture : id dans l’URL, id dans le corps, ou numéro de facture + entreprise (repli anti-proxy / encodage).
 */
function resolveInvoiceRowForRequest(db, idParam, invoiceBody, entId, plat, done) {
    const candidates = [];
    const push = (v) => {
        const n = normalizeInvoiceIdForLookup(v);
        if (n && candidates.indexOf(n) < 0) candidates.push(n);
    };
    push(idParam);
    if (invoiceBody && invoiceBody.id != null) push(invoiceBody.id);

    let idx = 0;
    const tryNextId = () => {
        if (idx >= candidates.length) return tryByInvoiceNumber();
        const cid = candidates[idx++];
        db.get('SELECT id, enterpriseId FROM invoices WHERE id = ?', [cid], (ert, row) => {
            if (ert) return done(ert, null);
            if (row) return done(null, row);
            tryNextId();
        });
    };
    const tryByInvoiceNumber = () => {
        const num = invoiceBody && invoiceBody.invoiceNumber != null ? String(invoiceBody.invoiceNumber).trim() : '';
        if (!num) return done(null, null);
        if (!plat && (entId == null || entId === '')) return done(null, null);
        const sql = plat
            ? 'SELECT id, enterpriseId FROM invoices WHERE invoiceNumber = ?'
            : 'SELECT id, enterpriseId FROM invoices WHERE invoiceNumber = ? AND enterpriseId = ?';
        const params = plat ? [num] : [num, entId];
        db.all(sql, params, (ern, rows) => {
            if (ern) return done(ern, null);
            if (!rows || rows.length !== 1) return done(null, null);
            done(null, rows[0]);
        });
    };
    tryNextId();
}

app.get('/api/invoices', (req, res) => {
    const enterpriseId = getEnterpriseId(req);
    let query = 'SELECT * FROM invoices';
    const params = [];
    if (enterpriseId !== null) {
        query += ' WHERE enterpriseId = ?';
        params.push(enterpriseId);
    }
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(
            rows.map((row) => {
                const signP = safeJsonParseObj(row.signProviderJson);
                const signC = safeJsonParseObj(row.signClientJson);
                return {
                    ...row,
                    items: JSON.parse(row.items || '[]'),
                    signProvider: signP,
                    signClient: signC
                };
            })
        );
    });
});

function safeJsonParseObj(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    try {
        const o = JSON.parse(raw);
        return typeof o === 'object' && o !== null ? o : null;
    } catch (_) {
        return null;
    }
}

function signatoriesToJsonCol(body, key) {
    const v = body && body[key];
    if (v == null) return '';
    try {
        return JSON.stringify(typeof v === 'object' ? v : {});
    } catch (_) {
        return '';
    }
}

app.post('/api/invoices', (req, res) => {
    const invoice = req.body;
    const entId = resolveCreateEnterpriseId(req, invoice);
    const billingMonth = invoice.billingMonth != null && invoice.billingMonth !== '' ? String(invoice.billingMonth).slice(0, 7) : '';
    const signProv = signatoriesToJsonCol(invoice, 'signProvider');
    const signCli = signatoriesToJsonCol(invoice, 'signClient');
    db.run(
        `INSERT INTO invoices (id, enterpriseId, invoiceNumber, date, dueDate, clientId, items, subtotal, taxRate,
         taxAmount, total, currency, status, notes, billingMonth, signProviderJson, signClientJson, contractId, site)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            invoice.id, entId, invoice.invoiceNumber, invoice.date, invoice.dueDate, invoice.clientId,
            JSON.stringify(invoice.items || []), invoice.subtotal, invoice.taxRate,
            invoice.taxAmount, invoice.total, invoice.currency, invoice.status, invoice.notes || '',
            billingMonth, signProv, signCli, invoice.contractId || null, invoice.site || ''
        ],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: invoice.id, message: 'Facture créée' });
        }
    );
});

app.put('/api/invoices/:id', (req, res) => {
    const idParam = req.params.id;
    const entId = getEnterpriseId(req);
    const invoice = req.body || {};
    const billingMonthU = invoice.billingMonth != null && invoice.billingMonth !== '' ? String(invoice.billingMonth).slice(0, 7) : '';
    const signProvU = signatoriesToJsonCol(invoice, 'signProvider');
    const signCliU = signatoriesToJsonCol(invoice, 'signClient');
    const plat = !!(req.auth && (req.auth.isSuperAdmin || req.auth.isPlatformOwner));
    resolveInvoiceRowForRequest(db, idParam, invoice, entId, plat, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Facture introuvable.' });
        if (!plat && entId != null && parseInt(row.enterpriseId, 10) !== parseInt(entId, 10)) {
            return res.status(403).json({
                error: 'Cette facture appartient à une autre organisation. Sélectionnez la bonne entreprise dans l’en-tête, puis réessayez.'
            });
        }
        const realId = row.id;
        const sql = `UPDATE invoices SET invoiceNumber = ?, date = ?, dueDate = ?, clientId = ?, items = ?,
         subtotal = ?, taxRate = ?, taxAmount = ?, total = ?, currency = ?, status = ?, notes = ?,
         billingMonth = ?, signProviderJson = ?, signClientJson = ?, contractId = ?, site = ?
         WHERE id = ?`;
        const vals = [
            invoice.invoiceNumber, invoice.date, invoice.dueDate, invoice.clientId,
            JSON.stringify(invoice.items || []), invoice.subtotal, invoice.taxRate,
            invoice.taxAmount, invoice.total, invoice.currency, invoice.status, invoice.notes || '',
            billingMonthU, signProvU, signCliU, invoice.contractId || null, invoice.site || '', realId
        ];
        db.run(sql, vals, function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Facture introuvable.' });
            res.json({ message: 'Facture mise à jour', changes: this.changes });
        });
    });
});

app.delete('/api/invoices/:id', (req, res) => {
    const idParam = req.params.id;
    const entId = getEnterpriseId(req);
    const plat = !!(req.auth && (req.auth.isSuperAdmin || req.auth.isPlatformOwner));
    resolveInvoiceRowForRequest(db, idParam, req.body || {}, entId, plat, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Facture introuvable (identifiant inconnu ou déjà supprimée).' });
        if (!plat && entId != null && parseInt(row.enterpriseId, 10) !== parseInt(entId, 10)) {
            return res.status(403).json({
                error: 'Cette facture appartient à une autre organisation. Sélectionnez la bonne entreprise dans l’en-tête, puis réessayez.'
            });
        }
        const realId = row.id;
        db.run('DELETE FROM invoices WHERE id = ?', [realId], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            db.run('UPDATE drill_month_billing SET invoiceId = NULL WHERE invoiceId = ?', [realId], function() {
                res.json({ message: 'Facture supprimée' });
            });
        });
    });
});

// ─── ROUTES API - PAYMENTS (Suivi des paiements / encaissements) ───

/** Helper : recalcule le statut d'une facture d'après ses paiements */
function recalcInvoiceStatus(db, invoiceId, done) {
    db.get('SELECT total, currency FROM invoices WHERE id = ?', [invoiceId], (err, inv) => {
        if (err || !inv) return done && done();
        db.get('SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE invoiceId = ?', [invoiceId], (err2, row) => {
            if (err2) return done && done();
            const paid = row.paid || 0;
            const total = inv.total || 0;
            let status = 'pending';
            if (paid >= total && total > 0) status = 'paid';
            else if (paid > 0) status = 'partial';
            else status = 'pending';
            db.run('UPDATE invoices SET status = ? WHERE id = ?', [status, invoiceId], () => done && done());
        });
    });
}

// GET /api/payments — liste tous les paiements (filtres : invoiceId, clientId, from, to, method)
app.get('/api/payments', (req, res) => {
    const entId = getEnterpriseId(req);
    const plat = isPlatformAdmin(req);
    let sql = 'SELECT p.*, i.invoiceNumber, i.clientId, i.total AS invoiceTotal FROM payments p LEFT JOIN invoices i ON p.invoiceId = i.id';
    const conditions = [];
    const params = [];
    if (!plat) { conditions.push('p.enterpriseId = ?'); params.push(entId); }
    if (req.query.invoiceId) { conditions.push('p.invoiceId = ?'); params.push(req.query.invoiceId); }
    if (req.query.clientId) { conditions.push('i.clientId = ?'); params.push(req.query.clientId); }
    if (req.query.from) { conditions.push('p.date >= ?'); params.push(req.query.from); }
    if (req.query.to) { conditions.push('p.date <= ?'); params.push(req.query.to); }
    if (req.query.method) { conditions.push('p.method = ?'); params.push(req.query.method); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY p.date DESC, p.createdAt DESC';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// GET /api/payments/stats — statistiques globales des encaissements
app.get('/api/payments/stats', (req, res) => {
    const entId = getEnterpriseId(req);
    const plat = isPlatformAdmin(req);
    const where = plat ? '' : ' WHERE p.enterpriseId = ' + Number(entId);
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';
    db.all(`SELECT p.currency,
            SUM(p.amount) AS totalReceived,
            SUM(CASE WHEN p.date >= '${monthStart}' THEN p.amount ELSE 0 END) AS receivedThisMonth,
            SUM(CASE WHEN p.date = '${today}' THEN p.amount ELSE 0 END) AS receivedToday,
            COUNT(*) AS count
        FROM payments p${where} GROUP BY p.currency`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // Aussi le total impayé
        const wInv = plat ? '' : ' WHERE enterpriseId = ' + Number(entId);
        db.all(`SELECT currency, SUM(total) AS totalDue,
                SUM(CASE WHEN status IN ('pending','overdue','partial') THEN total ELSE 0 END) AS outstanding
            FROM invoices${wInv} GROUP BY currency`, [], (err2, invRows) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ payments: rows || [], invoices: invRows || [] });
        });
    });
});

// GET /api/payments/invoice/:invoiceId — paiements d'une facture + solde restant
app.get('/api/payments/invoice/:invoiceId', (req, res) => {
    const entId = getEnterpriseId(req);
    const plat = isPlatformAdmin(req);
    const invoiceId = req.params.invoiceId;
    db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId], (err, inv) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
        if (!plat && inv.enterpriseId !== entId) return res.status(403).json({ error: 'Accès non autorisé' });
        db.all('SELECT * FROM payments WHERE invoiceId = ? ORDER BY date DESC', [invoiceId], (err2, payments) => {
            if (err2) return res.status(500).json({ error: err2.message });
            const totalPaid = (payments || []).reduce((s, p) => s + (p.amount || 0), 0);
            res.json({
                invoice: inv,
                payments: payments || [],
                totalPaid,
                remaining: (inv.total || 0) - totalPaid,
                fullyPaid: totalPaid >= (inv.total || 0)
            });
        });
    });
});

// POST /api/payments — enregistrer un paiement
app.post('/api/payments', (req, res) => {
    const p = req.body;
    const entId = resolveCreateEnterpriseId(req, p);
    if (!p.invoiceId) return res.status(400).json({ error: 'invoiceId requis' });
    if (!p.amount || p.amount <= 0) return res.status(400).json({ error: 'Montant invalide' });
    const id = p.id || ('PAY-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    db.run(`INSERT INTO payments (id, enterpriseId, invoiceId, date, amount, currency, method, reference, notes, receivedBy)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, entId, p.invoiceId, p.date || new Date().toISOString().slice(0, 10),
         p.amount, p.currency || 'XOF', p.method || 'cash', p.reference || '', p.notes || '', p.receivedBy || ''],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            // Met à jour le statut de la facture automatiquement
            recalcInvoiceStatus(db, p.invoiceId, () => {
                res.json({ id, message: 'Paiement enregistré' });
            });
        }
    );
});

// PUT /api/payments/:id — modifier un paiement
app.put('/api/payments/:id', (req, res) => {
    const entId = getEnterpriseId(req);
    const plat = isPlatformAdmin(req);
    const p = req.body;
    db.get('SELECT * FROM payments WHERE id = ?', [req.params.id], (err, existing) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!existing) return res.status(404).json({ error: 'Paiement introuvable' });
        if (!plat && existing.enterpriseId !== entId) return res.status(403).json({ error: 'Accès non autorisé' });
        const oldInvoiceId = existing.invoiceId;
        db.run(`UPDATE payments SET date = ?, amount = ?, currency = ?, method = ?, reference = ?, notes = ?, receivedBy = ?, invoiceId = ?
            WHERE id = ?`,
            [p.date || existing.date, p.amount || existing.amount, p.currency || existing.currency,
             p.method || existing.method, p.reference ?? existing.reference, p.notes ?? existing.notes,
             p.receivedBy ?? existing.receivedBy, p.invoiceId || existing.invoiceId, req.params.id],
            function(err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                // Recalculer l'ancienne et la nouvelle facture si changée
                recalcInvoiceStatus(db, p.invoiceId || oldInvoiceId, () => {
                    if (oldInvoiceId !== (p.invoiceId || oldInvoiceId)) {
                        recalcInvoiceStatus(db, oldInvoiceId, () => res.json({ message: 'Paiement modifié' }));
                    } else {
                        res.json({ message: 'Paiement modifié' });
                    }
                });
            }
        );
    });
});

// DELETE /api/payments/:id — supprimer un paiement
app.delete('/api/payments/:id', (req, res) => {
    const entId = getEnterpriseId(req);
    const plat = isPlatformAdmin(req);
    db.get('SELECT * FROM payments WHERE id = ?', [req.params.id], (err, existing) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!existing) return res.status(404).json({ error: 'Paiement introuvable' });
        if (!plat && existing.enterpriseId !== entId) return res.status(403).json({ error: 'Accès non autorisé' });
        db.run('DELETE FROM payments WHERE id = ?', [req.params.id], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            recalcInvoiceStatus(db, existing.invoiceId, () => {
                res.json({ message: 'Paiement supprimé' });
            });
        });
    });
});

// Clôture mensuelle par foreuse (arrêt facturation / lien facture)
app.get('/api/drill-month-billing', (req, res) => {
    const enterpriseId = getEnterpriseId(req);
    if (enterpriseId == null) {
        return res.status(400).json({ error: 'Contexte entreprise requis pour la clôture mensuelle' });
    }
    const ym = req.query.yearMonth;
    let sql = 'SELECT * FROM drill_month_billing WHERE enterpriseId = ?';
    const params = [enterpriseId];
    if (ym !== undefined && ym !== null && ym !== '') {
        sql += ' AND yearMonth = ?';
        params.push(String(ym).slice(0, 7));
    }
    sql += ' ORDER BY yearMonth DESC, drillId';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.post('/api/drill-month-billing', (req, res) => {
    const enterpriseId = getEnterpriseId(req);
    if (enterpriseId == null) {
        return res.status(400).json({ error: 'Contexte entreprise requis' });
    }
    const { drillId, yearMonth, status, invoiceId } = req.body || {};
    const did = drillId != null ? String(drillId).trim() : '';
    const ym = yearMonth != null ? String(yearMonth).slice(0, 7) : '';
    if (!did || !/^\d{4}-\d{2}$/.test(ym)) {
        return res.status(400).json({ error: 'drillId et yearMonth (YYYY-MM) requis' });
    }
    const st = status && String(status).trim() ? String(status).trim() : 'closed_arret';
    const inv = invoiceId != null && invoiceId !== '' ? String(invoiceId) : null;
    db.run(
        `INSERT INTO drill_month_billing (enterpriseId, drillId, yearMonth, status, invoiceId) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(enterpriseId, drillId, yearMonth) DO UPDATE SET status = excluded.status, invoiceId = excluded.invoiceId`,
        [enterpriseId, did, ym, st, inv],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Clôture enregistrée' });
        }
    );
});

app.delete('/api/drill-month-billing/:drillId/:yearMonth', (req, res) => {
    const enterpriseId = getEnterpriseId(req);
    if (enterpriseId == null) {
        return res.status(400).json({ error: 'Contexte entreprise requis' });
    }
    const did = req.params.drillId != null ? String(req.params.drillId) : '';
    const ym = req.params.yearMonth != null ? String(req.params.yearMonth).slice(0, 7) : '';
    db.run(
        'DELETE FROM drill_month_billing WHERE enterpriseId = ? AND drillId = ? AND yearMonth = ?',
        [enterpriseId, did, ym],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Clôture supprimée', changes: this.changes });
        }
    );
});

// ============================================
// ROUTES API - INVENTORY
// ============================================
app.get('/api/inventory', (req, res) => {
    const enterpriseId = getEnterpriseId(req);
    let query = 'SELECT * FROM inventory';
    const params = [];
    if (enterpriseId !== null) {
        query += ' WHERE enterpriseId = ?';
        params.push(enterpriseId);
    }
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.post('/api/inventory', (req, res) => {
    const item = req.body;
    const entId = resolveCreateEnterpriseId(req, item);
    db.run(
        `INSERT INTO inventory (id, enterpriseId, name, category, quantity, minStock, unit, price, alert, averagePrice)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            item.id, entId, item.name, item.category, item.quantity, item.minStock, item.unit,
            item.price, item.alert ? 1 : 0, item.averagePrice || item.price
        ],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: item.id, message: 'Article créé' });
        }
    );
});

app.put('/api/inventory/:id', (req, res) => {
    const { id } = req.params;
    const entId = getEnterpriseId(req);
    const item = req.body;
    let sql = `UPDATE inventory SET name = ?, category = ?, quantity = ?, minStock = ?, unit = ?,
         price = ?, alert = ?, averagePrice = ? WHERE id = ?`;
    const vals = [
        item.name, item.category, item.quantity, item.minStock, item.unit,
        item.price, item.alert ? 1 : 0, item.averagePrice || item.price, id
    ];
    if (entId !== null) {
        sql += ' AND enterpriseId = ?';
        vals.push(entId);
    }
    db.run(sql, vals, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Article introuvable ou accès refusé' });
        res.json({ message: 'Article mis à jour', changes: this.changes });
    });
});

// ============================================
// TAUX USD → XOF (cours mid-market affiché sur xe.com — page convertisseur publique)
// Pas d’API XE gratuite : lecture HTML locale, cache court pour limiter la charge.
// ============================================
const xeUsdXofCache = { rate: null, fetchedAt: 0 };
const XE_USD_XOF_CACHE_MS = 15 * 60 * 1000;

function httpsGetTextFollow(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(
            url,
            {
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    Accept: 'text/html,application/xhtml+xml',
                    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br'
                }
            },
            (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    let loc = res.headers.location;
                    if (!/^https?:/i.test(loc)) {
                        try {
                            loc = new URL(loc, url).href;
                        } catch (e) {
                            return reject(new Error('Redirection invalide'));
                        }
                    }
                    res.resume();
                    return resolve(httpsGetTextFollow(loc));
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error('HTTP ' + res.statusCode));
                }
                let stream = res;
                const enc = (res.headers['content-encoding'] || '').toLowerCase();
                if (enc.includes('gzip')) {
                    stream = res.pipe(zlib.createGunzip());
                } else if (enc.includes('deflate')) {
                    stream = res.pipe(zlib.createInflate());
                } else if (enc.includes('br')) {
                    stream = res.pipe(zlib.createBrotliDecompress());
                }
                const chunks = [];
                stream.on('data', (c) => chunks.push(c));
                stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                stream.on('error', reject);
            }
        );
        req.setTimeout(25000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
        req.on('error', reject);
    });
}

function parseUsdXofFromXeHtml(html) {
    if (!html || typeof html !== 'string') return null;
    const patterns = [
        /1(?:\.0+)?\s+USD\s*=\s*([\d.,]+)\s+XOF/i,
        /=\s*([\d.,]+)\s+XOF[^<]{0,80}Mid-market/i,
        /\$\s*1\.00[^=]*=\s*([\d.,]+)\s*XOF/i
    ];
    for (let i = 0; i < patterns.length; i++) {
        const m = html.match(patterns[i]);
        if (m && m[1]) {
            const n = parseFloat(String(m[1]).replace(/,/g, ''));
            if (!Number.isNaN(n) && n > 50 && n < 5000) return n;
        }
    }
    return null;
}

app.get('/api/fx/usd-xof', (req, res) => {
    const bypassCache = req.query && (req.query.refresh === '1' || req.query.refresh === 'true');
    const now = Date.now();
    if (
        !bypassCache &&
        xeUsdXofCache.rate &&
        now - xeUsdXofCache.fetchedAt < XE_USD_XOF_CACHE_MS
    ) {
        return res.json({
            rate: xeUsdXofCache.rate,
            source: 'xe.com',
            midMarket: true,
            cached: true,
            fetchedAt: xeUsdXofCache.fetchedAt
        });
    }
    const xeUrl =
        'https://www.xe.com/currencyconverter/convert/?Amount=1&From=USD&To=XOF';
    httpsGetTextFollow(xeUrl)
        .then((html) => {
            const rate = parseUsdXofFromXeHtml(html);
            if (rate == null) {
                if (xeUsdXofCache.rate) {
                    return res.json({
                        rate: xeUsdXofCache.rate,
                        source: 'xe.com',
                        midMarket: true,
                        cached: true,
                        stale: true,
                        warning: 'Analyse xe.com impossible, dernier taux en cache'
                    });
                }
                return res.status(502).json({
                    error: 'Impossible de lire le cours USD/XOF sur xe.com (format de page modifié).'
                });
            }
            xeUsdXofCache.rate = rate;
            xeUsdXofCache.fetchedAt = Date.now();
            return res.json({
                rate,
                source: 'xe.com',
                midMarket: true,
                cached: false,
                fetchedAt: xeUsdXofCache.fetchedAt,
                note: 'Cours mid-market indicatif affiché sur le convertisseur public xe.com'
            });
        })
        .catch((err) => {
            if (xeUsdXofCache.rate) {
                return res.json({
                    rate: xeUsdXofCache.rate,
                    source: 'xe.com',
                    midMarket: true,
                    cached: true,
                    stale: true,
                    warning: String(err.message || err)
                });
            }
            return res.status(502).json({
                error: 'Impossible de joindre xe.com pour le taux USD/XOF.',
                detail: String(err.message || err)
            });
        });
});

// ============================================
// ROUTES API - DAILY DATA RECORDS
// ============================================
app.get('/api/daily-data', (req, res) => {
    const { date, machineId } = req.query;
    const entId = getEnterpriseId(req);
    let query = 'SELECT * FROM dailyDataRecords WHERE 1=1';
    const params = [];
    if (entId !== null) {
        query += ' AND machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)';
        params.push(entId);
    }
    if (date) {
        query += ' AND date = ?';
        params.push(date);
    }
    if (machineId) {
        query += ' AND machineId = ?';
        params.push(machineId);
    }
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows.map(row => {
            var data = JSON.parse(row.data || '{}');
            if (row.shift !== undefined && data.shift === undefined) data.shift = row.shift;
            return { ...row, workflowStatus: normalizeDailyWorkflowStatus(row.workflowStatus), data: data };
        }));
    });
});

// Présence collaborative sur une saisie journalière (en mémoire, éphémère).
// Permet d'afficher « X est aussi sur cette saisie » pendant l'édition partagée.
const dailyPresence = new Map(); // recordId (String) -> Map(username -> { name, at })
app.post('/api/daily-data/:id/presence', (req, res) => {
    const id = String(req.params.id);
    const user = String((req.auth && req.auth.username) || '').toLowerCase();
    const name = (req.body && req.body.name) || (req.auth && req.auth.username) || 'Utilisateur';
    if (!user) return res.json({ others: [] });
    let m = dailyPresence.get(id);
    if (!m) { m = new Map(); dailyPresence.set(id, m); }
    if (req.body && req.body.leaving) { m.delete(user); }
    else { m.set(user, { name: name, at: Date.now() }); }
    const now = Date.now();
    const others = [];
    for (const [u, v] of Array.from(m.entries())) {
        if (now - v.at > 20000) { m.delete(u); continue; } // expire après 20 s sans battement
        if (u !== user) others.push(v.name);
    }
    if (m.size === 0) dailyPresence.delete(id);
    res.json({ others: others });
});

app.post('/api/daily-data', (req, res) => {
    const record = req.body || {};
    const shift = (record.data && record.data.shift) || '';
    const entId = getEnterpriseId(req);
    if (!record.date || !record.machineId) {
        return res.status(400).json({ error: 'date et machineId requis' });
    }
    if (!dailyDataCanEnterFromAuth(req.auth)) {
        return res.status(403).json({ error: 'Saisie réservée aux ingénieurs (et à la direction). Le tableau de bord reste consultable par tous.' });
    }
    const parsedDate = typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.date)
        ? new Date(record.date + 'T00:00:00Z') : null;
    if (!parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== record.date) {
        return res.status(400).json({ error: 'Date de saisie invalide (AAAA-MM-JJ attendu).' });
    }
    const valuesError = validateDailyDataValues(record.data == null ? {} : record.data);
    if (valuesError) return res.status(400).json({ error: valuesError });
    // Les anciens clients peuvent toujours enregistrer un poste sans marqueur. Le nouveau
    // bouton « Terminer » annonce explicitement une saisie complète, à contrôler dès l'enregistrement.
    if (record.data && record.data.entryStage === 'complete') {
        const completionError = validateDailyDataForSubmission({ ...record, shift });
        if (completionError) return res.status(400).json({ error: completionError });
    }
    assertDrillBelongsToTenant(db, record.machineId, entId, (aerr, ok) => {
        if (aerr) return res.status(500).json({ error: aerr.message });
        if (!ok) return res.status(403).json({ error: 'Machine invalide pour cette entreprise' });
        const persistRecord = () => getDailyDataActorFromRequest(req, (actorErr, actor) => {
            if (actorErr) return res.status(500).json({ error: actorErr.message });
            const elevated = dailyDataElevatedRoleFromAuth(req.auth);
            const actorUsername = String(actor.username || '').trim();
            const actorName = String(actor.name || actorUsername || '').trim() || actorUsername;
            const nowIso = new Date().toISOString();
            // Un ID sert à reprendre une saisie ; il permet aussi de déplacer la date ou le shift.
            const findExisting = (cb) => {
                if (record.id != null) {
                    let byIdSql = 'SELECT * FROM dailyDataRecords WHERE id = ? AND machineId = ?';
                    const byIdParams = [record.id, record.machineId];
                    if (entId !== null) {
                        byIdSql += ' AND machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)';
                        byIdParams.push(entId);
                    }
                    db.get(byIdSql, byIdParams, (err, row) => {
                        if (err) return cb(err);
                        if (row) return cb(null, row);
                        // Fallback : chercher par date+machine+shift
                        db.get('SELECT * FROM dailyDataRecords WHERE date = ? AND machineId = ? AND COALESCE(shift, \'\') = ?',
                            [record.date, record.machineId, shift], cb);
                    });
                } else {
                    db.get('SELECT * FROM dailyDataRecords WHERE date = ? AND machineId = ? AND COALESCE(shift, \'\') = ?',
                        [record.date, record.machineId, shift], cb);
                }
            };
            findExisting((err, existingRow) => {
                if (err) return res.status(500).json({ error: err.message });
                if (existingRow) {
                    // Vérifier qu'il n'y a pas déjà un autre record à la date+machine+shift cible
                    const dateOrShiftMoved = String(existingRow.date) !== record.date || String(existingRow.shift || '') !== shift;
                    const doUpdate = () => {
                    const workflowStatus = normalizeDailyWorkflowStatus(existingRow.workflowStatus);
                    if (workflowStatus === 'submitted' || workflowStatus === 'approved') {
                        return res.status(409).json({
                            error: workflowStatus === 'approved'
                                ? 'Poste approuvé : rouvrez-le avant toute correction.'
                                : 'Poste soumis : rejetez ou rouvrez-le avant toute correction.'
                        });
                    }
                    const traced = !!(existingRow.enteredByUsername && String(existingRow.enteredByUsername).trim());
                    const ownsRecord = actorUsername && actorUsername.toLowerCase() === String(existingRow.enteredByUsername || '').trim().toLowerCase();
                    if (traced && !elevated && !ownsRecord) {
                        return res.status(403).json({
                            error: 'Cette saisie appartient à un autre opérateur. Seuls superviseur, gestionnaire, ingénieur ou admin peuvent la modifier.'
                        });
                    }
                    let entUser = existingRow.enteredByUsername != null ? String(existingRow.enteredByUsername).trim() : '';
                    let entName = existingRow.enteredByName != null ? String(existingRow.enteredByName).trim() : '';
                    let entAt = existingRow.enteredAt || null;
                    if (!entUser) {
                        entUser = actorUsername;
                        entName = actorName || actorUsername;
                        entAt = nowIso;
                    }
                    let upd = "UPDATE dailyDataRecords SET date = ?, shift = ?, data = ?, notes = ?, enteredByUsername = ?, enteredByName = ?, enteredAt = ?, lastModifiedByUsername = ?, lastModifiedByName = ?, lastModifiedAt = ?, workflowVersion = COALESCE(workflowVersion, 0) + 1 WHERE id = ? AND COALESCE(workflowStatus, 'draft') IN ('draft', 'rejected')";
                    const uvals = [
                        record.date,
                        shift,
                        JSON.stringify(record.data || {}),
                        record.notes || '',
                        entUser,
                        entName || entUser,
                        entAt,
                        actorUsername,
                        actorName,
                        nowIso,
                        existingRow.id
                    ];
                    if (entId !== null) {
                        upd += ' AND machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)';
                        uvals.push(entId);
                    }
                    db.run(upd, uvals, function(updateErr) {
                        if (updateErr) return res.status(500).json({ error: updateErr.message });
                        if (this.changes === 0) return res.status(409).json({ error: 'Le statut du poste a changé. Rechargez les données.' });
                        res.json({ id: existingRow.id, message: 'Données mises à jour' });
                    });
                    }; // fin doUpdate
                    if (dateOrShiftMoved) {
                        db.get('SELECT id FROM dailyDataRecords WHERE date = ? AND machineId = ? AND COALESCE(shift, \'\') = ? AND id != ?',
                            [record.date, record.machineId, shift, existingRow.id], (conflictErr, conflictRow) => {
                                if (conflictErr) return res.status(500).json({ error: conflictErr.message });
                                if (conflictRow) return res.status(409).json({ error: 'Un enregistrement existe déjà pour cette machine à cette date et ce shift.' });
                                doUpdate();
                            });
                    } else {
                        doUpdate();
                    }
                } else {
                    db.run(
                        'INSERT INTO dailyDataRecords (date, machineId, shift, data, notes, enteredByUsername, enteredByName, enteredAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            record.date,
                            record.machineId,
                            shift,
                            JSON.stringify(record.data || {}),
                            record.notes || '',
                            actorUsername,
                            actorName || actorUsername,
                            nowIso
                        ],
                        function(insertErr) {
                            if (insertErr) return res.status(500).json({ error: insertErr.message });
                            res.json({ id: this.lastID, message: 'Données créées' });
                        }
                    );
                }
            });
        });
        if (record.data && record.data.entryStage === 'complete') {
            return validateDailyHoleReferences(req, record, (referenceError, referenceMessage) => {
                if (referenceError) return res.status(500).json({ error: referenceError.message });
                if (referenceMessage) return res.status(400).json({ error: referenceMessage });
                return persistRecord();
            });
        }
        return persistRecord();
    });
});

function getDailyWorkflowRecord(req, recordId, cb) {
    const entId = getEnterpriseId(req);
    let sql = `SELECT ddr.* FROM dailyDataRecords ddr
               JOIN drills d ON d.id = ddr.machineId
               WHERE ddr.id = ?`;
    const params = [recordId];
    if (entId !== null) {
        sql += ' AND d.enterpriseId = ?';
        params.push(entId);
    }
    db.get(sql, params, cb);
}

function sendDailyWorkflowRecord(res, recordId) {
    db.get('SELECT * FROM dailyDataRecords WHERE id = ?', [recordId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Saisie journalière introuvable' });
        try { row.data = JSON.parse(row.data || '{}'); } catch (_) { row.data = {}; }
        row.workflowStatus = normalizeDailyWorkflowStatus(row.workflowStatus);
        return res.json(row);
    });
}

app.post('/api/daily-data/:id/submit', (req, res) => {
    const recordId = parseInt(req.params.id, 10);
    if (!Number.isFinite(recordId)) return res.status(400).json({ error: 'Identifiant invalide' });
    getDailyWorkflowRecord(req, recordId, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Saisie journalière introuvable' });
        const status = normalizeDailyWorkflowStatus(row.workflowStatus);
        if (!['draft', 'rejected'].includes(status)) {
            return res.status(409).json({ error: 'Seul un brouillon ou un poste rejeté peut être soumis.' });
        }
        const actorFromToken = String(req.auth.username || '').trim();
        const ownsRecord = actorFromToken && actorFromToken.toLowerCase() === String(row.enteredByUsername || '').trim().toLowerCase();
        if (!ownsRecord && !dailyDataElevatedRoleFromAuth(req.auth)) {
            return res.status(403).json({ error: 'Seul l’auteur du poste ou un superviseur peut le soumettre.' });
        }
        const validationError = validateDailyDataForSubmission(row);
        if (validationError) return res.status(400).json({ error: validationError });
        validateDailyHoleReferences(req, row, (referenceError, referenceMessage) => {
            if (referenceError) return res.status(500).json({ error: referenceError.message });
            if (referenceMessage) return res.status(400).json({ error: referenceMessage });
            getDailyDataActorFromRequest(req, (actorError, actor) => {
                if (actorError) return res.status(500).json({ error: actorError.message });
                const now = new Date().toISOString();
                db.run(
                    `UPDATE dailyDataRecords SET workflowStatus = 'submitted', submittedByUsername = ?, submittedAt = ?,
                     reviewedByUsername = '', reviewedByName = '', reviewedAt = NULL, reviewComment = '',
                     workflowVersion = COALESCE(workflowVersion, 0) + 1
                     WHERE id = ? AND COALESCE(workflowStatus, 'draft') IN ('draft', 'rejected')
                     AND COALESCE(workflowVersion, 0) = ?`,
                    [actor.username || actorFromToken, now, recordId, Number(row.workflowVersion || 0)],
                    function submitRecord(updateError) {
                        if (updateError) return res.status(500).json({ error: updateError.message });
                        if (this.changes === 0) return res.status(409).json({ error: 'Le statut du poste a changé. Rechargez les données.' });
                        return sendDailyWorkflowRecord(res, recordId);
                    }
                );
            });
        });
    });
});

app.post('/api/daily-data/:id/approve', (req, res) => {
    if (!dailyDataElevatedRoleFromAuth(req.auth)) {
        return res.status(403).json({ error: 'Validation réservée au superviseur, gestionnaire, ingénieur ou administrateur.' });
    }
    const recordId = parseInt(req.params.id, 10);
    if (!Number.isFinite(recordId)) return res.status(400).json({ error: 'Identifiant invalide' });
    getDailyWorkflowRecord(req, recordId, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Saisie journalière introuvable' });
        if (normalizeDailyWorkflowStatus(row.workflowStatus) !== 'submitted') {
            return res.status(409).json({ error: 'Seul un poste soumis peut être approuvé.' });
        }
        const validationError = validateDailyDataForSubmission(row);
        if (validationError) return res.status(400).json({ error: validationError });
        getDailyDataActorFromRequest(req, (actorError, actor) => {
            if (actorError) return res.status(500).json({ error: actorError.message });
            const comment = req.body && req.body.comment != null ? String(req.body.comment).trim().slice(0, 2000) : '';
            db.run(
                `UPDATE dailyDataRecords SET workflowStatus = 'approved', reviewedByUsername = ?, reviewedByName = ?,
                 reviewedAt = ?, reviewComment = ?, workflowVersion = COALESCE(workflowVersion, 0) + 1
                 WHERE id = ? AND workflowStatus = 'submitted'`,
                [actor.username, actor.name, new Date().toISOString(), comment, recordId],
                function approveRecord(updateError) {
                    if (updateError) return res.status(500).json({ error: updateError.message });
                    if (this.changes === 0) return res.status(409).json({ error: 'Le statut du poste a changé. Rechargez les données.' });
                    applyApprovedDailyHoleProgress(req, row, actor.username, (progressError) => {
                        if (progressError) return res.status(500).json({ error: progressError.message });
                        return sendDailyWorkflowRecord(res, recordId);
                    });
                }
            );
        });
    });
});

app.post('/api/daily-data/:id/reject', (req, res) => {
    if (!dailyDataElevatedRoleFromAuth(req.auth)) {
        return res.status(403).json({ error: 'Rejet réservé au superviseur, gestionnaire, ingénieur ou administrateur.' });
    }
    const recordId = parseInt(req.params.id, 10);
    const comment = req.body && req.body.comment != null ? String(req.body.comment).trim().slice(0, 2000) : '';
    if (!Number.isFinite(recordId)) return res.status(400).json({ error: 'Identifiant invalide' });
    if (!comment) return res.status(400).json({ error: 'Indiquez le motif du rejet.' });
    getDailyWorkflowRecord(req, recordId, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Saisie journalière introuvable' });
        if (normalizeDailyWorkflowStatus(row.workflowStatus) !== 'submitted') {
            return res.status(409).json({ error: 'Seul un poste soumis peut être rejeté.' });
        }
        getDailyDataActorFromRequest(req, (actorError, actor) => {
            if (actorError) return res.status(500).json({ error: actorError.message });
            db.run(
                `UPDATE dailyDataRecords SET workflowStatus = 'rejected', reviewedByUsername = ?, reviewedByName = ?,
                 reviewedAt = ?, reviewComment = ?, workflowVersion = COALESCE(workflowVersion, 0) + 1
                 WHERE id = ? AND workflowStatus = 'submitted'`,
                [actor.username, actor.name, new Date().toISOString(), comment, recordId],
                function rejectRecord(updateError) {
                    if (updateError) return res.status(500).json({ error: updateError.message });
                    if (this.changes === 0) return res.status(409).json({ error: 'Le statut du poste a changé. Rechargez les données.' });
                    return sendDailyWorkflowRecord(res, recordId);
                }
            );
        });
    });
});

app.post('/api/daily-data/:id/reopen', (req, res) => {
    if (!dailyDataElevatedRoleFromAuth(req.auth)) {
        return res.status(403).json({ error: 'Réouverture réservée au superviseur, gestionnaire, ingénieur ou administrateur.' });
    }
    const recordId = parseInt(req.params.id, 10);
    if (!Number.isFinite(recordId)) return res.status(400).json({ error: 'Identifiant invalide' });
    getDailyWorkflowRecord(req, recordId, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Saisie journalière introuvable' });
        const status = normalizeDailyWorkflowStatus(row.workflowStatus);
        if (status === 'draft') return sendDailyWorkflowRecord(res, recordId);
        getDailyDataActorFromRequest(req, (actorError, actor) => {
            if (actorError) return res.status(500).json({ error: actorError.message });
            const comment = req.body && req.body.comment != null
                ? String(req.body.comment).trim().slice(0, 2000)
                : 'Poste rouvert pour correction';
            db.run(
                `UPDATE dailyDataRecords SET workflowStatus = 'draft', reviewedByUsername = ?, reviewedByName = ?,
                 reviewedAt = ?, reviewComment = ?, workflowVersion = COALESCE(workflowVersion, 0) + 1
                 WHERE id = ?`,
                [actor.username, actor.name, new Date().toISOString(), comment, recordId],
                function reopenRecord(updateError) {
                    if (updateError) return res.status(500).json({ error: updateError.message });
                    return sendDailyWorkflowRecord(res, recordId);
                }
            );
        });
    });
});

app.delete('/api/daily-data', (req, res) => {
    if (!dailyDataElevatedRoleFromAuth(req.auth)) {
        return res.status(403).json({ error: 'Droits insuffisants pour supprimer des saisies journalières (superviseur, gestionnaire, ingénieur ou admin).' });
    }
    const entId = getEnterpriseId(req);
    let { date, dateFrom, dateTo, machineId, shift } = req.query;
    if (date && !dateFrom) dateFrom = date;
    if (date && !dateTo) dateTo = date;
    if (!dateFrom || !dateTo) {
        return res.status(400).json({ error: 'Indiquez date ou dateFrom et dateTo (AAAA-MM-JJ).' });
    }
    const machineIdStr = machineId != null && String(machineId).trim() !== '' ? String(machineId).trim() : '';
    const runDelete = () => {
        let sql = "DELETE FROM dailyDataRecords WHERE date >= ? AND date <= ? AND COALESCE(workflowStatus, 'draft') <> 'approved'";
        const params = [dateFrom, dateTo];
        if (entId !== null) {
            sql += ' AND machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)';
            params.push(entId);
        }
        if (machineIdStr) {
            sql += ' AND machineId = ?';
            params.push(machineIdStr);
        }
        if (Object.prototype.hasOwnProperty.call(req.query, 'shift')) {
            sql += ' AND COALESCE(shift, \'\') = ?';
            params.push(shift == null ? '' : String(shift));
        }
        db.run(sql, params, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ deleted: this.changes, message: 'Saisies non approuvées supprimées. Les postes approuvés sont conservés pour la traçabilité.' });
        });
    };
    if (machineIdStr) {
        assertDrillBelongsToTenant(db, machineIdStr, entId, (aerr, ok) => {
            if (aerr) return res.status(500).json({ error: aerr.message });
            if (!ok) return res.status(403).json({ error: 'Machine invalide pour cette entreprise' });
            runDelete();
        });
    } else {
        runDelete();
    }
});

// ============================================
// ROUTES API - COMPANY INFO
// ============================================
app.get('/api/company', (req, res) => {
    const enterpriseId = getEnterpriseId(req);
    let query = 'SELECT * FROM companyInfo';
    const params = [];
    if (enterpriseId !== null) {
        query += ' WHERE enterpriseId = ?';
        params.push(enterpriseId);
    }
    query += ' LIMIT 1';
    db.get(query, params, (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(row || {});
    });
});

app.post('/api/company', (req, res) => {
    const company = req.body;
    const entId = resolveCreateEnterpriseId(req, company);
    
    db.get('SELECT id, fosses FROM companyInfo WHERE enterpriseId = ? LIMIT 1', [entId], (err, existing) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        // Préserver les fosses existantes si la sauvegarde ne les fournit pas
        // (évite qu'un enregistrement partiel de la fiche entreprise efface les fosses).
        const fossesToStore = Array.isArray(company.fosses)
            ? JSON.stringify(company.fosses)
            : (existing && existing.fosses != null ? existing.fosses : '[]');

        if (existing) {
            db.run(
                `UPDATE companyInfo SET name = ?, legalName = ?, address = ?, city = ?, country = ?,
                 postalCode = ?, taxId = ?, siret = ?, ifu = ?, rccm = ?, phone = ?, email = ?, website = ?,
                 bankName = ?, iban = ?, bic = ?, vatNumber = ?, tvaRate = ?, retenueSourceRate = ?, currency = ?,
                 signatoryFirstName = ?, signatoryLastName = ?, signatoryTitle = ?, fosses = ? WHERE enterpriseId = ?`,
                [
                    company.name, company.legalName, company.address, company.city, company.country,
                    company.postalCode, company.taxId, company.siret, company.ifu || '', company.rccm || '',
                    company.phone, company.email, company.website, company.bankName, company.iban, company.bic,
                    company.vatNumber, company.tvaRate != null ? company.tvaRate : 18, company.retenueSourceRate != null ? company.retenueSourceRate : 5,
                    company.currency || 'XOF',
                    company.signatoryFirstName || '',
                    company.signatoryLastName || '',
                    company.signatoryTitle || '',
                    fossesToStore,
                    entId
                ],
                function(updateErr) {
                    if (updateErr) return res.status(500).json({ error: updateErr.message });
                    res.json({ message: 'Informations entreprise mises à jour' });
                }
            );
        } else {
            db.run(
                `INSERT INTO companyInfo (enterpriseId, name, legalName, address, city, country, postalCode, taxId,
                 siret, ifu, rccm, phone, email, website, bankName, iban, bic, vatNumber, tvaRate, retenueSourceRate, currency,
                 signatoryFirstName, signatoryLastName, signatoryTitle, fosses)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    entId, company.name, company.legalName, company.address, company.city, company.country,
                    company.postalCode, company.taxId, company.siret, company.ifu || '', company.rccm || '',
                    company.phone, company.email, company.website, company.bankName, company.iban, company.bic,
                    company.vatNumber, company.tvaRate != null ? company.tvaRate : 18, company.retenueSourceRate != null ? company.retenueSourceRate : 5,
                    company.currency || 'XOF',
                    company.signatoryFirstName || '',
                    company.signatoryLastName || '',
                    company.signatoryTitle || '',
                    fossesToStore
                ],
                function(insertErr) {
                    if (insertErr) return res.status(500).json({ error: insertErr.message });
                    res.json({ message: 'Informations entreprise créées' });
                }
            );
        }
    });
});

app.post('/api/company/logo', (req, res) => {
    const { logo } = req.body;
    const entId = getEnterpriseId(req) || 1;
    db.run(
        'UPDATE companyInfo SET logo = ? WHERE enterpriseId = ?',
        [logo || '', entId],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ message: 'Logo mis à jour' });
        }
    );
});

// ============================================
// ROUTES API - CONSOMMABLES JOURNALIERS (alignés avec production)
// ============================================
app.get('/api/daily-consumables', (req, res) => {
    const entId = getEnterpriseId(req);
    let { date, dateFrom, dateTo, machineId, shift } = req.query;
    if (date && !dateFrom) dateFrom = date;
    if (date && !dateTo) dateTo = date;
    if (!dateFrom || !dateTo) {
        return res.status(400).json({ error: 'Indiquez date ou dateFrom et dateTo (AAAA-MM-JJ).' });
    }
    let sql = `
        SELECT dc.*, i.name as consumableName, i.category, i.unit, ddr.data as productionData
        FROM dailyConsumables dc
        JOIN inventory i ON dc.consumableId = i.id
        LEFT JOIN dailyDataRecords ddr ON dc.date = ddr.date AND dc.machineId = ddr.machineId AND COALESCE(dc.shift, '') = COALESCE(ddr.shift, '')
        WHERE dc.date >= ? AND dc.date <= ?
    `;
    const params = [dateFrom, dateTo];
    if (entId !== null) {
        sql += ' AND i.enterpriseId = ?';
        params.push(entId);
    }
    if (machineId) {
        sql += ' AND dc.machineId = ?';
        params.push(machineId);
    }
    if (Object.prototype.hasOwnProperty.call(req.query, 'shift')) {
        sql += ' AND COALESCE(dc.shift, \'\') = ?';
        params.push(shift == null ? '' : String(shift));
    }
    sql += ' ORDER BY dc.date DESC, dc.machineId, dc.consumableId';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/daily-consumables', (req, res) => {
    const { date, machineId, shift, consumableId, quantityUsed, unitPrice, currency, notes } = req.body;
    if (!date || !machineId || !consumableId || quantityUsed == null) {
        return res.status(400).json({ error: 'Champs requis: date, machineId, consumableId, quantityUsed' });
    }
    const entId = getEnterpriseId(req);
    const totalCost = (quantityUsed * (unitPrice || 0));
    const auth = req.auth;
    db.run(
        `INSERT OR REPLACE INTO dailyConsumables (date, machineId, shift, consumableId, quantityUsed, unitPrice, totalCost, currency, notes, enteredByUsername, enteredByName)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            date, machineId, shift || '', consumableId, quantityUsed, unitPrice || 0, totalCost, currency || 'XOF', notes || '',
            auth ? auth.username : '', auth ? auth.name : ''
        ],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, message: 'Consommable journalier enregistré' });
        }
    );
});

app.get('/api/consumables-cost-summary', (req, res) => {
    const entId = getEnterpriseId(req);
    let { dateFrom, dateTo, machineId } = req.query;
    if (!dateFrom || !dateTo) {
        return res.status(400).json({ error: 'Indiquez dateFrom et dateTo (AAAA-MM-JJ).' });
    }
    let sql = `
        SELECT dc.machineId, dc.date, SUM(dc.totalCost) as totalCost, dc.currency,
               JSON_GROUP_ARRAY(JSON_OBJECT('consumableName', i.name, 'category', i.category, 'quantityUsed', dc.quantityUsed, 'unitPrice', dc.unitPrice, 'totalCost', dc.totalCost)) as consumables,
               ddr.data as productionData
        FROM dailyConsumables dc
        JOIN inventory i ON dc.consumableId = i.id
        LEFT JOIN dailyDataRecords ddr ON dc.date = ddr.date AND dc.machineId = ddr.machineId
        WHERE dc.date >= ? AND dc.date <= ?
    `;
    const params = [dateFrom, dateTo];
    if (entId !== null) {
        sql += ' AND i.enterpriseId = ?';
        params.push(entId);
    }
    if (machineId) {
        sql += ' AND dc.machineId = ?';
        params.push(machineId);
    }
    sql += ' GROUP BY dc.machineId, dc.date ORDER BY dc.date DESC, dc.machineId';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // Calculer production (mètres forés) depuis ddr.data
        rows.forEach(row => {
            let production = 0;
            if (row.productionData) {
                try {
                    const data = JSON.parse(row.productionData);
                    production = data.metersDrilled || data.depth || 0;
                } catch (e) {}
            }
            row.production = production;
            row.costPerMeter = production > 0 ? row.totalCost / production : 0;
        });
        res.json(rows);
    });
});

// ── Phase 5 — Maintenance ──────────────────────────────────────────────────

function _calcNextMaintenanceDate(lastDate, intervalType, intervalValue) {
    if (!lastDate) return null;
    const d = new Date(lastDate);
    const v = Number(intervalValue) || 0;
    if (intervalType === 'days') d.setDate(d.getDate() + v);
    else if (intervalType === 'months') d.setMonth(d.getMonth() + v);
    else d.setDate(d.getDate() + Math.ceil(v / 24));
    return d.toISOString().split('T')[0];
}

app.get('/api/maintenance-schedules', (req, res) => {
    const eid = getEnterpriseId(req);
    const params = [];
    let where = '';
    if (eid !== null) {
        where = 'WHERE ms.enterpriseId = ?';
        params.push(eid);
    }
    db.all(`
        SELECT ms.*,
            CASE WHEN ms.nextMaintenanceDate < DATE('now') AND ms.status = 'scheduled'
                 THEN 'overdue' ELSE ms.status END AS status
        FROM maintenanceSchedules ms
        ${where}
        ORDER BY ms.nextMaintenanceDate ASC
    `, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/maintenance-schedules', (req, res) => {
    const eid = getEnterpriseId(req);
    const { machineId, type, description, priority, intervalType, intervalValue,
            lastMaintenanceDate, lastMaintenanceHours, assignedTo, notes } = req.body;
    if (!machineId || !description) {
        return res.status(400).json({ error: 'machineId et description sont requis' });
    }
    const nextDate = _calcNextMaintenanceDate(lastMaintenanceDate, intervalType, intervalValue);
    const nextHours = (Number(lastMaintenanceHours) || 0) + (Number(intervalValue) || 0);
    db.run(
        `INSERT INTO maintenanceSchedules
         (enterpriseId, machineId, type, description, priority, intervalType, intervalValue,
          lastMaintenanceDate, lastMaintenanceHours, nextMaintenanceDate, nextMaintenanceHours,
          status, assignedTo, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
        [eid || 1, machineId, type || 'preventive', description, priority || 'medium',
         intervalType || 'days', Number(intervalValue) || 0,
         lastMaintenanceDate || null, Number(lastMaintenanceHours) || 0,
         nextDate, nextHours, assignedTo || '', notes || ''],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, message: 'Planification créée' });
        }
    );
});

app.put('/api/maintenance-schedules/:id', (req, res) => {
    const eid = getEnterpriseId(req);
    const id = parseInt(req.params.id);
    const { machineId, type, description, priority, intervalType, intervalValue,
            lastMaintenanceDate, lastMaintenanceHours, assignedTo, notes } = req.body;
    const nextDate = _calcNextMaintenanceDate(lastMaintenanceDate, intervalType, intervalValue);
    const nextHours = (Number(lastMaintenanceHours) || 0) + (Number(intervalValue) || 0);
    const params = [machineId, type || 'preventive', description, priority || 'medium',
                    intervalType || 'days', Number(intervalValue) || 0,
                    lastMaintenanceDate || null, Number(lastMaintenanceHours) || 0,
                    nextDate, nextHours, assignedTo || '', notes || '', id];
    let sql = `UPDATE maintenanceSchedules SET machineId=?, type=?, description=?, priority=?,
               intervalType=?, intervalValue=?, lastMaintenanceDate=?, lastMaintenanceHours=?,
               nextMaintenanceDate=?, nextMaintenanceHours=?, assignedTo=?, notes=?, status='scheduled'
               WHERE id=?`;
    if (eid !== null) { sql += ' AND enterpriseId=?'; params.push(eid); }
    db.run(sql, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Non trouvé' });
        res.json({ message: 'Planification mise à jour' });
    });
});

app.delete('/api/maintenance-schedules/:id', (req, res) => {
    const eid = getEnterpriseId(req);
    const id = parseInt(req.params.id);
    const params = [id];
    let sql = 'DELETE FROM maintenanceSchedules WHERE id=?';
    if (eid !== null) { sql += ' AND enterpriseId=?'; params.push(eid); }
    db.run(sql, params, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Non trouvé' });
        res.json({ message: 'Planification supprimée' });
    });
});

app.post('/api/maintenance-schedules/:id/complete', (req, res) => {
    const eid = getEnterpriseId(req);
    const scheduleId = parseInt(req.params.id);
    const { date, duration, cost, technician, notes } = req.body;
    if (!date) return res.status(400).json({ error: 'date est requis' });
    const findSql = eid !== null
        ? 'SELECT * FROM maintenanceSchedules WHERE id=? AND enterpriseId=?'
        : 'SELECT * FROM maintenanceSchedules WHERE id=?';
    const findParams = eid !== null ? [scheduleId, eid] : [scheduleId];
    db.get(findSql, findParams, (err, schedule) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!schedule) return res.status(404).json({ error: 'Planification non trouvée' });
        const nextDate = _calcNextMaintenanceDate(date, schedule.intervalType, schedule.intervalValue);
        const nextHours = (Number(schedule.lastMaintenanceHours) || 0) + (Number(schedule.intervalValue) || 0);
        db.run(
            `INSERT INTO maintenanceHistory
             (enterpriseId, scheduleId, machineId, date, type, description, cost, duration, technician, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [eid || 1, scheduleId, schedule.machineId, date, schedule.type, schedule.description,
             Number(cost) || 0, Number(duration) || 0, technician || '', notes || ''],
            function(err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                const histId = this.lastID;
                const upSql = eid !== null
                    ? `UPDATE maintenanceSchedules SET lastMaintenanceDate=?, lastMaintenanceHours=?,
                       nextMaintenanceDate=?, nextMaintenanceHours=?, status='scheduled' WHERE id=? AND enterpriseId=?`
                    : `UPDATE maintenanceSchedules SET lastMaintenanceDate=?, lastMaintenanceHours=?,
                       nextMaintenanceDate=?, nextMaintenanceHours=?, status='scheduled' WHERE id=?`;
                const upParams = eid !== null
                    ? [date, Number(duration) || 0, nextDate, nextHours, scheduleId, eid]
                    : [date, Number(duration) || 0, nextDate, nextHours, scheduleId];
                db.run(upSql, upParams, (err3) => {
                    if (err3) return res.status(500).json({ error: err3.message });
                    res.json({ message: 'Maintenance complétée', historyId: histId, nextMaintenanceDate: nextDate });
                });
            }
        );
    });
});

app.get('/api/maintenance-history', (req, res) => {
    const eid = getEnterpriseId(req);
    const machineId = req.query.machineId;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const params = [];
    const conditions = [];
    if (eid !== null) { conditions.push('mh.enterpriseId = ?'); params.push(eid); }
    if (machineId) { conditions.push('mh.machineId = ?'); params.push(machineId); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit);
    db.all(`
        SELECT mh.* FROM maintenanceHistory mh
        ${where}
        ORDER BY mh.date DESC, mh.id DESC
        LIMIT ?
    `, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ── Dépenses diverses (miscellaneousExpenses) ─────────────────────────────

app.get('/api/misc-expenses', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.all('SELECT * FROM miscellaneousExpenses WHERE enterpriseId = ? ORDER BY date DESC, id DESC', [eid], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/misc-expenses', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    const { date, description, amount, category, notes } = req.body;
    if (!date || !description || amount == null) return res.status(400).json({ error: 'date, description et amount requis' });
    db.run(
        'INSERT INTO miscellaneousExpenses (enterpriseId, date, description, amount, category, notes) VALUES (?, ?, ?, ?, ?, ?)',
        [eid, date, description, Number(amount), category || 'Autre', notes || ''],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        }
    );
});

app.put('/api/misc-expenses/:id', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    const { date, description, amount, category, notes } = req.body;
    db.run(
        'UPDATE miscellaneousExpenses SET date=?, description=?, amount=?, category=?, notes=? WHERE id=? AND enterpriseId=?',
        [date, description, Number(amount), category || 'Autre', notes || '', req.params.id, eid],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Non trouvé' });
            res.json({ ok: true });
        }
    );
});

app.delete('/api/misc-expenses/:id', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.run('DELETE FROM miscellaneousExpenses WHERE id=? AND enterpriseId=?', [req.params.id, eid], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

// ── Dépenses repas chantier (siteMealExpenses) ────────────────────────────

app.get('/api/site-meal-expenses', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.all('SELECT * FROM siteMealExpenses WHERE enterpriseId = ? ORDER BY date DESC, id DESC', [eid], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// L'administrateur général : seul habilité à modifier/supprimer un repas déjà saisi.
function isMealGeneralAdmin(req) {
    return !!(req.auth && (req.auth.isSuperAdmin || req.auth.isPlatformOwner || req.auth.role === 'admin'));
}

// Prix par plat effectif : celui fourni, sinon le réglage de l'entreprise (invisible au saisisseur).
function resolveMealUnitPrice(eid, body, cb) {
    if (body.unitPrice != null && body.unitPrice !== '' && Number.isFinite(Number(body.unitPrice))) {
        return cb(Number(body.unitPrice));
    }
    db.get('SELECT unitPrice FROM site_meal_settings WHERE enterpriseId = ?', [eid], (err, row) => {
        cb(row && row.unitPrice != null ? Number(row.unitPrice) : null);
    });
}

function mealAmountFrom(body, unit) {
    const plates = body.plates != null && body.plates !== '' ? Number(body.plates) : null;
    if (plates != null && unit != null && Number.isFinite(plates) && Number.isFinite(unit)) {
        return Math.max(0, plates * unit);
    }
    return body.amount != null ? Number(body.amount) : 0;
}

app.post('/api/site-meal-expenses', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    const { date, siteId, drillId, mealPeriod, headcount, currency, label, notes, shift, plates } = req.body;
    if (!date) return res.status(400).json({ error: 'date requise' });
    const filledBy = (req.auth && req.auth.username) ? String(req.auth.username) : (req.body.filledBy || '');
    resolveMealUnitPrice(eid, req.body, (unit) => {
        const amount = mealAmountFrom(req.body, unit);
        db.run(
            'INSERT INTO siteMealExpenses (enterpriseId, date, siteId, drillId, mealPeriod, headcount, amount, currency, label, notes, shift, plates, unitPrice, filledBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [eid, date, siteId != null ? String(siteId) : '', drillId || '', mealPeriod || 'lunch',
             headcount != null ? Number(headcount) : null, Number(amount), currency || 'XOF', label || '', notes || '',
             shift || '', plates != null && plates !== '' ? Number(plates) : null, unit != null ? unit : null, filledBy],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: this.lastID, amount, filledBy });
            }
        );
    });
});

app.put('/api/site-meal-expenses/:id', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    // Une fois saisi, un repas ne se modifie qu'avec l'administrateur général.
    if (!isMealGeneralAdmin(req)) {
        return res.status(403).json({ error: "Modification réservée à l'administrateur général." });
    }
    const { date, siteId, drillId, mealPeriod, headcount, currency, label, notes, shift, plates } = req.body;
    resolveMealUnitPrice(eid, req.body, (unit) => {
        const amount = mealAmountFrom(req.body, unit);
        db.run(
            'UPDATE siteMealExpenses SET date=?, siteId=?, drillId=?, mealPeriod=?, headcount=?, amount=?, currency=?, label=?, notes=?, shift=?, plates=?, unitPrice=? WHERE id=? AND enterpriseId=?',
            [date, siteId != null ? String(siteId) : '', drillId || '', mealPeriod || 'lunch',
             headcount != null ? Number(headcount) : null, Number(amount), currency || 'XOF', label || '', notes || '',
             shift || '', plates != null && plates !== '' ? Number(plates) : null, unit != null ? unit : null,
             req.params.id, eid],
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                if (this.changes === 0) return res.status(404).json({ error: 'Non trouvé' });
                res.json({ ok: true, amount });
            }
        );
    });
});

// Réglage du prix par plat (par entreprise)
app.get('/api/site-meal-settings', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT unitPrice, currency FROM site_meal_settings WHERE enterpriseId = ?', [eid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { unitPrice: 0, currency: 'XOF' });
    });
});

app.put('/api/site-meal-settings', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    const unitPrice = Number(req.body.unitPrice) || 0;
    const currency = req.body.currency || 'XOF';
    db.run(
        'INSERT INTO site_meal_settings (enterpriseId, unitPrice, currency, updatedAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ' +
        'ON CONFLICT(enterpriseId) DO UPDATE SET unitPrice=excluded.unitPrice, currency=excluded.currency, updatedAt=CURRENT_TIMESTAMP',
        [eid, unitPrice, currency],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true, unitPrice, currency });
        }
    );
});

app.delete('/api/site-meal-expenses/:id', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    if (!isMealGeneralAdmin(req)) {
        return res.status(403).json({ error: "Suppression réservée à l'administrateur général." });
    }
    db.run('DELETE FROM siteMealExpenses WHERE id=? AND enterpriseId=?', [req.params.id, eid], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

// ── Mouvements de stock (stockMovements) ─────────────────────────────────

app.get('/api/stock-movements', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    const articleId = req.query.articleId;
    const params = [eid];
    let extra = '';
    if (articleId) { extra = 'AND sm.articleId = ?'; params.push(articleId); }
    db.all(
        `SELECT sm.* FROM stockMovements sm WHERE sm.enterpriseId = ? ${extra} ORDER BY sm.date DESC, sm.id DESC`,
        params,
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.post('/api/stock-movements', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    const { type, articleId, quantity, unitPrice, date, supplier, person, personId, authorizedBy, authorizedById, reason, machineId, notes } = req.body;
    if (!type || !articleId || !quantity || !date) return res.status(400).json({ error: 'type, articleId, quantity et date requis' });
    const qty = Number(quantity);
    const delta = type === 'entry' ? qty : -qty;
    db.serialize(() => {
        db.run('BEGIN');
        db.run(
            `INSERT INTO stockMovements (enterpriseId, type, articleId, quantity, unitPrice, total, date, supplier, person, personId, authorizedBy, authorizedById, reason, machineId, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [eid, type, articleId, qty, Number(unitPrice) || 0, qty * (Number(unitPrice) || 0),
             date, supplier || '', person || '', personId || null, authorizedBy || '', authorizedById || null,
             reason || '', machineId || '', notes || ''],
            function(err) {
                if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: err.message }); }
                const movId = this.lastID;
                db.run(
                    'UPDATE inventory SET quantity = MAX(0, quantity + ?) WHERE id = ? AND enterpriseId = ?',
                    [delta, articleId, eid],
                    function(err2) {
                        if (err2) { db.run('ROLLBACK'); return res.status(500).json({ error: err2.message }); }
                        db.run('COMMIT', (err3) => {
                            if (err3) return res.status(500).json({ error: err3.message });
                            db.get('SELECT * FROM inventory WHERE id = ? AND enterpriseId = ?', [articleId, eid], (err4, inv) => {
                                res.json({ id: movId, inventory: inv || null });
                            });
                        });
                    }
                );
            }
        );
    });
});

app.delete('/api/stock-movements/:id', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT * FROM stockMovements WHERE id=? AND enterpriseId=?', [req.params.id, eid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Non trouvé' });
        const delta = row.type === 'entry' ? -row.quantity : row.quantity;
        db.serialize(() => {
            db.run('BEGIN');
            db.run('DELETE FROM stockMovements WHERE id=? AND enterpriseId=?', [req.params.id, eid], (err2) => {
                if (err2) { db.run('ROLLBACK'); return res.status(500).json({ error: err2.message }); }
                db.run('UPDATE inventory SET quantity = MAX(0, quantity + ?) WHERE id=? AND enterpriseId=?', [delta, row.articleId, eid], (err3) => {
                    if (err3) { db.run('ROLLBACK'); return res.status(500).json({ error: err3.message }); }
                    db.run('COMMIT', (err4) => {
                        if (err4) return res.status(500).json({ error: err4.message });
                        res.json({ ok: true });
                    });
                });
            });
        });
    });
});

// ── Phase 3 — Affûtage des bits ────────────────────────────────────────────

function recordBitStatusChange(eid, bitId, fromStatus, toStatus, changedBy, reason, cb) {
    db.run(
        `INSERT INTO bit_status_history (enterpriseId, bitId, fromStatus, toStatus, changedBy, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [eid, bitId, fromStatus, toStatus, changedBy || '', reason || ''],
        cb
    );
}

app.get('/api/bits', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.all(
        `SELECT b.*,
                (SELECT COUNT(*) FROM bit_sharpening_cycles sc WHERE sc.bitId = b.id AND sc.completedAt IS NOT NULL) AS completedSharpenings
         FROM bits b WHERE b.enterpriseId = ? ORDER BY b.createdAt DESC`,
        [eid],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.post('/api/bits', (req, res) => {
    const eid = resolveCreateEnterpriseId(req, req.body);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    const { serialNumber, type, diameter, brand, maxSharpenings, maxMetersPerSharpening, notes } = req.body || {};
    if (!serialNumber) return res.status(400).json({ error: 'serialNumber requis' });
    db.run(
        `INSERT INTO bits (enterpriseId, serialNumber, type, diameter, brand, maxSharpenings, maxMetersPerSharpening, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [eid, String(serialNumber).trim(), type || '', diameter != null ? parseFloat(diameter) : null,
         brand || '', maxSharpenings != null ? parseInt(maxSharpenings, 10) : null,
         maxMetersPerSharpening != null ? parseFloat(maxMetersPerSharpening) : null, notes || ''],
        function(err) {
            if (err) {
                if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ce numéro de série existe déjà' });
                return res.status(500).json({ error: err.message });
            }
            db.get('SELECT * FROM bits WHERE id = ?', [this.lastID], (err2, row) => {
                if (err2) return res.status(500).json({ error: err2.message });
                res.status(201).json(row);
            });
        }
    );
});

app.get('/api/bits/:id', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT * FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Bit non trouvé' });
        res.json(row);
    });
});

app.put('/api/bits/:id', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT * FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, existing) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!existing) return res.status(404).json({ error: 'Bit non trouvé' });
        const body = req.body || {};
        db.run(
            `UPDATE bits SET serialNumber = ?, type = ?, diameter = ?, brand = ?, maxSharpenings = ?,
             maxMetersPerSharpening = ?, notes = ?, currentDrillId = ?, updatedAt = CURRENT_TIMESTAMP
             WHERE id = ? AND enterpriseId = ?`,
            [
                body.serialNumber !== undefined ? String(body.serialNumber).trim() : existing.serialNumber,
                body.type !== undefined ? body.type : existing.type,
                body.diameter !== undefined ? (body.diameter != null ? parseFloat(body.diameter) : null) : existing.diameter,
                body.brand !== undefined ? body.brand : existing.brand,
                body.maxSharpenings !== undefined ? (body.maxSharpenings != null ? parseInt(body.maxSharpenings, 10) : null) : existing.maxSharpenings,
                body.maxMetersPerSharpening !== undefined ? (body.maxMetersPerSharpening != null ? parseFloat(body.maxMetersPerSharpening) : null) : existing.maxMetersPerSharpening,
                body.notes !== undefined ? body.notes : existing.notes,
                body.currentDrillId !== undefined ? body.currentDrillId : existing.currentDrillId,
                req.params.id, eid
            ],
            (err2) => {
                if (err2) {
                    if (String(err2.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ce numéro de série existe déjà' });
                    return res.status(500).json({ error: err2.message });
                }
                db.get('SELECT * FROM bits WHERE id = ?', [req.params.id], (err3, row) => res.json(row));
            }
        );
    });
});

app.delete('/api/bits/:id', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT id, status FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Bit non trouvé' });
        if (row.status === 'EN_SERVICE' || row.status === 'EN_AFFÛTAGE') {
            return res.status(409).json({ error: 'Impossible de supprimer un bit en service ou en affûtage actif' });
        }
        db.run('DELETE FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], function(err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ deleted: this.changes });
        });
    });
});

// ── Lifecycle transitions ──────────────────────────────────────────────────

app.post('/api/bits/:id/start-service', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    const { drillId } = req.body || {};
    db.get('SELECT * FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, bit) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!bit) return res.status(404).json({ error: 'Bit non trouvé' });
        if (bit.status !== 'NEUF' && bit.status !== 'EN_ATTENTE_AFFÛTAGE') {
            return res.status(409).json({ error: `Transition invalide depuis ${bit.status}` });
        }
        db.run(
            `UPDATE bits SET status = 'EN_SERVICE', currentDrillId = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND enterpriseId = ?`,
            [drillId || null, req.params.id, eid],
            (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                recordBitStatusChange(eid, req.params.id, bit.status, 'EN_SERVICE', req.auth.username, req.body.reason || '', () => {
                    db.get('SELECT * FROM bits WHERE id = ?', [req.params.id], (e, row) => res.json(row));
                });
            }
        );
    });
});

app.post('/api/bits/:id/request-sharpening', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT * FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, bit) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!bit) return res.status(404).json({ error: 'Bit non trouvé' });
        if (bit.status !== 'EN_SERVICE') {
            return res.status(409).json({ error: `Transition invalide depuis ${bit.status}` });
        }
        db.run(
            `UPDATE bits SET status = 'EN_ATTENTE_AFFÛTAGE', updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND enterpriseId = ?`,
            [req.params.id, eid],
            (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                const sharpeningNum = (bit.sharpeningCount || 0) + 1;
                db.run(
                    `INSERT INTO bit_sharpening_cycles (enterpriseId, bitId, sharpeningNumber, metersBeforeSharpening, notes)
                     VALUES (?, ?, ?, ?, ?)`,
                    [eid, req.params.id, sharpeningNum, bit.totalMeters || 0, req.body.notes || ''],
                    (err3) => {
                        if (err3) return res.status(500).json({ error: err3.message });
                        recordBitStatusChange(eid, req.params.id, 'EN_SERVICE', 'EN_ATTENTE_AFFÛTAGE', req.auth.username, req.body.reason || '', () => {
                            db.get('SELECT * FROM bits WHERE id = ?', [req.params.id], (e, row) => res.json(row));
                        });
                    }
                );
            }
        );
    });
});

app.post('/api/bits/:id/start-sharpening', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT * FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, bit) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!bit) return res.status(404).json({ error: 'Bit non trouvé' });
        if (bit.status !== 'EN_ATTENTE_AFFÛTAGE') {
            return res.status(409).json({ error: `Transition invalide depuis ${bit.status}` });
        }
        db.run(
            `UPDATE bits SET status = 'EN_AFFÛTAGE', currentDrillId = NULL, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND enterpriseId = ?`,
            [req.params.id, eid],
            (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                db.run(
                    `UPDATE bit_sharpening_cycles SET startedAt = CURRENT_TIMESTAMP, technicianName = ?
                     WHERE id = (SELECT id FROM bit_sharpening_cycles WHERE bitId = ? AND enterpriseId = ? AND startedAt IS NULL ORDER BY id DESC LIMIT 1)`,
                    [req.body.technicianName || '', req.params.id, eid],
                    (err3) => {
                        if (err3) return res.status(500).json({ error: err3.message });
                        recordBitStatusChange(eid, req.params.id, 'EN_ATTENTE_AFFÛTAGE', 'EN_AFFÛTAGE', req.auth.username, req.body.reason || '', () => {
                            db.get('SELECT * FROM bits WHERE id = ?', [req.params.id], (e, row) => res.json(row));
                        });
                    }
                );
            }
        );
    });
});

app.post('/api/bits/:id/complete-sharpening', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT * FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, bit) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!bit) return res.status(404).json({ error: 'Bit non trouvé' });
        if (bit.status !== 'EN_AFFÛTAGE') {
            return res.status(409).json({ error: `Transition invalide depuis ${bit.status}` });
        }
        const newCount = (bit.sharpeningCount || 0) + 1;
        db.run(
            `UPDATE bits SET status = 'EN_SERVICE', sharpeningCount = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND enterpriseId = ?`,
            [newCount, req.params.id, eid],
            (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                db.run(
                    `UPDATE bit_sharpening_cycles SET completedAt = CURRENT_TIMESTAMP,
                       technicianName = COALESCE(NULLIF(?, ''), technicianName),
                       notes = COALESCE(NULLIF(?, ''), notes),
                       sharpeningDuration = COALESCE(?, sharpeningDuration),
                       sharpeningCost = COALESCE(?, sharpeningCost),
                       sharpeningType = COALESCE(NULLIF(?, ''), sharpeningType),
                       diameterAfter = COALESCE(?, diameterAfter),
                       teethCondition = COALESCE(NULLIF(?, ''), teethCondition),
                       recommendation = COALESCE(NULLIF(?, ''), recommendation)
                     WHERE id = (SELECT id FROM bit_sharpening_cycles WHERE bitId = ? AND enterpriseId = ? AND completedAt IS NULL ORDER BY id DESC LIMIT 1)`,
                    [
                        req.body.technicianName || '', req.body.notes || '',
                        req.body.sharpeningDuration != null ? parseFloat(req.body.sharpeningDuration) || null : null,
                        req.body.sharpeningCost != null ? parseFloat(req.body.sharpeningCost) || null : null,
                        req.body.sharpeningType || '',
                        req.body.diameterAfter != null ? parseFloat(req.body.diameterAfter) || null : null,
                        req.body.teethCondition || '',
                        req.body.recommendation || '',
                        req.params.id, eid
                    ],
                    (err3) => {
                        if (err3) return res.status(500).json({ error: err3.message });
                        recordBitStatusChange(eid, req.params.id, 'EN_AFFÛTAGE', 'EN_SERVICE', req.auth.username, req.body.reason || '', () => {
                            db.get('SELECT * FROM bits WHERE id = ?', [req.params.id], (e, row) => res.json(row));
                        });
                    }
                );
            }
        );
    });
});

app.post('/api/bits/:id/reform', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT * FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, bit) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!bit) return res.status(404).json({ error: 'Bit non trouvé' });
        if (bit.status === 'RÉFORMÉ') return res.status(409).json({ error: 'Ce bit est déjà réformé' });
        const fromStatus = bit.status;
        db.run(
            `UPDATE bits SET status = 'RÉFORMÉ', currentDrillId = NULL, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND enterpriseId = ?`,
            [req.params.id, eid],
            (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                db.run(
                    `INSERT INTO bit_reform_logs (enterpriseId, bitId, reason, reformedBy, totalMeters, totalSharpenings, notes)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [eid, req.params.id, req.body.reason || '', (req.auth && req.auth.username) || '', bit.totalMeters || 0, bit.sharpeningCount || 0, req.body.notes || ''],
                    (err3) => {
                        if (err3) return res.status(500).json({ error: err3.message });
                        recordBitStatusChange(eid, req.params.id, fromStatus, 'RÉFORMÉ', (req.auth && req.auth.username) || '', req.body.reason || '', () => {
                            db.get('SELECT * FROM bits WHERE id = ?', [req.params.id], (e, row) => res.json(row));
                        });
                    }
                );
            }
        );
    });
});

// ── Production logs ────────────────────────────────────────────────────────

app.get('/api/bits/:id/production', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT id FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, bit) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!bit) return res.status(404).json({ error: 'Bit non trouvé' });
        const limit = Math.min(parseInt(req.query.limit, 10) || 90, 365);
        db.all(
            `SELECT * FROM bit_production_logs WHERE bitId = ? AND enterpriseId = ? ORDER BY date DESC LIMIT ?`,
            [req.params.id, eid, limit],
            (err2, rows) => {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json(rows);
            }
        );
    });
});

app.post('/api/bits/:id/production', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    const { date, drillId, metersDrilled, hoursUsed, notes } = req.body || {};
    if (!date || !drillId) return res.status(400).json({ error: 'date et drillId requis' });
    db.get('SELECT id FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, bit) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!bit) return res.status(404).json({ error: 'Bit non trouvé' });
        const meters = parseFloat(metersDrilled) || 0;
        const hours = parseFloat(hoursUsed) || 0;
        db.run(
            `INSERT INTO bit_production_logs (enterpriseId, bitId, date, drillId, metersDrilled, hoursUsed, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(enterpriseId, bitId, date) DO UPDATE SET
               drillId = excluded.drillId, metersDrilled = excluded.metersDrilled,
               hoursUsed = excluded.hoursUsed, notes = excluded.notes`,
            [eid, req.params.id, date, String(drillId), meters, hours, notes || ''],
            function(err2) {
                if (err2) return res.status(500).json({ error: err2.message });
                db.run(
                    `UPDATE bits SET totalMeters = (SELECT COALESCE(SUM(metersDrilled), 0) FROM bit_production_logs WHERE bitId = ? AND enterpriseId = ?), updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND enterpriseId = ?`,
                    [req.params.id, eid, req.params.id, eid],
                    (err3) => {
                        if (err3) return res.status(500).json({ error: err3.message });
                        db.get(
                            'SELECT * FROM bit_production_logs WHERE bitId = ? AND date = ? AND enterpriseId = ?',
                            [req.params.id, date, eid],
                            (e, row) => res.json(row)
                        );
                    }
                );
            }
        );
    });
});

// ── Sharpening & status history ────────────────────────────────────────────

app.get('/api/bits/:id/sharpening-cycles', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT id FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, bit) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!bit) return res.status(404).json({ error: 'Bit non trouvé' });
        db.all(
            `SELECT * FROM bit_sharpening_cycles WHERE bitId = ? AND enterpriseId = ? ORDER BY id DESC`,
            [req.params.id, eid],
            (err2, rows) => {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json(rows);
            }
        );
    });
});

app.get('/api/bits/:id/status-history', (req, res) => {
    const eid = getEnterpriseId(req);
    if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
    db.get('SELECT id FROM bits WHERE id = ? AND enterpriseId = ?', [req.params.id, eid], (err, bit) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!bit) return res.status(404).json({ error: 'Bit non trouvé' });
        db.all(
            `SELECT * FROM bit_status_history WHERE bitId = ? AND enterpriseId = ? ORDER BY changedAt DESC LIMIT 100`,
            [req.params.id, eid],
            (err2, rows) => {
                if (err2) return res.status(500).json({ error: err2.message });
                res.json(rows);
            }
        );
    });
});

require('./routes-collab')(app, { db, getEnterpriseId });

loadPlanDefaultTabsFromDb();

// Catch-all handler: send back React's index.html file for client-side routing (doit être à la fin)
app.get('*', (req, res) => {
    // Ne pas interférer avec les routes API
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Route API non trouvée' });
    }
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Garantit shift + UNIQUE(date, machineId, shift) avant traitement des requêtes (bases anciennes / migration incomplète)
ensureDailyDataRecordsSchema(db, (schemaErr) => {
    if (schemaErr) {
        console.error('❌ Schéma dailyDataRecords (shift / contrainte unique):', schemaErr.message);
    }
    app.listen(PORT, () => {
        console.log(`🚀 Serveur API démarré sur http://localhost:${PORT}`);
        console.log(`📊 Base de données: ${DB_PATH}`);
        console.log(`🏢 Mode: ${DEPLOYMENT_MODE === 'dedicated' ? 'Dédié (1 instance = 1 entreprise)' : 'Partagé (multi-tenant)'}`);
    });
});
