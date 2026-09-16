'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const initialPassword = 'SmokeTest-2026!';
const jwtSecret = 'smoke-test-only-secret-that-is-long-and-random-enough';

function runNode(script, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
            cwd: projectDir,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) return resolve({ stdout, stderr });
            reject(new Error(`${path.basename(script)} a échoué (${code})\n${stdout}\n${stderr}`));
        });
    });
}

function findFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => resolve(address.port));
        });
    });
}

async function request(baseUrl, endpoint, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.enterpriseId != null) headers['X-Enterprise-Id'] = String(options.enterpriseId);
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(baseUrl + endpoint, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    return { status: response.status, body };
}

async function waitForHealth(baseUrl, serverLogs) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
            const result = await request(baseUrl, '/api/health');
            if (result.status === 200) return result.body;
        } catch (_) {
            // Le serveur est encore en cours de démarrage.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Le serveur n'est pas devenu prêt.\n${serverLogs()}`);
}

function readUserCredentialState(dbPath, username) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
            if (openErr) return reject(openErr);
            db.get(
                'SELECT password, passwordHash FROM users WHERE username = ?',
                [username],
                (err, row) => {
                    db.close(() => {});
                    if (err) return reject(err);
                    resolve(row);
                }
            );
        });
    });
}

function clientPayload(id, name) {
    return {
        id,
        name,
        legalName: name,
        address: '',
        city: '',
        postalCode: '',
        country: 'BF',
        taxId: '',
        vatNumber: '',
        email: '',
        phone: '',
        website: '',
        currency: 'XOF',
        paymentTerms: '',
        notes: '',
        machines: [],
        monthlyMeters: {}
    };
}

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gedrilling-smoke-'));
    const dbPath = path.join(tempDir, 'smoke.db');
    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = {
        DB_PATH: dbPath,
        INITIAL_PLATFORM_PASSWORD: initialPassword,
        JWT_SECRET: jwtSecret,
        DEPLOYMENT_MODE: 'shared',
        PORT: String(port),
        NODE_ENV: 'test',
        CORS_ORIGINS: baseUrl
    };

    let server = null;
    let stdout = '';
    let stderr = '';

    try {
        await runNode(path.join(projectDir, 'init-db.js'), env);

        server = spawn(process.execPath, [path.join(projectDir, 'server.js')], {
            cwd: projectDir,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        server.stdout.on('data', (chunk) => { stdout += chunk; });
        server.stderr.on('data', (chunk) => { stderr += chunk; });
        server.on('error', (err) => { stderr += `\n${err.stack || err.message}`; });

        const health = await waitForHealth(baseUrl, () => stdout + '\n' + stderr);
        assert.equal(health.status, 'ok');
        assert.equal(health.database, 'ready');
        assert.equal(health.deploymentMode, 'shared');

        const anonymous = await request(baseUrl, '/api/enterprises');
        assert.equal(anonymous.status, 401, 'Une route métier doit refuser un appel sans JWT');

        const legacyTenantToken = jwt.sign(
            { sub: 999999, username: 'legacy', role: 'foreur' },
            jwtSecret,
            { expiresIn: '5m' }
        );
        const legacyTenantAccess = await request(baseUrl, '/api/clients', { token: legacyTenantToken });
        assert.equal(
            legacyTenantAccess.status,
            403,
            'Un ancien JWT sans entreprise ne doit jamais obtenir un accès global'
        );

        const platformLogin = await request(baseUrl, '/api/auth/login', {
            method: 'POST',
            body: { username: 'gestion_abonnements', password: initialPassword }
        });
        assert.equal(platformLogin.status, 200, JSON.stringify(platformLogin.body));
        const platformToken = platformLogin.body.token;

        async function createEnterprise(suffix) {
            const username = `admin_${suffix}`;
            const password = `Tenant-${suffix}-2026!`;
            const result = await request(baseUrl, '/api/enterprises', {
                method: 'POST',
                token: platformToken,
                body: {
                    name: `Mine ${suffix.toUpperCase()}`,
                    slug: `mine-${suffix}`,
                    plan: 'enterprise',
                    currency: 'XOF',
                    maxUsers: 10,
                    maxSites: 3,
                    firstUserUsername: username,
                    firstUserPassword: password,
                    firstUserName: `Admin ${suffix.toUpperCase()}`,
                    firstUserRole: 'admin'
                }
            });
            assert.equal(result.status, 200, JSON.stringify(result.body));
            return { id: result.body.id, username, password };
        }

        const tenantA = await createEnterprise('a');
        const tenantB = await createEnterprise('b');

        async function loginTenant(tenant) {
            const result = await request(baseUrl, '/api/auth/login', {
                method: 'POST',
                body: { username: tenant.username, password: tenant.password }
            });
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.deepEqual(
                result.body.enterprises.map((enterprise) => enterprise.id),
                [tenant.id],
                'La connexion d’un tenant ne doit exposer que sa propre entreprise'
            );
            assert.equal(result.body.currentEnterpriseId, tenant.id);
            return result.body.token;
        }

        const tokenA = await loginTenant(tenantA);
        const tokenB = await loginTenant(tenantB);

        const meA = await request(baseUrl, '/api/auth/me', { token: tokenA });
        assert.equal(meA.status, 200, JSON.stringify(meA.body));
        assert.deepEqual(meA.body.enterprises.map((enterprise) => enterprise.id), [tenantA.id]);

        const createClientA = await request(baseUrl, '/api/clients', {
            method: 'POST',
            token: tokenA,
            body: clientPayload(1001, 'Client A')
        });
        assert.equal(createClientA.status, 200, JSON.stringify(createClientA.body));

        const createClientB = await request(baseUrl, '/api/clients', {
            method: 'POST',
            token: tokenB,
            body: clientPayload(2001, 'Client B')
        });
        assert.equal(createClientB.status, 200, JSON.stringify(createClientB.body));

        const clientsSeenByA = await request(baseUrl, '/api/clients', {
            token: tokenA,
            enterpriseId: tenantB.id
        });
        assert.equal(clientsSeenByA.status, 200, JSON.stringify(clientsSeenByA.body));
        assert.deepEqual(
            clientsSeenByA.body.map((client) => client.id),
            [1001],
            'Un tenant ne doit pas pouvoir changer de contexte avec X-Enterprise-Id'
        );

        const createWorker = await request(baseUrl, '/api/users', {
            method: 'POST',
            token: tokenA,
            body: {
                username: 'foreur_a',
                password: 'Foreur-A-2026!',
                role: 'foreur',
                name: 'Foreur A'
            }
        });
        assert.equal(createWorker.status, 200, JSON.stringify(createWorker.body));

        const tenantAUsers = await request(baseUrl, '/api/users', { token: tokenA });
        assert.equal(tenantAUsers.status, 200, JSON.stringify(tenantAUsers.body));
        assert.deepEqual(
            tenantAUsers.body.map((user) => user.username).sort(),
            ['admin_a', 'foreur_a'],
            'Un administrateur tenant ne doit voir que les comptes de son entreprise'
        );

        const crossTenantUpdate = await request(baseUrl, `/api/users/${tenantB.username}`, {
            method: 'PUT',
            token: tokenA,
            body: { name: 'Modification interdite' }
        });
        assert.equal(crossTenantUpdate.status, 403, 'Un administrateur ne doit pas modifier un autre tenant');

        const workerLogin = await request(baseUrl, '/api/auth/login', {
            method: 'POST',
            body: { username: 'foreur_a', password: 'Foreur-A-2026!' }
        });
        assert.equal(workerLogin.status, 200, JSON.stringify(workerLogin.body));

        const workerUsersRead = await request(baseUrl, '/api/users', { token: workerLogin.body.token });
        assert.equal(workerUsersRead.status, 403, 'Un foreur ne doit pas pouvoir lister les comptes');

        const workerUsersWrite = await request(baseUrl, '/api/users', {
            method: 'POST',
            token: workerLogin.body.token,
            body: { username: 'intrus', password: 'Intrus-2026!', role: 'admin', name: 'Intrus' }
        });
        assert.equal(workerUsersWrite.status, 403, 'Un foreur ne doit pas pouvoir créer un administrateur');

        const updateWorker = await request(baseUrl, '/api/users/foreur_a', {
            method: 'PUT',
            token: tokenA,
            body: {
                newUsername: 'foreur_a_maj',
                name: 'Foreur A mis à jour',
                email: 'foreur.a@example.test',
                siteIds: [1, '2', 'invalide']
            }
        });
        assert.equal(updateWorker.status, 200, JSON.stringify(updateWorker.body));
        assert.equal(updateWorker.body.changes, 1);

        const changePassword = await request(baseUrl, '/api/auth/change-password', {
            method: 'POST',
            token: workerLogin.body.token,
            body: {
                currentPassword: 'Foreur-A-2026!',
                newPassword: 'Foreur-A-2027!'
            }
        });
        assert.equal(changePassword.status, 200, JSON.stringify(changePassword.body));

        const oldPasswordLogin = await request(baseUrl, '/api/auth/login', {
            method: 'POST',
            body: { username: 'foreur_a_maj', password: 'Foreur-A-2026!' }
        });
        assert.equal(oldPasswordLogin.status, 401, 'L’ancien mot de passe doit être invalidé');

        const updatedWorkerLogin = await request(baseUrl, '/api/auth/login', {
            method: 'POST',
            body: { username: 'foreur_a_maj', password: 'Foreur-A-2027!' }
        });
        assert.equal(updatedWorkerLogin.status, 200, JSON.stringify(updatedWorkerLogin.body));

        const createDrill = await request(baseUrl, '/api/drills', {
            method: 'POST',
            token: tokenA,
            body: {
                id: 'DRILL-A-01',
                location: 'Fosse A - banquette 410',
                status: 'EN FORAGE',
                telemetry: {},
                fuel: { level: 500, capacity: 1000 },
                rods: {},
                consumables: {}
            }
        });
        assert.equal(createDrill.status, 200, JSON.stringify(createDrill.body));

        const savePlan = await request(baseUrl, '/api/drilling-plan', {
            method: 'PUT',
            token: tokenA,
            body: {
                baseVersion: 0,
                blocks: [{
                    id: 'BLK-A-01',
                    name: 'Banquette 410',
                    spacing: '4x4',
                    burden: 4,
                    cols: 5,
                    holes: [{
                        id: 'T-001',
                        status: 'PLANIFIÉ',
                        planDepth: 12,
                        actDepth: 0,
                        diameterMm: 115,
                        easting: 643210.25,
                        northing: 1320450.75,
                        elevation: 410,
                        geology: 'OxM',
                        azimuth: 0,
                        inclination: 90,
                        waterEncountered: false,
                        drillId: 'DRILL-A-01'
                    }]
                }]
            }
        });
        assert.equal(savePlan.status, 200, JSON.stringify(savePlan.body));
        assert.equal(savePlan.body.version, 1);
        assert.equal(savePlan.body.blocks[0].holes[0].diameterMm, 115);

        const planVersionConflict = await request(baseUrl, '/api/drilling-plan', {
            method: 'PUT',
            token: tokenA,
            body: { baseVersion: 0, blocks: [] }
        });
        assert.equal(planVersionConflict.status, 409, 'Une ancienne version du plan doit être refusée');

        const workerPlanWrite = await request(baseUrl, '/api/drilling-plan', {
            method: 'PUT',
            token: updatedWorkerLogin.body.token,
            body: { baseVersion: 1, blocks: [] }
        });
        assert.equal(workerPlanWrite.status, 403, 'Un foreur ne doit pas modifier le plan maître');

        const tenantBPlan = await request(baseUrl, '/api/drilling-plan', { token: tokenB });
        assert.equal(tenantBPlan.status, 200, JSON.stringify(tenantBPlan.body));
        assert.deepEqual(tenantBPlan.body.blocks, [], 'Le plan de forage doit être isolé par entreprise');

        const dailyDraft = await request(baseUrl, '/api/daily-data', {
            method: 'POST',
            token: updatedWorkerLogin.body.token,
            body: {
                date: '2026-09-05',
                machineId: 'DRILL-A-01',
                data: {
                    shift: 'day',
                    location: 'Fosse A - banquette 410',
                    drillingType: 'production',
                    materialType: 'OxM',
                    bitType: 'carbure-115',
                    metersDrilled: 8,
                    hours: 8,
                    holesWorked: [{ blockId: 'BLK-A-01', holeId: 'T-001', meters: 8, finalDepth: 8 }],
                    stoppages: [{ reason: 'maintenance', hours: 4 }]
                },
                notes: 'Poste de test'
            }
        });
        assert.equal(dailyDraft.status, 200, JSON.stringify(dailyDraft.body));

        const submitted = await request(baseUrl, `/api/daily-data/${dailyDraft.body.id}/submit`, {
            method: 'POST',
            token: updatedWorkerLogin.body.token,
            body: {}
        });
        assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
        assert.equal(submitted.body.workflowStatus, 'submitted');

        const lockedEdit = await request(baseUrl, '/api/daily-data', {
            method: 'POST',
            token: updatedWorkerLogin.body.token,
            body: { date: '2026-09-05', machineId: 'DRILL-A-01', data: submitted.body.data, notes: 'Modification interdite' }
        });
        assert.equal(lockedEdit.status, 409, 'Un poste soumis doit être verrouillé');

        const workerApproval = await request(baseUrl, `/api/daily-data/${dailyDraft.body.id}/approve`, {
            method: 'POST', token: updatedWorkerLogin.body.token, body: {}
        });
        assert.equal(workerApproval.status, 403, 'Un foreur ne doit pas approuver son propre poste');

        const approved = await request(baseUrl, `/api/daily-data/${dailyDraft.body.id}/approve`, {
            method: 'POST', token: tokenA, body: { comment: 'Contrôlé par le superviseur' }
        });
        assert.equal(approved.status, 200, JSON.stringify(approved.body));
        assert.equal(approved.body.workflowStatus, 'approved');

        const progressedPlan = await request(baseUrl, '/api/drilling-plan', { token: tokenA });
        assert.equal(progressedPlan.status, 200, JSON.stringify(progressedPlan.body));
        assert.equal(progressedPlan.body.version, 2);
        assert.equal(progressedPlan.body.blocks[0].holes[0].actDepth, 8);
        assert.equal(progressedPlan.body.blocks[0].holes[0].status, 'EN COURS');

        const protectedDelete = await request(baseUrl, '/api/daily-data?date=2026-09-05&machineId=DRILL-A-01&shift=day', {
            method: 'DELETE', token: tokenA
        });
        assert.equal(protectedDelete.status, 200, JSON.stringify(protectedDelete.body));
        assert.equal(protectedDelete.body.deleted, 0, 'Un poste approuvé doit rester dans la piste d’audit');

        const reopened = await request(baseUrl, `/api/daily-data/${dailyDraft.body.id}/reopen`, {
            method: 'POST', token: tokenA, body: { comment: 'Correction demandée' }
        });
        assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
        assert.equal(reopened.body.workflowStatus, 'draft');

        const resubmitted = await request(baseUrl, `/api/daily-data/${dailyDraft.body.id}/submit`, {
            method: 'POST', token: updatedWorkerLogin.body.token, body: {}
        });
        assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));

        const rejected = await request(baseUrl, `/api/daily-data/${dailyDraft.body.id}/reject`, {
            method: 'POST', token: tokenA, body: { comment: 'Vérifier le métrage du trou' }
        });
        assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
        assert.equal(rejected.body.workflowStatus, 'rejected');
        assert.equal(rejected.body.reviewComment, 'Vérifier le métrage du trou');

        const deleteWorker = await request(baseUrl, '/api/users/foreur_a_maj', {
            method: 'DELETE',
            token: tokenA
        });
        assert.equal(deleteWorker.status, 200, JSON.stringify(deleteWorker.body));
        assert.equal(deleteWorker.body.changes, 1);

        const usersAfterDelete = await request(baseUrl, '/api/users', { token: tokenA });
        assert.equal(usersAfterDelete.status, 200, JSON.stringify(usersAfterDelete.body));
        assert.deepEqual(usersAfterDelete.body.map((user) => user.username), ['admin_a']);

        const stored = await readUserCredentialState(dbPath, tenantA.username);
        assert.ok(stored, 'Le premier utilisateur doit exister');
        assert.equal(stored.password, '', 'Aucun mot de passe en clair ne doit être stocké');
        assert.ok(stored.passwordHash && stored.passwordHash.startsWith('$2'), 'Le hash bcrypt doit être stocké');

        console.log('✅ Smoke test GEDRILLING réussi');
        console.log('   santé API, JWT, isolation tenant, plans normalisés, workflow journalier, rôles et mots de passe vérifiés');
    } finally {
        if (server && server.exitCode == null) {
            server.kill();
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 3000);
                server.once('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        if (stderr.trim()) process.stderr.write(stderr);
    }
}

main().catch((err) => {
    console.error('❌ Smoke test GEDRILLING échoué');
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
});
