const PLAN_WRITE_ROLES = new Set([
    'admin',
    'gestionnaire',
    'gestionnaire_site',
    'superviseur',
    'ingenieur',
    'platform_owner'
]);

const HOLE_STATUSES = new Set(['PLANIFIÉ', 'EN COURS', 'COMPLETÉ', 'PROBLÈME']);

function finiteNumber(value, fallback = null) {
    if (value === '' || value == null) return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function boundedNumber(value, name, min, max, fallback = null) {
    const number = finiteNumber(value, fallback);
    if (number == null) return number;
    if (number < min || number > max) throw new Error(`${name} doit être compris entre ${min} et ${max}`);
    return number;
}

function text(value, maxLength = 500) {
    return value == null ? '' : String(value).trim().slice(0, maxLength);
}

function normalizePlan(rawPlan) {
    const sourceBlocks = rawPlan && Array.isArray(rawPlan.blocks) ? rawPlan.blocks : [];
    if (sourceBlocks.length > 500) throw new Error('Le plan dépasse la limite de 500 blocs');

    const blockCodes = new Set();
    let totalHoles = 0;
    const blocks = sourceBlocks.map((sourceBlock, blockIndex) => {
        const code = text(sourceBlock.id || sourceBlock.code, 80);
        if (!code) throw new Error(`Identifiant requis pour le bloc ${blockIndex + 1}`);
        if (blockCodes.has(code.toLowerCase())) throw new Error(`Bloc dupliqué : ${code}`);
        blockCodes.add(code.toLowerCase());

        const sourceHoles = Array.isArray(sourceBlock.holes) ? sourceBlock.holes : [];
        totalHoles += sourceHoles.length;
        if (totalHoles > 10000) throw new Error('Le plan dépasse la limite de 10 000 trous');
        const holeCodes = new Set();
        const holes = sourceHoles.map((sourceHole, holeIndex) => {
            const holeCode = text(sourceHole.id || sourceHole.code, 80);
            if (!holeCode) throw new Error(`Identifiant requis pour le trou ${holeIndex + 1} du bloc ${code}`);
            if (holeCodes.has(holeCode.toLowerCase())) throw new Error(`Trou dupliqué dans ${code} : ${holeCode}`);
            holeCodes.add(holeCode.toLowerCase());
            const status = HOLE_STATUSES.has(sourceHole.status) ? sourceHole.status : 'PLANIFIÉ';
            return {
                id: holeCode,
                status,
                planDepth: boundedNumber(sourceHole.planDepth, `Profondeur planifiée ${holeCode}`, 0, 20000, 0),
                actDepth: boundedNumber(sourceHole.actDepth, `Profondeur réelle ${holeCode}`, 0, 20000, 0),
                diameterMm: boundedNumber(sourceHole.diameterMm, `Diamètre ${holeCode}`, 0, 2000, null),
                azimuth: boundedNumber(sourceHole.azimuth, `Azimut ${holeCode}`, 0, 360, 0),
                inclination: boundedNumber(sourceHole.inclination, `Inclinaison ${holeCode}`, -90, 180, 90),
                easting: finiteNumber(sourceHole.easting, null),
                northing: finiteNumber(sourceHole.northing, null),
                elevation: finiteNumber(sourceHole.elevation, null),
                geology: text(sourceHole.geology, 200),
                waterEncountered: sourceHole.waterEncountered ? 1 : 0,
                waterDepth: boundedNumber(sourceHole.waterDepth, `Profondeur d'eau ${holeCode}`, 0, 20000, null),
                drillId: text(sourceHole.drillId, 120) || null,
                operatorName: text(sourceHole.operatorName, 200),
                startDate: text(sourceHole.startDate, 20),
                endDate: text(sourceHole.endDate, 20),
                notes: text(sourceHole.notes, 3000)
            };
        });

        return {
            id: code,
            name: text(sourceBlock.name, 200) || code,
            spacing: text(sourceBlock.spacing, 80),
            burden: boundedNumber(sourceBlock.burden, `Banquette ${code}`, 0, 1000, null),
            cols: Math.round(boundedNumber(sourceBlock.cols, `Colonnes ${code}`, 1, 100, 5)),
            siteId: finiteNumber(sourceBlock.siteId, null),
            contractId: text(sourceBlock.contractId, 120) || null,
            description: text(sourceBlock.description, 3000),
            holes
        };
    });
    return { blocks };
}

module.exports = function registerDrillingPlanRoutes(app, options) {
    const { db, getEnterpriseId } = options;

    // sqlite3 repasse en mode parallèle après chaque bloc serialize(). Sans ce
    // regroupement, la création des index peut devancer celle des tables sur une
    // base existante qui n'a pas encore reçu le module plan de forage.
    db.serialize(() => {
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
    });

    function resolveTenant(req, res) {
        const enterpriseId = getEnterpriseId(req);
        if (enterpriseId == null || Number.isNaN(Number(enterpriseId))) {
            res.status(400).json({ error: 'Contexte entreprise requis pour le plan de forage' });
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

    function loadPlan(enterpriseId, callback) {
        db.get('SELECT version, updatedByUsername, updatedAt FROM drilling_plan_meta WHERE enterpriseId = ?', [enterpriseId], (metaError, meta) => {
            if (metaError) return callback(metaError);
            db.all('SELECT * FROM drilling_blocks WHERE enterpriseId = ? ORDER BY id', [enterpriseId], (blockError, blockRows) => {
                if (blockError) return callback(blockError);
                db.all('SELECT * FROM drilling_holes WHERE enterpriseId = ? ORDER BY blockId, id', [enterpriseId], (holeError, holeRows) => {
                    if (holeError) return callback(holeError);
                    const holesByBlock = new Map();
                    (holeRows || []).forEach((row) => {
                        if (!holesByBlock.has(row.blockId)) holesByBlock.set(row.blockId, []);
                        holesByBlock.get(row.blockId).push({
                            id: row.code,
                            status: row.status,
                            planDepth: row.plannedDepth || 0,
                            actDepth: row.actualDepth || 0,
                            diameterMm: row.diameterMm,
                            azimuth: row.azimuth || 0,
                            inclination: row.inclination == null ? 90 : row.inclination,
                            easting: row.easting,
                            northing: row.northing,
                            elevation: row.elevation,
                            geology: row.geology || '',
                            waterEncountered: !!row.waterEncountered,
                            waterDepth: row.waterDepth,
                            drillId: row.drillId,
                            operatorName: row.operatorName || '',
                            startDate: row.startDate || '',
                            endDate: row.endDate || '',
                            notes: row.notes || ''
                        });
                    });
                    return callback(null, {
                        version: meta ? meta.version : 0,
                        updatedByUsername: meta ? meta.updatedByUsername : '',
                        updatedAt: meta ? meta.updatedAt : null,
                        blocks: (blockRows || []).map((row) => ({
                            id: row.code,
                            name: row.name,
                            spacing: row.spacing || '',
                            burden: row.burden,
                            cols: row.cols || 5,
                            siteId: row.siteId,
                            contractId: row.contractId,
                            description: row.description || '',
                            holes: holesByBlock.get(row.id) || []
                        }))
                    });
                });
            });
        });
    }

    app.get('/api/drilling-plan', (req, res) => {
        const enterpriseId = resolveTenant(req, res);
        if (enterpriseId == null) return;
        loadPlan(enterpriseId, (err, plan) => {
            if (err) return res.status(500).json({ error: err.message });
            return res.json(plan);
        });
    });

    app.put('/api/drilling-plan', (req, res) => {
        if (!canWrite(req)) {
            return res.status(403).json({ error: 'Droits insuffisants pour modifier le plan de forage' });
        }
        const enterpriseId = resolveTenant(req, res);
        if (enterpriseId == null) return;

        let plan;
        try {
            plan = normalizePlan(req.body || {});
        } catch (validationError) {
            return res.status(400).json({ error: validationError.message });
        }
        const baseVersion = req.body && req.body.baseVersion != null ? Number(req.body.baseVersion) : null;
        const actor = text(req.auth.username, 120);
        const now = new Date().toISOString();

        db.get('SELECT version FROM drilling_plan_meta WHERE enterpriseId = ?', [enterpriseId], (metaError, meta) => {
            if (metaError) return res.status(500).json({ error: metaError.message });
            const currentVersion = meta ? Number(meta.version) : 0;
            if (baseVersion != null && baseVersion !== currentVersion) {
                return res.status(409).json({
                    error: 'Le plan a été modifié sur un autre poste. Rechargez-le avant de réessayer.',
                    currentVersion
                });
            }

            db.serialize(() => {
                let failed = false;
                const fail = (err) => {
                    if (failed) return;
                    failed = true;
                    db.run('ROLLBACK', () => res.status(500).json({ error: err.message }));
                };
                db.run('BEGIN IMMEDIATE', (beginError) => {
                    if (beginError) return fail(beginError);
                    db.run('DELETE FROM drilling_holes WHERE enterpriseId = ?', [enterpriseId], (holeDeleteError) => {
                        if (holeDeleteError) return fail(holeDeleteError);
                        db.run('DELETE FROM drilling_blocks WHERE enterpriseId = ?', [enterpriseId], (blockDeleteError) => {
                            if (blockDeleteError) return fail(blockDeleteError);

                            let blockIndex = 0;
                            const insertNextBlock = () => {
                                if (failed) return;
                                if (blockIndex >= plan.blocks.length) {
                                    const nextVersion = currentVersion + 1;
                                    return db.run(
                                        `INSERT INTO drilling_plan_meta (enterpriseId, version, updatedByUsername, updatedAt)
                                         VALUES (?, ?, ?, ?)
                                         ON CONFLICT(enterpriseId) DO UPDATE SET version = excluded.version,
                                             updatedByUsername = excluded.updatedByUsername, updatedAt = excluded.updatedAt`,
                                        [enterpriseId, nextVersion, actor, now],
                                        (metaWriteError) => {
                                            if (metaWriteError) return fail(metaWriteError);
                                            db.run('COMMIT', (commitError) => {
                                                if (commitError) return fail(commitError);
                                                loadPlan(enterpriseId, (loadError, savedPlan) => {
                                                    if (loadError) return res.status(500).json({ error: loadError.message });
                                                    return res.json(savedPlan);
                                                });
                                            });
                                        }
                                    );
                                }

                                const block = plan.blocks[blockIndex++];
                                db.run(
                                    `INSERT INTO drilling_blocks
                                     (enterpriseId, code, name, spacing, burden, cols, siteId, contractId, description, updatedAt)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                    [enterpriseId, block.id, block.name, block.spacing, block.burden, block.cols, block.siteId, block.contractId, block.description, now],
                                    function insertBlock(blockInsertError) {
                                        if (blockInsertError) return fail(blockInsertError);
                                        const blockDbId = this.lastID;
                                        let holeIndex = 0;
                                        const insertNextHole = () => {
                                            if (failed) return;
                                            if (holeIndex >= block.holes.length) return insertNextBlock();
                                            const hole = block.holes[holeIndex++];
                                            db.run(
                                                `INSERT INTO drilling_holes
                                                 (enterpriseId, blockId, code, status, plannedDepth, actualDepth, diameterMm,
                                                  azimuth, inclination, easting, northing, elevation, geology,
                                                  waterEncountered, waterDepth, drillId, operatorName, startDate, endDate, notes, updatedAt)
                                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                                [
                                                    enterpriseId, blockDbId, hole.id, hole.status, hole.planDepth, hole.actDepth,
                                                    hole.diameterMm, hole.azimuth, hole.inclination, hole.easting, hole.northing,
                                                    hole.elevation, hole.geology, hole.waterEncountered, hole.waterDepth,
                                                    hole.drillId, hole.operatorName, hole.startDate, hole.endDate, hole.notes, now
                                                ],
                                                (holeInsertError) => {
                                                    if (holeInsertError) return fail(holeInsertError);
                                                    return insertNextHole();
                                                }
                                            );
                                        };
                                        return insertNextHole();
                                    }
                                );
                            };
                            insertNextBlock();
                        });
                    });
                });
            });
        });
    });
};
