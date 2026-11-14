/**
 * Évaluation des alertes opérationnelles GEDRILLING.
 * Utilisé par GET /api/alerts et le générateur de rapport hebdomadaire.
 *
 * @param {object} db - instance sqlite3
 * @param {number|string} enterpriseId
 * @returns {Promise<{total:number, critical:number, warning:number, info:number, items:Array}>}
 */
function evaluateAlerts(db, enterpriseId) {
    return new Promise((resolve, reject) => {
        const today = new Date().toISOString().slice(0, 10);
        const in30  = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
        const items = [];
        let pending = 6;
        let failed  = null;

        function done(err) {
            if (err && !failed) failed = err;
            if (--pending === 0) {
                if (failed) return reject(failed);
                const order = { critical: 0, warning: 1, info: 2 };
                items.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
                const critical = items.filter(i => i.severity === 'critical').length;
                const warning  = items.filter(i => i.severity === 'warning').length;
                const info     = items.filter(i => i.severity === 'info').length;
                resolve({ total: items.length, critical, warning, info, items });
            }
        }

        // 1. Révisions en retard
        db.all(
            `SELECT ms.id, ms.machineId, ms.type, ms.description, ms.nextMaintenanceDate, ms.priority
             FROM maintenanceSchedules ms
             WHERE ms.enterpriseId = ?
               AND ms.nextMaintenanceDate IS NOT NULL
               AND ms.nextMaintenanceDate < ?
               AND ms.status NOT IN ('completed','cancelled')
             ORDER BY ms.nextMaintenanceDate ASC`,
            [enterpriseId, today],
            (err, rows) => {
                if (!err && rows) rows.forEach(r => {
                    const days = Math.floor((Date.now() - new Date(r.nextMaintenanceDate).getTime()) / 86400000);
                    items.push({
                        type: 'maintenance_overdue', severity: 'critical', entityLabel: r.machineId,
                        message: `Révision "${r.type || r.description || 'maintenance'}" en retard de ${days} j (foreuse ${r.machineId})`,
                        details: { machineId: r.machineId, dueDate: r.nextMaintenanceDate, daysOverdue: days, priority: r.priority }
                    });
                });
                done(err);
            }
        );

        // 2. Stock critique
        db.all(
            `SELECT id, name, category, quantity, minStock, unit
             FROM inventory
             WHERE enterpriseId = ? AND minStock > 0 AND quantity <= minStock
             ORDER BY (CAST(quantity AS REAL) / minStock) ASC`,
            [enterpriseId],
            (err, rows) => {
                if (!err && rows) rows.forEach(r => {
                    items.push({
                        type: 'stock_critical',
                        severity: r.quantity === 0 ? 'critical' : 'warning',
                        entityLabel: r.name,
                        message: r.quantity === 0
                            ? `Stock épuisé : ${r.name} (${r.category})`
                            : `Stock critique : ${r.name} — ${r.quantity} ${r.unit} ≤ seuil ${r.minStock} ${r.unit}`,
                        details: { itemId: r.id, quantity: r.quantity, minStock: r.minStock, unit: r.unit, category: r.category }
                    });
                });
                done(err);
            }
        );

        // 3. Contrats expirés
        db.all(
            `SELECT c.id, c.endDate, cl.name as clientName
             FROM contracts c LEFT JOIN clients cl ON cl.id = c.clientId
             WHERE c.enterpriseId = ? AND c.status = 'active' AND c.endDate < ?
             ORDER BY c.endDate ASC`,
            [enterpriseId, today],
            (err, rows) => {
                if (!err && rows) rows.forEach(r => {
                    const days = Math.floor((Date.now() - new Date(r.endDate).getTime()) / 86400000);
                    items.push({
                        type: 'contract_expired', severity: 'critical',
                        entityLabel: r.clientName || r.id,
                        message: `Contrat expiré depuis ${days} j — client : ${r.clientName || r.id}`,
                        details: { contractId: r.id, endDate: r.endDate, daysExpired: days }
                    });
                });
                done(err);
            }
        );

        // 4. Contrats expirant dans 30 j
        db.all(
            `SELECT c.id, c.endDate, cl.name as clientName
             FROM contracts c LEFT JOIN clients cl ON cl.id = c.clientId
             WHERE c.enterpriseId = ? AND c.status = 'active' AND c.endDate >= ? AND c.endDate <= ?
             ORDER BY c.endDate ASC`,
            [enterpriseId, today, in30],
            (err, rows) => {
                if (!err && rows) rows.forEach(r => {
                    const days = Math.ceil((new Date(r.endDate).getTime() - Date.now()) / 86400000);
                    items.push({
                        type: 'contract_expiring',
                        severity: days <= 7 ? 'critical' : 'warning',
                        entityLabel: r.clientName || r.id,
                        message: `Contrat expire dans ${days} j — client : ${r.clientName || r.id}`,
                        details: { contractId: r.id, endDate: r.endDate, daysLeft: days }
                    });
                });
                done(err);
            }
        );

        // 5. Factures en souffrance
        db.all(
            `SELECT i.id, i.invoiceNumber, i.total, i.currency, i.dueDate, cl.name as clientName
             FROM invoices i LEFT JOIN clients cl ON cl.id = i.clientId
             WHERE i.enterpriseId = ? AND i.status = 'pending'
               AND i.dueDate IS NOT NULL AND i.dueDate < ?
             ORDER BY i.dueDate ASC`,
            [enterpriseId, today],
            (err, rows) => {
                if (!err && rows) rows.forEach(r => {
                    const days = Math.floor((Date.now() - new Date(r.dueDate).getTime()) / 86400000);
                    items.push({
                        type: 'invoice_overdue', severity: 'warning',
                        entityLabel: r.invoiceNumber,
                        message: `Facture ${r.invoiceNumber} en retard de ${days} j — ${r.clientName || ''} (${r.total} ${r.currency})`,
                        details: { invoiceId: r.id, invoiceNumber: r.invoiceNumber, dueDate: r.dueDate, daysOverdue: days, total: r.total, currency: r.currency }
                    });
                });
                done(err);
            }
        );

        // 6. Foreuses actives sans saisie journalière aujourd'hui
        db.all(
            `SELECT d.id, d.location FROM drills d
             WHERE d.enterpriseId = ? AND d.status = 'active'
               AND NOT EXISTS (
                   SELECT 1 FROM dailyDataRecords dr
                   WHERE dr.machineId = d.id AND dr.date = ?
               )`,
            [enterpriseId, today],
            (err, rows) => {
                if (!err && rows) rows.forEach(r => {
                    items.push({
                        type: 'no_daily_entry', severity: 'info', entityLabel: r.id,
                        message: `Pas de saisie journalière aujourd'hui pour la foreuse ${r.id} (${r.location || ''})`,
                        details: { drillId: r.id, location: r.location, date: today }
                    });
                });
                done(err);
            }
        );
    });
}

module.exports = { evaluateAlerts };
