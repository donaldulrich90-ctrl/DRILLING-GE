/**
 * Catalogue matériel codifié (GEDRILLING)
 *
 * Donne au stock une structure « material master » comme dans les grandes
 * entreprises minières : des FAMILLES de matériel codées, un CATALOGUE de
 * référence (articles types avec code, unité, référence fournisseur), et un
 * code article (FAMILLE-####) pour chaque article d'inventaire.
 *
 * - material_families  : les familles (code court + libellé), seed par défaut.
 * - material_catalog   : les articles types de référence, seed par défaut,
 *                        éditable (ajout/modif/suppression par l'entreprise).
 * - inventory.code / familyCode / reference : codification de chaque article.
 *
 * Seed paresseux : à la première lecture d'une entreprise, on insère le
 * catalogue standard pour cette entreprise, qui peut ensuite le personnaliser.
 *
 * Toutes les ressources sont scopées par enterpriseId.
 */

// ── Familles standard (code, libellé) ───────────────────────────────────────
const FAMILIES = [
    ['FOR', 'Forage — taillants & accessoires'],
    ['MFT', 'Marteau fond de trou (DTH)'],
    ['TIG', 'Tiges, raccords & tubage'],
    ['LUB', 'Lubrifiants & fluides'],
    ['FIL', 'Filtration'],
    ['HYD', 'Hydraulique'],
    ['MEC', 'Mécanique & transmission'],
    ['MOT', 'Moteur'],
    ['ELE', 'Électrique & câbles'],
    ['BAT', 'Batteries & énergie'],
    ['PNE', 'Pneumatiques & roues'],
    ['USU', "Pièces d'usure & structure"],
    ['LEV', 'Levage & élingage'],
    ['SOU', 'Soudure & découpe'],
    ['QUI', 'Quincaillerie & fixation'],
    ['ETC', 'Étanchéité & joints'],
    ['OUT', 'Outillage'],
    ['EPI', 'EPI & sécurité'],
    ['ATE', 'Consommables atelier'],
    ['CAR', 'Carburants & énergie'],
    ['TIR', 'Tir & accessoires'],
    ['BUR', 'Fournitures & divers'],
];

// ── Catalogue de référence : [familyCode, libellé, unité, référence?] ────────
// Les codes article (FOR-0001…) sont générés à l'insertion, par famille.
const CATALOG = [
    // FOR — Forage : taillants & accessoires
    ['FOR', 'Taillant à boutons DTH Ø90 mm', 'unité'],
    ['FOR', 'Taillant à boutons DTH Ø102 mm', 'unité'],
    ['FOR', 'Taillant à boutons DTH Ø115 mm', 'unité'],
    ['FOR', 'Taillant à boutons DTH Ø127 mm', 'unité'],
    ['FOR', 'Taillant à boutons DTH Ø140 mm', 'unité'],
    ['FOR', 'Taillant à boutons DTH Ø152 mm', 'unité'],
    ['FOR', 'Taillant tricône Ø200 mm', 'unité'],
    ['FOR', 'Taillant PDC Ø115 mm', 'unité'],
    ['FOR', 'Couronne diamantée imprégnée (carottage)', 'unité'],
    ['FOR', 'Couronne carbure', 'unité'],
    ['FOR', 'Élargisseur (reamer)', 'unité'],
    ['FOR', 'Boutons carbure de rechange', 'unité'],
    ['FOR', "Meule / lime d'affûtage boutons", 'unité'],
    ['FOR', 'Graisse à taillant (bit grease)', 'kg'],

    // MFT — Marteau fond de trou
    ['MFT', 'Marteau fond de trou 4"', 'unité'],
    ['MFT', 'Marteau fond de trou 5"', 'unité'],
    ['MFT', 'Marteau fond de trou 6"', 'unité'],
    ['MFT', 'Piston de marteau DTH', 'unité'],
    ['MFT', 'Chemise (cylindre) de marteau', 'unité'],
    ['MFT', 'Clapet anti-retour de marteau', 'unité'],
    ['MFT', 'Kit de réparation marteau DTH', 'kit'],
    ['MFT', 'Porte-taillant (driver sub)', 'unité'],
    ['MFT', 'Clé de démontage marteau', 'unité'],

    // TIG — Tiges, raccords & tubage
    ['TIG', 'Tige de forage DTH 76 mm × 3 m', 'unité'],
    ['TIG', 'Tige de forage DTH 89 mm × 3 m', 'unité'],
    ['TIG', 'Tige de forage DTH 102 mm × 3 m', 'unité'],
    ['TIG', 'Raccord (sub) mâle/femelle', 'unité'],
    ['TIG', 'Manchon de raccordement', 'unité'],
    ['TIG', 'Adaptateur de tête (shank adapter)', 'unité'],
    ['TIG', 'Tube de revêtement (casing) Ø115 mm', 'm'],
    ['TIG', 'Sabot de casing', 'unité'],
    ['TIG', 'Stabilisateur Ø152 mm', 'unité'],
    ['TIG', 'Amortisseur (shock sub)', 'unité'],

    // LUB — Lubrifiants & fluides
    ['LUB', 'Huile moteur 15W40', 'L'],
    ['LUB', 'Huile hydraulique ISO 68', 'L'],
    ['LUB', 'Huile hydraulique ISO 46', 'L'],
    ['LUB', 'Huile de transmission 80W90', 'L'],
    ['LUB', 'Huile de pont / différentiel', 'L'],
    ['LUB', 'Huile compresseur', 'L'],
    ['LUB', 'Graisse multi-usage EP2', 'kg'],
    ['LUB', 'Graisse haute température', 'kg'],
    ['LUB', 'Liquide de refroidissement', 'L'],
    ['LUB', 'Liquide de frein DOT4', 'L'],
    ['LUB', 'AdBlue', 'L'],

    // FIL — Filtration
    ['FIL', 'Filtre à huile moteur', 'unité'],
    ['FIL', 'Filtre à carburant', 'unité'],
    ['FIL', 'Séparateur eau/carburant', 'unité'],
    ['FIL', 'Filtre à air primaire', 'unité'],
    ['FIL', 'Filtre à air secondaire', 'unité'],
    ['FIL', 'Filtre hydraulique', 'unité'],
    ['FIL', 'Filtre de retour hydraulique', 'unité'],
    ['FIL', 'Filtre séparateur compresseur', 'unité'],
    ['FIL', 'Filtre déshydrateur (climatisation)', 'unité'],

    // HYD — Hydraulique
    ['HYD', 'Flexible hydraulique 1/2"', 'm'],
    ['HYD', 'Flexible hydraulique 3/4"', 'm'],
    ['HYD', 'Flexible hydraulique 1"', 'm'],
    ['HYD', 'Raccord hydraulique JIC', 'unité'],
    ['HYD', 'Raccord rapide hydraulique', 'unité'],
    ['HYD', 'Vérin hydraulique', 'unité'],
    ['HYD', 'Pompe hydraulique', 'unité'],
    ['HYD', 'Distributeur hydraulique', 'unité'],
    ['HYD', 'Kit de joints de vérin', 'kit'],
    ['HYD', 'Limiteur / clapet de pression', 'unité'],
    ['HYD', 'Accumulateur hydraulique', 'unité'],

    // MEC — Mécanique & transmission
    ['MEC', 'Courroie trapézoïdale', 'unité'],
    ['MEC', 'Courroie striée (poly-V)', 'unité'],
    ['MEC', 'Roulement à billes', 'unité'],
    ['MEC', 'Roulement à rouleaux', 'unité'],
    ['MEC', 'Palier (support de roulement)', 'unité'],
    ['MEC', "Bague d'étanchéité (joint spi)", 'unité'],
    ['MEC', 'Galet tendeur', 'unité'],
    ['MEC', 'Chaîne de transmission', 'm'],
    ['MEC', 'Pignon / roue dentée', 'unité'],
    ['MEC', 'Silentbloc / support moteur', 'unité'],
    ['MEC', 'Accouplement élastique', 'unité'],

    // MOT — Moteur
    ['MOT', 'Kit de joints moteur', 'kit'],
    ['MOT', 'Joint de culasse', 'unité'],
    ['MOT', 'Injecteur', 'unité'],
    ['MOT', "Pompe d'injection", 'unité'],
    ['MOT', 'Turbocompresseur', 'unité'],
    ['MOT', 'Pompe à eau', 'unité'],
    ['MOT', 'Thermostat', 'unité'],
    ['MOT', 'Démarreur', 'unité'],
    ['MOT', 'Alternateur', 'unité'],
    ['MOT', 'Bougie de préchauffage', 'unité'],

    // ELE — Électrique & câbles
    ['ELE', 'Câble électrique souple 3G2,5 mm²', 'm'],
    ['ELE', 'Câble électrique 4×16 mm²', 'm'],
    ['ELE', 'Câble de forage (trailing cable)', 'm'],
    ['ELE', 'Câble de batterie', 'm'],
    ['ELE', 'Disjoncteur', 'unité'],
    ['ELE', 'Contacteur / relais', 'unité'],
    ['ELE', 'Fusible', 'unité'],
    ['ELE', 'Interrupteur / sectionneur', 'unité'],
    ['ELE', 'Projecteur LED chantier', 'unité'],
    ['ELE', 'Ampoule / tube LED', 'unité'],
    ['ELE', 'Prise industrielle', 'unité'],
    ['ELE', 'Cosse / connecteur', 'unité'],
    ['ELE', 'Gaine / goulotte', 'm'],

    // BAT — Batteries & énergie
    ['BAT', 'Batterie 12V 100Ah', 'unité'],
    ['BAT', 'Batterie 12V 200Ah', 'unité'],
    ['BAT', 'Chargeur de batterie', 'unité'],
    ['BAT', 'Onduleur / convertisseur', 'unité'],
    ['BAT', 'Pièces groupe électrogène', 'unité'],

    // PNE — Pneumatiques & roues
    ['PNE', 'Pneu 14.00-24', 'unité'],
    ['PNE', 'Pneu 18.00-25', 'unité'],
    ['PNE', 'Pneu véhicule léger', 'unité'],
    ['PNE', 'Chambre à air', 'unité'],
    ['PNE', 'Jante', 'unité'],
    ['PNE', 'Valve de gonflage', 'unité'],
    ['PNE', 'Mèche / rustine de réparation', 'unité'],

    // USU — Pièces d'usure & structure
    ['USU', 'Dent de godet', 'unité'],
    ['USU', "Lame d'usure", 'unité'],
    ['USU', 'Patin de chenille', 'unité'],
    ['USU', 'Maillon de chenille', 'unité'],
    ['USU', 'Barbotin / roue folle', 'unité'],
    ['USU', "Tôle d'usure (Hardox)", 'unité'],

    // LEV — Levage & élingage
    ['LEV', 'Élingue textile', 'unité'],
    ['LEV', 'Élingue câble acier', 'unité'],
    ['LEV', 'Chaîne de levage', 'm'],
    ['LEV', 'Manille', 'unité'],
    ['LEV', 'Crochet de levage', 'unité'],
    ['LEV', 'Palan / treuil', 'unité'],
    ['LEV', 'Câble acier', 'm'],
    ['LEV', 'Sangle à cliquet', 'unité'],

    // SOU — Soudure & découpe
    ['SOU', 'Électrode de soudure Ø2,5 mm', 'kg'],
    ['SOU', 'Électrode de soudure Ø3,2 mm', 'kg'],
    ['SOU', 'Fil de soudure MIG', 'kg'],
    ['SOU', 'Disque à tronçonner', 'unité'],
    ['SOU', 'Disque à ébarber', 'unité'],
    ['SOU', "Bouteille d'oxygène", 'unité'],
    ['SOU', "Bouteille d'acétylène", 'unité'],
    ['SOU', 'Buse de chalumeau', 'unité'],
    ['SOU', 'Masque de soudure', 'unité'],

    // QUI — Quincaillerie & fixation
    ['QUI', 'Boulon HM (assortiment)', 'unité'],
    ['QUI', 'Écrou', 'unité'],
    ['QUI', 'Rondelle plate', 'unité'],
    ['QUI', 'Rondelle frein / grower', 'unité'],
    ['QUI', 'Vis à tôle', 'unité'],
    ['QUI', 'Goupille', 'unité'],
    ['QUI', 'Collier de serrage', 'unité'],
    ['QUI', 'Serre-câble', 'unité'],
    ['QUI', 'Cheville', 'unité'],

    // ETC — Étanchéité & joints
    ['ETC', 'Joint torique (assortiment)', 'unité'],
    ['ETC', 'Joint plat', 'unité'],
    ['ETC', 'Pâte à joint', 'unité'],
    ['ETC', "Ruban téflon", 'rouleau'],
    ['ETC', 'Presse-étoupe', 'unité'],

    // OUT — Outillage
    ['OUT', 'Jeu de clés plates', 'jeu'],
    ['OUT', 'Clé à choc', 'unité'],
    ['OUT', 'Clé dynamométrique', 'unité'],
    ["OUT", "Meuleuse d'angle", 'unité'],
    ['OUT', 'Perceuse', 'unité'],
    ['OUT', 'Pompe à graisse', 'unité'],
    ['OUT', 'Cric hydraulique', 'unité'],
    ['OUT', 'Multimètre', 'unité'],

    // EPI — EPI & sécurité
    ['EPI', 'Casque de chantier', 'unité'],
    ['EPI', 'Gants de travail', 'paire'],
    ['EPI', 'Chaussures de sécurité', 'paire'],
    ['EPI', 'Lunettes de protection', 'unité'],
    ['EPI', 'Protection auditive (casque/bouchons)', 'unité'],
    ['EPI', 'Masque anti-poussière', 'unité'],
    ['EPI', 'Gilet haute visibilité', 'unité'],
    ['EPI', 'Harnais de sécurité', 'unité'],
    ['EPI', 'Extincteur', 'unité'],

    // ATE — Consommables atelier
    ['ATE', 'Chiffon / torchon', 'kg'],
    ['ATE', 'Dégraissant / nettoyant', 'L'],
    ['ATE', 'Peinture antirouille', 'L'],
    ['ATE', 'Diluant', 'L'],
    ['ATE', 'Spray dégrippant', 'unité'],
    ['ATE', 'Frein-filet (loctite)', 'unité'],
    ['ATE', 'Colle / mastic', 'unité'],
    ['ATE', 'Papier abrasif', 'unité'],

    // CAR — Carburants & énergie
    ['CAR', 'Gasoil / Diesel', 'L'],
    ['CAR', 'Essence', 'L'],
    ['CAR', 'Pétrole lampant', 'L'],

    // TIR — Tir & accessoires (les explosifs restent gérés par l'entreprise de tir agréée)
    ['TIR', 'Bourrage (stemming)', 'sac'],
    ['TIR', 'Accessoires de tir — divers', 'unité'],

    // BUR — Fournitures & divers
    ['BUR', 'Fournitures de bureau', 'unité'],
    ['BUR', 'Article divers', 'unité'],
];

module.exports = function registerMaterialCatalogRoutes(app, { db, getEnterpriseId }) {
    function qAll(sql, p) { return new Promise((ok, f) => db.all(sql, p, (e, r) => e ? f(e) : ok(r || []))); }
    function qOne(sql, p) { return new Promise((ok, f) => db.get(sql, p, (e, r) => e ? f(e) : ok(r || null))); }
    function qRun(sql, p) { return new Promise((ok, f) => db.run(sql, p, function (e) { e ? f(e) : ok({ lastID: this.lastID, changes: this.changes }); })); }
    function reqEid(req, res) {
        const eid = getEnterpriseId(req);
        if (!eid) { res.status(400).json({ error: 'Contexte entreprise requis' }); return null; }
        return eid;
    }
    function text(v, max) { if (v == null) return ''; const s = String(v); return s.length > max ? s.slice(0, max) : s; }

    // ── Schéma ──────────────────────────────────────────────────────────────
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS material_families (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            code TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '',
            sortOrder INTEGER DEFAULT 0,
            isActive INTEGER DEFAULT 1,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(enterpriseId, code)
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_matfam_ent ON material_families(enterpriseId)');

        db.run(`CREATE TABLE IF NOT EXISTS material_catalog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            enterpriseId INTEGER NOT NULL,
            familyCode TEXT NOT NULL DEFAULT '',
            code TEXT NOT NULL DEFAULT '',
            label TEXT NOT NULL DEFAULT '',
            unit TEXT DEFAULT 'unité',
            reference TEXT DEFAULT '',
            note TEXT DEFAULT '',
            isActive INTEGER DEFAULT 1,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(enterpriseId, code)
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_matcat_ent ON material_catalog(enterpriseId, familyCode)');

        // Codification des articles d'inventaire
        db.run("ALTER TABLE inventory ADD COLUMN code TEXT DEFAULT ''", (e) => {
            if (e && !String(e.message || '').includes('duplicate column')) console.warn('inventory.code:', e.message);
        });
        db.run("ALTER TABLE inventory ADD COLUMN familyCode TEXT DEFAULT ''", (e) => {
            if (e && !String(e.message || '').includes('duplicate column')) console.warn('inventory.familyCode:', e.message);
        });
        db.run("ALTER TABLE inventory ADD COLUMN reference TEXT DEFAULT ''", (e) => {
            if (e && !String(e.message || '').includes('duplicate column')) console.warn('inventory.reference:', e.message);
        });
    });

    // Seed paresseux par entreprise (familles + catalogue standard).
    async function ensureSeed(eid) {
        const fam = await qOne('SELECT COUNT(*) AS n FROM material_families WHERE enterpriseId = ?', [eid]);
        if (fam && fam.n > 0) return;
        await qRun('BEGIN', []);
        try {
            for (let i = 0; i < FAMILIES.length; i++) {
                await qRun('INSERT OR IGNORE INTO material_families (enterpriseId, code, label, sortOrder) VALUES (?,?,?,?)',
                    [eid, FAMILIES[i][0], FAMILIES[i][1], i + 1]);
            }
            const counters = {};
            for (const row of CATALOG) {
                const [famCode, label, unit, reference] = row;
                counters[famCode] = (counters[famCode] || 0) + 1;
                const code = famCode + '-' + String(counters[famCode]).padStart(4, '0');
                await qRun('INSERT OR IGNORE INTO material_catalog (enterpriseId, familyCode, code, label, unit, reference) VALUES (?,?,?,?,?,?)',
                    [eid, famCode, code, label, unit || 'unité', reference || '']);
            }
            await qRun('COMMIT', []);
        } catch (e) {
            await qRun('ROLLBACK', []).catch(() => {});
            throw e;
        }
    }

    // Prochain numéro de code article dans une famille (sans collision catalogue/inventaire).
    async function nextCode(eid, familyCode) {
        const fam = text(familyCode, 8).toUpperCase();
        if (!fam) return '';
        const like = fam + '-%';
        const rows = await qAll(
            `SELECT code FROM (
                SELECT code FROM material_catalog WHERE enterpriseId = ? AND code LIKE ?
                UNION ALL
                SELECT code FROM inventory WHERE enterpriseId = ? AND code LIKE ?
             )`, [eid, like, eid, like]);
        let max = 0;
        rows.forEach(r => { const m = String(r.code || '').match(/-(\d+)$/); if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; } });
        return fam + '-' + String(max + 1).padStart(4, '0');
    }

    // ── Familles ──────────────────────────────────────────────────────────────
    app.get('/api/material/families', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            await ensureSeed(eid);
            const rows = await qAll('SELECT * FROM material_families WHERE enterpriseId = ? ORDER BY sortOrder, code', [eid]);
            res.json(rows);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/material/families', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const b = req.body || {};
        const code = text(b.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
        const label = text(b.label, 120).trim();
        if (!code) return res.status(400).json({ error: 'Code requis' });
        if (!label) return res.status(400).json({ error: 'Libellé requis' });
        try {
            const r = await qRun('INSERT INTO material_families (enterpriseId, code, label, sortOrder) VALUES (?,?,?,?)',
                [eid, code, label, Number(b.sortOrder) || 99]);
            res.status(201).json({ id: r.lastID, code });
        } catch (e) {
            if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ce code de famille existe déjà' });
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/material/families/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const b = req.body || {};
        try {
            await qRun('UPDATE material_families SET label = COALESCE(?, label), sortOrder = COALESCE(?, sortOrder), isActive = COALESCE(?, isActive) WHERE id = ? AND enterpriseId = ?',
                [b.label != null ? text(b.label, 120) : null, b.sortOrder != null ? Number(b.sortOrder) : null,
                 b.isActive == null ? null : (b.isActive ? 1 : 0), Number(req.params.id), eid]);
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/material/families/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            const fam = await qOne('SELECT code FROM material_families WHERE id = ? AND enterpriseId = ?', [Number(req.params.id), eid]);
            if (!fam) return res.status(404).json({ error: 'Famille introuvable' });
            const used = await qOne('SELECT COUNT(*) AS n FROM material_catalog WHERE enterpriseId = ? AND familyCode = ?', [eid, fam.code]);
            if (used && used.n > 0) return res.status(409).json({ error: 'Famille utilisée par ' + used.n + ' article(s) du catalogue.' });
            await qRun('DELETE FROM material_families WHERE id = ? AND enterpriseId = ?', [Number(req.params.id), eid]);
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Catalogue d'articles types ──────────────────────────────────────────
    app.get('/api/material/catalog', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            await ensureSeed(eid);
            const fam = text(req.query.family, 8).toUpperCase();
            let sql = 'SELECT * FROM material_catalog WHERE enterpriseId = ?';
            const p = [eid];
            if (fam) { sql += ' AND familyCode = ?'; p.push(fam); }
            sql += ' ORDER BY familyCode, code';
            res.json(await qAll(sql, p));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/material/catalog', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const b = req.body || {};
        const familyCode = text(b.familyCode, 8).toUpperCase();
        const label = text(b.label, 200).trim();
        if (!familyCode) return res.status(400).json({ error: 'Famille requise' });
        if (!label) return res.status(400).json({ error: 'Libellé requis' });
        try {
            const fam = await qOne('SELECT id FROM material_families WHERE enterpriseId = ? AND code = ?', [eid, familyCode]);
            if (!fam) return res.status(400).json({ error: 'Famille inconnue' });
            let code = text(b.code, 20).toUpperCase().trim();
            if (!code) code = await nextCode(eid, familyCode);
            const r = await qRun('INSERT INTO material_catalog (enterpriseId, familyCode, code, label, unit, reference, note) VALUES (?,?,?,?,?,?,?)',
                [eid, familyCode, code, label, text(b.unit, 20) || 'unité', text(b.reference, 80), text(b.note, 300)]);
            res.status(201).json({ id: r.lastID, code });
        } catch (e) {
            if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ce code article existe déjà' });
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/material/catalog/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const b = req.body || {};
        try {
            await qRun(`UPDATE material_catalog SET
                        label = COALESCE(?, label), unit = COALESCE(?, unit), familyCode = COALESCE(?, familyCode),
                        reference = COALESCE(?, reference), note = COALESCE(?, note), isActive = COALESCE(?, isActive)
                        WHERE id = ? AND enterpriseId = ?`,
                [b.label != null ? text(b.label, 200) : null, b.unit != null ? text(b.unit, 20) : null,
                 b.familyCode != null ? text(b.familyCode, 8).toUpperCase() : null,
                 b.reference != null ? text(b.reference, 80) : null, b.note != null ? text(b.note, 300) : null,
                 b.isActive == null ? null : (b.isActive ? 1 : 0), Number(req.params.id), eid]);
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/material/catalog/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            await qRun('DELETE FROM material_catalog WHERE id = ? AND enterpriseId = ?', [Number(req.params.id), eid]);
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Génération du prochain code article pour l'inventaire ────────────────
    app.get('/api/material/next-code', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            const code = await nextCode(eid, text(req.query.family, 8));
            res.json({ code });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
};
