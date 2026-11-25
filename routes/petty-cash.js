/**
 * Petit cash / caisse (GEDRILLING)
 *
 * Journal de caisse simple : approvisionnements (entrées) et dépenses (sorties),
 * par catégorie, avec solde courant. Multi-devise (XOF par défaut), scopé par
 * enterpriseId, et optionnellement rattaché à un site.
 *
 *   direction : 'in'  = approvisionnement (entrée de caisse)
 *               'out' = dépense (sortie de caisse)
 */
const path = require('path');
const fs = require('fs');
const multer = require('multer');

module.exports = function registerPettyCashRoutes(app, { db, getEnterpriseId }) {
    function qAll(sql, p) { return new Promise((ok, f) => db.all(sql, p, (e, r) => e ? f(e) : ok(r || []))); }
    function qRun(sql, p) { return new Promise((ok, f) => db.run(sql, p, function (e) { e ? f(e) : ok({ lastID: this.lastID, changes: this.changes }); })); }
    function qOne(sql, p) { return new Promise((ok, f) => db.get(sql, p, (e, r) => e ? f(e) : ok(r || null))); }
    function reqEid(req, res) { const e = getEnterpriseId(req); if (!e) { res.status(400).json({ error: 'Contexte entreprise requis' }); return null; } return e; }
    function text(v, max) { if (v == null) return ''; const s = String(v); return s.length > max ? s.slice(0, max) : s; }
    function username(req) { return (req.auth && req.auth.username) || ''; }
    function tenantOf(req) { const e = getEnterpriseId(req); return (e == null || Number.isNaN(Number(e))) ? '0' : String(e); }

    // Justificatif (photo / PDF) joint à une écriture de caisse.
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(__dirname, '..', 'uploads', 'pettycash', tenantOf(req));
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const safe = String(file.originalname || 'justificatif').replace(/[^\w.\-]+/g, '_').slice(-80);
            cb(null, Date.now() + '_' + safe);
        }
    });
    const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS petty_cash_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            date TEXT NOT NULL,
            direction TEXT NOT NULL DEFAULT 'out',
            category TEXT DEFAULT '',
            label TEXT NOT NULL DEFAULT '',
            amount REAL DEFAULT 0,
            currency TEXT DEFAULT 'XOF',
            siteId INTEGER,
            person TEXT DEFAULT '',
            reference TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            attachment TEXT DEFAULT '',
            createdByUsername TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_petty_ent ON petty_cash_entries(enterpriseId, date)');
        db.run("ALTER TABLE petty_cash_entries ADD COLUMN attachment TEXT DEFAULT ''", (e) => {
            if (e && !String(e.message || '').includes('duplicate column')) console.warn('petty_cash_entries.attachment:', e.message);
        });
    });

    // Liste + solde. Filtres optionnels : ?month=YYYY-MM, ?siteId=
    app.get('/api/petty-cash', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const month = String(req.query.month || '').slice(0, 7);
        const siteId = req.query.siteId ? Number(req.query.siteId) : null;
        try {
            let sql = 'SELECT * FROM petty_cash_entries WHERE enterpriseId = ?';
            const p = [eid];
            if (/^\d{4}-\d{2}$/.test(month)) { sql += " AND substr(date,1,7) = ?"; p.push(month); }
            if (siteId) { sql += ' AND siteId = ?'; p.push(siteId); }
            sql += ' ORDER BY date DESC, id DESC';
            const rows = await qAll(sql, p);
            // Solde global (toutes périodes) par devise — le solde réel ne dépend pas du filtre mois.
            const allSql = 'SELECT direction, currency, SUM(amount) AS s FROM petty_cash_entries WHERE enterpriseId = ?' +
                (siteId ? ' AND siteId = ?' : '') + ' GROUP BY direction, currency';
            const allP = siteId ? [eid, siteId] : [eid];
            const sums = await qAll(allSql, allP);
            const balances = {};
            sums.forEach(r => {
                const cur = r.currency || 'XOF';
                balances[cur] = balances[cur] || { in: 0, out: 0, balance: 0 };
                if (r.direction === 'in') balances[cur].in += Number(r.s) || 0;
                else balances[cur].out += Number(r.s) || 0;
            });
            Object.keys(balances).forEach(c => { balances[c].balance = balances[c].in - balances[c].out; });
            res.json({ entries: rows, balances });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Création avec photo/justificatif optionnel (multipart). Champs en texte.
    app.post('/api/petty-cash', (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        upload.single('attachment')(req, res, async (upErr) => {
            if (upErr) return res.status(400).json({ error: upErr.message });
            const b = req.body || {};
            const date = text(b.date, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date (AAAA-MM-JJ) requise' });
            const direction = b.direction === 'in' ? 'in' : 'out';
            const label = text(b.label, 200).trim();
            if (!label) return res.status(400).json({ error: 'Libellé requis' });
            const amount = Number(b.amount);
            if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Montant invalide' });
            const url = req.file ? ('/uploads/pettycash/' + eid + '/' + req.file.filename) : '';
            try {
                const r = await qRun(
                    `INSERT INTO petty_cash_entries (enterpriseId, date, direction, category, label, amount, currency, siteId, person, reference, notes, attachment, createdByUsername)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [eid, date, direction, text(b.category, 80), label, amount, text(b.currency, 8) || 'XOF',
                     b.siteId ? Number(b.siteId) : null, text(b.person, 120), text(b.reference, 80), text(b.notes, 1000), url, username(req)]);
                res.status(201).json({ id: r.lastID, attachment: url });
            } catch (e) { res.status(500).json({ error: e.message }); }
        });
    });

    app.put('/api/petty-cash/:id', (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        upload.single('attachment')(req, res, async (upErr) => {
            if (upErr) return res.status(400).json({ error: upErr.message });
            const b = req.body || {};
            const date = text(b.date, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date (AAAA-MM-JJ) requise' });
            const direction = b.direction === 'in' ? 'in' : 'out';
            const label = text(b.label, 200).trim();
            if (!label) return res.status(400).json({ error: 'Libellé requis' });
            const amount = Number(b.amount);
            if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Montant invalide' });
            try {
                // Une nouvelle photo remplace l'ancienne ; sinon on garde le justificatif existant.
                let setAttach = '', attachVal = null;
                if (req.file) { setAttach = ', attachment=?'; attachVal = '/uploads/pettycash/' + eid + '/' + req.file.filename; }
                const params = [date, direction, text(b.category, 80), label, amount, text(b.currency, 8) || 'XOF',
                    b.siteId ? Number(b.siteId) : null, text(b.person, 120), text(b.reference, 80), text(b.notes, 1000)];
                if (req.file) params.push(attachVal);
                params.push(Number(req.params.id), eid);
                const r = await qRun(
                    `UPDATE petty_cash_entries SET date=?, direction=?, category=?, label=?, amount=?, currency=?, siteId=?, person=?, reference=?, notes=?${setAttach}
                     WHERE id=? AND enterpriseId=?`, params);
                if (!r.changes) return res.status(404).json({ error: 'Écriture introuvable' });
                res.json({ ok: true, attachment: attachVal || undefined });
            } catch (e) { res.status(500).json({ error: e.message }); }
        });
    });

    app.delete('/api/petty-cash/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            await qRun('DELETE FROM petty_cash_entries WHERE id=? AND enterpriseId=?', [Number(req.params.id), eid]);
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
};
