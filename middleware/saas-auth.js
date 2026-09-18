/**
 * Authentification JWT et contexte SaaS (tenant)
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const configuredJwtSecret = String(process.env.JWT_SECRET || '').trim();
if (!configuredJwtSecret && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET doit être défini en production.');
}
// En développement, une clé éphémère évite de laisser un secret connu dans le dépôt.
const JWT_SECRET = configuredJwtSecret || crypto.randomBytes(48).toString('hex');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signUserToken(user, meta) {
    const { isSuperAdmin, isPlatformOwner, deploymentMode } = meta;
    return jwt.sign(
        {
            sub: user.id,
            username: user.username,
            role: user.role,
            enterpriseId: user.enterpriseId,
            isSuperAdmin: !!isSuperAdmin,
            isPlatformOwner: !!isPlatformOwner,
            deploymentMode: deploymentMode || 'dedicated'
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

function verifyAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentification requise (token Bearer manquant)' });
    }
    try {
        const payload = jwt.verify(header.slice(7), JWT_SECRET);
        req.auth = payload;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Session invalide ou expirée' });
    }
}

function requirePlatformAdmin(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'Non authentifié' });
    if (req.auth.isSuperAdmin || req.auth.isPlatformOwner) return next();
    // Compatibilité : anciens JWT (avant correctif) sans flags, ou revendication explicite par rôle
    if (req.auth.role === 'platform_owner') return next();
    if (req.auth.role === 'super_admin' && (req.auth.enterpriseId == null || req.auth.enterpriseId === '')) return next();
    return res.status(403).json({ error: 'Accès réservé à l’administration plateforme' });
}

module.exports = {
    signUserToken,
    verifyAuth,
    requirePlatformAdmin,
    JWT_EXPIRES_IN
};
