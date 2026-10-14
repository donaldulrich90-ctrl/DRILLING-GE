// Module Présence / Pointage (Forage) — pointages d'entrée/sortie des employés
// et gabarits biométriques enrôlés. Alimenté par le kiosque (lecteur d'empreinte
// via l'agent local) ou saisi manuellement par les RH.

const WRITE_ROLES = new Set(['admin', 'gestionnaire', 'gestionnaire_site', 'superviseur', 'ingenieur', 'platform_owner', 'santesecurite']);

function text(v, max) { if (v == null) return ''; var s = String(v); return s.length > max ? s.slice(0, max) : s; }
function isIsoish(s) { return typeof s === 'string' && /\d{4}-\d{2}-\d{2}/.test(s); }

module.exports = function registerAttendanceRoutes(app, options) {
    const { db, getEnterpriseId } = options;

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

    // ── Pointages ────────────────────────────────────────────────────────────

    // Liste des pointages (filtrable par date AAAA-MM-JJ et/ou employé).
    app.get('/api/attendance', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        const where = ['a.enterpriseId = ?'];
        const params = [eid];
        const date = text(req.query.date, 10);
        if (isIsoish(date)) { where.push("substr(a.ts,1,10) = ?"); params.push(date.slice(0, 10)); }
        if (req.query.from && isIsoish(String(req.query.from))) { where.push("substr(a.ts,1,10) >= ?"); params.push(String(req.query.from).slice(0, 10)); }
        if (req.query.to && isIsoish(String(req.query.to))) { where.push("substr(a.ts,1,10) <= ?"); params.push(String(req.query.to).slice(0, 10)); }
        if (req.query.employeeId) { where.push('a.employeeId = ?'); params.push(Number(req.query.employeeId) || 0); }
        const sql = 'SELECT a.*, e.name AS employeeName, e.employeeNumber AS employeeNumber, e.role AS employeeRole ' +
            'FROM attendance a LEFT JOIN employees e ON e.id = a.employeeId ' +
            'WHERE ' + where.join(' AND ') + ' ORDER BY a.ts DESC LIMIT 2000';
        db.all(sql, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    // Synthèse « présents aujourd'hui » : dernier pointage par employé sur la journée.
    app.get('/api/attendance/today', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        const day = isIsoish(text(req.query.date, 10)) ? String(req.query.date).slice(0, 10) : new Date().toISOString().slice(0, 10);
        const sql = 'SELECT a.employeeId, e.name AS employeeName, e.employeeNumber, e.role AS employeeRole, ' +
            "MIN(CASE WHEN a.type='in' THEN a.ts END) AS firstIn, " +
            "MAX(CASE WHEN a.type='out' THEN a.ts END) AS lastOut, " +
            'MAX(a.ts) AS lastTs, ' +
            "(SELECT type FROM attendance x WHERE x.enterpriseId=a.enterpriseId AND x.employeeId=a.employeeId AND substr(x.ts,1,10)=? ORDER BY x.ts DESC LIMIT 1) AS lastType, " +
            'COUNT(*) AS punches ' +
            'FROM attendance a LEFT JOIN employees e ON e.id=a.employeeId ' +
            'WHERE a.enterpriseId=? AND substr(a.ts,1,10)=? GROUP BY a.employeeId ORDER BY e.name';
        db.all(sql, [day, eid, day], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ date: day, rows: rows || [] });
        });
    });

    // Enregistre un pointage (kiosque / manuel). { employeeId, type, method, deviceId, ts?, note? }
    app.post('/api/attendance/punch', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const b = req.body || {};
        const employeeId = Number(b.employeeId) || 0;
        if (!employeeId) return res.status(400).json({ error: 'employeeId requis' });
        const type = (b.type === 'out') ? 'out' : (b.type === 'in' ? 'in' : 'in');
        const method = text(b.method, 20) || 'fingerprint';
        const deviceId = text(b.deviceId, 60);
        const note = text(b.note, 300);
        const ts = isIsoish(text(b.ts, 40)) ? new Date(b.ts).toISOString() : new Date().toISOString();
        const by = actor(req);
        // L'employé doit appartenir au tenant.
        db.get('SELECT id, siteId FROM employees WHERE id = ? AND enterpriseId = ?', [employeeId, eid], (e0, emp) => {
            if (e0) return res.status(500).json({ error: e0.message });
            if (!emp) return res.status(404).json({ error: 'Employé introuvable dans cette entreprise' });
            db.run(
                `INSERT OR IGNORE INTO attendance (enterpriseId, employeeId, type, ts, method, deviceId, source, siteId, note, createdBy)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
                [eid, employeeId, type, ts, method, deviceId, text(b.source, 20) || 'kiosk', emp.siteId || null, note, by],
                function (iErr) {
                    if (iErr) return res.status(500).json({ error: iErr.message });
                    const duplicate = this.changes === 0;
                    db.get('SELECT a.*, e.name AS employeeName FROM attendance a LEFT JOIN employees e ON e.id=a.employeeId WHERE a.id = ?', [this.lastID], (gErr, row) => {
                        res.json({ ok: true, duplicate, punch: row || { id: this.lastID, employeeId, type, ts, method } });
                    });
                }
            );
        });
    });

    // Import groupé depuis l'agent (terminaux ZKTeco réseau). { punches:[{employeeId|deviceUserId, type, ts}], deviceId }
    app.post('/api/attendance/sync', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const b = req.body || {};
        const list = Array.isArray(b.punches) ? b.punches.slice(0, 5000) : [];
        if (!list.length) return res.json({ ok: true, inserted: 0, ignored: 0 });
        const deviceId = text(b.deviceId, 60);
        // Map deviceUserId -> employeeId via les gabarits enrôlés.
        db.all('SELECT employeeId, deviceUserId FROM employee_biometrics WHERE enterpriseId = ? AND deviceUserId <> ""', [eid], (mErr, maps) => {
            if (mErr) return res.status(500).json({ error: mErr.message });
            const byDevUser = {};
            (maps || []).forEach((m) => { if (m.deviceUserId) byDevUser[String(m.deviceUserId)] = m.employeeId; });
            let inserted = 0, ignored = 0, pending = 0, done = false;
            const finish = () => { if (!done && pending === 0) { done = true; res.json({ ok: true, inserted, ignored }); } };
            const stmt = db.prepare('INSERT OR IGNORE INTO attendance (enterpriseId, employeeId, type, ts, method, deviceId, source) VALUES (?,?,?,?,?,?,?)');
            list.forEach((p) => {
                let employeeId = Number(p.employeeId) || 0;
                if (!employeeId && p.deviceUserId != null) employeeId = byDevUser[String(p.deviceUserId)] || 0;
                const ts = isIsoish(text(p.ts, 40)) ? new Date(p.ts).toISOString() : null;
                if (!employeeId || !ts) { ignored++; return; }
                const type = (p.type === 'out') ? 'out' : 'in';
                pending++;
                stmt.run([eid, employeeId, type, ts, 'fingerprint', deviceId, 'device'], function (e) {
                    if (!e && this.changes > 0) inserted++; else ignored++;
                    pending--; finish();
                });
            });
            stmt.finalize();
            if (pending === 0) finish();
        });
    });

    // Supprime un pointage (correction RH).
    app.delete('/api/attendance/:id', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        db.run('DELETE FROM attendance WHERE id = ? AND enterpriseId = ?', [Number(req.params.id) || 0, eid], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true, deleted: this.changes });
        });
    });

    // ── Biométrie (gabarits enrôlés) ─────────────────────────────────────────

    // Liste des employés enrôlés (sans exposer les gabarits).
    app.get('/api/attendance/enrollments', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        db.all('SELECT b.id, b.employeeId, b.finger, b.deviceUserId, b.quality, b.updatedAt, e.name AS employeeName, e.employeeNumber ' +
            'FROM employee_biometrics b LEFT JOIN employees e ON e.id=b.employeeId WHERE b.enterpriseId = ? ORDER BY e.name', [eid], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    // Gabarits d'un employé (template inclus — utilisé par le kiosque pour l'identification locale).
    app.get('/api/employees/:id/biometrics', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        db.all('SELECT * FROM employee_biometrics WHERE enterpriseId = ? AND employeeId = ?', [eid, Number(req.params.id) || 0], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    // Tous les gabarits du tenant (le kiosque les charge pour l'identification 1:N via l'agent).
    app.get('/api/attendance/templates', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        db.all('SELECT employeeId, finger, template, format, deviceUserId FROM employee_biometrics WHERE enterpriseId = ?', [eid], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    // Enrôle / met à jour le gabarit d'un employé. { template, finger?, format?, deviceUserId?, quality? }
    app.post('/api/employees/:id/biometrics', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const employeeId = Number(req.params.id) || 0;
        const b = req.body || {};
        const template = text(b.template, 200000);
        if (!template) return res.status(400).json({ error: 'template requis' });
        const finger = text(b.finger, 30);
        const format = text(b.format, 20) || 'zk';
        const deviceUserId = text(b.deviceUserId, 40);
        const quality = Number(b.quality) || 0;
        const by = actor(req);
        const now = new Date().toISOString();
        db.get('SELECT id FROM employees WHERE id = ? AND enterpriseId = ?', [employeeId, eid], (e0, emp) => {
            if (e0) return res.status(500).json({ error: e0.message });
            if (!emp) return res.status(404).json({ error: 'Employé introuvable dans cette entreprise' });
            db.run(
                `INSERT INTO employee_biometrics (enterpriseId, employeeId, finger, template, format, deviceUserId, quality, createdBy, createdAt, updatedAt)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
                [eid, employeeId, finger, template, format, deviceUserId, quality, by, now, now],
                function (iErr) {
                    if (iErr) return res.status(500).json({ error: iErr.message });
                    res.json({ ok: true, id: this.lastID });
                }
            );
        });
    });

    // Supprime un gabarit (ré-enrôlement).
    app.delete('/api/employees/:id/biometrics/:bioId', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        db.run('DELETE FROM employee_biometrics WHERE id = ? AND employeeId = ? AND enterpriseId = ?',
            [Number(req.params.bioId) || 0, Number(req.params.id) || 0, eid], function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ ok: true, deleted: this.changes });
            });
    });
};
