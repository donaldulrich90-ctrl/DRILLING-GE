/**
 * Flotte de véhicules légers (GEDRILLING)
 *
 * Véhicules légers appartenant à l'entreprise (pick-up, 4x4, berlines, motos…)
 * avec suivi des échéances réglementaires et d'entretien :
 *   • Assurance        (insuranceExpiry)
 *   • Visite technique  (inspectionExpiry)
 *   • Entretien / PM    (pmNextDate, option pmIntervalKm + odometer)
 *   • Vignette          (vignetteExpiry)
 *
 * Les alertes (échéance dépassée / proche) sont calculées côté interface et
 * remontées au centre d'alertes. Scopé par enterpriseId.
 */
module.exports = function registerFleetLightRoutes(app, { db, getEnterpriseId }) {
    function qAll(sql, p) { return new Promise((ok, f) => db.all(sql, p, (e, r) => e ? f(e) : ok(r || []))); }
    function qOne(sql, p) { return new Promise((ok, f) => db.get(sql, p, (e, r) => e ? f(e) : ok(r || null))); }
    function qRun(sql, p) { return new Promise((ok, f) => db.run(sql, p, function (e) { e ? f(e) : ok({ lastID: this.lastID, changes: this.changes }); })); }
    function reqEid(req, res) { const e = getEnterpriseId(req); if (!e) { res.status(400).json({ error: 'Contexte entreprise requis' }); return null; } return e; }
    function text(v, max) { if (v == null) return ''; const s = String(v); return s.length > max ? s.slice(0, max) : s; }
    function dateOrNull(v) { const s = text(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
    function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS light_vehicles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            plate TEXT NOT NULL DEFAULT '',
            brand TEXT DEFAULT '',
            model TEXT DEFAULT '',
            vtype TEXT DEFAULT '',
            year INTEGER,
            assignedTo TEXT DEFAULT '',
            siteId INTEGER,
            odometer REAL,
            insuranceExpiry TEXT,
            inspectionExpiry TEXT,
            pmNextDate TEXT,
            pmIntervalKm REAL,
            lastPmDate TEXT,
            vignetteExpiry TEXT,
            notes TEXT DEFAULT '',
            isActive INTEGER DEFAULT 1,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_lightveh_ent ON light_vehicles(enterpriseId)');
    });

    function fields(b) {
        return {
            plate: text(b.plate, 30).trim(),
            brand: text(b.brand, 60),
            model: text(b.model, 60),
            vtype: text(b.vtype, 40),
            year: numOrNull(b.year),
            assignedTo: text(b.assignedTo, 120),
            siteId: numOrNull(b.siteId),
            odometer: numOrNull(b.odometer),
            insuranceExpiry: dateOrNull(b.insuranceExpiry),
            inspectionExpiry: dateOrNull(b.inspectionExpiry),
            pmNextDate: dateOrNull(b.pmNextDate),
            pmIntervalKm: numOrNull(b.pmIntervalKm),
            lastPmDate: dateOrNull(b.lastPmDate),
            vignetteExpiry: dateOrNull(b.vignetteExpiry),
            notes: text(b.notes, 1000),
            isActive: b.isActive === false ? 0 : 1,
        };
    }

    app.get('/api/light-vehicles', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try { res.json(await qAll('SELECT * FROM light_vehicles WHERE enterpriseId = ? ORDER BY plate', [eid])); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/light-vehicles', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const f = fields(req.body || {});
        if (!f.plate) return res.status(400).json({ error: 'Immatriculation requise' });
        try {
            const r = await qRun(
                `INSERT INTO light_vehicles (enterpriseId, plate, brand, model, vtype, year, assignedTo, siteId, odometer,
                    insuranceExpiry, inspectionExpiry, pmNextDate, pmIntervalKm, lastPmDate, vignetteExpiry, notes, isActive)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [eid, f.plate, f.brand, f.model, f.vtype, f.year, f.assignedTo, f.siteId, f.odometer,
                 f.insuranceExpiry, f.inspectionExpiry, f.pmNextDate, f.pmIntervalKm, f.lastPmDate, f.vignetteExpiry, f.notes, f.isActive]);
            res.status(201).json({ id: r.lastID });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.put('/api/light-vehicles/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const f = fields(req.body || {});
        if (!f.plate) return res.status(400).json({ error: 'Immatriculation requise' });
        try {
            const r = await qRun(
                `UPDATE light_vehicles SET plate=?, brand=?, model=?, vtype=?, year=?, assignedTo=?, siteId=?, odometer=?,
                    insuranceExpiry=?, inspectionExpiry=?, pmNextDate=?, pmIntervalKm=?, lastPmDate=?, vignetteExpiry=?, notes=?, isActive=?
                 WHERE id=? AND enterpriseId=?`,
                [f.plate, f.brand, f.model, f.vtype, f.year, f.assignedTo, f.siteId, f.odometer,
                 f.insuranceExpiry, f.inspectionExpiry, f.pmNextDate, f.pmIntervalKm, f.lastPmDate, f.vignetteExpiry, f.notes, f.isActive,
                 Number(req.params.id), eid]);
            if (!r.changes) return res.status(404).json({ error: 'Véhicule introuvable' });
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/light-vehicles/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            await qRun('DELETE FROM light_vehicles WHERE id=? AND enterpriseId=?', [Number(req.params.id), eid]);
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
};
