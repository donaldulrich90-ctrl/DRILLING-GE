/**
 * Analytique opérationnelle GEDRILLING
 *
 * GET /api/analytics/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   → production (byMachine, byFormation, ROP), maintenance (MTBF/MTTR), stock, finance
 */
module.exports = function registerAnalyticsRoutes(app, { db, getEnterpriseId }) {

    app.get('/api/analytics/summary', (req, res) => {
        const eid = getEnterpriseId(req);
        if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });

        const toDate   = String(req.query.to   || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
        const fromDate = String(req.query.from || '').slice(0, 10) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

        if (fromDate > toDate) return res.status(400).json({ error: 'from doit être antérieur à to' });

        Promise.all([
            collectProduction(db, eid, fromDate, toDate),
            collectMaintenance(db, eid, fromDate, toDate),
            collectStock(db, eid),
            collectFinance(db, eid, fromDate, toDate)
        ])
        .then(([production, maintenance, stock, finance]) =>
            res.json({ period: { from: fromDate, to: toDate }, production, maintenance, stock, finance })
        )
        .catch(err => {
            console.error('[analytics]', err.message);
            res.status(500).json({ error: err.message });
        });
    });
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function qAll(db, sql, params) {
    return new Promise((ok, fail) => db.all(sql, params, (e, r) => e ? fail(e) : ok(r || [])));
}
function qOne(db, sql, params) {
    return new Promise((ok, fail) => db.get(sql, params, (e, r) => e ? fail(e) : ok(r || null)));
}

// ── Collecteurs ───────────────────────────────────────────────────────────────

async function collectProduction(db, eid, from, to) {
    const byMachine = await qAll(db,
        `SELECT machineId,
                COUNT(*) AS shifts,
                ROUND(SUM(CAST(json_extract(data,'$.metersDrilled') AS REAL)), 1) AS meters,
                ROUND(SUM(CAST(json_extract(data,'$.hours')         AS REAL)), 1) AS hours,
                ROUND(SUM(COALESCE(
                    CAST(json_extract(data,'$.fuelConsumptionEffective') AS REAL),
                    CAST(json_extract(data,'$.fuelConsumed') AS REAL),
                    0)), 0) AS fuel,
                ROUND(AVG(CAST(json_extract(data,'$.availabilityPct') AS REAL)), 1) AS avgAvailability
         FROM dailyDataRecords
         WHERE machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)
           AND date >= ? AND date <= ?
           AND workflowStatus IN ('approved','submitted')
         GROUP BY machineId
         ORDER BY meters DESC`,
        [eid, from, to]
    );

    const byFormation = await qAll(db,
        `SELECT COALESCE(
                    NULLIF(TRIM(json_extract(data,'$.materialType')),''),
                    NULLIF(TRIM(json_extract(data,'$.formation')),''),
                    'Non précisé') AS formation,
                COUNT(*) AS records,
                ROUND(SUM(CAST(json_extract(data,'$.metersDrilled') AS REAL)), 1) AS meters,
                ROUND(SUM(CAST(json_extract(data,'$.hours')         AS REAL)), 1) AS hours
         FROM dailyDataRecords
         WHERE machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)
           AND date >= ? AND date <= ?
           AND workflowStatus IN ('approved','submitted')
         GROUP BY formation
         HAVING (meters IS NOT NULL AND meters > 0) OR (hours IS NOT NULL AND hours > 0)
         ORDER BY meters DESC`,
        [eid, from, to]
    );

    const totalMeters = byMachine.reduce((s, r) => s + (r.meters || 0), 0);
    const totalHours  = byMachine.reduce((s, r) => s + (r.hours  || 0), 0);
    const r = (v) => Math.round(v * 100) / 100;

    return {
        drillCount:   byMachine.length,
        totalMeters:  Math.round(totalMeters * 10) / 10,
        totalHours:   Math.round(totalHours  * 10) / 10,
        avgROP:       totalHours > 0 ? r(totalMeters / totalHours) : null,
        byMachine:    byMachine.map(m => ({ ...m, rop: m.hours > 0 ? r(m.meters / m.hours) : null })),
        byFormation:  byFormation.map(f => ({ ...f, rop: f.hours > 0 ? r(f.meters / f.hours) : null }))
    };
}

async function collectMaintenance(db, eid, from, to) {
    const rows = await qAll(db,
        `SELECT machineId,
                COUNT(*) AS interventions,
                ROUND(AVG(duration), 1) AS avgMTTR,
                ROUND(SUM(cost), 0)     AS totalCost
         FROM maintenanceHistory
         WHERE enterpriseId = ? AND date >= ? AND date <= ?
         GROUP BY machineId
         ORDER BY interventions DESC`,
        [eid, from, to]
    );

    const totalInterventions = rows.reduce((s, r) => s + (r.interventions || 0), 0);
    const totalCost          = rows.reduce((s, r) => s + (r.totalCost     || 0), 0);
    return { totalInterventions, totalCost, byMachine: rows };
}

async function collectStock(db, eid) {
    const critical = await qOne(db,
        `SELECT COUNT(*) AS cnt FROM inventory WHERE enterpriseId = ? AND minStock > 0 AND quantity <= minStock`,
        [eid]
    );
    const empty = await qOne(db,
        `SELECT COUNT(*) AS cnt FROM inventory WHERE enterpriseId = ? AND quantity = 0`,
        [eid]
    );
    return { criticalItems: critical?.cnt || 0, emptyItems: empty?.cnt || 0 };
}

async function collectFinance(db, eid, from, to) {
    const invoiced = await qOne(db,
        `SELECT COALESCE(SUM(total),0) AS total, currency FROM invoices
         WHERE enterpriseId = ? AND date >= ? AND date <= ?
         GROUP BY currency ORDER BY total DESC LIMIT 1`,
        [eid, from, to]
    );
    const collected = await qOne(db,
        `SELECT COALESCE(SUM(amount),0) AS total, currency FROM payments
         WHERE enterpriseId = ? AND date >= ? AND date <= ?
         GROUP BY currency ORDER BY total DESC LIMIT 1`,
        [eid, from, to]
    );
    const overdue = await qOne(db,
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(total),0) AS total
         FROM invoices
         WHERE enterpriseId = ? AND status = 'pending'
           AND dueDate IS NOT NULL AND dueDate < date('now')`,
        [eid]
    );
    return {
        invoicedAmount:  invoiced?.total  || 0,
        collectedAmount: collected?.total || 0,
        currency:        invoiced?.currency || collected?.currency || 'XOF',
        overdueCount:    overdue?.cnt   || 0,
        overdueAmount:   overdue?.total || 0
    };
}
