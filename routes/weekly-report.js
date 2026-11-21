/**
 * Rapport hebdomadaire configurable GEDRILLING
 *
 * GET  /api/reports/weekly/config      → config de l'entreprise
 * PUT  /api/reports/weekly/config      → mise à jour config
 * POST /api/reports/weekly/run         → génère le rapport (semaine courante ou ?weekStart=YYYY-MM-DD)
 * GET  /api/reports/weekly             → liste des rapports générés (10 derniers)
 * GET  /api/reports/weekly/:id         → HTML d'un rapport archivé
 */
const { generateWeeklyReport } = require('../services/weekly-report-generator');

// Semaine minière : SAMEDI → VENDREDI (7 jours). 0 = dimanche … 6 = samedi.
// Doit rester aligné avec GE_WEEK_START_DAY dans plateforme-forage.html.
const WEEK_START_DAY = 6;

function getWeekBounds(refDate) {
    // Calcul en UTC sur la date AAAA-MM-JJ pour éviter tout décalage de fuseau.
    const ymd = refDate ? String(refDate).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const [y, m, dd] = ymd.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, dd));
    const start = new Date(d);
    start.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - WEEK_START_DAY + 7) % 7));
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    const toISO = dt => dt.toISOString().slice(0, 10);
    return { weekStart: toISO(start), weekEnd: toISO(end) };
}

module.exports = function registerWeeklyReportRoutes(app, { db, getEnterpriseId }) {

    // GET config
    app.get('/api/reports/weekly/config', (req, res) => {
        const eid = getEnterpriseId(req);
        if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });

        db.get('SELECT * FROM weeklyReportConfigs WHERE enterpriseId = ?', [eid], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) {
                return res.json({
                    enterpriseId: eid, reportDay: 5,
                    includeSections: ['alerts','production','maintenance','stock','finance'],
                    recipientName: '', whatsappNumber: '', notes: ''
                });
            }
            try { row.includeSections = JSON.parse(row.includeSections); } catch(_) { row.includeSections = []; }
            res.json(row);
        });
    });

    // PUT config
    app.put('/api/reports/weekly/config', (req, res) => {
        const eid = getEnterpriseId(req);
        if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });

        const { reportDay, includeSections, recipientName, whatsappNumber, notes } = req.body || {};
        const sectionsJson = JSON.stringify(Array.isArray(includeSections) ? includeSections : ['alerts','production','maintenance','stock','finance']);
        const day  = Number.isInteger(reportDay) ? Math.max(0, Math.min(6, reportDay)) : 5;
        const name = String(recipientName  || '').slice(0, 200);
        const wa   = String(whatsappNumber || '').replace(/[^\d+]/g, '').slice(0, 20);
        const note = String(notes          || '').slice(0, 500);
        const now  = new Date().toISOString();

        db.get('SELECT id FROM weeklyReportConfigs WHERE enterpriseId = ?', [eid], (err, existing) => {
            if (err) return res.status(500).json({ error: err.message });

            const sql = existing
                ? `UPDATE weeklyReportConfigs SET reportDay=?,includeSections=?,recipientName=?,whatsappNumber=?,notes=?,updatedAt=? WHERE enterpriseId=?`
                : `INSERT INTO weeklyReportConfigs (reportDay,includeSections,recipientName,whatsappNumber,notes,updatedAt,enterpriseId) VALUES (?,?,?,?,?,?,?)`;
            const params = [day, sectionsJson, name, wa, note, now, eid];

            db.run(sql, params, function(runErr) {
                if (runErr) return res.status(500).json({ error: runErr.message });
                res.json({ ok: true, changes: this.changes });
            });
        });
    });

    // POST /run — génère et archive le rapport
    app.post('/api/reports/weekly/run', (req, res) => {
        const eid = getEnterpriseId(req);
        if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });

        const { weekStart: reqStart } = req.body || {};
        const { weekStart, weekEnd } = getWeekBounds(reqStart || null);
        const generatedBy = req.auth?.username || '';

        generateWeeklyReport(db, eid, weekStart, weekEnd)
            .then(({ summary, html }) => {
                db.run(
                    `INSERT INTO weeklyReports (enterpriseId, weekStart, weekEnd, generatedAt, generatedBy, htmlContent, summary)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [eid, weekStart, weekEnd, new Date().toISOString(), generatedBy, html, JSON.stringify(summary)],
                    function(err) {
                        if (err) return res.status(500).json({ error: err.message });
                        res.json({ id: this.lastID, weekStart, weekEnd, summary });
                    }
                );
            })
            .catch(err => res.status(500).json({ error: err.message }));
    });

    // GET liste
    app.get('/api/reports/weekly', (req, res) => {
        const eid = getEnterpriseId(req);
        if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });

        db.all(
            `SELECT id, weekStart, weekEnd, generatedAt, generatedBy, summary
             FROM weeklyReports WHERE enterpriseId = ?
             ORDER BY generatedAt DESC LIMIT 20`,
            [eid],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows.map(r => {
                    try { r.summary = JSON.parse(r.summary); } catch(_) {}
                    return r;
                }));
            }
        );
    });

    // GET HTML d'un rapport archivé
    app.get('/api/reports/weekly/:id', (req, res) => {
        const eid = getEnterpriseId(req);
        if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID invalide' });

        db.get(
            'SELECT * FROM weeklyReports WHERE id = ? AND enterpriseId = ?',
            [id, eid],
            (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Rapport introuvable' });
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.send(row.htmlContent);
            }
        );
    });
};
