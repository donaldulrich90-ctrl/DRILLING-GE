// Module Présence / Pointage (Forage) — pointages d'entrée/sortie des employés
// et gabarits biométriques enrôlés. Alimenté par le kiosque (lecteur d'empreinte
// via l'agent local) ou saisi manuellement par les RH.

const crypto = require('crypto');

const WRITE_ROLES = new Set(['admin', 'gestionnaire', 'gestionnaire_site', 'superviseur', 'ingenieur', 'platform_owner', 'santesecurite']);

function text(v, max) { if (v == null) return ''; var s = String(v); return s.length > max ? s.slice(0, max) : s; }
function isIsoish(s) { return typeof s === 'string' && /\d{4}-\d{2}-\d{2}/.test(s); }

// ── WebAuthn (empreinte de l'appareil : téléphone / PC) ──────────────────────
// Défis à usage unique, courte durée de vie, en mémoire (serveur unique).
const _waChallenges = new Map(); // challenge(base64url) -> expiry(ms)
function waNewChallenge() {
    const c = crypto.randomBytes(32).toString('base64url');
    _waChallenges.set(c, Date.now() + 5 * 60 * 1000);
    if (_waChallenges.size > 5000) { const now = Date.now(); for (const [k, v] of _waChallenges) if (v < now) _waChallenges.delete(k); }
    return c;
}
function waConsumeChallenge(c) {
    if (!c || !_waChallenges.has(c)) return false;
    const exp = _waChallenges.get(c); _waChallenges.delete(c);
    return exp >= Date.now();
}
function b64urlToBuf(s) { return Buffer.from(String(s || ''), 'base64url'); }
function parseClientData(clientDataB64) {
    try { return JSON.parse(b64urlToBuf(clientDataB64).toString('utf8')); } catch (e) { return null; }
}
// Vérifie l'assertion WebAuthn (signature de l'appareil) contre la clé publique stockée (SPKI DER).
function waVerifyAssertion(publicKeySpkiB64, authDataB64, clientDataB64, signatureB64) {
    try {
        const keyObj = crypto.createPublicKey({ key: Buffer.from(publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' });
        const authData = b64urlToBuf(authDataB64);
        const clientHash = crypto.createHash('sha256').update(b64urlToBuf(clientDataB64)).digest();
        const signed = Buffer.concat([authData, clientHash]);
        const sig = b64urlToBuf(signatureB64);
        const isEc = keyObj.asymmetricKeyType === 'ec';
        return crypto.verify('sha256', signed, isEc ? { key: keyObj, dsaEncoding: 'der' } : keyObj, sig);
    } catch (e) { return false; }
}

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

    // Gabarits « lecteur » du tenant (le kiosque USB les charge pour l'identification 1:N via l'agent).
    // Exclut les identifiants WebAuthn (empreinte de l'appareil), traités à part.
    app.get('/api/attendance/templates', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        db.all("SELECT employeeId, finger, template, format, deviceUserId FROM employee_biometrics WHERE enterpriseId = ? AND format <> 'webauthn'", [eid], (err, rows) => {
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

    // ── Pointage par empreinte de l'appareil (WebAuthn : téléphone / PC) ──────

    // Détermine entrée/sortie en basculant depuis le dernier pointage du jour, puis insère.
    function recordPunchToggle(eid, employeeId, method, deviceId, source, cb) {
        const day = new Date().toISOString().slice(0, 10);
        db.get("SELECT type FROM attendance WHERE enterpriseId=? AND employeeId=? AND substr(ts,1,10)=? ORDER BY ts DESC LIMIT 1",
            [eid, employeeId, day], (e, row) => {
                const type = (row && row.type === 'in') ? 'out' : 'in';
                const ts = new Date().toISOString();
                db.run('INSERT OR IGNORE INTO attendance (enterpriseId, employeeId, type, ts, method, deviceId, source) VALUES (?,?,?,?,?,?,?)',
                    [eid, employeeId, type, ts, method, deviceId, source], function (ie) {
                        if (ie) return cb(ie);
                        cb(null, { type, ts });
                    });
            });
    }

    // Défi à usage unique (anti-rejeu) pour enrôler ou pointer.
    app.get('/api/attendance/webauthn/challenge', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        res.json({ challenge: waNewChallenge(), rpId: req.hostname });
    });

    // Identifiants WebAuthn enrôlés (pour construire allowCredentials côté client).
    app.get('/api/attendance/webauthn/credentials', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        db.all("SELECT employeeId, template AS credentialId FROM employee_biometrics WHERE enterpriseId = ? AND format = 'webauthn'", [eid], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    // Enrôle l'empreinte de l'appareil pour un employé. { credentialId, publicKey, clientDataJSON, finger? }
    app.post('/api/employees/:id/webauthn/register', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const employeeId = Number(req.params.id) || 0;
        const b = req.body || {};
        const credentialId = text(b.credentialId, 1000);
        const publicKey = text(b.publicKey, 4000);
        if (!credentialId || !publicKey) return res.status(400).json({ error: 'credentialId et publicKey requis' });
        const cd = parseClientData(b.clientDataJSON);
        if (!cd || cd.type !== 'webauthn.create' || !waConsumeChallenge(cd.challenge)) {
            return res.status(400).json({ error: 'Attestation invalide (défi ou type)' });
        }
        db.get('SELECT id FROM employees WHERE id = ? AND enterpriseId = ?', [employeeId, eid], (e0, emp) => {
            if (e0) return res.status(500).json({ error: e0.message });
            if (!emp) return res.status(404).json({ error: 'Employé introuvable dans cette entreprise' });
            const now = new Date().toISOString();
            db.run(
                `INSERT INTO employee_biometrics (enterpriseId, employeeId, finger, template, format, publicKey, deviceUserId, quality, createdBy, createdAt, updatedAt)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                [eid, employeeId, text(b.finger, 30) || 'appareil', credentialId, 'webauthn', publicKey, '', 0, actor(req), now, now],
                function (iErr) {
                    if (iErr) return res.status(500).json({ error: iErr.message });
                    res.json({ ok: true, id: this.lastID });
                }
            );
        });
    });

    // Pointe un employé après vérification de l'empreinte de l'appareil.
    // { credentialId, authenticatorData, clientDataJSON, signature, deviceId? }
    app.post('/api/attendance/webauthn/punch', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        const b = req.body || {};
        const credentialId = text(b.credentialId, 1000);
        if (!credentialId) return res.status(400).json({ error: 'credentialId requis' });
        const cd = parseClientData(b.clientDataJSON);
        if (!cd || cd.type !== 'webauthn.get' || !waConsumeChallenge(cd.challenge)) {
            return res.status(400).json({ error: 'Assertion invalide (défi ou type)' });
        }
        db.get("SELECT employeeId, publicKey FROM employee_biometrics WHERE enterpriseId = ? AND format='webauthn' AND template = ?", [eid, credentialId], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Appareil non enrôlé' });
            if (!waVerifyAssertion(row.publicKey, b.authenticatorData, b.clientDataJSON, b.signature)) {
                return res.status(401).json({ error: 'Empreinte non vérifiée' });
            }
            recordPunchToggle(eid, row.employeeId, 'webauthn', text(b.deviceId, 60) || 'appareil', 'webauthn', (e2, r) => {
                if (e2) return res.status(500).json({ error: e2.message });
                db.get('SELECT name FROM employees WHERE id = ?', [row.employeeId], (e3, emp) => {
                    res.json({ ok: true, employeeId: row.employeeId, employeeName: emp ? emp.name : '', type: r.type, ts: r.ts });
                });
            });
        });
    });
};
