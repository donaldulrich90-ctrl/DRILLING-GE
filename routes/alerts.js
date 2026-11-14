/**
 * Centre d'alertes opérationnelles GEDRILLING
 * GET /api/alerts → { total, critical, warning, info, items[] }
 */
const { evaluateAlerts } = require('../services/alert-evaluator');

module.exports = function registerAlertRoutes(app, { db, getEnterpriseId }) {

    app.get('/api/alerts', (req, res) => {
        const eid = getEnterpriseId(req);
        if (!eid) return res.status(400).json({ error: 'Contexte entreprise requis' });

        evaluateAlerts(db, eid)
            .then(result => res.json(result))
            .catch(err => {
                console.error('[alerts]', err.message);
                res.status(500).json({ error: 'Erreur lors de l\'évaluation des alertes' });
            });
    });
};
