const bcrypt = require('bcryptjs');

module.exports = function registerUserRoutes(app, options) {
    const {
        db,
        getEnterpriseId,
        parseUserSiteIds,
        requireUserManagementRole,
        validateTenantUserAssignment
    } = options;

    function isPlatformUser(req) {
        return !!(
            req.auth.isSuperAdmin ||
            req.auth.isPlatformOwner ||
            req.auth.role === 'platform_owner'
        );
    }

    app.get('/api/users', requireUserManagementRole, (req, res) => {
        const isPlatform = isPlatformUser(req);
        const requestedEnterprise = req.query.enterpriseId;
        let query = 'SELECT id, username, role, name, email, enterpriseId, restrictions, siteIds, notes, createdAt FROM users';
        const params = [];

        if (isPlatform && requestedEnterprise !== undefined && requestedEnterprise !== '') {
            const enterpriseId = parseInt(requestedEnterprise, 10);
            if (!Number.isNaN(enterpriseId)) {
                query += " WHERE enterpriseId = ? AND role NOT IN ('platform_owner','super_admin')";
                params.push(enterpriseId);
            }
        }

        if (params.length === 0) {
            const enterpriseId = getEnterpriseId(req);
            if (enterpriseId !== null && enterpriseId !== undefined) {
                query += " WHERE enterpriseId = ? AND role NOT IN ('platform_owner','super_admin')";
                params.push(enterpriseId);
            } else if (!isPlatform) {
                return res.status(400).json({ error: 'Contexte entreprise manquant' });
            }
        }

        query += ' ORDER BY name';
        db.all(query, params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            return res.json(rows.map((row) => ({
                ...row,
                restrictions: row.restrictions ? JSON.parse(row.restrictions) : {},
                siteIds: parseUserSiteIds(row.siteIds)
            })));
        });
    });

    app.post('/api/users', requireUserManagementRole, (req, res) => {
        const { password, role, name, restrictions, notes, enterpriseId: bodyEnterpriseId, email, siteIds } = req.body || {};
        const username = req.body && req.body.username != null ? String(req.body.username).trim().toLowerCase() : '';
        if (!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
        if (!role) return res.status(400).json({ error: 'Rôle requis' });

        let enterpriseId = getEnterpriseId(req);
        if (isPlatformUser(req)) {
            if (bodyEnterpriseId != null && bodyEnterpriseId !== '') enterpriseId = parseInt(bodyEnterpriseId, 10);
        } else if (enterpriseId == null) {
            return res.status(400).json({ error: 'Contexte entreprise manquant' });
        }

        validateTenantUserAssignment(db, enterpriseId, role, true, (validationError) => {
            if (validationError) return res.status(403).json({ error: validationError.message });

            const restrictionsJson = JSON.stringify(restrictions || {});
            const siteIdsJson = JSON.stringify(
                Array.isArray(siteIds)
                    ? siteIds.map((value) => parseInt(value, 10)).filter((value) => !Number.isNaN(value))
                    : []
            );
            const emailValue = email != null && String(email).trim() !== '' ? String(email).trim() : null;
            db.run(
                'INSERT INTO users (username, password, passwordHash, role, name, enterpriseId, restrictions, notes, email, siteIds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [username, '', bcrypt.hashSync(password, 10), role, name, enterpriseId, restrictionsJson, notes || '', emailValue, siteIdsJson],
                function insertUser(insertError) {
                    if (insertError) return res.status(500).json({ error: insertError.message });
                    return res.json({ id: this.lastID, username, role, name, enterpriseId });
                }
            );
        });
    });

    app.put('/api/users/:username', requireUserManagementRole, (req, res) => {
        const paramUsername = req.params.username != null ? String(req.params.username).trim() : '';
        const body = req.body || {};
        db.get(
            'SELECT enterpriseId, role, username AS dbUsername FROM users WHERE LOWER(TRIM(username)) = LOWER(?)',
            [paramUsername],
            (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Utilisateur inconnu' });

                const canonicalUsername = row.dbUsername;
                if (!isPlatformUser(req)) {
                    const myEnterpriseId = getEnterpriseId(req);
                    if (row.enterpriseId == null || parseInt(row.enterpriseId, 10) !== parseInt(myEnterpriseId, 10)) {
                        return res.status(403).json({ error: 'Non autorisé' });
                    }
                }
                if (['platform_owner', 'super_admin'].includes(row.role)) {
                    return res.status(403).json({ error: 'Les comptes plateforme ne sont pas modifiables par cette route.' });
                }

                const { password, role, name, restrictions, notes, newUsername, email, siteIds } = body;
                if (password != null && password !== '' && String(password).length < 6) {
                    return res.status(400).json({ error: 'Mot de passe : minimum 6 caractères' });
                }

                let newUsernameValue = null;
                if (newUsername !== undefined && newUsername !== null) {
                    const normalized = String(newUsername).trim().toLowerCase();
                    if (normalized !== '' && normalized !== String(canonicalUsername).toLowerCase()) {
                        newUsernameValue = normalized;
                    }
                }

                const buildUpdates = () => {
                    const updates = [];
                    const values = [];
                    if (newUsernameValue) {
                        updates.push('username = ?');
                        values.push(newUsernameValue);
                    }
                    if (password) {
                        updates.push('password = ?', 'passwordHash = ?');
                        values.push('', bcrypt.hashSync(password, 10));
                    }
                    if (role) {
                        updates.push('role = ?');
                        values.push(role);
                    }
                    if (name) {
                        updates.push('name = ?');
                        values.push(name);
                    }
                    if (restrictions !== undefined) {
                        updates.push('restrictions = ?');
                        values.push(JSON.stringify(restrictions || {}));
                    }
                    if (notes !== undefined) {
                        updates.push('notes = ?');
                        values.push(notes);
                    }
                    if (email !== undefined) {
                        updates.push('email = ?');
                        values.push(email === null || email === '' ? null : String(email).trim());
                    }
                    if (siteIds !== undefined) {
                        updates.push('siteIds = ?');
                        values.push(JSON.stringify(
                            Array.isArray(siteIds)
                                ? siteIds.map((value) => parseInt(value, 10)).filter((value) => !Number.isNaN(value))
                                : []
                        ));
                    }
                    return { updates, values };
                };

                const runUpdate = (updates, values) => {
                    if (updates.length === 0) return res.status(400).json({ error: 'Aucune mise à jour' });
                    db.run(
                        `UPDATE users SET ${updates.join(', ')} WHERE username = ?`,
                        values.concat([canonicalUsername]),
                        function updateUser(updateError) {
                            if (updateError) return res.status(500).json({ error: updateError.message });
                            return res.json({ message: 'Utilisateur mis à jour', changes: this.changes });
                        }
                    );
                };

                const proceed = () => {
                    const { updates, values } = buildUpdates();
                    if (!role) return runUpdate(updates, values);
                    return validateTenantUserAssignment(db, row.enterpriseId, role, false, (validationError) => {
                        if (validationError) return res.status(403).json({ error: validationError.message });
                        return runUpdate(updates, values);
                    });
                };

                if (!newUsernameValue) return proceed();
                return db.get(
                    'SELECT id FROM users WHERE LOWER(TRIM(username)) = LOWER(?)',
                    [newUsernameValue],
                    (duplicateError, duplicate) => {
                        if (duplicateError) return res.status(500).json({ error: duplicateError.message });
                        if (duplicate) return res.status(400).json({ error: 'Cet identifiant de connexion est déjà utilisé' });
                        return proceed();
                    }
                );
            }
        );
    });

    app.delete('/api/users/:username', requireUserManagementRole, (req, res) => {
        const username = req.params.username != null ? String(req.params.username).trim() : '';
        db.get(
            'SELECT enterpriseId, role, username AS dbUsername FROM users WHERE LOWER(TRIM(username)) = LOWER(?)',
            [username],
            (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Utilisateur inconnu' });
                if (['super_admin', 'platform_owner'].includes(row.role)) {
                    return res.status(403).json({ error: 'Compte plateforme non supprimable ici' });
                }
                if (!isPlatformUser(req)) {
                    const myEnterpriseId = getEnterpriseId(req);
                    if (row.enterpriseId == null || parseInt(row.enterpriseId, 10) !== parseInt(myEnterpriseId, 10)) {
                        return res.status(403).json({ error: 'Non autorisé' });
                    }
                }
                return db.run(
                    "DELETE FROM users WHERE username = ? AND role NOT IN ('admin','super_admin','platform_owner')",
                    [row.dbUsername],
                    function deleteUser(deleteError) {
                        if (deleteError) return res.status(500).json({ error: deleteError.message });
                        return res.json({ message: 'Utilisateur supprimé', changes: this.changes });
                    }
                );
            }
        );
    });
};
