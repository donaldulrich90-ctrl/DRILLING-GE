/*
 * ADAPTATEUR FORAGE (DRILLING-GE) — API de service pour le portail.
 *
 * Monté dans server.js AVANT le gardien « JWT requis pour /api ». Routes
 * protégées par la clé de service SERVICE_API_KEY (en-tête X-Service-Key) :
 *
 *   GET  /api/service/metrics?enterpriseId=..&start=YYYY-MM-DD&end=YYYY-MM-DD
 *        -> métriques forage de l'entreprise sur la période.
 *   POST /api/service/enterprise    { name, slug?, plan? }
 *        -> crée (ou retrouve par slug) l'entreprise, renvoie son id. Idempotent.
 *   POST /api/service/user          { enterpriseId, username, password, role, name }
 *        -> crée le compte, ou le met à jour s'il appartient DÉJÀ à cette
 *           entreprise. Un identifiant pris par une autre entreprise ou par
 *           un compte plateforme est refusé (409) : jamais d'écrasement.
 *   POST /api/service/module-state  { enterpriseId, active }
 *        -> active / désactive l'entreprise (case « module Forage » du portail).
 *
 * Les données de forage sont rattachées à l'entreprise VIA LA FOREUSE :
 * dailyDataRecords.machineId / dailyConsumables.machineId -> drills.id -> drills.enterpriseId.
 *
 * NB : db.js expose des fonctions à promesses (get/all/run sans callback) ;
 * on utilise donc la connexion sqlite3 brute de getDb(), comme server.js.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('./db');
const { ALL_TENANT_ROLES, PLATFORM_ROLES } = require('./plan-roles');

const SERVICE_API_KEY = process.env.SERVICE_API_KEY || '';

function keyMatches(given) {
    const a = Buffer.from(String(given || ''), 'utf8');
    const b = Buffer.from(SERVICE_API_KEY, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireServiceKey(req, res, next) {
    if (!SERVICE_API_KEY) return res.status(500).json({ error: 'SERVICE_API_KEY non configurée' });
    if (!keyMatches(req.headers['x-service-key'])) {
        return res.status(401).json({ error: 'Clé de service invalide' });
    }
    next();
}

function registerMetrics(app) {
    // ---- Métriques ------------------------------------------------------
    app.get('/api/service/metrics', requireServiceKey, (req, res) => {
        const enterpriseId = parseInt(req.query.enterpriseId, 10);
        const start = String(req.query.start || '');
        const end = String(req.query.end || '');
        if (!enterpriseId || !start || !end) {
            return res.status(400).json({ error: 'enterpriseId, start et end requis' });
        }
        const db = getDb();

        const sqlProd = `
            SELECT d.machineId AS engin,
                   COALESCE(SUM(CAST(json_extract(d.data,'$.metersDrilled') AS REAL)),0) AS metres,
                   AVG(CAST(json_extract(d.data,'$.rop') AS REAL)) AS rop,
                   COUNT(*) AS saisies
            FROM dailyDataRecords d
            JOIN drills dr ON dr.id = d.machineId
            WHERE dr.enterpriseId = ? AND d.date >= ? AND d.date <= ?
            GROUP BY d.machineId`;

        db.all(sqlProd, [enterpriseId, start, end], (err, prodRows) => {
            if (err) return res.status(500).json({ error: err.message });

            consommablesParEngin(db, enterpriseId, start, end, (conso) => {
                db.get(
                    "SELECT COUNT(*) AS n FROM employees WHERE enterpriseId = ? AND COALESCE(status,'active') = 'active'",
                    [enterpriseId],
                    (e2, r2) => {
                        const effectif = (!e2 && r2 && r2.n) || 0;

                        // Fusion production + consommables, par foreuse.
                        const parEnginMap = new Map();
                        for (const r of prodRows || []) {
                            parEnginMap.set(r.engin, {
                                engin: r.engin,
                                metres: round(r.metres, 1),
                                rop: round(r.rop, 2),
                                arrets: 0, // à relier à la table des arrêts de poste si besoin
                                consommables_cout: 0,
                            });
                        }
                        for (const [engin, cout] of conso) {
                            const row = parEnginMap.get(engin)
                                || { engin, metres: 0, rop: 0, arrets: 0, consommables_cout: 0 };
                            row.consommables_cout = round(cout, 2);
                            parEnginMap.set(engin, row);
                        }
                        const parEngin = [...parEnginMap.values()].sort((a, b) => b.metres - a.metres);
                        const metresTotal = parEngin.reduce((s, r) => s + (r.metres || 0), 0);
                        const coutConso = parEngin.reduce((s, r) => s + (r.consommables_cout || 0), 0);

                        res.json({
                            module: 'forage',
                            periode: { start, end },
                            par_engin: parEngin,
                            metres_total: round(metresTotal, 1),
                            consommables_cout: round(coutConso, 2),
                            // Le forage ne suit pas encore le carburant en litres
                            // (fuelPct = niveau de cuve, pas une consommation).
                            carburant_litres: 0,
                            cout_total: round(coutConso, 2),
                            effectif: effectif,
                        });
                    }
                );
            });
        });
    });

    // ---- Création d'une entreprise (pilotée par le portail) -------------
    app.post('/api/service/enterprise', requireServiceKey, (req, res) => {
        const b = req.body || {};
        const name = String(b.name || '').trim();
        const slug = (String(b.slug || '').trim()
            || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''));
        const plan = String(b.plan || 'enterprise');
        if (!name) return res.status(400).json({ error: 'name requis' });
        const db = getDb();
        db.get('SELECT id FROM enterprises WHERE slug = ?', [slug], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (row) return res.json({ ok: true, existing: true, id: row.id, slug });
            db.run(
                'INSERT INTO enterprises (name, slug, currency, plan, maxUsers, maxDrills, maxSites) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [name, slug, 'XOF', plan, 50, 50, 20],
                function (e2) {
                    if (e2) return res.status(500).json({ error: e2.message });
                    res.json({ ok: true, created: true, id: this.lastID, slug });
                }
            );
        });
    });

    // ---- Création / mise à jour d'un compte (pilotée par le portail) ---
    app.post('/api/service/user', requireServiceKey, (req, res) => {
        const b = req.body || {};
        const enterpriseId = parseInt(b.enterpriseId, 10);
        const username = String(b.username || '').trim();
        const password = String(b.password || '');
        const role = String(b.role || 'foreur').trim();
        const name = String(b.name || username).trim() || username;
        if (!enterpriseId || !username || !password) {
            return res.status(400).json({ error: 'enterpriseId, username et password requis' });
        }
        if (!ALL_TENANT_ROLES.includes(role)) {
            return res.status(400).json({
                error: `Rôle Forage non autorisé : « ${role} ». Rôles possibles : ${ALL_TENANT_ROLES.join(', ')}`,
            });
        }
        const db = getDb();

        db.get('SELECT id FROM enterprises WHERE id = ?', [enterpriseId], (e0, ent) => {
            if (e0) return res.status(500).json({ error: e0.message });
            if (!ent) return res.status(404).json({ error: `Entreprise Forage n°${enterpriseId} introuvable` });

            db.get(
                'SELECT id, role, enterpriseId FROM users WHERE LOWER(TRIM(username)) = LOWER(?)',
                [username],
                (err, row) => {
                    if (err) return res.status(500).json({ error: err.message });
                    const hash = bcrypt.hashSync(password, 10);

                    if (row) {
                        // Jamais d'écrasement d'un compte d'une autre entreprise
                        // ou d'un compte plateforme (super_admin / platform_owner).
                        if (PLATFORM_ROLES.includes(row.role) || parseInt(row.enterpriseId, 10) !== enterpriseId) {
                            return res.status(409).json({
                                error: `L'identifiant « ${username} » est déjà utilisé dans Forage par un autre compte. Choisis un autre identifiant.`,
                            });
                        }
                        return db.run(
                            'UPDATE users SET password = ?, passwordHash = ?, role = ? WHERE id = ?',
                            ['', hash, role, row.id],
                            (e2) => (e2
                                ? res.status(500).json({ error: e2.message })
                                : res.json({ ok: true, updated: true, username }))
                        );
                    }

                    db.run(
                        'INSERT INTO users (username, password, passwordHash, role, name, enterpriseId, restrictions, notes, email, siteIds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [username, '', hash, role, name, enterpriseId, '{}', '', '', '[]'],
                        function (e2) {
                            if (e2) return res.status(500).json({ error: e2.message });
                            res.json({ ok: true, created: true, id: this.lastID, username });
                        }
                    );
                }
            );
        });
    });

    // ---- (Dé)activation de l'entreprise --------------------------------
    app.post('/api/service/module-state', requireServiceKey, (req, res) => {
        const enterpriseId = parseInt((req.body || {}).enterpriseId, 10);
        const active = (req.body || {}).active ? 1 : 0;
        if (!enterpriseId) return res.status(400).json({ error: 'enterpriseId requis' });
        getDb().run(
            "UPDATE enterprises SET isActive = ?, subscriptionStatus = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?",
            [active, active ? 'active' : 'suspended', enterpriseId],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                if (!this.changes) return res.status(404).json({ error: `Entreprise Forage n°${enterpriseId} introuvable` });
                res.json({ ok: true, enterpriseId, active: !!active });
            }
        );
    });
}

/** Coût des consommables par foreuse (Map engin -> coût). Tolérant : erreur => vide. */
function consommablesParEngin(db, enterpriseId, start, end, cb) {
    const sql = `
        SELECT dc.machineId AS engin, COALESCE(SUM(CAST(dc.totalCost AS REAL)),0) AS cout
        FROM dailyConsumables dc
        JOIN drills dr ON dr.id = dc.machineId
        WHERE dr.enterpriseId = ? AND dc.date >= ? AND dc.date <= ?
        GROUP BY dc.machineId`;
    db.all(sql, [enterpriseId, start, end], (err, rows) => {
        const m = new Map();
        if (!err) for (const r of rows || []) m.set(r.engin, r.cout || 0);
        cb(m);
    });
}

function round(v, n) {
    if (v == null || isNaN(v)) return 0;
    const p = Math.pow(10, n);
    return Math.round(v * p) / p;
}

module.exports = { registerMetrics };
