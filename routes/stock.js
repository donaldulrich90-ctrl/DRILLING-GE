/**
 * Stock multi-sites GEDRILLING
 *
 * Deux niveaux :
 *   • Bureau central (Ouagadougou) : fait les commandes fournisseurs, garde un stock,
 *     expédie vers les sites, valide les demandes de réapprovisionnement.
 *   • Magasin de chantier (par site) : reçoit du bureau, consomme (sorties),
 *     remonte des demandes de réappro quand un article passe sous le seuil.
 *
 * Routes :
 *   GET/POST/PUT/DELETE /api/stock-locations
 *   GET/POST/PUT        /api/stock-transfers           (POST = brouillon ; PUT change de statut)
 *   POST                /api/stock-transfers/:id/send
 *   POST                /api/stock-transfers/:id/receive
 *   GET/POST/PUT        /api/stock-replenishment-requests
 *   POST                /api/stock-replenishment-requests/:id/decide
 *
 * Toutes les ressources sont scopées par enterpriseId.
 */
module.exports = function registerStockRoutes(app, { db, getEnterpriseId }) {

    // ───────────────────────── Helpers ─────────────────────────────────────────
    function qAll(sql, params) { return new Promise((ok, fail) => db.all(sql, params, (e, r) => e ? fail(e) : ok(r || []))); }
    function qOne(sql, params) { return new Promise((ok, fail) => db.get(sql, params, (e, r) => e ? fail(e) : ok(r || null))); }
    function qRun(sql, params) {
        return new Promise((ok, fail) => db.run(sql, params, function (e) { e ? fail(e) : ok({ lastID: this.lastID, changes: this.changes }); }));
    }
    function reqEid(req, res) {
        const eid = getEnterpriseId(req);
        if (!eid) { res.status(400).json({ error: 'Contexte entreprise requis' }); return null; }
        return eid;
    }
    function username(req) { return (req.auth && req.auth.username) || ''; }

    async function ownsLocation(eid, locationId) {
        const row = await qOne('SELECT id FROM stock_locations WHERE id = ? AND enterpriseId = ?', [locationId, eid]);
        return !!row;
    }

    async function nextSequence(table, column, prefix, eid) {
        const year = new Date().getFullYear();
        const row = await qOne(
            `SELECT ${column} AS num FROM ${table} WHERE enterpriseId = ? AND ${column} LIKE ? ORDER BY id DESC LIMIT 1`,
            [eid, prefix + '-' + year + '-%']
        );
        let n = 1;
        if (row && row.num) {
            const m = String(row.num).match(/-(\d{4})-(\d+)$/);
            if (m) n = parseInt(m[2], 10) + 1;
        }
        return prefix + '-' + year + '-' + String(n).padStart(4, '0');
    }

    // ───────────────────────── Locations ───────────────────────────────────────
    app.get('/api/stock-locations', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            const rows = await qAll(
                `SELECT l.*, s.name AS siteName,
                        (SELECT COUNT(*) FROM inventory i WHERE i.locationId = l.id) AS itemCount
                 FROM stock_locations l
                 LEFT JOIN sites s ON s.id = l.siteId
                 WHERE l.enterpriseId = ?
                 ORDER BY (l.kind = 'central') DESC, l.name`,
                [eid]
            );
            res.json(rows);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/stock-locations', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const { name, kind, siteId, address, managerUserId, notes } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nom requis' });
        const k = (['central', 'site', 'other'].includes(kind)) ? kind : 'site';
        try {
            const r = await qRun(
                `INSERT INTO stock_locations (enterpriseId, name, kind, siteId, address, managerUserId, isActive, notes)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
                [eid, String(name).trim(), k, siteId || null, String(address || ''), managerUserId || null, String(notes || '')]
            );
            res.status(201).json({ id: r.lastID });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.put('/api/stock-locations/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const id = parseInt(req.params.id, 10);
        if (!(await ownsLocation(eid, id))) return res.status(404).json({ error: 'Location introuvable' });
        const { name, kind, siteId, address, managerUserId, isActive, notes } = req.body || {};
        try {
            await qRun(
                `UPDATE stock_locations
                 SET name = COALESCE(?, name), kind = COALESCE(?, kind), siteId = ?, address = COALESCE(?, address),
                     managerUserId = ?, isActive = COALESCE(?, isActive), notes = COALESCE(?, notes)
                 WHERE id = ? AND enterpriseId = ?`,
                [name || null, kind || null, siteId || null, address == null ? null : String(address),
                 managerUserId || null, isActive == null ? null : (isActive ? 1 : 0), notes == null ? null : String(notes),
                 id, eid]
            );
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/stock-locations/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const id = parseInt(req.params.id, 10);
        if (!(await ownsLocation(eid, id))) return res.status(404).json({ error: 'Location introuvable' });
        try {
            const used = await qOne('SELECT COUNT(*) AS n FROM inventory WHERE locationId = ?', [id]);
            if (used && used.n > 0) return res.status(409).json({ error: 'Location utilisée par ' + used.n + ' article(s). Déplacez-les d\'abord.' });
            await qRun('DELETE FROM stock_locations WHERE id = ? AND enterpriseId = ?', [id, eid]);
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ───────────────────────── Transferts bureau → site ────────────────────────
    app.get('/api/stock-transfers', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            const rows = await qAll(
                `SELECT t.*,
                        lf.name AS fromName, lt.name AS toName,
                        (SELECT COUNT(*) FROM stock_transfer_items ti WHERE ti.transferId = t.id) AS lineCount,
                        (SELECT ROUND(SUM(quantity * unitPrice), 0) FROM stock_transfer_items ti WHERE ti.transferId = t.id) AS totalValue
                 FROM stock_transfers t
                 LEFT JOIN stock_locations lf ON lf.id = t.fromLocationId
                 LEFT JOIN stock_locations lt ON lt.id = t.toLocationId
                 WHERE t.enterpriseId = ?
                 ORDER BY t.createdAt DESC`,
                [eid]
            );
            res.json(rows);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/stock-transfers/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            const t = await qOne('SELECT * FROM stock_transfers WHERE id = ? AND enterpriseId = ?', [req.params.id, eid]);
            if (!t) return res.status(404).json({ error: 'Transfert introuvable' });
            const items = await qAll('SELECT * FROM stock_transfer_items WHERE transferId = ? ORDER BY id', [t.id]);
            res.json({ ...t, items });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/stock-transfers', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const { fromLocationId, toLocationId, carrier, notes, items } = req.body || {};
        if (!fromLocationId || !toLocationId) return res.status(400).json({ error: 'Source et destination requises' });
        if (fromLocationId === toLocationId) return res.status(400).json({ error: 'Source et destination doivent être différentes' });
        if (!(await ownsLocation(eid, fromLocationId)) || !(await ownsLocation(eid, toLocationId))) {
            return res.status(404).json({ error: 'Location invalide' });
        }
        const list = Array.isArray(items) ? items.filter(it => it && it.itemName && Number(it.quantity) > 0) : [];
        if (!list.length) return res.status(400).json({ error: 'Au moins une ligne requise' });
        try {
            const num = await nextSequence('stock_transfers', 'transferNumber', 'BT', eid);
            const r = await qRun(
                `INSERT INTO stock_transfers (enterpriseId, transferNumber, fromLocationId, toLocationId, status, carrier, notes, sentByUsername)
                 VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
                [eid, num, fromLocationId, toLocationId, String(carrier || ''), String(notes || ''), username(req)]
            );
            for (const it of list) {
                await qRun(
                    `INSERT INTO stock_transfer_items (transferId, itemName, itemCategory, unit, quantity, unitPrice, priceCurrency, notes)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [r.lastID, String(it.itemName).trim(), String(it.itemCategory || ''), String(it.unit || 'unité'),
                     Number(it.quantity), Number(it.unitPrice) || 0, String(it.priceCurrency || 'XOF'), String(it.notes || '')]
                );
            }
            res.status(201).json({ id: r.lastID, transferNumber: num });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Envoi : décrémente le stock de la location source ; crée un mouvement "exit".
    app.post('/api/stock-transfers/:id/send', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            const t = await qOne('SELECT * FROM stock_transfers WHERE id = ? AND enterpriseId = ?', [req.params.id, eid]);
            if (!t) return res.status(404).json({ error: 'Transfert introuvable' });
            if (t.status !== 'draft') return res.status(409).json({ error: 'Transfert déjà ' + t.status });
            const items = await qAll('SELECT * FROM stock_transfer_items WHERE transferId = ?', [t.id]);
            // Décrémente le stock bureau central (si l'article existe à la source)
            for (const it of items) {
                const stock = await qOne(
                    `SELECT id, quantity FROM inventory WHERE enterpriseId = ? AND locationId = ? AND LOWER(name) = LOWER(?) LIMIT 1`,
                    [eid, t.fromLocationId, it.itemName]
                );
                if (stock) {
                    const newQ = Math.max(0, (Number(stock.quantity) || 0) - (Number(it.quantity) || 0));
                    await qRun('UPDATE inventory SET quantity = ? WHERE id = ?', [newQ, stock.id]);
                    await qRun(
                        `INSERT INTO stockMovements (enterpriseId, type, articleId, quantity, unitPrice, priceCurrency, total, date, person, reason, notes, locationId)
                         VALUES (?, 'exit', ?, ?, ?, ?, ?, date('now'), ?, ?, ?, ?)`,
                        [eid, stock.id, Number(it.quantity), Number(it.unitPrice) || 0, it.priceCurrency || 'XOF',
                         (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), username(req),
                         'Transfert ' + t.transferNumber, it.notes || '', t.fromLocationId]
                    );
                }
            }
            await qRun(
                `UPDATE stock_transfers SET status = 'sent', sentDate = date('now'), sentByUsername = ? WHERE id = ?`,
                [username(req), t.id]
            );
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Réception : incrémente le stock de la location destination ; crée ou complète chaque article ; mouvement "entry".
    app.post('/api/stock-transfers/:id/receive', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            const t = await qOne('SELECT * FROM stock_transfers WHERE id = ? AND enterpriseId = ?', [req.params.id, eid]);
            if (!t) return res.status(404).json({ error: 'Transfert introuvable' });
            if (t.status !== 'sent') return res.status(409).json({ error: 'Transfert non expédié (statut: ' + t.status + ')' });
            const items = await qAll('SELECT * FROM stock_transfer_items WHERE transferId = ?', [t.id]);
            for (const it of items) {
                let stock = await qOne(
                    `SELECT id, quantity FROM inventory WHERE enterpriseId = ? AND locationId = ? AND LOWER(name) = LOWER(?) LIMIT 1`,
                    [eid, t.toLocationId, it.itemName]
                );
                if (!stock) {
                    // Création automatique de l'article au magasin du site
                    const ins = await qRun(
                        `INSERT INTO inventory (enterpriseId, name, category, quantity, minStock, unit, price, averagePrice, priceCurrency, locationId)
                         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
                        [eid, it.itemName, it.itemCategory || 'Divers', Number(it.quantity) || 0,
                         it.unit || 'unité', Number(it.unitPrice) || 0, Number(it.unitPrice) || 0,
                         it.priceCurrency || 'XOF', t.toLocationId]
                    );
                    stock = { id: ins.lastID, quantity: Number(it.quantity) || 0 };
                } else {
                    const newQ = (Number(stock.quantity) || 0) + (Number(it.quantity) || 0);
                    await qRun('UPDATE inventory SET quantity = ? WHERE id = ?', [newQ, stock.id]);
                }
                await qRun(
                    `INSERT INTO stockMovements (enterpriseId, type, articleId, quantity, unitPrice, priceCurrency, total, date, person, reason, notes, locationId)
                     VALUES (?, 'entry', ?, ?, ?, ?, ?, date('now'), ?, ?, ?, ?)`,
                    [eid, stock.id, Number(it.quantity), Number(it.unitPrice) || 0, it.priceCurrency || 'XOF',
                     (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), username(req),
                     'Réception transfert ' + t.transferNumber, it.notes || '', t.toLocationId]
                );
            }
            await qRun(
                `UPDATE stock_transfers SET status = 'received', receivedDate = date('now'), receivedByUsername = ? WHERE id = ?`,
                [username(req), t.id]
            );
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/stock-transfers/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            const t = await qOne('SELECT * FROM stock_transfers WHERE id = ? AND enterpriseId = ?', [req.params.id, eid]);
            if (!t) return res.status(404).json({ error: 'Transfert introuvable' });
            if (t.status !== 'draft') return res.status(409).json({ error: 'Seul un brouillon peut être supprimé' });
            await qRun('DELETE FROM stock_transfers WHERE id = ?', [t.id]);
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ───────────────────────── Demandes de réapprovisionnement ─────────────────
    app.get('/api/stock-replenishment-requests', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            const rows = await qAll(
                `SELECT r.*, l.name AS siteName, l.siteId,
                        (SELECT COUNT(*) FROM stock_replenishment_items i WHERE i.requestId = r.id) AS lineCount
                 FROM stock_replenishment_requests r
                 LEFT JOIN stock_locations l ON l.id = r.siteLocationId
                 WHERE r.enterpriseId = ?
                 ORDER BY r.createdAt DESC`,
                [eid]
            );
            res.json(rows);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/stock-replenishment-requests/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            const r = await qOne('SELECT * FROM stock_replenishment_requests WHERE id = ? AND enterpriseId = ?', [req.params.id, eid]);
            if (!r) return res.status(404).json({ error: 'Demande introuvable' });
            const items = await qAll('SELECT * FROM stock_replenishment_items WHERE requestId = ? ORDER BY id', [r.id]);
            res.json({ ...r, items });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/stock-replenishment-requests', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const { siteLocationId, urgency, notes, items, requestedByName } = req.body || {};
        if (!siteLocationId) return res.status(400).json({ error: 'Magasin de chantier requis' });
        if (!(await ownsLocation(eid, siteLocationId))) return res.status(404).json({ error: 'Magasin introuvable' });
        const list = Array.isArray(items) ? items.filter(it => it && it.itemName && Number(it.requestedQty) > 0) : [];
        if (!list.length) return res.status(400).json({ error: 'Au moins une ligne requise' });
        try {
            const num = await nextSequence('stock_replenishment_requests', 'requestNumber', 'DR', eid);
            const r = await qRun(
                `INSERT INTO stock_replenishment_requests (enterpriseId, requestNumber, siteLocationId, requestedByUsername, requestedByName, urgency, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [eid, num, siteLocationId, username(req), String(requestedByName || username(req)),
                 (['low', 'normal', 'high', 'critical'].includes(urgency) ? urgency : 'normal'), String(notes || '')]
            );
            for (const it of list) {
                await qRun(
                    `INSERT INTO stock_replenishment_items (requestId, itemName, itemCategory, unit, currentQuantity, minStock, requestedQty, notes)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [r.lastID, String(it.itemName).trim(), String(it.itemCategory || ''), String(it.unit || 'unité'),
                     Number(it.currentQuantity) || 0, Number(it.minStock) || 0, Number(it.requestedQty), String(it.notes || '')]
                );
            }
            res.status(201).json({ id: r.lastID, requestNumber: num });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Validation côté bureau central : approuve / rejette / marque comme traité (après transfert)
    app.post('/api/stock-replenishment-requests/:id/decide', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const { decision, decisionNotes, approvedQuantities, fulfilledByTransferId } = req.body || {};
        const r = await qOne('SELECT * FROM stock_replenishment_requests WHERE id = ? AND enterpriseId = ?', [req.params.id, eid]);
        if (!r) return res.status(404).json({ error: 'Demande introuvable' });
        if (!['approved', 'rejected', 'fulfilled'].includes(decision)) {
            return res.status(400).json({ error: 'Décision invalide (approved|rejected|fulfilled)' });
        }
        try {
            await qRun(
                `UPDATE stock_replenishment_requests
                 SET status = ?, decidedByUsername = ?, decidedAt = datetime('now'),
                     decisionNotes = ?, fulfilledByTransferId = COALESCE(?, fulfilledByTransferId)
                 WHERE id = ?`,
                [decision, username(req), String(decisionNotes || ''), fulfilledByTransferId || null, r.id]
            );
            if (approvedQuantities && typeof approvedQuantities === 'object') {
                for (const [itemId, qty] of Object.entries(approvedQuantities)) {
                    await qRun('UPDATE stock_replenishment_items SET approvedQty = ? WHERE id = ? AND requestId = ?',
                        [Number(qty) || 0, parseInt(itemId, 10), r.id]);
                }
            }
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ───────────────────────── Consommations mensuelles → lignes de facture ───
    // Agrège les sorties stock (type='exit', hors transferts) des magasins
    // rattachés aux sites du client donné, sur le mois YYYY-MM, et renvoie
    // des lignes prêtes à être injectées dans la facture mensuelle.
    // Chaque ligne : { description, quantity, unit, unitPrice, total, currency }.
    app.get('/api/invoices/monthly-stock-consumption', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        const clientId = parseInt(req.query.clientId, 10);
        const month = String(req.query.month || '').slice(0, 7); // YYYY-MM
        if (!clientId || !/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({ error: 'Paramètres clientId et month (YYYY-MM) requis' });
        }
        try {
            // Sites de ce client
            const sites = await qAll('SELECT id, name FROM sites WHERE enterpriseId = ? AND clientId = ?', [eid, clientId]);
            if (!sites.length) return res.json({ lines: [], total: 0, currency: 'XOF', sitesCount: 0 });
            const siteIds = sites.map(s => s.id);
            // Locations magasin de ces sites
            const placeholders = siteIds.map(() => '?').join(',');
            const locations = await qAll(
                `SELECT id FROM stock_locations WHERE enterpriseId = ? AND siteId IN (${placeholders})`,
                [eid, ...siteIds]
            );
            if (!locations.length) return res.json({ lines: [], total: 0, currency: 'XOF', sitesCount: sites.length });
            const locIds = locations.map(l => l.id);
            const locPlaceholders = locIds.map(() => '?').join(',');
            // Sorties du mois (exit), hors transferts (qui remplissent la source "Transfert xxx" dans reason)
            const movements = await qAll(
                `SELECT m.*, i.name AS itemName, i.category AS itemCategory, i.unit AS itemUnit
                 FROM stockMovements m
                 LEFT JOIN inventory i ON i.id = m.articleId
                 WHERE m.enterpriseId = ?
                   AND m.locationId IN (${locPlaceholders})
                   AND m.type = 'exit'
                   AND substr(m.date, 1, 7) = ?
                   AND (m.reason IS NULL OR m.reason NOT LIKE 'Transfert %')`,
                [eid, ...locIds, month]
            );
            // Agrège par (article, prix unitaire, devise)
            const agg = new Map();
            for (const m of movements) {
                const key = (m.itemName || 'Article #' + m.articleId) + '|' + (m.unitPrice || 0) + '|' + (m.priceCurrency || 'XOF') + '|' + (m.itemUnit || 'unité');
                if (!agg.has(key)) agg.set(key, { itemName: m.itemName || 'Article #' + m.articleId, unit: m.itemUnit || 'unité', unitPrice: Number(m.unitPrice) || 0, currency: m.priceCurrency || 'XOF', quantity: 0 });
                const row = agg.get(key);
                row.quantity += Number(m.quantity) || 0;
            }
            const lines = [];
            let total = 0;
            let currency = 'XOF';
            for (const row of agg.values()) {
                const qty = Math.round(row.quantity * 100) / 100;
                const lineTotal = Math.round(qty * row.unitPrice * 100) / 100;
                total += lineTotal;
                currency = row.currency;
                lines.push({
                    description: 'Consommation ' + row.itemName + ' — ' + month,
                    quantity: qty,
                    unit: row.unit,
                    unitPrice: row.unitPrice,
                    total: lineTotal,
                    currency: row.currency
                });
            }
            res.json({ lines: lines, total: Math.round(total * 100) / 100, currency: currency, sitesCount: sites.length });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/stock-replenishment-requests/:id', async (req, res) => {
        const eid = reqEid(req, res); if (!eid) return;
        try {
            const r = await qOne('SELECT * FROM stock_replenishment_requests WHERE id = ? AND enterpriseId = ?', [req.params.id, eid]);
            if (!r) return res.status(404).json({ error: 'Demande introuvable' });
            if (!['draft', 'pending', 'rejected'].includes(r.status)) {
                return res.status(409).json({ error: 'Seule une demande en attente ou rejetée peut être supprimée' });
            }
            await qRun('DELETE FROM stock_replenishment_requests WHERE id = ?', [r.id]);
            res.json({ ok: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
};
