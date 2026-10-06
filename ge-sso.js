/*
 * ADAPTATEUR FORAGE (DRILLING-GE) — connexion unique (SSO) depuis le portail.
 *
 * Monté dans server.js AVANT le gardien « JWT requis pour /api ».
 *
 * Route GET /sso?token=... :
 *   - vérifie le jeton signé par le portail (secret PARTAGÉ SSO_SHARED_SECRET),
 *   - contrôle qu'il est destiné à "forage" et qu'il n'a jamais servi,
 *   - retrouve le compte dans la base Forage (username + enterpriseId),
 *     refuse les comptes plateforme et les entreprises désactivées,
 *   - pose le cookie forage_jwt habituel de l'app (via signUserToken),
 *   - pose un cookie lisible ge_switchbar pour la barre de bascule,
 *   - renvoie une petite page « pont » qui positionne le drapeau
 *     localStorage.forage_session (sans lui, la page Forage ne tente pas de
 *     restaurer la session et affiche l'écran de connexion), puis ouvre l'app.
 *
 * Aucune logique métier de l'app n'est modifiée : on réutilise son propre
 * signUserToken et sa base. L'ancienne page de connexion reste disponible.
 *
 * NB : db.js expose des fonctions à promesses (get/all/run sans callback) ;
 * on utilise donc la connexion sqlite3 brute de getDb(), comme server.js.
 */
const jwt = require('jsonwebtoken');
const { signUserToken, JWT_EXPIRES_IN } = require('./middleware/saas-auth');
const { getDb } = require('./db');
const { PLATFORM_ROLES } = require('./plan-roles');

const SSO_SHARED_SECRET = process.env.SSO_SHARED_SECRET || '';
const PORTAIL_BASE_URL = process.env.PORTAIL_BASE_URL || '';
const COOKIE_SECURE = process.env.NODE_ENV === 'production';
const SESSION_MAX_AGE_MS = expiresInToMs(JWT_EXPIRES_IN);

// Anti-rejeu : jti déjà utilisés, gardés jusqu'à expiration (usage unique).
// Stockage en mémoire = suffisant pour 1 process Node (cas de ce déploiement).
const usedJti = new Map();
function rememberJti(jti, expSeconds) {
    usedJti.set(jti, expSeconds * 1000);
    if (usedJti.size > 5000) {
        const now = Date.now();
        for (const [k, v] of usedJti) if (v < now) usedJti.delete(k);
    }
}
function jtiAlreadyUsed(jti) {
    const exp = usedJti.get(jti);
    if (!exp) return false;
    if (exp < Date.now()) { usedJti.delete(jti); return false; }
    return true;
}

function expiresInToMs(expiresIn) {
    const m = String(expiresIn || '').match(/^(\d+)([smhd])$/);
    if (!m) return 7 * 24 * 3600 * 1000;
    const f = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return parseInt(m[1], 10) * f[m[2]];
}

function refuse(res, status, message) {
    res.set('Cache-Control', 'no-store');
    return res.status(status).type('text/plain; charset=utf-8').send('SSO refusé : ' + message);
}

// Page « pont » : drapeau de session côté navigateur puis ouverture de l'app.
// location.replace() retire aussi l'URL /sso?token=... de l'historique.
const BRIDGE_HTML = '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
    + '<meta name="robots" content="noindex"><title>Connexion…</title></head><body>'
    + '<p style="font-family:system-ui,sans-serif">Connexion en cours…</p>'
    + '<script>try{localStorage.setItem("forage_session","1")}catch(e){}location.replace("/");</script>'
    + '<noscript><a href="/">Continuer</a></noscript></body></html>';

function registerSso(app) {
    app.get('/sso', (req, res) => {
        const token = String(req.query.token || '');
        if (!token) return refuse(res, 400, 'jeton manquant.');
        if (!SSO_SHARED_SECRET) return refuse(res, 500, 'SSO non configuré (SSO_SHARED_SECRET).');

        let payload;
        try {
            payload = jwt.verify(token, SSO_SHARED_SECRET, {
                algorithms: ['HS256'],
                audience: 'forage',
                issuer: 'portail-ge',
            });
        } catch (e) {
            return refuse(res, 401, 'jeton invalide ou expiré.');
        }

        if (!payload.jti || jtiAlreadyUsed(payload.jti)) {
            return refuse(res, 401, 'jeton déjà utilisé.');
        }
        rememberJti(payload.jti, payload.exp);

        const username = String(payload.sub || '').trim();
        const enterpriseId = parseInt(payload.ent, 10);
        if (!username || !Number.isInteger(enterpriseId)) {
            return refuse(res, 400, 'jeton incomplet.');
        }

        const db = getDb();
        // Même règle d'identifiant que /api/auth/login (insensible à la casse).
        db.get(
            'SELECT * FROM users WHERE LOWER(TRIM(username)) = LOWER(?) AND enterpriseId = ?',
            [username, enterpriseId],
            (err, user) => {
                if (err) return refuse(res, 500, 'erreur base.');
                if (!user) return refuse(res, 403, 'compte Forage introuvable pour cette entreprise.');
                if (PLATFORM_ROLES.includes(user.role)) {
                    return refuse(res, 403, 'compte plateforme non autorisé via le portail.');
                }

                db.get('SELECT id, name, isActive FROM enterprises WHERE id = ?', [enterpriseId], (err2, ent) => {
                    if (err2) return refuse(res, 500, 'erreur base.');
                    if (!ent || parseInt(ent.isActive, 10) === 0) {
                        return refuse(res, 403, 'entreprise introuvable ou désactivée dans Forage.');
                    }

                    // Cookie de session habituel de l'app.
                    const appToken = signUserToken(user, {
                        isSuperAdmin: false,
                        isPlatformOwner: false,
                        deploymentMode: process.env.DEPLOYMENT_MODE || 'dedicated',
                    });
                    res.cookie('forage_jwt', appToken, {
                        httpOnly: true,
                        sameSite: 'lax', // arrivée par redirection depuis le portail
                        secure: COOKIE_SECURE,
                        path: '/',
                        maxAge: SESSION_MAX_AGE_MS,
                    });

                    // Cookie lisible par la barre de bascule (non httpOnly).
                    const mods = Array.isArray(payload.mods)
                        ? payload.mods.filter((m) => m === 'forage' || m === 'mine')
                        : [];
                    const sb = {
                        portal: payload.portal || PORTAIL_BASE_URL,
                        current: 'forage',
                        modules: mods.length ? mods : ['forage'],
                        enterprise: ent.name || '',
                    };
                    res.cookie('ge_switchbar', JSON.stringify(sb), {
                        httpOnly: false,
                        sameSite: 'lax',
                        secure: COOKIE_SECURE,
                        path: '/',
                        maxAge: SESSION_MAX_AGE_MS,
                    });

                    res.set('Cache-Control', 'no-store');
                    return res.type('html').send(BRIDGE_HTML);
                });
            }
        );
    });
}

module.exports = { registerSso };
