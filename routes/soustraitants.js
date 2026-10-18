// Module Sous-traitants (Forage) — sociétés qui louent des machines à l'entreprise.
// Paiement mensuel = tarif × usage réel par machine, moins les back-charges
// imputées au sous-traitant. Back-charges aussi imputables à l'entreprise
// (pour le bénéfice net), avec justificatif joint.

const path = require('path');
const fs = require('fs');
const multer = require('multer');

const WRITE_ROLES = new Set(['admin', 'gestionnaire', 'gestionnaire_site', 'superviseur', 'ingenieur', 'platform_owner']);
const UNITS = new Set(['heure', 'jour', 'metre', 'forfait']);
const SCOPES = new Set(['subcontractor', 'enterprise']);

function text(v, max) { if (v == null) return ''; const s = String(v); return s.length > max ? s.slice(0, max) : s; }
function num(v, min, max, fb) { let n = Number(v); if (!Number.isFinite(n)) return fb; if (min != null && n < min) n = min; if (max != null && n > max) n = max; return n; }
function period(v) { const s = text(v, 7); return /^\d{4}-\d{2}$/.test(s) ? s : ''; }

module.exports = function registerSoustraitantsRoutes(app, options) {
    const { db, getEnterpriseId } = options;

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS subcontractors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            contact TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            email TEXT DEFAULT '',
            note TEXT DEFAULT '',
            active INTEGER DEFAULT 1,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_subc_enterprise ON subcontractors(enterpriseId)');

        db.run(`CREATE TABLE IF NOT EXISTS rented_machines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            subcontractorId INTEGER NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            model TEXT DEFAULT '',
            rate REAL DEFAULT 0,
            unit TEXT DEFAULT 'jour',
            active INTEGER DEFAULT 1,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_rmach_enterprise ON rented_machines(enterpriseId)');

        db.run(`CREATE TABLE IF NOT EXISTS machine_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            machineId INTEGER NOT NULL,
            period TEXT NOT NULL,
            quantity REAL DEFAULT 0,
            note TEXT DEFAULT '',
            updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(machineId, period)
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_usage_enterprise ON machine_usage(enterpriseId, period)');

        db.run(`CREATE TABLE IF NOT EXISTS back_charges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            scope TEXT NOT NULL DEFAULT 'subcontractor',
            subcontractorId INTEGER,
            period TEXT NOT NULL DEFAULT '',
            label TEXT DEFAULT '',
            amount REAL DEFAULT 0,
            note TEXT DEFAULT '',
            attachment TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            createdBy TEXT DEFAULT ''
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_bc_enterprise ON back_charges(enterpriseId, period)');
    });

    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(__dirname, '..', 'uploads', 'backcharges', String(resolveTenant(req) || '0'));
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const safe = String(file.originalname || 'fichier').replace(/[^\w.\-]+/g, '_').slice(-80);
            cb(null, Date.now() + '_' + safe);
        }
    });
    const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

    function resolveTenant(req) {
        const e = getEnterpriseId(req);
        return (e == null || Number.isNaN(Number(e))) ? null : Number(e);
    }
    function tenantOr400(req, res) {
        const e = resolveTenant(req);
        if (e == null) { res.status(400).json({ error: 'Contexte entreprise requis' }); return null; }
        return e;
    }
    function canWrite(req) {
        return !!(req.auth && (req.auth.isSuperAdmin || req.auth.isPlatformOwner || WRITE_ROLES.has(req.auth.role)));
    }
    function actor(req) { return text(req.auth && req.auth.username, 120); }

    // ------------------------------------------------------------------ Sous-traitants
    app.get('/api/soustraitants', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        db.all('SELECT * FROM subcontractors WHERE enterpriseId = ? ORDER BY name', [eid], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.post('/api/soustraitants', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const b = req.body || {};
        const name = text(b.name, 160);
        if (!name) return res.status(400).json({ error: 'Nom requis' });
        db.run('INSERT INTO subcontractors (enterpriseId, name, contact, phone, email, note, active) VALUES (?,?,?,?,?,?,?)',
            [eid, name, text(b.contact, 160), text(b.phone, 60), text(b.email, 160), text(b.note, 1000), b.active === false ? 0 : 1],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                db.get('SELECT * FROM subcontractors WHERE id = ?', [this.lastID], (e, r) => res.json(r));
            });
    });

    app.put('/api/soustraitants/:id', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const id = Number(req.params.id); const b = req.body || {};
        const name = text(b.name, 160);
        if (!name) return res.status(400).json({ error: 'Nom requis' });
        db.run('UPDATE subcontractors SET name=?, contact=?, phone=?, email=?, note=?, active=? WHERE id=? AND enterpriseId=?',
            [name, text(b.contact, 160), text(b.phone, 60), text(b.email, 160), text(b.note, 1000), b.active === false ? 0 : 1, id, eid],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                db.get('SELECT * FROM subcontractors WHERE id = ?', [id], (e, r) => res.json(r || {}));
            });
    });

    app.delete('/api/soustraitants/:id', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const id = Number(req.params.id);
        db.run('DELETE FROM subcontractors WHERE id=? AND enterpriseId=?', [id, eid], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run('DELETE FROM rented_machines WHERE subcontractorId=? AND enterpriseId=?', [id, eid], () => {});
            db.run('DELETE FROM back_charges WHERE subcontractorId=? AND enterpriseId=?', [id, eid], () => {});
            res.json({ ok: true });
        });
    });

    // ------------------------------------------------------------------ Machines louées
    app.get('/api/soustraitants/machines', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        db.all('SELECT * FROM rented_machines WHERE enterpriseId = ? ORDER BY label', [eid], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.post('/api/soustraitants/machines', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const b = req.body || {};
        const label = text(b.label, 160);
        const subId = Number(b.subcontractorId);
        if (!label) return res.status(400).json({ error: 'Nom de machine requis' });
        if (!Number.isFinite(subId)) return res.status(400).json({ error: 'Sous-traitant requis' });
        const unit = UNITS.has(b.unit) ? b.unit : 'jour';
        db.run('INSERT INTO rented_machines (enterpriseId, subcontractorId, label, model, rate, unit, active) VALUES (?,?,?,?,?,?,?)',
            [eid, subId, label, text(b.model, 120), num(b.rate, 0, 1e12, 0), unit, b.active === false ? 0 : 1],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                db.get('SELECT * FROM rented_machines WHERE id = ?', [this.lastID], (e, r) => res.json(r));
            });
    });

    app.put('/api/soustraitants/machines/:id', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const id = Number(req.params.id); const b = req.body || {};
        const label = text(b.label, 160);
        const subId = Number(b.subcontractorId);
        if (!label) return res.status(400).json({ error: 'Nom de machine requis' });
        if (!Number.isFinite(subId)) return res.status(400).json({ error: 'Sous-traitant requis' });
        const unit = UNITS.has(b.unit) ? b.unit : 'jour';
        db.run('UPDATE rented_machines SET subcontractorId=?, label=?, model=?, rate=?, unit=?, active=? WHERE id=? AND enterpriseId=?',
            [subId, label, text(b.model, 120), num(b.rate, 0, 1e12, 0), unit, b.active === false ? 0 : 1, id, eid],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                db.get('SELECT * FROM rented_machines WHERE id = ?', [id], (e, r) => res.json(r || {}));
            });
    });

    app.delete('/api/soustraitants/machines/:id', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const id = Number(req.params.id);
        db.run('DELETE FROM rented_machines WHERE id=? AND enterpriseId=?', [id, eid], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run('DELETE FROM machine_usage WHERE machineId=? AND enterpriseId=?', [id, eid], () => {});
            res.json({ ok: true });
        });
    });

    // ------------------------------------------------------------------ Relevé d'usage mensuel
    app.get('/api/soustraitants/usage', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        const p = period(req.query.period);
        if (!p) return res.status(400).json({ error: 'Période AAAA-MM requise' });
        db.all('SELECT * FROM machine_usage WHERE enterpriseId = ? AND period = ?', [eid, p], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    // Upsert d'un relevé (machine + période)
    app.post('/api/soustraitants/usage', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const b = req.body || {};
        const machineId = Number(b.machineId);
        const p = period(b.period);
        if (!Number.isFinite(machineId) || !p) return res.status(400).json({ error: 'Machine et période requises' });
        const qty = num(b.quantity, 0, 1e12, 0);
        const now = new Date().toISOString();
        db.run(`INSERT INTO machine_usage (enterpriseId, machineId, period, quantity, note, updatedAt)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(machineId, period) DO UPDATE SET quantity=excluded.quantity, note=excluded.note, updatedAt=excluded.updatedAt`,
            [eid, machineId, p, qty, text(b.note, 300), now],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ ok: true });
            });
    });

    // ------------------------------------------------------------------ Back-charges
    app.get('/api/soustraitants/backcharges', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        const p = period(req.query.period);
        const params = [eid]; let sql = 'SELECT * FROM back_charges WHERE enterpriseId = ?';
        if (p) { sql += ' AND period = ?'; params.push(p); }
        sql += ' ORDER BY id DESC';
        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    // Création avec justificatif optionnel (multipart). Champs en texte.
    app.post('/api/soustraitants/backcharges', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        upload.single('attachment')(req, res, (upErr) => {
            if (upErr) return res.status(400).json({ error: upErr.message });
            const b = req.body || {};
            const scope = SCOPES.has(b.scope) ? b.scope : 'subcontractor';
            const p = period(b.period);
            if (!p) return res.status(400).json({ error: 'Période AAAA-MM requise' });
            const amount = num(b.amount, 0, 1e12, 0);
            const label = text(b.label, 200);
            if (!label) return res.status(400).json({ error: 'Libellé requis' });
            let subId = Number(b.subcontractorId);
            if (scope === 'enterprise' || !Number.isFinite(subId)) subId = null;
            if (scope === 'subcontractor' && subId == null) return res.status(400).json({ error: 'Sous-traitant requis' });
            const url = req.file ? ('/uploads/backcharges/' + eid + '/' + req.file.filename) : '';
            db.run(`INSERT INTO back_charges (enterpriseId, scope, subcontractorId, period, label, amount, note, attachment, createdBy)
                    VALUES (?,?,?,?,?,?,?,?,?)`,
                [eid, scope, subId, p, label, amount, text(b.note, 1000), url, actor(req)],
                function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    db.get('SELECT * FROM back_charges WHERE id = ?', [this.lastID], (e, r) => res.json(r));
                });
        });
    });

    app.delete('/api/soustraitants/backcharges/:id', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        db.run('DELETE FROM back_charges WHERE id=? AND enterpriseId=?', [Number(req.params.id), eid], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
    });

    // ------------------------------------------------------------------ État de paiement mensuel
    // Pour chaque sous-traitant : machines (tarif × usage = brut), moins back-charges
    // du sous-traitant = net à payer. Plus les back-charges côté entreprise.
    app.get('/api/soustraitants/statement', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        const p = period(req.query.period);
        if (!p) return res.status(400).json({ error: 'Période AAAA-MM requise' });
        const q = (sql, params) => new Promise((resolve, reject) =>
            db.all(sql, params, (e, r) => e ? reject(e) : resolve(r || [])));
        Promise.all([
            q('SELECT * FROM subcontractors WHERE enterpriseId = ? ORDER BY name', [eid]),
            q('SELECT * FROM rented_machines WHERE enterpriseId = ?', [eid]),
            q('SELECT * FROM machine_usage WHERE enterpriseId = ? AND period = ?', [eid, p]),
            q('SELECT * FROM back_charges WHERE enterpriseId = ? AND period = ?', [eid, p]),
        ]).then(([subs, machines, usage, charges]) => {
            const usageByMachine = {};
            usage.forEach(u => { usageByMachine[u.machineId] = u; });
            const chargesBySub = {};
            let entBack = 0; const entCharges = [];
            charges.forEach(c => {
                if (c.scope === 'enterprise') { entBack += Number(c.amount) || 0; entCharges.push(c); }
                else { (chargesBySub[c.subcontractorId] = chargesBySub[c.subcontractorId] || []).push(c); }
            });
            let totGross = 0, totSubBack = 0, totNet = 0;
            const out = subs.map(s => {
                const sMachines = machines.filter(m => Number(m.subcontractorId) === Number(s.id)).map(m => {
                    const u = usageByMachine[m.id];
                    const quantity = u ? (Number(u.quantity) || 0) : 0;
                    const rate = Number(m.rate) || 0;
                    const gross = m.unit === 'forfait' ? rate : rate * quantity;
                    return { machineId: m.id, label: m.label, model: m.model, unit: m.unit, rate, quantity, gross };
                });
                const grossTotal = sMachines.reduce((a, m) => a + m.gross, 0);
                const bch = chargesBySub[s.id] || [];
                const backTotal = bch.reduce((a, c) => a + (Number(c.amount) || 0), 0);
                const net = grossTotal - backTotal;
                totGross += grossTotal; totSubBack += backTotal; totNet += net;
                return {
                    id: s.id, name: s.name, phone: s.phone, email: s.email,
                    machines: sMachines, grossTotal,
                    backCharges: bch, backTotal, net,
                };
            });
            res.json({
                period: p,
                subcontractors: out,
                enterpriseBackCharges: entCharges,
                totals: {
                    gross: totGross,
                    subcontractorBackCharges: totSubBack,
                    netToPay: totNet,
                    enterpriseBackCharges: entBack,
                    // Coûts déductibles du gain de l'entreprise (bénéfice net = revenus − coûts).
                    totalCosts: totNet + entBack,
                },
            });
        }).catch(err => res.status(500).json({ error: err.message }));
    });
};
