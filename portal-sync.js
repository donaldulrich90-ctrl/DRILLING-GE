/**
 * Recopie automatique d'un compte Forage vers le Portail (best-effort).
 *
 * Utilisé à la création d'un compte, au changement de mot de passe, et à la
 * connexion (c'est le seul moment où le mot de passe en clair est disponible).
 * N'échoue jamais la requête appelante. Nécessite PORTAIL_BASE_URL (défaut :
 * le Portail de production) et SERVICE_API_KEY (clé de service partagée).
 */
const PORTAIL_BASE_URL = (process.env.PORTAIL_BASE_URL || 'https://geportail.duckdns.org').replace(/\/+$/, '');
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || '';

// Rôles plateforme : jamais recopiés vers une entreprise cliente du Portail.
const PLATFORM_ROLES = ['super_admin', 'platform_owner'];

function propagateUserToPortal(enterpriseId, username, password, role) {
    try {
        if (!PORTAIL_BASE_URL || !SERVICE_API_KEY) return;
        if (!enterpriseId || !username || !password) return;
        if (PLATFORM_ROLES.includes(String(role || ''))) return;
        const fetchFn = globalThis.fetch;
        if (typeof fetchFn !== 'function') return;
        fetchFn(PORTAIL_BASE_URL + '/api/service/portal-account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': SERVICE_API_KEY },
            body: JSON.stringify({
                forageEnterpriseId: enterpriseId,
                username: username,
                password: password,
                role: role || 'foreur'
            })
        })
            .then(function (r) {
                if (!r.ok) {
                    return r.text().then(function (t) {
                        console.warn('[portal-account] HTTP ' + r.status + ' (' + username + '): ' + String(t).slice(0, 200));
                    }).catch(function () { console.warn('[portal-account] HTTP ' + r.status + ' (' + username + ')'); });
                }
                console.log('[portal-account] OK ' + username);
            })
            .catch(function (e) { console.warn('[portal-account] KO (' + username + '):', e && e.message); });
    } catch (e) {
        console.warn('[portal-account] exception:', e && e.message);
    }
}

module.exports = { propagateUserToPortal };
