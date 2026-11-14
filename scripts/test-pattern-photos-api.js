'use strict';

// API des plans hachurés (photo par fosse et par jour) : validation des images,
// normalisation du hachurage, reprise « veille » et isolation entre entreprises.
const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const initialPassword = 'PatternTest-2026!';
const JPEG = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-pattern').toString('base64');
const PNG = 'data:image/png;base64,' + Buffer.from('fake-png-composite').toString('base64');

function runNode(script, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], { cwd: projectDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { out += c; });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(script)} (${code})\n${out}`))));
    });
}
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer(); s.unref(); s.on('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}
async function request(baseUrl, endpoint, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(baseUrl + endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
    return { status: r.status, body: json };
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gedrilling-patterns-'));
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = {
        DB_PATH: path.join(tempDir, 'patterns.db'), BACKUP_DIR: path.join(tempDir, 'backups'), AUTO_BACKUP: 'off',
        INITIAL_PLATFORM_PASSWORD: initialPassword, JWT_SECRET: 'pattern-test-only-secret-that-is-long-enough-123',
        DEPLOYMENT_MODE: 'shared', PORT: String(port), NODE_ENV: 'test', CORS_ORIGINS: baseUrl
    };
    let server = null, logs = '';
    let checks = 0;
    const check = (cond, msg) => { assert.ok(cond, msg); checks += 1; };
    try {
        await runNode(path.join(projectDir, 'init-db.js'), env);
        await runNode(path.join(projectDir, 'migrate-db.js'), env);
        server = spawn(process.execPath, [path.join(projectDir, 'server.js')], { cwd: projectDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stdout.on('data', (c) => { logs += c; });
        server.stderr.on('data', (c) => { logs += c; });
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(baseUrl + '/api/health')).ok) break; } catch (_) {}
            await new Promise((r) => setTimeout(r, 100));
            if (i === 99) throw new Error('Serveur non prêt\n' + logs);
        }
        const platform = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'gestion_abonnements', password: initialPassword } });
        assert.equal(platform.status, 200, JSON.stringify(platform.body));
        async function tenant(suffix) {
            const created = await request(baseUrl, '/api/enterprises', { method: 'POST', token: platform.body.token, body: {
                name: `Forage ${suffix}`, slug: `forage-${suffix}`, plan: 'enterprise', currency: 'XOF', maxUsers: 5, maxSites: 3,
                firstUserUsername: `admin_${suffix}`, firstUserPassword: `Admin-${suffix}-2026!`, firstUserName: `Admin ${suffix}`, firstUserRole: 'admin'
            } });
            assert.equal(created.status, 200, JSON.stringify(created.body));
            const login = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: `admin_${suffix}`, password: `Admin-${suffix}-2026!` } });
            assert.equal(login.status, 200, JSON.stringify(login.body));
            return login.body.token;
        }
        const A = await tenant('a');
        const B = await tenant('b');

        // Validation des entrées
        for (const image of ['data:image/png;base64,AAA" onerror="x', 'data:image/svg+xml;base64,PHN2Zz4=', 'javascript:alert(1)', '']) {
            const bad = await request(baseUrl, '/api/pattern-photos', { method: 'POST', token: A, body: { date: '2026-10-26', zone: 'P17', image } });
            check(bad.status === 400, `Image refusée attendue pour ${image.slice(0, 30)}`);
        }
        check((await request(baseUrl, '/api/pattern-photos', { method: 'POST', token: A, body: { date: '26/10/2026', zone: 'P17', image: JPEG } })).status === 400, 'Date invalide refusée');
        check((await request(baseUrl, '/api/pattern-photos', { method: 'POST', token: A, body: { date: '2026-10-26', zone: '  ', image: JPEG } })).status === 400, 'Fosse requise');
        check((await request(baseUrl, '/api/pattern-photos', { method: 'POST', token: A, body: { date: '2026-10-26', zone: 'P17', image: JPEG, baseImage: 'data:text/html;base64,PGI+' } })).status === 400, 'Photo d’origine invalide refusée');

        // Import simple (photo déjà hachurée à la main) : pas de marques.
        const plain = await request(baseUrl, '/api/pattern-photos', { method: 'POST', token: A, body: { date: '2026-10-25', zone: 'P17', image: JPEG, source: 'photo' } });
        check(plain.status === 200 && plain.body.marks === 0, JSON.stringify(plain.body));

        // Hachurage dans la plateforme : marques normalisées côté serveur.
        const marks = {
            labels: false, legend: { show: true, pos: 'tr' },
            marks: [
                { x: 0.2, y: 0.3, t: 'drilled', id: ' P17-01 ', r: 0.5 },
                { x: 0.4, y: 0.3, t: 'previous', id: 'P17-02' },
                { x: 1.4, y: 0.3, t: 'drilled' },
                { x: 0.5, y: 0.5, t: '<script>', id: 'X'.repeat(90) },
                'nimporte quoi'
            ]
        };
        const saved = await request(baseUrl, '/api/pattern-photos', { method: 'POST', token: A, body: { date: '2026-10-26', zone: 'P17', image: PNG, baseImage: JPEG, marks, source: 'photo' } });
        check(saved.status === 200 && saved.body.marks === 3, JSON.stringify(saved.body));

        const list = await request(baseUrl, '/api/pattern-photos?date=2026-10-26', { token: A });
        check(list.status === 200 && list.body.length === 1, JSON.stringify(list.body));
        check(!('baseImage' in list.body[0]), 'La liste ne renvoie pas la photo d’origine (allègement)');
        check(list.body[0].image === PNG, 'La liste renvoie l’image hachurée');
        const m = list.body[0].marks;
        check(m && m.v === 1 && m.labels === false && m.legend.pos === 'tr', JSON.stringify(m));
        check(m.marks.length === 3 && m.marks[0].id === 'P17-01' && m.marks[0].r === 0.08, JSON.stringify(m.marks[0]));
        check(m.marks[2].t === 'drilled' && m.marks[2].id.length === 40, 'Type inconnu ramené à « foré », identifiant tronqué');

        const full = await request(baseUrl, `/api/pattern-photos/${saved.body.id}`, { token: A });
        check(full.status === 200 && full.body.baseImage === JPEG && full.body.image === PNG, 'Lecture complète pour l’éditeur');

        // Un seul pattern par fosse et par jour : le nouvel enregistrement remplace l'ancien.
        const replaced = await request(baseUrl, '/api/pattern-photos', { method: 'POST', token: A, body: { date: '2026-10-26', zone: 'P17', image: PNG, baseImage: JPEG, marks: { marks: [{ x: 0.1, y: 0.1 }] } } });
        check(replaced.status === 200, JSON.stringify(replaced.body));
        const afterReplace = await request(baseUrl, '/api/pattern-photos?date=2026-10-26', { token: A });
        check(afterReplace.body.length === 1 && afterReplace.body[0].id === replaced.body.id, 'Remplacement par fosse et par jour');

        // Un plan auto plus récent ne doit pas servir de « photo de la veille ».
        await request(baseUrl, '/api/pattern-photos', { method: 'POST', token: A, body: { date: '2026-10-26', zone: 'P18', image: PNG, source: 'auto' } });
        const prev = await request(baseUrl, '/api/pattern-photos/previous?zone=p17&before=2026-10-27', { token: A });
        check(prev.status === 200 && prev.body && prev.body.date === '2026-10-26' && prev.body.baseImage === JPEG, JSON.stringify(prev.body && prev.body.date));
        check(prev.body.marks && prev.body.marks.marks.length === 1, 'La reprise renvoie les positions des trous');
        const prevOlder = await request(baseUrl, '/api/pattern-photos/previous?zone=P17&before=2026-10-26', { token: A });
        check(prevOlder.body && prevOlder.body.date === '2026-10-25', 'La reprise prend le dernier plan strictement antérieur');
        const noAuto = await request(baseUrl, '/api/pattern-photos/previous?zone=P18&before=2026-10-27', { token: A });
        check(noAuto.status === 200 && noAuto.body === null, 'Un plan auto n’est jamais repris comme photo');
        check((await request(baseUrl, '/api/pattern-photos/previous?zone=P17&before=demain', { token: A })).status === 400, 'Date de reprise invalide');

        // Isolation entre entreprises
        check((await request(baseUrl, `/api/pattern-photos/${saved.body.id}`, { token: B })).status === 404, 'Une autre entreprise ne lit pas le plan');
        check((await request(baseUrl, `/api/pattern-photos/${replaced.body.id}`, { token: B })).status === 404, 'Une autre entreprise ne lit pas le plan (bis)');
        const listB = await request(baseUrl, '/api/pattern-photos?date=2026-10-26', { token: B });
        check(listB.status === 200 && listB.body.length === 0, 'Liste isolée par entreprise');
        const prevB = await request(baseUrl, '/api/pattern-photos/previous?zone=P17&before=2026-10-27', { token: B });
        check(prevB.status === 200 && prevB.body === null, 'Reprise isolée par entreprise');
        const delB = await request(baseUrl, `/api/pattern-photos/${replaced.body.id}`, { method: 'DELETE', token: B });
        check(delB.status === 200 && delB.body.changes === 0, 'Une autre entreprise ne supprime pas le plan');
        check((await request(baseUrl, '/api/pattern-photos?date=2026-10-26', { token: A })).body.length === 2, 'Le plan de A est intact');

        console.log(`✅ Plans hachurés API : ${checks} contrôles réussis (validation, hachurage, reprise, isolation).`);
    } finally {
        if (server) server.kill();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch((error) => { console.error('❌ Test API plans hachurés échoué'); console.error(error); process.exitCode = 1; });
