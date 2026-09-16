/**
 * Traduction : DeepL (recommandé, DEEPL_API_KEY), puis LibreTranslate, puis MyMemory.
 * DeepL : https://www.deepl.com/pro-api — DEEPL_API_KEY (clé Free se termine souvent par :fx → hôte api-free.deepl.com automatique).
 * Autres env : DEEPL_API_URL, LIBRETRANSLATE_URL, LIBRETRANSLATE_API_KEY, LIBRETRANSLATE_OFF=1
 */
const path = require('path');
const fs = require('fs');
const https = require('https');
const multer = require('multer');

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        https
            .get(url, (r) => {
                let d = '';
                r.on('data', (c) => {
                    d += c;
                });
                r.on('end', () => {
                    try {
                        resolve(JSON.parse(d));
                    } catch (e) {
                        reject(e);
                    }
                });
            })
            .on('error', reject);
    });
}

/** POST JSON HTTPS (LibreTranslate, etc.) */
function httpPostJson(urlString, payload) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(urlString);
        const body = JSON.stringify(payload);
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: `${parsed.pathname || '/'}${parsed.search || ''}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = https.request(opts, (r) => {
            let d = '';
            r.on('data', (c) => {
                d += c;
            });
            r.on('end', () => {
                let json = null;
                try {
                    json = d ? JSON.parse(d) : {};
                } catch (e) {
                    return reject(e);
                }
                resolve({ status: r.statusCode || 0, json });
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/** POST application/x-www-form-urlencoded (API DeepL v2). */
function httpPostUrlEncoded(urlString, formObject) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(formObject).toString();
        const parsed = new URL(urlString);
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: `${parsed.pathname || '/'}${parsed.search || ''}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = https.request(opts, (r) => {
            let d = '';
            r.on('data', (c) => {
                d += c;
            });
            r.on('end', () => {
                let json = null;
                try {
                    json = d ? JSON.parse(d) : {};
                } catch (e) {
                    return reject(e);
                }
                resolve({ status: r.statusCode || 0, json });
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function mapLangForDeepL(code) {
    const s = String(code || '').toLowerCase();
    if (s.startsWith('en')) return 'EN';
    if (s.startsWith('fr')) return 'FR';
    const two = s.replace(/[^a-z]/g, '').slice(0, 2);
    return two.length === 2 ? two.toUpperCase() : 'EN';
}

/**
 * DeepL Pro / Free API — https://www.deepl.com/pro-api/documentation
 * Registre soutenu : formality=more quand demandé (repli auto sans ce paramètre si non supporté).
 */
async function translateWithDeepL(text, source, target, wantProfessional) {
    const authKey = String(process.env.DEEPL_API_KEY || '').trim();
    if (!authKey) throw new Error('DEEPL_API_KEY manquant');
    let base = String(process.env.DEEPL_API_URL || '').trim().replace(/\/$/, '');
    if (!base) {
        base = authKey.includes(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    } else if (!base.includes('://')) {
        base = `https://${base}`;
    }
    const url = `${base}/v2/translate`;
    const sl = mapLangForDeepL(source);
    const tl = mapLangForDeepL(target);

    const run = async (withFormality) => {
        const params = {
            auth_key: authKey,
            text,
            source_lang: sl,
            target_lang: tl
        };
        if (withFormality) params.formality = 'more';
        const r = await httpPostUrlEncoded(url, params);
        const ok = r.status >= 200 && r.status < 300;
        const arr = ok && r.json && Array.isArray(r.json.translations) ? r.json.translations : null;
        const out = arr && arr[0] && typeof arr[0].text === 'string' ? arr[0].text.trim() : '';
        if (!ok || !out) {
            const msg = (r.json && (r.json.message || r.json.error)) || `DeepL HTTP ${r.status}`;
            throw new Error(msg);
        }
        return out;
    };

    if (wantProfessional) {
        try {
            return await run(true);
        } catch (e) {
            /* formality non supportée pour cette paire de langues */
        }
    }
    return await run(false);
}

/**
 * Traduction « professionnelle » via LibreTranslate (formality prefer_more si supporté).
 * Repli sans formality, puis l’appelant basculera sur MyMemory.
 */
async function translateWithLibreTranslate(text, source, target, wantFormality) {
    let base = String(process.env.LIBRETRANSLATE_URL || 'https://libretranslate.com').replace(/\/$/, '');
    if (!base.includes('://')) base = `https://${base}`;
    const url = `${base}/translate`;
    const apiKey = process.env.LIBRETRANSLATE_API_KEY || '';
    const basePayload = {
        q: text,
        source: String(source || 'auto').slice(0, 8),
        target: String(target || 'en').slice(0, 8),
        format: 'text'
    };
    if (apiKey) basePayload.api_key = apiKey;

    const tryOnce = async (payload) => {
        const r = await httpPostJson(url, payload);
        const ok = r.status >= 200 && r.status < 300;
        const out = ok && r.json && typeof r.json.translatedText === 'string' ? r.json.translatedText.trim() : '';
        if (!ok || !out) {
            const errMsg = (r.json && r.json.error) || `HTTP ${r.status}`;
            throw new Error(errMsg);
        }
        return out;
    };

    if (wantFormality) {
        try {
            return await tryOnce({ ...basePayload, formality: 'prefer_more' });
        } catch (e) {
            /* Certaines instances ne gèrent pas formality */
        }
    }
    return await tryOnce({ ...basePayload });
}

function normalizeEmail(e) {
    return String(e || '')
        .trim()
        .toLowerCase();
}

function resolveCollabEnterpriseId(req, getEnterpriseId) {
    let eid = getEnterpriseId(req);
    if (eid == null && req.auth && req.auth.enterpriseId != null && req.auth.enterpriseId !== '') {
        const n = parseInt(req.auth.enterpriseId, 10);
        if (!isNaN(n)) eid = n;
    }
    return eid;
}

/** Publications « Infos », suppression d’annonces, diffusion de rapports sur la plateforme — réservé aux gestionnaires (et comptes plateforme). */
function canManageCompanyInfo(auth) {
    if (!auth) return false;
    if (auth.isSuperAdmin || auth.isPlatformOwner) return true;
    const r = auth.role || '';
    return ['gestionnaire', 'gestionnaire_site'].includes(r);
}

module.exports = function registerCollabRoutes(app, { db, getEnterpriseId }) {
    const uploadRoot = path.join(__dirname, 'uploads', 'chat');
    if (!fs.existsSync(uploadRoot)) {
        fs.mkdirSync(uploadRoot, { recursive: true });
    }

    const chatStorage = multer.diskStorage({
        destination(req, file, cb) {
            const entId = getEnterpriseId(req) || 1;
            const dir = path.join(uploadRoot, String(entId));
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch (e) {
                /* ignore */
            }
            cb(null, dir);
        },
        filename(req, file, cb) {
            const ext = path.extname(file.originalname || '') || '';
            cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        }
    });
    const chatUpload = multer({
        storage: chatStorage,
        limits: { fileSize: 18 * 1024 * 1024 }
    });

    app.post('/api/translate', (req, res) => {
        const q = String((req.body && req.body.text) || '').trim();
        const source = String((req.body && req.body.source) || 'fr').toLowerCase().slice(0, 5);
        const target = String((req.body && req.body.target) || 'en').toLowerCase().slice(0, 5);
        const reg = String((req.body && req.body.register) || 'standard').toLowerCase();
        const wantProfessional = reg !== 'standard' && reg !== 'casual' && reg !== 'courant';
        if (!q || q.length > 4500) {
            return res.status(400).json({ error: 'Texte requis (max. 4500 caractères)' });
        }

        const runMyMemory = () => {
            const pair = `${encodeURIComponent(source)}|${encodeURIComponent(target)}`;
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${pair}`;
            return httpGetJson(url).then((data) => {
                const out = data && data.responseData && data.responseData.translatedText;
                if (!out) {
                    return Promise.reject(new Error('Service de traduction indisponible ou quota dépassé'));
                }
                if (data.quotaFinished === true || String(out).includes('MYMEMORY WARNING')) {
                    return Promise.reject(new Error(
                        'Quota journalier MyMemory atteint. Réessayez demain, ou configurez DEEPL_API_KEY sur le serveur pour une traduction illimitée.'
                    ));
                }
                return {
                    translatedText: String(out).trim(),
                    engine: 'mymemory',
                    rawMatch: data.responseData.match != null ? data.responseData.match : null
                };
            });
        };

        const finish = (payload) => res.json(payload);
        const fail = () => res.status(502).json({ error: 'Erreur réseau (traduction)' });

        /**
         * Sans DeepL : toujours essayer LibreTranslate avant MyMemory (MyMemory est très imprécis sur de courts textes).
         * Registre professionnel : LT avec formalité → puis LT neutre → puis MyMemory.
         */
        const fallbackAfterDeepL = () => {
            const ltOff = process.env.LIBRETRANSLATE_OFF === '1';
            const afterLtFailed = (err) => {
                console.warn('Traduction LibreTranslate:', err && err.message);
                runMyMemory().then((payload) => finish(payload)).catch(() => fail());
            };
            if (ltOff) {
                runMyMemory().then((payload) => finish(payload)).catch(() => fail());
                return;
            }
            const tryLt = (wantFormality, regLabel) => {
                translateWithLibreTranslate(q, source, target, wantFormality)
                    .then((out) =>
                        finish({
                            translatedText: out,
                            engine: 'libretranslate',
                            register: regLabel
                        })
                    )
                    .catch((err) => {
                        if (wantFormality) {
                            tryLt(false, 'standard');
                        } else {
                            afterLtFailed(err);
                        }
                    });
            };
            if (wantProfessional) {
                tryLt(true, 'professional');
            } else {
                tryLt(false, 'standard');
            }
        };

        if (process.env.DEEPL_API_KEY) {
            translateWithDeepL(q, source, target, wantProfessional)
                .then((out) => finish({ translatedText: out, engine: 'deepl', register: wantProfessional ? 'professional' : 'standard' }))
                .catch((err) => {
                    console.warn('Traduction DeepL:', err && err.message);
                    fallbackAfterDeepL();
                });
            return;
        }

        fallbackAfterDeepL();
    });

    app.get('/api/worker-chat/messages', (req, res) => {
        const enterpriseId = resolveCollabEnterpriseId(req, getEnterpriseId);
        if (enterpriseId == null) {
            return res.status(400).json({ error: 'Contexte entreprise requis (sélectionnez une entreprise ou reconnectez-vous)' });
        }
        const me = parseInt(req.auth.sub, 10);
        if (Number.isNaN(me)) return res.status(400).json({ error: 'Session utilisateur invalide' });
        const sinceId = parseInt(req.query.sinceId || '0', 10) || 0;
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '80', 10) || 80));
        const sql = `
            SELECT m.*, uf.name AS fromName, uf.username AS fromUsername,
                   ut.name AS toName, ut.username AS toUsername
            FROM worker_chat_messages m
            LEFT JOIN users uf ON uf.id = m.fromUserId
            LEFT JOIN users ut ON ut.id = m.toUserId
            WHERE m.enterpriseId = ?
            AND (m.toUserId IS NULL OR m.fromUserId = ? OR m.toUserId = ?)
            AND m.id > ?
            ORDER BY m.id ASC
            LIMIT ?`;
        db.all(sql, [enterpriseId, me, me, sinceId, limit], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
    });

    app.post('/api/worker-chat/messages', (req, res) => {
        const enterpriseId = resolveCollabEnterpriseId(req, getEnterpriseId);
        if (enterpriseId == null) {
            return res.status(400).json({ error: 'Contexte entreprise requis (sélectionnez une entreprise ou reconnectez-vous)' });
        }
        let toUserId = req.body && req.body.toUserId;
        if (toUserId === '' || toUserId === undefined || toUserId === null) toUserId = null;
        else {
            toUserId = parseInt(toUserId, 10);
            if (Number.isNaN(toUserId)) return res.status(400).json({ error: 'Destinataire invalide' });
        }
        const body = String((req.body && req.body.body) || '').trim();
        if (!body) return res.status(400).json({ error: 'Message vide' });

        const fromId = parseInt(req.auth.sub, 10);
        if (Number.isNaN(fromId)) return res.status(400).json({ error: 'Session utilisateur invalide' });
        const ins = () => {
            db.run(
                `INSERT INTO worker_chat_messages (enterpriseId, fromUserId, toUserId, body, filePath, fileOriginalName)
                 VALUES (?, ?, ?, ?, NULL, NULL)`,
                [enterpriseId, fromId, toUserId, body],
                function (e2) {
                    if (e2) return res.status(500).json({ error: e2.message });
                    res.json({ id: this.lastID, ok: true });
                }
            );
        };

        if (toUserId != null) {
            db.get(
                'SELECT id FROM users WHERE id = ? AND enterpriseId = ? AND role NOT IN (\'platform_owner\',\'super_admin\')',
                [toUserId, enterpriseId],
                (e3, urow) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    if (!urow) return res.status(400).json({ error: 'Destinataire introuvable dans cette entreprise' });
                    ins();
                }
            );
        } else {
            ins();
        }
    });

    app.post('/api/worker-chat/messages/upload', chatUpload.single('file'), (req, res) => {
        const enterpriseId = resolveCollabEnterpriseId(req, getEnterpriseId);
        if (enterpriseId == null) {
            return res.status(400).json({ error: 'Contexte entreprise requis (sélectionnez une entreprise ou reconnectez-vous)' });
        }
        let toUserId = req.body && req.body.toUserId;
        if (toUserId === '' || toUserId === undefined || toUserId === null) toUserId = null;
        else {
            toUserId = parseInt(toUserId, 10);
            if (Number.isNaN(toUserId)) return res.status(400).json({ error: 'Destinataire invalide' });
        }
        const body = String((req.body && req.body.body) || '').trim();
        const file = req.file;
        if (!body && !file) return res.status(400).json({ error: 'Message ou fichier requis' });
        if (!file) return res.status(400).json({ error: 'Fichier manquant' });

        const fromId = parseInt(req.auth.sub, 10);
        if (Number.isNaN(fromId)) return res.status(400).json({ error: 'Session utilisateur invalide' });
        const relPath = path.relative(path.join(__dirname, 'uploads'), file.path).replace(/\\/g, '/');
        const finishInsert = () => {
            db.run(
                `INSERT INTO worker_chat_messages (enterpriseId, fromUserId, toUserId, body, filePath, fileOriginalName)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [enterpriseId, fromId, toUserId, body || '', relPath, file.originalname || 'fichier'],
                function (e2) {
                    if (e2) return res.status(500).json({ error: e2.message });
                    res.json({ id: this.lastID, ok: true, fileUrl: '/uploads/' + relPath });
                }
            );
        };

        if (toUserId != null) {
            db.get(
                'SELECT id FROM users WHERE id = ? AND enterpriseId = ? AND role NOT IN (\'platform_owner\',\'super_admin\')',
                [toUserId, enterpriseId],
                (e3, urow) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    if (!urow) return res.status(400).json({ error: 'Destinataire introuvable' });
                    finishInsert();
                }
            );
        } else {
            finishInsert();
        }
    });

    app.get('/api/company-info/posts', (req, res) => {
        const enterpriseId = getEnterpriseId(req);
        if (enterpriseId == null) return res.status(400).json({ error: 'Contexte entreprise requis' });
        db.all(
            `SELECT p.*, u.name AS authorName, u.username AS authorUsername
             FROM company_info_posts p
             LEFT JOIN users u ON u.id = p.authorUserId
             WHERE p.enterpriseId = ?
             ORDER BY p.pinned DESC, p.createdAt DESC
             LIMIT 200`,
            [enterpriseId],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
    });

    app.post('/api/company-info/posts', (req, res) => {
        if (!canManageCompanyInfo(req.auth)) {
            return res.status(403).json({ error: 'Seuls les gestionnaires peuvent publier des annonces' });
        }
        const enterpriseId = getEnterpriseId(req);
        if (enterpriseId == null) return res.status(400).json({ error: 'Contexte entreprise requis' });
        const title = String((req.body && req.body.title) || '').trim();
        const bodyHtml = String((req.body && req.body.body) || '').trim();
        if (!title || !bodyHtml) return res.status(400).json({ error: 'Titre et contenu requis' });
        const pinned = req.body && req.body.pinned ? 1 : 0;
        db.run(
            `INSERT INTO company_info_posts (enterpriseId, title, body, authorUserId, pinned) VALUES (?, ?, ?, ?, ?)`,
            [enterpriseId, title, bodyHtml, req.auth.sub, pinned],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: this.lastID });
            }
        );
    });

    app.delete('/api/company-info/posts/:id', (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) return res.status(400).json({ error: 'ID invalide' });
        const enterpriseId = getEnterpriseId(req);
        if (enterpriseId == null) return res.status(400).json({ error: 'Contexte entreprise requis' });
        db.get('SELECT * FROM company_info_posts WHERE id = ? AND enterpriseId = ?', [id, enterpriseId], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            if (!row) return res.status(404).json({ error: 'Publication introuvable' });
            if (!canManageCompanyInfo(req.auth)) {
                return res.status(403).json({ error: 'Seuls les gestionnaires peuvent retirer une annonce' });
            }
            db.run('DELETE FROM company_info_posts WHERE id = ?', [id], function (e2) {
                if (e2) return res.status(500).json({ error: e2.message });
                res.json({ ok: true, changes: this.changes });
            });
        });
    });

    app.post('/api/report-distributions', (req, res) => {
        if (!canManageCompanyInfo(req.auth)) {
            return res.status(403).json({ error: 'Seuls les gestionnaires peuvent envoyer une diffusion de rapport' });
        }
        const enterpriseId = getEnterpriseId(req);
        if (enterpriseId == null) return res.status(400).json({ error: 'Contexte entreprise requis' });
        const title = String((req.body && req.body.title) || '').trim();
        const bodyTxt = String((req.body && req.body.body) || '').trim();
        const reportData = req.body && req.body.reportData != null ? JSON.stringify(req.body.reportData) : null;
        let emails = req.body && req.body.emails;
        if (typeof emails === 'string') {
            emails = emails.split(/[,;\s]+/).map(normalizeEmail).filter(Boolean);
        }
        if (!Array.isArray(emails)) emails = [];
        emails = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
        if (!title) return res.status(400).json({ error: 'Titre requis' });
        if (emails.length === 0) return res.status(400).json({ error: 'Au moins une adresse e-mail' });

        db.run(
            `INSERT INTO report_distributions (enterpriseId, fromUserId, title, body, reportData) VALUES (?, ?, ?, ?, ?)`,
            [enterpriseId, req.auth.sub, title, bodyTxt || '', reportData],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                const distId = this.lastID;
                let i = 0;
                function nextEm() {
                    if (i >= emails.length) {
                        return res.json({ id: distId, recipients: emails.length });
                    }
                    const em = emails[i++];
                    db.run(
                        'INSERT INTO report_distribution_emails (distributionId, email) VALUES (?, ?)',
                        [distId, em],
                        (e2) => {
                            if (e2) return res.status(500).json({ error: e2.message });
                            nextEm();
                        }
                    );
                }
                nextEm();
            }
        );
    });

    app.get('/api/report-distributions/mine', (req, res) => {
        const enterpriseId = getEnterpriseId(req);
        if (enterpriseId == null) return res.status(400).json({ error: 'Contexte entreprise requis' });
        db.get('SELECT email, username FROM users WHERE id = ?', [req.auth.sub], (err, u) => {
            if (err) return res.status(500).json({ error: err.message });
            const mailParts = [];
            if (u && u.email) mailParts.push(normalizeEmail(u.email));
            if (u && u.username && String(u.username).includes('@')) mailParts.push(normalizeEmail(u.username));
            if (mailParts.length === 0) {
                return res.json([]);
            }
            const placeholders = mailParts.map(() => '?').join(',');
            const sql = `
                SELECT DISTINCT d.*, uf.name AS fromName
                FROM report_distributions d
                JOIN report_distribution_emails re ON re.distributionId = d.id
                JOIN users uf ON uf.id = d.fromUserId
                WHERE d.enterpriseId = ?
                AND LOWER(TRIM(re.email)) IN (${placeholders})
                ORDER BY d.createdAt DESC
                LIMIT 100`;
            db.all(sql, [enterpriseId, ...mailParts], (e2, rows) => {
                if (e2) return res.status(500).json({ error: e2.message });
                const parsed = (rows || []).map((r) => ({
                    ...r,
                    reportData: r.reportData
                        ? (function () {
                              try {
                                  return JSON.parse(r.reportData);
                              } catch (_) {
                                  return null;
                              }
                          })()
                        : null
                }));
                res.json(parsed);
            });
        });
    });

    app.get('/api/report-distributions', (req, res) => {
        if (!canManageCompanyInfo(req.auth) && !req.auth.isSuperAdmin && !req.auth.isPlatformOwner) {
            return res.status(403).json({ error: 'Non autorisé' });
        }
        const enterpriseId = getEnterpriseId(req);
        if (enterpriseId == null) return res.status(400).json({ error: 'Contexte entreprise requis' });
        db.all(
            `SELECT d.*, uf.name AS fromName FROM report_distributions d
             JOIN users uf ON uf.id = d.fromUserId
             WHERE d.enterpriseId = ?
             ORDER BY d.createdAt DESC LIMIT 100`,
            [enterpriseId],
            (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows || []);
            }
        );
    });

    /** Suppression d’une diffusion reçue : gestionnaire (toute l’entreprise) ou destinataire figurant sur l’e-mail. */
    app.delete('/api/report-distributions/:id', (req, res) => {
        const distId = parseInt(req.params.id, 10);
        if (Number.isNaN(distId)) return res.status(400).json({ error: 'Identifiant invalide' });
        const enterpriseId = resolveCollabEnterpriseId(req, getEnterpriseId);
        if (enterpriseId == null) return res.status(400).json({ error: 'Contexte entreprise requis' });

        db.get(
            'SELECT * FROM report_distributions WHERE id = ? AND enterpriseId = ?',
            [distId, enterpriseId],
            (err, dist) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!dist) return res.status(404).json({ error: 'Rapport introuvable' });

                const runDelete = () => {
                    db.run('DELETE FROM report_distributions WHERE id = ? AND enterpriseId = ?', [distId, enterpriseId], function (e2) {
                        if (e2) return res.status(500).json({ error: e2.message });
                        if (this.changes === 0) return res.status(404).json({ error: 'Rapport introuvable' });
                        res.json({ ok: true });
                    });
                };

                if (canManageCompanyInfo(req.auth)) {
                    return runDelete();
                }

                db.get('SELECT email, username FROM users WHERE id = ?', [req.auth.sub], (e3, u) => {
                    if (e3) return res.status(500).json({ error: e3.message });
                    const mailParts = [];
                    if (u && u.email) mailParts.push(normalizeEmail(u.email));
                    if (u && u.username && String(u.username).includes('@')) mailParts.push(normalizeEmail(u.username));
                    if (mailParts.length === 0) {
                        return res.status(403).json({ error: 'Non autorisé à supprimer ce rapport' });
                    }
                    const ph = mailParts.map(() => '?').join(',');
                    db.get(
                        `SELECT 1 AS ok FROM report_distribution_emails WHERE distributionId = ? AND LOWER(TRIM(email)) IN (${ph})`,
                        [distId, ...mailParts],
                        (e4, row) => {
                            if (e4) return res.status(500).json({ error: e4.message });
                            if (!row) return res.status(403).json({ error: 'Vous n’êtes pas destinataire de ce rapport' });
                            runDelete();
                        }
                    );
                });
            }
        );
    });
};
