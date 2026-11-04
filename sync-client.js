// ============================================================
// Client de synchronisation AUTOMATIQUE (instance LOCALE).
// Quand internet est disponible, se connecte au serveur en ligne,
// TIRE ses données (pull) puis POUSSE les siennes (push), à
// intervalle régulier. Fusion additive via sync-core.
//
// Activé uniquement si SYNC_ENABLED=true (donc jamais en ligne).
// Config (variables d'environnement) :
//   SYNC_ENABLED=true
//   SYNC_REMOTE_URL=https://serveur-en-ligne
//   SYNC_USERNAME / SYNC_PASSWORD   (compte admin de l'entreprise en ligne)
//   SYNC_INTERVAL_MINUTES=15        (défaut 15)
//   SYNC_ENTERPRISE_ID=...          (défaut : la seule entreprise locale)
// ============================================================
const syncCore = require('./sync-core');

function log() { console.log.apply(console, ['[SYNC]'].concat(Array.from(arguments))); }

function cookieHeaderFrom(resp) {
    try {
        const sc = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
        const pairs = (sc || []).map((c) => String(c).split(';')[0]).filter(Boolean);
        return pairs.join('; ');
    } catch (e) { return ''; }
}

async function remoteLogin(base, username, password) {
    const r = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    if (!r.ok) throw new Error('connexion HTTP ' + r.status);
    const cookie = cookieHeaderFrom(r);
    if (!cookie) throw new Error('pas de cookie de session renvoyé');
    return cookie;
}

function getLocalEnterpriseId(db, cb) {
    const envId = parseInt(process.env.SYNC_ENTERPRISE_ID, 10);
    if (!Number.isNaN(envId)) return cb(null, envId);
    db.get('SELECT id FROM enterprises ORDER BY id LIMIT 1', [], (e, row) => cb(e, row ? row.id : 1));
}

async function cycle(db) {
    const base = String(process.env.SYNC_REMOTE_URL || '').replace(/\/+$/, '');
    const username = process.env.SYNC_USERNAME;
    const password = process.env.SYNC_PASSWORD;
    const status = global.__syncStatus = global.__syncStatus || { enabled: true };
    status.remote = base;
    status.lastAttemptAt = new Date().toISOString();
    if (!base || !username || !password) {
        status.lastError = 'Configuration incomplète (SYNC_REMOTE_URL / SYNC_USERNAME / SYNC_PASSWORD).';
        log(status.lastError);
        return;
    }
    let cookie;
    try {
        cookie = await remoteLogin(base, username, password);
    } catch (e) {
        status.lastError = 'Connexion au serveur en ligne impossible : ' + e.message;
        log('échec connexion:', e.message);
        return;
    }
    const entId = await new Promise((resolve) => getLocalEnterpriseId(db, (e, id) => resolve(id)));

    // 1) PULL : récupérer la config + les données en ligne et les appliquer localement.
    //    La config (foreuses, sites…) d'abord, pour que les saisies trouvent leur foreuse.
    try {
        const r = await fetch(base + '/api/sync/export?patterns=1&config=1', { headers: { Cookie: cookie } });
        if (!r.ok) throw new Error('export HTTP ' + r.status);
        const payload = await r.json();
        if (payload && payload.config) {
            status.lastConfig = await new Promise((resolve, reject) => syncCore.applyConfig(db, entId, payload.config, (e, c) => e ? reject(e) : resolve(c)));
        }
        status.lastPull = await new Promise((resolve, reject) => syncCore.applyMerge(db, entId, payload, (e, c) => e ? reject(e) : resolve(c)));
    } catch (e) {
        status.lastError = 'Récupération (pull) : ' + e.message;
        log('échec pull:', e.message);
    }

    // 2) PUSH : envoyer les données locales au serveur en ligne
    try {
        const payload = await new Promise((resolve, reject) => syncCore.buildExport(db, entId, true, (e, p) => e ? reject(e) : resolve(p)));
        const r = await fetch(base + '/api/sync/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify(payload)
        });
        if (!r.ok) throw new Error('import HTTP ' + r.status);
        status.lastPush = await r.json();
    } catch (e) {
        status.lastError = 'Envoi (push) : ' + e.message;
        log('échec push:', e.message);
    }

    status.lastSyncAt = new Date().toISOString();
    if (status.lastPull && status.lastPush) status.lastError = null;
    log('cycle terminé —', JSON.stringify({ pull: status.lastPull || null, push: status.lastPush || null }));
}

let _db = null;
let _running = false;

function runNow() {
    if (process.env.SYNC_ENABLED !== 'true' || !_db) return Promise.resolve({ ok: false, reason: 'désactivée' });
    if (_running) return Promise.resolve({ ok: false, reason: 'déjà en cours' });
    _running = true;
    return cycle(_db).catch((e) => log('erreur cycle:', e && e.message ? e.message : e)).then(() => { _running = false; return { ok: true }; });
}

function start(opts) {
    opts = opts || {};
    _db = opts.db || null;
    if (process.env.SYNC_ENABLED !== 'true') { global.__syncStatus = { enabled: false }; return; }
    if (!_db) { log('démarrage impossible : base indisponible'); return; }
    const minutes = Math.max(1, parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || 15);
    global.__syncStatus = { enabled: true, intervalMinutes: minutes, remote: String(process.env.SYNC_REMOTE_URL || '') };
    log('synchro automatique activée — intervalle', minutes, 'min — cible', process.env.SYNC_REMOTE_URL || '(non défini)');
    const run = () => { if (!_running) runNow(); };
    setTimeout(run, 15000);              // premier essai 15 s après le démarrage
    setInterval(run, minutes * 60 * 1000);
}

module.exports = { start, runNow };
