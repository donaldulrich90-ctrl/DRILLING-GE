const bcrypt = require('bcryptjs');
const { signUserToken } = require('../middleware/saas-auth');

module.exports = function registerAuthRoutes(app, options) {
    const { db, deploymentMode, parseUserSiteIds } = options;

    function buildSessionPayload(user, token) {
        const isSuperAdmin = user.role === 'super_admin' && user.enterpriseId == null;
        const isPlatformOwner = user.role === 'platform_owner';
        const tokenUser = {
            id: user.id,
            username: user.username,
            name: user.name,
            role: user.role,
            email: user.email != null && String(user.email).trim() !== '' ? String(user.email).trim() : null,
            enterpriseId: deploymentMode === 'dedicated' ? (user.enterpriseId || 1) : user.enterpriseId,
            restrictions: user.restrictions ? JSON.parse(user.restrictions) : {},
            siteIds: parseUserSiteIds(user.siteIds)
        };
        return { isSuperAdmin, isPlatformOwner, tokenUser, token };
    }

    function sendSessionResponse(res, session) {
        const { user, token, includeToken } = session;
        const payload = buildSessionPayload(user, token);

        db.all('SELECT * FROM enterprises ORDER BY name', [], (err, enterprises) => {
            if (err) return res.status(500).json({ error: err.message });

            let list = enterprises || [];
            let currentEnterpriseId = 1;
            if (deploymentMode === 'dedicated') {
                if (payload.isPlatformOwner || payload.isSuperAdmin) {
                    currentEnterpriseId = payload.isSuperAdmin ? null : (user.enterpriseId != null ? user.enterpriseId : null);
                } else {
                    const tenantId = user.enterpriseId != null ? parseInt(user.enterpriseId, 10) : 1;
                    list = list.filter((enterprise) => parseInt(enterprise.id, 10) === tenantId);
                    currentEnterpriseId = tenantId;
                }
            } else if (!payload.isPlatformOwner && !payload.isSuperAdmin) {
                const tenantId = user.enterpriseId != null ? parseInt(user.enterpriseId, 10) : NaN;
                if (Number.isNaN(tenantId)) {
                    return res.status(403).json({ error: 'Compte sans entreprise attribuée' });
                }
                list = list.filter((enterprise) => (
                    parseInt(enterprise.id, 10) === tenantId && parseInt(enterprise.isActive, 10) === 1
                ));
                if (list.length === 0) {
                    return res.status(403).json({ error: 'Entreprise introuvable ou désactivée' });
                }
                currentEnterpriseId = tenantId;
            } else {
                currentEnterpriseId = payload.isSuperAdmin ? null : user.enterpriseId;
            }

            const response = {
                user: payload.tokenUser,
                isSuperAdmin: payload.isSuperAdmin,
                isPlatformOwner: payload.isPlatformOwner,
                enterprises: list,
                currentEnterpriseId,
                deploymentMode
            };
            if (includeToken) response.token = token;
            return res.json(response);
        });
    }

    app.post('/api/auth/login', (req, res) => {
        const { username, password } = req.body || {};
        const loginUser = username != null ? String(username).trim() : '';
        if (!loginUser || !password) {
            return res.status(400).json({ error: 'Identifiants requis' });
        }

        db.get('SELECT * FROM users WHERE LOWER(TRIM(username)) = LOWER(?)', [loginUser], (err, user) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });

            let passwordOk = false;
            if (user.passwordHash) {
                passwordOk = bcrypt.compareSync(password, user.passwordHash);
            } else {
                passwordOk = user.password === password;
                if (passwordOk) {
                    const hash = bcrypt.hashSync(password, 10);
                    db.run('UPDATE users SET password = ?, passwordHash = ? WHERE id = ?', ['', hash, user.id], () => {});
                }
            }
            if (!passwordOk) return res.status(401).json({ error: 'Identifiants incorrects' });

            const token = signUserToken(
                {
                    id: user.id,
                    username: user.username,
                    role: user.role,
                    enterpriseId: deploymentMode === 'dedicated' ? (user.enterpriseId || 1) : user.enterpriseId
                },
                {
                    isSuperAdmin: user.role === 'super_admin' && user.enterpriseId == null,
                    isPlatformOwner: user.role === 'platform_owner',
                    deploymentMode
                }
            );
            return sendSessionResponse(res, { user, token, includeToken: true });
        });
    });

    app.get('/api/auth/me', (req, res) => {
        db.get('SELECT * FROM users WHERE id = ?', [req.auth.sub], (err, user) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!user) return res.status(401).json({ error: 'Utilisateur inconnu' });
            return sendSessionResponse(res, { user, includeToken: false });
        });
    });

    app.post('/api/auth/change-password', (req, res) => {
        const { currentPassword, newPassword } = req.body || {};
        if (currentPassword == null || newPassword == null || String(currentPassword) === '' || String(newPassword) === '') {
            return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis' });
        }
        if (String(newPassword).length < 6) {
            return res.status(400).json({ error: 'Mot de passe : minimum 6 caractères' });
        }

        db.get('SELECT * FROM users WHERE id = ?', [req.auth.sub], (err, user) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!user) return res.status(404).json({ error: 'Utilisateur inconnu' });

            const ok = user.passwordHash
                ? bcrypt.compareSync(String(currentPassword), user.passwordHash)
                : String(user.password || '') === String(currentPassword);
            if (!ok) return res.status(403).json({ error: 'Mot de passe actuel incorrect' });

            const hash = bcrypt.hashSync(String(newPassword), 10);
            db.run('UPDATE users SET password = ?, passwordHash = ? WHERE id = ?', ['', hash, user.id], (updateErr) => {
                if (updateErr) return res.status(500).json({ error: updateErr.message });
                return res.json({ message: 'Mot de passe mis à jour' });
            });
        });
    });
};
