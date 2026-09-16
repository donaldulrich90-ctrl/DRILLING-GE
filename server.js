const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const https = require('https');
const zlib = require('zlib');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { getDb, backup, DB_PATH } = require('./db');
const { verifyAuth, requirePlatformAdmin } = require('./middleware/saas-auth');
const planRoles = require('./plan-roles');
const { ensureDailyDataRecordsSchema } = require('./ensure-daily-data-schema');

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
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedCorsOrigins.has(origin)) return callback(null, true);
        return callback(new Error('Origine CORS non autorisée'));
    }
}));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

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
// Les pages de test historiques ne doivent pas être publiées par le serveur de production.
app.use((req, res, next) => {
    if (/^\/test(?:-[^/]+)?\.html$/i.test(req.path)) return res.status(404).end();
    return next();
});
app.use(express.static(__dirname));
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
    if (req.auth.role === 'platform_owner' || req.auth.role === 'admin') return next();
    return res.status(403).json({ error: 'Accès réservé aux administrateurs des comptes' });
}

function enrichEnterpriseRows(rows) {
    const list = rows || [];
    return list.map((row) => ({
        ...row,
        effectiveAllowedTabs: planRoles.getEffectiveAllowedTabs(row)
    }));
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

function normalizeDailyWorkflowStatus(value) {
    const status = String(value || 'draft').toLowerCase();
    return ['draft', 'submitted', 'approved', 'rejected'].includes(status) ? status : 'draft';
}

function validateDailyDataForSubmission(row) {
    let data;
    try {
        data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : (row.data || {});
    } catch (_) {
        return 'Les données du poste ne sont pas lisibles.';
    }
    const meters = Number(data.metersDrilled || 0);
    const machineHours = Number(data.hours || 0);
    if (!Number.isFinite(meters) || meters < 0) return 'Le métrage foré est invalide.';
    if (!Number.isFinite(machineHours) || machineHours < 0) return 'Les heures machine sont invalides.';
    if (!String(data.location || '').trim()) return 'Le lieu de forage est requis avant soumission.';
    if (!String(data.drillingType || '').trim()) return 'Le type de forage est requis avant soumission.';
    if (!String(data.materialType || '').trim()) return 'Le type de roche ou matériau est requis avant soumission.';
    if (!String(data.bitType || '').trim()) return 'Le type de trépan est requis avant soumission.';

    const holes = Array.isArray(data.holesWorked) ? data.holesWorked : [];
    if (meters > 0 && holes.length === 0) {
        return 'Ajoutez au moins un trou travaillé avant de soumettre un poste avec métrage.';
    }
    const seenHoles = new Set();
    let holeMeters = 0;
    for (const hole of holes) {
        const holeId = String(hole && hole.holeId || '').trim();
        if (!holeId) return 'Chaque ligne de trou doit comporter une référence.';
        const key = `${String(hole.blockId || '').trim()}::${holeId}`.toLowerCase();
        if (seenHoles.has(key)) return `Le trou ${holeId} est présent plusieurs fois.`;
        seenHoles.add(key);
        const worked = Number(hole.meters || 0);
        if (!Number.isFinite(worked) || worked < 0) return `Le métrage du trou ${holeId} est invalide.`;
        const finalDepth = hole.finalDepth == null || hole.finalDepth === '' ? null : Number(hole.finalDepth);
        if (finalDepth != null && (!Number.isFinite(finalDepth) || finalDepth < 0)) {
            return `La profondeur finale du trou ${holeId} est invalide.`;
        }
        holeMeters += worked;
    }
    if (holes.length > 0 && Math.abs(holeMeters - meters) > 0.11) {
        return `La somme des métrages par trou (${holeMeters.toFixed(1)} m) doit correspondre au métrage du poste (${meters.toFixed(1)} m).`;
    }

    const stoppages = Array.isArray(data.stoppages) ? data.stoppages : [];
    let downtime = 0;
    for (const stop of stoppages) {
        const hours = Number(stop && stop.hours || 0);
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
    const holes = parseDailyHolesWorked(row);
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
    const holes = parseDailyHolesWorked(row);
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

// JWT requis pour toutes les routes /api sauf login et health
app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    if (req.path === '/api/auth/login' || req.path === '/api/health') return next();
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
    const { id, location, status, siteId, contractId, telemetry, maintenance, fuel, rods, consumables, connectionMode, connectionStatus, connectionConfig } = req.body;
    const entId = resolveCreateEnterpriseId(req, req.body);
    db.run(
        `INSERT INTO drills (id, enterpriseId, location, status, siteId, contractId, telemetry, maintenance, fuel, rods, consumables, connectionMode, connectionStatus, connectionConfig)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id, entId, location, status, siteId || null, contractId || null,
            JSON.stringify(telemetry || {}),
            maintenance || 100,
            JSON.stringify(fuel || {}),
            JSON.stringify(rods || {}),
            JSON.stringify(consumables || {}),
            connectionMode || 'manual',
            connectionStatus || 'disconnected',
            JSON.stringify(connectionConfig || {})
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
    const { location, status, siteId, contractId, telemetry, maintenance, fuel, rods, consumables, connectionMode, connectionStatus, connectionConfig } = req.body;
    let sql = `UPDATE drills SET 
            location = ?, status = ?, siteId = ?, contractId = ?, telemetry = ?, maintenance = ?, 
            fuel = ?, rods = ?, consumables = ?, connectionMode = ?, 
            connectionStatus = ?, connectionConfig = ?
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
                `INSERT INTO sites (enterpriseId, name, address, city, region, country, clientId, coordinates, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [entId, name || '', address || '', city || '', region || '', country || '', clientId, coordinates || '', notes || ''],
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
    let sql = `UPDATE sites SET name = ?, address = ?, city = ?, region = ?, country = ?, clientId = ?, coordinates = ?, notes = ? WHERE id = ?`;
    const vals = [name || '', address || '', city || '', region || '', country || '', clientId, coordinates || '', notes || '', id];
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
         paymentTerms, billingMonthDefinition, notes, fuelPrice, fuelPriceCurrency, rates)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            contract.id, entId, contract.clientId, contract.siteId || null, contract.startDate, contract.endDate,
            contract.value, contract.currency, contract.status, contract.description,
            contract.paymentTerms, contract.billingMonthDefinition || '', contract.notes || '', contract.fuelPrice || 1.20,
            normalizeContractFuelPriceCurrency(contract.fuelPriceCurrency, contract.currency),
            JSON.stringify(contract.rates || [])
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
         status = ?, description = ?, paymentTerms = ?, billingMonthDefinition = ?, notes = ?, fuelPrice = ?, fuelPriceCurrency = ?, rates = ?
         WHERE id = ?`;
    const vals = [
        contract.clientId, contract.siteId || null, contract.startDate, contract.endDate, contract.value, contract.currency,
        contract.status, contract.description, contract.paymentTerms, contract.billingMonthDefinition || '',
        contract.notes || '',
        contract.fuelPrice || 1.20,
        normalizeContractFuelPriceCurrency(contract.fuelPriceCurrency, contract.currency),
        JSON.stringify(contract.rates || []), id
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
         address, notes, takenLeave, payslips, siteId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            entId, employee.employeeNumber, employee.name, employee.role, employee.email,
            employee.phone, employee.status, employee.salary, employee.startDate,
            employee.address || '', employee.notes || '', employee.takenLeave || 0,
            JSON.stringify(employee.payslips || []),
            employee.siteId != null && employee.siteId !== '' ? parseInt(employee.siteId, 10) : null
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
         status = ?, salary = ?, startDate = ?, address = ?, notes = ?, takenLeave = ?, payslips = ?, siteId = ?
         WHERE id = ?`;
    const vals = [
        employee.employeeNumber, employee.name, employee.role, employee.email, employee.phone,
        employee.status, employee.salary, employee.startDate, employee.address || '',
        employee.notes || '', employee.takenLeave || 0,
        JSON.stringify(employee.payslips || []),
        employee.siteId != null && employee.siteId !== '' ? parseInt(employee.siteId, 10) : null,
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
         taxAmount, total, currency, status, notes, billingMonth, signProviderJson, signClientJson)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            invoice.id, entId, invoice.invoiceNumber, invoice.date, invoice.dueDate, invoice.clientId,
            JSON.stringify(invoice.items || []), invoice.subtotal, invoice.taxRate,
            invoice.taxAmount, invoice.total, invoice.currency, invoice.status, invoice.notes || '',
            billingMonth, signProv, signCli
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
         billingMonth = ?, signProviderJson = ?, signClientJson = ?
         WHERE id = ?`;
        const vals = [
            invoice.invoiceNumber, invoice.date, invoice.dueDate, invoice.clientId,
            JSON.stringify(invoice.items || []), invoice.subtotal, invoice.taxRate,
            invoice.taxAmount, invoice.total, invoice.currency, invoice.status, invoice.notes || '',
            billingMonthU, signProvU, signCliU, realId
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

app.post('/api/daily-data', (req, res) => {
    const record = req.body || {};
    const shift = (record.data && record.data.shift) || '';
    const entId = getEnterpriseId(req);
    if (!record.date || !record.machineId) {
        return res.status(400).json({ error: 'date et machineId requis' });
    }
    assertDrillBelongsToTenant(db, record.machineId, entId, (aerr, ok) => {
        if (aerr) return res.status(500).json({ error: aerr.message });
        if (!ok) return res.status(403).json({ error: 'Machine invalide pour cette entreprise' });
        getDailyDataActorFromRequest(req, (actorErr, actor) => {
            if (actorErr) return res.status(500).json({ error: actorErr.message });
            const elevated = dailyDataElevatedRoleFromAuth(req.auth);
            const actorUsername = String(actor.username || '').trim();
            const actorName = String(actor.name || actorUsername || '').trim() || actorUsername;
            const nowIso = new Date().toISOString();
            const checkQuery = 'SELECT * FROM dailyDataRecords WHERE date = ? AND machineId = ? AND COALESCE(shift, \'\') = ?';
            db.get(checkQuery, [record.date, record.machineId, shift], (err, existingRow) => {
                if (err) return res.status(500).json({ error: err.message });
                if (existingRow) {
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
                    let upd = 'UPDATE dailyDataRecords SET data = ?, notes = ?, enteredByUsername = ?, enteredByName = ?, enteredAt = ?, lastModifiedByUsername = ?, lastModifiedByName = ?, lastModifiedAt = ?, workflowVersion = COALESCE(workflowVersion, 0) + 1 WHERE id = ?';
                    const uvals = [
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
                        if (this.changes === 0) return res.status(403).json({ error: 'Mise à jour refusée' });
                        res.json({ id: existingRow.id, message: 'Données mises à jour' });
                    });
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
                     WHERE id = ? AND COALESCE(workflowStatus, 'draft') IN ('draft', 'rejected')`,
                    [actor.username || actorFromToken, now, recordId],
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
    
    db.get('SELECT id FROM companyInfo WHERE enterpriseId = ? LIMIT 1', [entId], (err, existing) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        if (existing) {
            db.run(
                `UPDATE companyInfo SET name = ?, legalName = ?, address = ?, city = ?, country = ?,
                 postalCode = ?, taxId = ?, siret = ?, ifu = ?, rccm = ?, phone = ?, email = ?, website = ?,
                 bankName = ?, iban = ?, bic = ?, vatNumber = ?, tvaRate = ?, retenueSourceRate = ?, currency = ?,
                 signatoryFirstName = ?, signatoryLastName = ?, signatoryTitle = ? WHERE enterpriseId = ?`,
                [
                    company.name, company.legalName, company.address, company.city, company.country,
                    company.postalCode, company.taxId, company.siret, company.ifu || '', company.rccm || '',
                    company.phone, company.email, company.website, company.bankName, company.iban, company.bic,
                    company.vatNumber, company.tvaRate != null ? company.tvaRate : 18, company.retenueSourceRate != null ? company.retenueSourceRate : 5,
                    company.currency || 'XOF',
                    company.signatoryFirstName || '',
                    company.signatoryLastName || '',
                    company.signatoryTitle || '',
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
                 signatoryFirstName, signatoryLastName, signatoryTitle)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    entId, company.name, company.legalName, company.address, company.city, company.country,
                    company.postalCode, company.taxId, company.siret, company.ifu || '', company.rccm || '',
                    company.phone, company.email, company.website, company.bankName, company.iban, company.bic,
                    company.vatNumber, company.tvaRate != null ? company.tvaRate : 18, company.retenueSourceRate != null ? company.retenueSourceRate : 5,
                    company.currency || 'XOF',
                    company.signatoryFirstName || '',
                    company.signatoryLastName || '',
                    company.signatoryTitle || ''
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
               JSON_GROUP_ARRAY(JSON_OBJECT('consumableName', i.name, 'quantityUsed', dc.quantityUsed, 'unitPrice', dc.unitPrice, 'totalCost', dc.totalCost)) as consumables,
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
