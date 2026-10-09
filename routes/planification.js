// Module Planification & Suivi — plan (court/long terme) stocké par entreprise.
// Même convention que routes/drilling-plan.js : table créée au démarrage,
// endpoints GET/PUT multi-tenant, versionné (anti-écrasement concurrent).

const PLAN_WRITE_ROLES = new Set([
    'admin',
    'gestionnaire',
    'gestionnaire_site',
    'superviseur',
    'ingenieur',
    'platform_owner'
]);

function text(value, max) {
    if (value == null) return '';
    const s = String(value);
    return s.length > max ? s.slice(0, max) : s;
}

function num(value, min, max, fallback) {
    let n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (min != null && n < min) n = min;
    if (max != null && n > max) n = max;
    return n;
}

function normalizePeriods(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 400).map((p) => ({
        start: text(p && p.start, 20),
        end: text(p && p.end, 20),
        label: text(p && p.label, 40),
        target: num(p && p.target, 0, 1e9, 0)
    }));
}

function normalizePlan(body) {
    const metric = (body && body.metric === 'trous') ? 'trous' : 'metres';
    return {
        label: text(body && body.label, 160) || 'Plan',
        metric,
        unit: metric === 'trous' ? 'trous' : 'm',
        site: text(body && body.site, 160),
        startDate: text(body && body.startDate, 20),
        endDate: text(body && body.endDate, 20),
        totalTarget: num(body && body.totalTarget, 0, 1e9, 0),
        months: normalizePeriods(body && body.months),
        weeks: normalizePeriods(body && body.weeks)
    };
}

module.exports = function registerPlanificationRoutes(app, options) {
    const { db, getEnterpriseId } = options;

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS planification (
            enterpriseId INTEGER PRIMARY KEY,
            data TEXT DEFAULT '{}',
            version INTEGER NOT NULL DEFAULT 0,
            updatedByUsername TEXT DEFAULT '',
            updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (enterpriseId) REFERENCES enterprises(id) ON DELETE CASCADE
        )`);
    });

    function resolveTenant(req, res) {
        const enterpriseId = getEnterpriseId(req);
        if (enterpriseId == null || Number.isNaN(Number(enterpriseId))) {
            res.status(400).json({ error: 'Contexte entreprise requis pour la planification' });
            return null;
        }
        return Number(enterpriseId);
    }

    function canWrite(req) {
        return !!(
            req.auth &&
            (req.auth.isSuperAdmin || req.auth.isPlatformOwner || PLAN_WRITE_ROLES.has(req.auth.role))
        );
    }

    app.get('/api/planification', (req, res) => {
        const enterpriseId = resolveTenant(req, res);
        if (enterpriseId == null) return;
        db.get('SELECT data, version, updatedByUsername, updatedAt FROM planification WHERE enterpriseId = ?', [enterpriseId], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.json({ plan: null, version: 0 });
            let plan = null;
            try { plan = JSON.parse(row.data || '{}'); } catch (e) { plan = null; }
            return res.json({ plan, version: Number(row.version) || 0, updatedBy: row.updatedByUsername, updatedAt: row.updatedAt });
        });
    });

    app.put('/api/planification', (req, res) => {
        if (!canWrite(req)) {
            return res.status(403).json({ error: 'Droits insuffisants pour modifier la planification' });
        }
        const enterpriseId = resolveTenant(req, res);
        if (enterpriseId == null) return;

        let plan;
        try { plan = normalizePlan(req.body || {}); }
        catch (validationError) { return res.status(400).json({ error: validationError.message }); }

        const baseVersion = req.body && req.body.baseVersion != null ? Number(req.body.baseVersion) : null;
        const actor = text(req.auth && req.auth.username, 120);
        const now = new Date().toISOString();

        db.get('SELECT version FROM planification WHERE enterpriseId = ?', [enterpriseId], (metaError, meta) => {
            if (metaError) return res.status(500).json({ error: metaError.message });
            const currentVersion = meta ? Number(meta.version) : 0;
            if (baseVersion != null && baseVersion !== currentVersion) {
                return res.status(409).json({
                    error: 'La planification a été modifiée sur un autre poste. Rechargez-la avant de réessayer.',
                    currentVersion
                });
            }
            const nextVersion = currentVersion + 1;
            db.run(
                `INSERT INTO planification (enterpriseId, data, version, updatedByUsername, updatedAt)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(enterpriseId) DO UPDATE SET
                    data = excluded.data,
                    version = excluded.version,
                    updatedByUsername = excluded.updatedByUsername,
                    updatedAt = excluded.updatedAt`,
                [enterpriseId, JSON.stringify(plan), nextVersion, actor, now],
                (updateError) => {
                    if (updateError) return res.status(500).json({ error: updateError.message });
                    return res.json({ plan, version: nextVersion, updatedBy: actor, updatedAt: now });
                }
            );
        });
    });
};
