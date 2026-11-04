// ============================================================
// Noyau de synchronisation : construction d'un export et fusion
// additive (« le plus récent gagne », jamais d'effacement).
// Réutilisé par les endpoints HTTP (/api/sync/*) ET par le client
// de synchro automatique (sync-client.js).
//
// Portée entreprise :
//  - dailyDataRecords n'a PAS de colonne enterpriseId : on scope via
//    la foreuse (machineId -> drills.enterpriseId). La clé naturelle
//    (date, machineId, shift) est globalement unique (machineId = id
//    de foreuse, unique), donc sûre entre entreprises.
//  - pattern_photos porte enterpriseId : scope direct.
// À l'import, on REFUSE une saisie dont la foreuse n'appartient pas à
// l'entreprise cible (anti-mélange entre entreprises en ligne).
// ============================================================

// Construit l'export des données opérationnelles d'une entreprise.
// cb(err, { version, exportedAt, enterpriseId, dailyDataRecords, patternPhotos })
function buildExport(db, entId, includePatterns, cb) {
    const dailySql = entId != null
        ? 'SELECT date, machineId, shift, data, notes, createdAt, enteredByUsername, enteredByName, enteredAt, lastModifiedByUsername, lastModifiedByName, lastModifiedAt, workflowStatus FROM dailyDataRecords WHERE machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)'
        : 'SELECT date, machineId, shift, data, notes, createdAt, enteredByUsername, enteredByName, enteredAt, lastModifiedByUsername, lastModifiedByName, lastModifiedAt, workflowStatus FROM dailyDataRecords';
    const dailyP = entId != null ? [entId] : [];
    db.all(dailySql, dailyP, (e, daily) => {
        if (e) return cb(e);
        const base = { version: 1, exportedAt: new Date().toISOString(), enterpriseId: entId, dailyDataRecords: daily || [], patternPhotos: [] };
        if (!includePatterns) return cb(null, base);
        const patSql = entId != null ? 'SELECT siteId, date, zone, image, source, createdAt FROM pattern_photos WHERE enterpriseId = ?' : 'SELECT siteId, date, zone, image, source, createdAt FROM pattern_photos';
        db.all(patSql, entId != null ? [entId] : [], (e2, patterns) => {
            if (e2) return cb(e2);
            base.patternPhotos = patterns || [];
            cb(null, base);
        });
    });
}

// Fusionne un export dans la base locale pour l'entreprise entVal.
// cb(err, counts)
function applyMerge(db, entVal, payload, cb) {
    const daily = Array.isArray(payload && payload.dailyDataRecords) ? payload.dailyDataRecords : [];
    const patterns = Array.isArray(payload && payload.patternPhotos) ? payload.patternPhotos : [];
    const out = { dailyInserted: 0, dailyUpdated: 0, dailySkipped: 0, patternsInserted: 0, patternsUpdated: 0, patternsSkipped: 0 };

    let di = 0;
    function nextDaily() {
        if (di >= daily.length) return doPatterns();
        const r = daily[di++] || {};
        if (!r.date || r.machineId == null || r.machineId === '') { out.dailySkipped++; return nextDaily(); }
        // Sécurité : la foreuse doit appartenir à cette entreprise.
        db.get('SELECT 1 AS ok FROM drills WHERE id = ? AND enterpriseId = ?', [r.machineId, entVal], (eo, owns) => {
            if (eo || !owns) { out.dailySkipped++; return nextDaily(); }
            const shift = r.shift || '';
            const dataStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {});
            const incT = String(r.lastModifiedAt || r.enteredAt || r.createdAt || '');
            db.get('SELECT id, lastModifiedAt, createdAt FROM dailyDataRecords WHERE date = ? AND machineId = ? AND COALESCE(shift, \'\') = ?',
                [r.date, r.machineId, shift], (e, ex) => {
                    if (e) { out.dailySkipped++; return nextDaily(); }
                    if (!ex) {
                        db.run('INSERT INTO dailyDataRecords (date, machineId, shift, data, notes, createdAt, enteredByUsername, enteredByName, enteredAt, lastModifiedByUsername, lastModifiedByName, lastModifiedAt, workflowStatus) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                            [r.date, r.machineId, shift, dataStr, r.notes || '', r.createdAt || new Date().toISOString(), r.enteredByUsername || '', r.enteredByName || '', r.enteredAt || null, r.lastModifiedByUsername || '', r.lastModifiedByName || '', r.lastModifiedAt || null, r.workflowStatus || 'draft'],
                            (ie) => { if (ie) out.dailySkipped++; else out.dailyInserted++; nextDaily(); });
                    } else {
                        const exT = String(ex.lastModifiedAt || ex.createdAt || '');
                        if (incT && incT > exT) {
                            db.run('UPDATE dailyDataRecords SET data = ?, notes = ?, lastModifiedByUsername = ?, lastModifiedByName = ?, lastModifiedAt = ?, workflowStatus = ? WHERE id = ?',
                                [dataStr, r.notes || '', r.lastModifiedByUsername || '', r.lastModifiedByName || '', r.lastModifiedAt || null, r.workflowStatus || 'draft', ex.id],
                                (ue) => { if (ue) out.dailySkipped++; else out.dailyUpdated++; nextDaily(); });
                        } else { out.dailySkipped++; nextDaily(); }
                    }
                });
        });
    }

    let pi = 0;
    function doPatterns() {
        if (pi >= patterns.length) return cb(null, out);
        const p = patterns[pi++] || {};
        if (!p.date || !p.zone || typeof p.image !== 'string' || !/^data:image\//.test(p.image)) { out.patternsSkipped++; return doPatterns(); }
        const siteId = (p.siteId === '' || p.siteId == null) ? null : parseInt(p.siteId, 10);
        const incT = String(p.createdAt || '');
        db.get('SELECT id, createdAt FROM pattern_photos WHERE enterpriseId = ? AND date = ? AND zone = ? AND IFNULL(siteId,-1) = IFNULL(?,-1)',
            [entVal, p.date, p.zone, siteId], (e, ex) => {
                if (e) { out.patternsSkipped++; return doPatterns(); }
                if (!ex) {
                    db.run('INSERT INTO pattern_photos (enterpriseId, siteId, date, zone, image, source, createdAt) VALUES (?,?,?,?,?,?,?)',
                        [entVal, siteId, p.date, p.zone, p.image, p.source === 'auto' ? 'auto' : 'photo', p.createdAt || new Date().toISOString()],
                        (ie) => { if (ie) out.patternsSkipped++; else out.patternsInserted++; doPatterns(); });
                } else if (incT && incT > String(ex.createdAt || '')) {
                    db.run('UPDATE pattern_photos SET image = ?, source = ?, createdAt = ? WHERE id = ?',
                        [p.image, p.source === 'auto' ? 'auto' : 'photo', p.createdAt, ex.id],
                        (ue) => { if (ue) out.patternsSkipped++; else out.patternsUpdated++; doPatterns(); });
                } else { out.patternsSkipped++; doPatterns(); }
            });
    }

    nextDaily();
}

// ---- Configuration (sens online → local uniquement) ------------------------
// Export de la configuration de l'entreprise : clients, sites, contrats,
// foreuses, fiche entreprise (dont fosses), comptes utilisateurs.
function buildConfigExport(db, entId, cb) {
    const out = { clients: [], sites: [], contracts: [], drills: [], companyInfo: [], users: [] };
    const where = entId != null ? ' WHERE enterpriseId = ?' : '';
    const p = entId != null ? [entId] : [];
    const tables = ['clients', 'sites', 'contracts', 'drills', 'companyInfo', 'users'];
    let i = 0;
    (function next() {
        if (i >= tables.length) return cb(null, out);
        const t = tables[i++];
        db.all('SELECT * FROM ' + t + where, p, (e, rows) => { if (!e && rows) out[t] = rows; next(); });
    })();
}

// Applique une configuration reçue (upsert par clé primaire). L'entreprise en
// ligne fait foi : « online gagne » pour la config. Additif (jamais de
// suppression). enterpriseId est forcé à entVal (sécurité).
function applyConfig(db, entVal, cfg, cb) {
    if (!cfg) return cb(null, {});
    const counts = {};
    function upsertTable(table, rows, done) {
        rows = Array.isArray(rows) ? rows : [];
        db.all('PRAGMA table_info(' + table + ')', [], (e, cols) => {
            if (e || !cols) { counts[table] = 0; return done(); }
            const colNames = cols.map((c) => c.name);
            let n = 0, i = 0;
            (function next() {
                if (i >= rows.length) { counts[table] = n; return done(); }
                const r = rows[i++] || {};
                if (colNames.indexOf('enterpriseId') >= 0) r.enterpriseId = entVal;
                const use = colNames.filter((c) => Object.prototype.hasOwnProperty.call(r, c));
                if (!use.length) return next();
                const ph = use.map(() => '?').join(',');
                db.run('INSERT OR REPLACE INTO ' + table + ' (' + use.join(',') + ') VALUES (' + ph + ')', use.map((c) => r[c]), (ie) => { if (!ie) n++; next(); });
            })();
        });
    }
    // companyInfo : une seule ligne par entreprise → on remplace celle-ci.
    function doCompanyInfo(done) {
        db.run('DELETE FROM companyInfo WHERE enterpriseId = ?', [entVal], () => upsertTable('companyInfo', cfg.companyInfo, done));
    }
    // Ordre : parents avant enfants (clients → sites → contrats → foreuses).
    const seq = [
        (d) => upsertTable('clients', cfg.clients, d),
        (d) => upsertTable('sites', cfg.sites, d),
        (d) => upsertTable('contracts', cfg.contracts, d),
        (d) => upsertTable('drills', cfg.drills, d),
        (d) => doCompanyInfo(d),
        (d) => upsertTable('users', cfg.users, d)
    ];
    let i = 0;
    (function run() { if (i >= seq.length) return cb(null, counts); seq[i++](run); })();
}

module.exports = { buildExport, applyMerge, buildConfigExport, applyConfig };
