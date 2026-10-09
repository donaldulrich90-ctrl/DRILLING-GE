// Module Expression de besoin (Forage) — demandes partagées à toute l'entreprise,
// avec pièces jointes et circuit allouer → exécuter → vérifier → valider.

const path = require('path');
const fs = require('fs');
const multer = require('multer');

const WRITE_ROLES = new Set(['admin', 'gestionnaire', 'gestionnaire_site', 'superviseur', 'ingenieur', 'platform_owner', 'operateur']);
const TYPES = new Set(['Matériel', 'Pièce', 'Consommable', 'Carburant', 'Service', 'Autre']);
const PRIOS = new Set(['normal', 'urgent', 'critique']);
const STATUTS = new Set(['nouveau', 'assigne', 'traite', 'verifie', 'valide', 'rejete']);

function text(v, max) { if (v == null) return ''; var s = String(v); return s.length > max ? s.slice(0, max) : s; }
function num(v, min, max, fb) { var n = Number(v); if (!Number.isFinite(n)) return fb; if (min != null && n < min) n = min; if (max != null && n > max) n = max; return n; }

module.exports = function registerBesoinsRoutes(app, options) {
    const { db, getEnterpriseId } = options;

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS besoins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            numero TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            createdBy TEXT DEFAULT '',
            site TEXT DEFAULT '',
            type TEXT DEFAULT 'Matériel',
            designation TEXT DEFAULT '',
            quantite REAL DEFAULT 0,
            unite TEXT DEFAULT '',
            priorite TEXT DEFAULT 'normal',
            justification TEXT DEFAULT '',
            statut TEXT NOT NULL DEFAULT 'nouveau',
            assignee TEXT DEFAULT '',
            verificateur TEXT DEFAULT '',
            validateur TEXT DEFAULT '',
            attachments TEXT DEFAULT '[]',
            history TEXT DEFAULT '[]',
            updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_besoins_enterprise ON besoins(enterpriseId)');
    });

    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(__dirname, '..', 'uploads', 'besoins', String(resolveTenant(req) || '0'));
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
    function rowOut(r) {
        let att = [], hist = [];
        try { att = JSON.parse(r.attachments || '[]'); } catch (e) {}
        try { hist = JSON.parse(r.history || '[]'); } catch (e) {}
        return Object.assign({}, r, { attachments: att, history: hist });
    }

    app.get('/api/besoins', (req, res) => {
        const eid = tenantOr400(req, res); if (eid == null) return;
        db.all('SELECT * FROM besoins WHERE enterpriseId = ? ORDER BY id DESC', [eid], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json((rows || []).map(rowOut));
        });
    });

    app.post('/api/besoins', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const b = req.body || {};
        const type = TYPES.has(b.type) ? b.type : 'Matériel';
        const priorite = PRIOS.has(b.priorite) ? b.priorite : 'normal';
        const designation = text(b.designation, 400);
        if (!designation) return res.status(400).json({ error: 'Désignation requise' });
        const now = new Date().toISOString();
        const by = actor(req);
        const hist = JSON.stringify([{ at: now, by, action: 'création' }]);
        db.get('SELECT COUNT(*) AS n FROM besoins WHERE enterpriseId = ?', [eid], (cErr, cRow) => {
            const numero = 'EB-' + eid + '-' + String((cRow ? cRow.n : 0) + 1).padStart(4, '0');
            db.run(
                `INSERT INTO besoins (enterpriseId, numero, createdAt, createdBy, site, type, designation, quantite, unite, priorite, justification, statut, history, updatedAt)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?, 'nouveau', ?, ?)`,
                [eid, numero, now, by, text(b.site, 160), type, designation, num(b.quantite, 0, 1e9, 0), text(b.unite, 40), priorite, text(b.justification, 3000), hist, now],
                function (iErr) {
                    if (iErr) return res.status(500).json({ error: iErr.message });
                    db.get('SELECT * FROM besoins WHERE id = ?', [this.lastID], (gErr, row) => {
                        if (gErr) return res.status(500).json({ error: gErr.message });
                        res.json(rowOut(row));
                    });
                }
            );
        });
    });

    // Action de workflow : assign / execute / verify / validate / reject
    app.put('/api/besoins/:id', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        const id = Number(req.params.id);
        const b = req.body || {};
        const action = text(b.action, 20);
        db.get('SELECT * FROM besoins WHERE id = ? AND enterpriseId = ?', [id, eid], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Demande introuvable' });
            let statut = row.statut, assignee = row.assignee, verificateur = row.verificateur, validateur = row.validateur;
            const by = actor(req), now = new Date().toISOString();
            let label = '';
            if (action === 'assign') { assignee = text(b.assignee, 120); statut = 'assigne'; label = 'allouée à ' + assignee; }
            else if (action === 'execute') { statut = 'traite'; label = 'exécutée (marquée faite)'; }
            else if (action === 'verify') { verificateur = by; statut = 'verifie'; label = 'vérifiée'; }
            else if (action === 'validate') { validateur = by; statut = 'valide'; label = 'validée'; }
            else if (action === 'reject') { statut = 'rejete'; label = 'rejetée'; }
            else return res.status(400).json({ error: 'Action inconnue' });
            if (!STATUTS.has(statut)) statut = row.statut;
            let hist = []; try { hist = JSON.parse(row.history || '[]'); } catch (e) {}
            hist.push({ at: now, by, action: label, comment: text(b.comment, 1000) });
            db.run('UPDATE besoins SET statut=?, assignee=?, verificateur=?, validateur=?, history=?, updatedAt=? WHERE id=? AND enterpriseId=?',
                [statut, assignee, verificateur, validateur, JSON.stringify(hist), now, id, eid], (uErr) => {
                    if (uErr) return res.status(500).json({ error: uErr.message });
                    db.get('SELECT * FROM besoins WHERE id = ?', [id], (gErr, r2) => res.json(rowOut(r2)));
                });
        });
    });

    // Pièce jointe
    app.post('/api/besoins/:id/attachment', (req, res) => {
        if (!canWrite(req)) return res.status(403).json({ error: 'Droits insuffisants' });
        const eid = tenantOr400(req, res); if (eid == null) return;
        upload.single('file')(req, res, (upErr) => {
            if (upErr) return res.status(400).json({ error: upErr.message });
            if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
            const id = Number(req.params.id);
            const url = '/uploads/besoins/' + eid + '/' + req.file.filename;
            db.get('SELECT attachments FROM besoins WHERE id = ? AND enterpriseId = ?', [id, eid], (err, row) => {
                if (err || !row) return res.status(404).json({ error: 'Demande introuvable' });
                let att = []; try { att = JSON.parse(row.attachments || '[]'); } catch (e) {}
                att.push({ name: text(req.file.originalname, 200), url, at: new Date().toISOString() });
                db.run('UPDATE besoins SET attachments=?, updatedAt=? WHERE id=? AND enterpriseId=?',
                    [JSON.stringify(att), new Date().toISOString(), id, eid], (uErr) => {
                        if (uErr) return res.status(500).json({ error: uErr.message });
                        res.json({ attachments: att });
                    });
            });
        });
    });
};
