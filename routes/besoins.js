// Module Expressions de besoin — demandes de matériel/ressources par entreprise,
// avec circuit de validation (En attente -> Approuvée / Refusée -> Traitée).
// Même convention que routes/planification.js : table créée au démarrage,
// endpoints multi-tenant.

const VALIDATE_ROLES = new Set([
    'admin',
    'gestionnaire',
    'gestionnaire_site',
    'superviseur',
    'ingenieur',
    'platform_owner'
]);

const STATUTS = new Set(['En attente', 'Approuvée', 'Refusée', 'Traitée']);
const URGENCES = new Set(['Normale', 'Urgente', 'Critique']);

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

module.exports = function registerBesoinsRoutes(app, options) {
    const { db, getEnterpriseId } = options;

    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS besoins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            designation TEXT NOT NULL,
            quantite REAL DEFAULT 0,
            unite TEXT DEFAULT '',
            categorie TEXT DEFAULT '',
            site TEXT DEFAULT '',
            urgence TEXT DEFAULT 'Normale',
            justification TEXT DEFAULT '',
            demandeurUsername TEXT DEFAULT '',
            demandeurNom TEXT DEFAULT '',
            statut TEXT NOT NULL DEFAULT 'En attente',
            valideParUsername TEXT DEFAULT '',
            valideParNom TEXT DEFAULT '',
            valideAt TEXT DEFAULT NULL,
            commentaire TEXT DEFAULT '',
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_besoins_enterprise ON besoins(enterpriseId)');
    });

    function resolveTenant(req, res) {
        const enterpriseId = getEnterpriseId(req);
        if (enterpriseId == null || Number.isNaN(Number(enterpriseId))) {
            res.status(400).json({ error: 'Contexte entreprise requis pour les expressions de besoin' });
            return null;
        }
        return Number(enterpriseId);
    }
    function canValidate(req) {
        return !!(req.auth && (req.auth.isSuperAdmin || req.auth.isPlatformOwner || VALIDATE_ROLES.has(req.auth.role)));
    }
    function actor(req) {
        return {
            username: text(req.auth && (req.auth.username || req.auth.user), 120),
            nom: text(req.auth && (req.auth.name || req.auth.displayName || req.auth.username), 200)
        };
    }

    // Liste des expressions de besoin de l'entreprise
    app.get('/api/besoins', (req, res) => {
        const enterpriseId = resolveTenant(req, res);
        if (enterpriseId == null) return;
        db.all('SELECT * FROM besoins WHERE enterpriseId = ? ORDER BY datetime(createdAt) DESC, id DESC', [enterpriseId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            return res.json(rows || []);
        });
    });

    // Création d'une expression de besoin (tout utilisateur authentifié)
    app.post('/api/besoins', (req, res) => {
        if (!req.auth) return res.status(401).json({ error: 'Authentification requise' });
        const enterpriseId = resolveTenant(req, res);
        if (enterpriseId == null) return;
        const b = req.body || {};
        const designation = text(b.designation, 300).trim();
        if (!designation) return res.status(400).json({ error: 'La désignation est obligatoire' });
        const a = actor(req);
        const now = new Date().toISOString();
        const urgence = URGENCES.has(b.urgence) ? b.urgence : 'Normale';
        db.run(
            `INSERT INTO besoins (enterpriseId, designation, quantite, unite, categorie, site, urgence, justification, demandeurUsername, demandeurNom, statut, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'En attente', ?, ?)`,
            [enterpriseId, designation, num(b.quantite, 0, 1e9, 0), text(b.unite, 40), text(b.categorie, 120), text(b.site, 160), urgence, text(b.justification, 3000), a.username, a.nom, now, now],
            function (insErr) {
                if (insErr) return res.status(500).json({ error: insErr.message });
                db.get('SELECT * FROM besoins WHERE id = ?', [this.lastID], (gErr, row) => {
                    if (gErr) return res.status(500).json({ error: gErr.message });
                    return res.json(row);
                });
            }
        );
    });

    // Mise à jour du statut / workflow (rôles de validation uniquement)
    app.put('/api/besoins/:id', (req, res) => {
        const enterpriseId = resolveTenant(req, res);
        if (enterpriseId == null) return;
        if (!canValidate(req)) return res.status(403).json({ error: 'Droits insuffisants pour traiter une expression de besoin' });
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'Identifiant invalide' });
        const b = req.body || {};
        const statut = STATUTS.has(b.statut) ? b.statut : null;
        if (!statut) return res.status(400).json({ error: 'Statut invalide' });
        const a = actor(req);
        const now = new Date().toISOString();
        db.get('SELECT id FROM besoins WHERE id = ? AND enterpriseId = ?', [id, enterpriseId], (gErr, exist) => {
            if (gErr) return res.status(500).json({ error: gErr.message });
            if (!exist) return res.status(404).json({ error: 'Expression de besoin introuvable' });
            db.run(
                `UPDATE besoins SET statut = ?, commentaire = ?, valideParUsername = ?, valideParNom = ?, valideAt = ?, updatedAt = ? WHERE id = ? AND enterpriseId = ?`,
                [statut, text(b.commentaire, 3000), a.username, a.nom, now, now, id, enterpriseId],
                (uErr) => {
                    if (uErr) return res.status(500).json({ error: uErr.message });
                    db.get('SELECT * FROM besoins WHERE id = ?', [id], (g2, row) => {
                        if (g2) return res.status(500).json({ error: g2.message });
                        return res.json(row);
                    });
                }
            );
        });
    });
};
