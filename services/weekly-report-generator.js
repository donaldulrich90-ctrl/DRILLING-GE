/**
 * Générateur de rapport hebdomadaire GEDRILLING.
 * Collecte les données de la semaine et produit un résumé + HTML prêt à partager.
 */
const { evaluateAlerts } = require('./alert-evaluator');

/**
 * @param {object} db
 * @param {number} enterpriseId
 * @param {string} weekStart  YYYY-MM-DD (lundi)
 * @param {string} weekEnd    YYYY-MM-DD (dimanche)
 * @returns {Promise<{summary:object, html:string}>}
 */
async function generateWeeklyReport(db, enterpriseId, weekStart, weekEnd) {
    const [production, maintenance, stock, finance, alerts] = await Promise.all([
        collectProduction(db, enterpriseId, weekStart, weekEnd),
        collectMaintenance(db, enterpriseId, weekStart, weekEnd),
        collectStock(db, enterpriseId),
        collectFinance(db, enterpriseId, weekStart, weekEnd),
        evaluateAlerts(db, enterpriseId)
    ]);

    const summary = { weekStart, weekEnd, production, maintenance, stock, finance, alerts };
    const html = renderHtml(summary);
    return { summary, html };
}

// ── Collecteurs ────────────────────────────────────────────────────────────────

function query(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}

function queryOne(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
    });
}

async function collectProduction(db, eid, start, end) {
    const rows = await query(db,
        `SELECT machineId,
                COUNT(*) as shifts,
                SUM(CAST(json_extract(data,'$.metersDrilled') AS REAL)) as totalMeters,
                SUM(CAST(json_extract(data,'$.hours') AS REAL)) as totalHours
         FROM dailyDataRecords
         WHERE machineId IN (SELECT id FROM drills WHERE enterpriseId = ?)
           AND date >= ? AND date <= ?
           AND workflowStatus IN ('approved','submitted')
         GROUP BY machineId
         ORDER BY totalMeters DESC`,
        [eid, start, end]
    );

    const totalMeters = rows.reduce((s, r) => s + (r.totalMeters || 0), 0);
    const totalHours  = rows.reduce((s, r) => s + (r.totalHours  || 0), 0);
    return {
        drillCount: rows.length,
        totalMeters: Math.round(totalMeters * 10) / 10,
        totalHours:  Math.round(totalHours  * 10) / 10,
        byDrill: rows.map(r => ({
            machineId:   r.machineId,
            shifts:      r.shifts,
            meters:      Math.round((r.totalMeters || 0) * 10) / 10,
            hours:       Math.round((r.totalHours  || 0) * 10) / 10,
            rop:         r.totalHours > 0 ? Math.round((r.totalMeters / r.totalHours) * 10) / 10 : null
        }))
    };
}

async function collectMaintenance(db, eid, start, end) {
    const done = await query(db,
        `SELECT COUNT(*) as cnt FROM maintenanceSchedules
         WHERE enterpriseId = ? AND status = 'completed'
           AND nextMaintenanceDate >= ? AND nextMaintenanceDate <= ?`,
        [eid, start, end]
    );
    const overdue = await query(db,
        `SELECT COUNT(*) as cnt FROM maintenanceSchedules
         WHERE enterpriseId = ? AND status NOT IN ('completed','cancelled')
           AND nextMaintenanceDate < date('now')`,
        [eid]
    );
    return {
        completedThisWeek: done[0]?.cnt || 0,
        currentlyOverdue:  overdue[0]?.cnt || 0
    };
}

async function collectStock(db, eid) {
    const critical = await query(db,
        `SELECT COUNT(*) as cnt FROM inventory
         WHERE enterpriseId = ? AND minStock > 0 AND quantity <= minStock`,
        [eid]
    );
    const empty = await query(db,
        `SELECT COUNT(*) as cnt FROM inventory
         WHERE enterpriseId = ? AND quantity = 0`,
        [eid]
    );
    return {
        criticalItems: critical[0]?.cnt || 0,
        emptyItems:    empty[0]?.cnt    || 0
    };
}

async function collectFinance(db, eid, start, end) {
    const invoiced = await queryOne(db,
        `SELECT COALESCE(SUM(total),0) as total, currency
         FROM invoices
         WHERE enterpriseId = ? AND date >= ? AND date <= ?
         GROUP BY currency ORDER BY total DESC LIMIT 1`,
        [eid, start, end]
    );
    const collected = await queryOne(db,
        `SELECT COALESCE(SUM(amount),0) as total, currency
         FROM payments
         WHERE enterpriseId = ? AND date >= ? AND date <= ?
         GROUP BY currency ORDER BY total DESC LIMIT 1`,
        [eid, start, end]
    );
    const overdue = await queryOne(db,
        `SELECT COUNT(*) as cnt, COALESCE(SUM(total),0) as total
         FROM invoices
         WHERE enterpriseId = ? AND status = 'pending'
           AND dueDate IS NOT NULL AND dueDate < date('now')`,
        [eid]
    );
    return {
        invoicedAmount:   invoiced?.total   || 0,
        collectedAmount:  collected?.total  || 0,
        currency:         invoiced?.currency || collected?.currency || 'XOF',
        overdueCount:     overdue?.cnt   || 0,
        overdueAmount:    overdue?.total  || 0
    };
}

// ── Rendu HTML ─────────────────────────────────────────────────────────────────

function fmt(n) { return Number(n).toLocaleString('fr-FR'); }
function fmtDate(d) {
    if (!d) return '';
    const [y,m,day] = d.split('-');
    return `${day}/${m}/${y}`;
}

const SEVERITY_COLOR = { critical: '#DC2626', warning: '#D97706', info: '#2563EB' };
const SEVERITY_LABEL = { critical: 'CRITIQUE', warning: 'ATTENTION', info: 'INFO' };

function renderHtml(s) {
    const { weekStart, weekEnd, production, maintenance, stock, finance, alerts } = s;

    const alertRows = alerts.items.slice(0, 10).map(a => `
        <tr>
            <td style="padding:6px 10px;">
                <span style="background:${SEVERITY_COLOR[a.severity]};color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;">
                    ${SEVERITY_LABEL[a.severity]}
                </span>
            </td>
            <td style="padding:6px 10px;font-size:13px;">${a.message}</td>
        </tr>`).join('');

    const drillRows = production.byDrill.map(d => `
        <tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:6px 10px;font-weight:600;">${d.machineId}</td>
            <td style="padding:6px 10px;text-align:right;">${d.shifts}</td>
            <td style="padding:6px 10px;text-align:right;">${fmt(d.meters)} m</td>
            <td style="padding:6px 10px;text-align:right;">${d.rop != null ? d.rop + ' m/h' : '—'}</td>
        </tr>`).join('');

    const alertBadge = alerts.critical > 0
        ? `<span style="background:#DC2626;color:#fff;padding:3px 10px;border-radius:12px;font-weight:700;">${alerts.critical} critique${alerts.critical > 1 ? 's' : ''}</span>`
        : `<span style="background:#16A34A;color:#fff;padding:3px 10px;border-radius:12px;font-weight:700;">Aucune alerte critique</span>`;

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rapport hebdomadaire GEDRILLING — ${fmtDate(weekStart)} au ${fmtDate(weekEnd)}</title>
<style>
  body{font-family:"Segoe UI",system-ui,sans-serif;background:#f3f4f6;margin:0;padding:16px;}
  .card{background:#fff;border-radius:10px;box-shadow:0 1px 6px rgba(0,0,0,.1);margin-bottom:16px;overflow:hidden;}
  .card-header{background:#063D2B;color:#fff;padding:12px 20px;display:flex;align-items:center;gap:10px;}
  .card-header h2{margin:0;font-size:15px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;}
  .card-body{padding:16px 20px;}
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:12px;}
  .kpi{background:#f9fafb;border-radius:8px;padding:12px;text-align:center;border-left:4px solid #F5B800;}
  .kpi-val{font-size:22px;font-weight:800;color:#063D2B;}
  .kpi-lbl{font-size:11px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.05em;}
  table{width:100%;border-collapse:collapse;}
  thead th{background:#f3f4f6;padding:7px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#374151;}
  .footer{text-align:center;font-size:11px;color:#9ca3af;padding:8px;}
  @media print{body{padding:0;}@page{margin:15mm;}}
</style>
</head>
<body>
<div style="max-width:720px;margin:0 auto;">

  <!-- En-tête -->
  <div style="background:#063D2B;border-radius:10px;padding:20px 24px;margin-bottom:16px;color:#fff;">
    <div style="font-family:'Oswald',sans-serif;font-size:22px;font-weight:800;letter-spacing:.08em;color:#F5B800;">
      GEDRILLING — GOOD ENGINEERS
    </div>
    <div style="font-size:14px;color:#cfe0d6;margin-top:4px;">
      Rapport hebdomadaire · ${fmtDate(weekStart)} au ${fmtDate(weekEnd)}
    </div>
    <div style="margin-top:10px;">${alertBadge}</div>
  </div>

  <!-- Production -->
  <div class="card">
    <div class="card-header"><h2>⛏ Production de forage</h2></div>
    <div class="card-body">
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-val">${fmt(production.totalMeters)} m</div><div class="kpi-lbl">Mètres forés</div></div>
        <div class="kpi"><div class="kpi-val">${production.drillCount}</div><div class="kpi-lbl">Foreuses actives</div></div>
        <div class="kpi"><div class="kpi-val">${fmt(production.totalHours)} h</div><div class="kpi-lbl">Heures de forage</div></div>
      </div>
      ${drillRows ? `<table>
        <thead><tr><th>Foreuse</th><th style="text-align:right">Postes</th><th style="text-align:right">Mètres</th><th style="text-align:right">ROP</th></tr></thead>
        <tbody>${drillRows}</tbody>
      </table>` : '<p style="color:#6b7280;font-size:13px;">Aucune saisie journalière cette semaine.</p>'}
    </div>
  </div>

  <!-- Maintenance -->
  <div class="card">
    <div class="card-header"><h2>🔧 Maintenance</h2></div>
    <div class="card-body">
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-val">${maintenance.completedThisWeek}</div><div class="kpi-lbl">Révisions réalisées</div></div>
        <div class="kpi" style="border-left-color:${maintenance.currentlyOverdue > 0 ? '#DC2626' : '#16A34A'}">
          <div class="kpi-val" style="color:${maintenance.currentlyOverdue > 0 ? '#DC2626' : '#16A34A'}">${maintenance.currentlyOverdue}</div>
          <div class="kpi-lbl">Révisions en retard</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Stock -->
  <div class="card">
    <div class="card-header"><h2>📦 Stock</h2></div>
    <div class="card-body">
      <div class="kpi-grid">
        <div class="kpi" style="border-left-color:${stock.emptyItems > 0 ? '#DC2626' : '#16A34A'}">
          <div class="kpi-val" style="color:${stock.emptyItems > 0 ? '#DC2626' : '#16A34A'}">${stock.emptyItems}</div>
          <div class="kpi-lbl">Articles épuisés</div>
        </div>
        <div class="kpi" style="border-left-color:${stock.criticalItems > 0 ? '#D97706' : '#16A34A'}">
          <div class="kpi-val" style="color:${stock.criticalItems > 0 ? '#D97706' : '#16A34A'}">${stock.criticalItems}</div>
          <div class="kpi-lbl">Stock critique</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Finance -->
  <div class="card">
    <div class="card-header"><h2>💰 Finance</h2></div>
    <div class="card-body">
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-val">${fmt(finance.invoicedAmount)}</div><div class="kpi-lbl">Facturé (${finance.currency})</div></div>
        <div class="kpi"><div class="kpi-val">${fmt(finance.collectedAmount)}</div><div class="kpi-lbl">Encaissé (${finance.currency})</div></div>
        <div class="kpi" style="border-left-color:${finance.overdueCount > 0 ? '#DC2626' : '#16A34A'}">
          <div class="kpi-val" style="color:${finance.overdueCount > 0 ? '#DC2626' : '#16A34A'}">${finance.overdueCount}</div>
          <div class="kpi-lbl">Factures impayées</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Alertes -->
  ${alerts.items.length > 0 ? `
  <div class="card">
    <div class="card-header"><h2>🔔 Alertes opérationnelles (${alerts.total})</h2></div>
    <div class="card-body" style="padding:0;">
      <table>
        <thead><tr><th>Niveau</th><th>Message</th></tr></thead>
        <tbody>${alertRows}</tbody>
      </table>
      ${alerts.items.length > 10 ? `<p style="padding:8px 10px;font-size:12px;color:#6b7280;">… et ${alerts.items.length - 10} autre(s) alerte(s)</p>` : ''}
    </div>
  </div>` : ''}

  <div class="footer">Généré automatiquement par GEDRILLING · ${new Date().toLocaleString('fr-FR')}</div>
</div>
</body>
</html>`;
}

module.exports = { generateWeeklyReport };
