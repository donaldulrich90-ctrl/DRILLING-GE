'use strict';

// API réelle et base isolée : aucune dépendance aux comptes ni aux données de production.
const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const projectDir = path.resolve(__dirname, '..');
const initialPassword = 'DailyDraftTest-2026!';

function runNode(script, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], { cwd: projectDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(script)} (${code})\n${output}`)));
    });
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

async function main() {
    const tempRoot = path.resolve(os.tmpdir());
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'gedrilling-daily-drafts-'));
    const baseUrl = `http://127.0.0.1:${await freePort()}`;
    const env = {
        DB_PATH: path.join(tempDir, 'daily-drafts.db'),
        BACKUP_DIR: path.join(tempDir, 'backups'),
        INITIAL_PLATFORM_PASSWORD: initialPassword,
        JWT_SECRET: 'daily-drafts-test-secret-2026-isolated-environment',
        DEPLOYMENT_MODE: 'shared',
        PORT: baseUrl.split(':').pop(),
        NODE_ENV: 'test',
        CORS_ORIGINS: baseUrl
    };
    let server;
    let logs = '';
    let assertions = 0;
    const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions += 1; };
    async function request(endpoint, { token, method = 'GET', body, enterpriseId } = {}) {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (enterpriseId != null) headers['X-Enterprise-Id'] = String(enterpriseId);
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(baseUrl + endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    }
    function status(result, expected, message) { check(result.status, expected, `${message}: ${JSON.stringify(result.body)}`); }

    try {
        await runNode(path.join(projectDir, 'init-db.js'), env);
        server = spawn(process.execPath, [path.join(projectDir, 'server.js')], { cwd: projectDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stdout.on('data', (chunk) => { logs += chunk; });
        server.stderr.on('data', (chunk) => { logs += chunk; });
        server.on('error', (error) => { logs += error.stack || error.message; });
        let ready = false;
        for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
            try { ready = (await request('/api/health')).status === 200; } catch (_) {}
            if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(ready, `Serveur indisponible\n${logs}`);

        const platformLogin = await request('/api/auth/login', { method: 'POST', body: { username: 'gestion_abonnements', password: initialPassword } });
        status(platformLogin, 200, 'Connexion plateforme');
        async function createTenant(suffix) {
            const username = `daily_admin_${suffix}`;
            const password = `Daily-${suffix}-2026!`;
            const created = await request('/api/enterprises', {
                method: 'POST', token: platformLogin.body.token,
                body: { name: `Daily mine ${suffix}`, slug: `daily-mine-${suffix}`, plan: 'enterprise', currency: 'XOF', maxUsers: 10, maxSites: 3,
                    firstUserUsername: username, firstUserPassword: password, firstUserName: `Admin ${suffix}`, firstUserRole: 'admin' }
            });
            status(created, 200, 'Création entreprise');
            const login = await request('/api/auth/login', { method: 'POST', body: { username, password } });
            status(login, 200, 'Connexion entreprise');
            return { id: created.body.id, token: login.body.token };
        }
        const tenantA = await createTenant('a');
        const tenantB = await createTenant('b');
        status(await request('/api/users', { method: 'POST', token: tenantA.token,
            body: { username: 'daily_engineer', name: 'Ingénieur de test', role: 'ingenieur', password: 'Engineer-2026!' } }), 200, 'Création ingénieur');
        const engineer = await request('/api/auth/login', { method: 'POST', body: { username: 'daily_engineer', password: 'Engineer-2026!' } });
        status(engineer, 200, 'Connexion ingénieur autorisé à saisir');
        const token = engineer.body.token;

        for (const [tenant, machineId] of [[tenantA, 'DAILY-A'], [tenantB, 'DAILY-B']]) {
            status(await request('/api/drills', { method: 'POST', token: tenant.token,
                body: { id: machineId, location: 'Fosse de test', status: 'EN FORAGE', telemetry: {}, fuel: { level: 500, capacity: 1000 }, rods: {}, consumables: {} } }), 200, 'Création machine');
            status(await request('/api/drilling-plan', { method: 'PUT', token: tenant.token,
                body: { baseVersion: 0, blocks: [{ id: `${machineId}-BLOCK`, name: 'Bloc test', holes: [{ id: 'T-01', planDepth: 12, actDepth: 0, status: 'PLANIFIÉ', drillId: machineId }] }] } }), 200, 'Création plan');
        }

        const recordKey = { date: '2026-10-22', machineId: 'DAILY-A' };
        const save = (data, extra = {}) => request('/api/daily-data', { method: 'POST', token, body: { ...recordKey, data, ...extra } });
        const read = () => request('/api/daily-data?date=2026-10-22&machineId=DAILY-A', { token });
        const blank = { shift: 'day', entryStage: 'draft' };
        const created = await save(blank);
        status(created, 200, 'Préenregistrement sans détails');
        const id = created.body.id;
        const initialRead = await read();
        status(initialRead, 200, 'Lecture du brouillon');
        check(initialRead.body[0].data, blank, 'Aucun zéro ni aucune donnée inventée dans un brouillon vide');
        check(initialRead.body[0].workflowStatus, 'draft', 'Le circuit de validation demeure distinct du stade de saisie');
        check(initialRead.body[0].enteredByUsername, 'daily_engineer', 'Auteur serveur tracé');

        const partial = { ...blank, metersDrilled: null, hours: '', location: 'Fosse A',
            holesWorked: [{ blockId: 'DAILY-A-BLOCK', holeId: '', meters: null, finalDepth: null }],
            stoppages: [{ reason: 'maintenance', timeStart: '10:30', timeEnd: '', hours: null, detail: 'Diagnostic en cours' }] };
        const updated = await save(partial, { notes: 'Reprendre après la relève' });
        status(updated, 200, 'Préenregistrement partiel avec arrêt en cours');
        check(updated.body.id, id, 'La reprise utilise la même saisie');
        const partialRead = (await read()).body[0];
        check(partialRead.data, partial, 'Champs vides et arrêt ouvert conservés exactement');
        check(partialRead.notes, 'Reprendre après la relève', 'Notes préenregistrées');
        check(partialRead.lastModifiedByUsername, 'daily_engineer', 'Modification tracée');
        check(partialRead.workflowVersion, 1, 'Version incrémentée à la reprise');
        status(await request(`/api/daily-data/${id}/submit`, { method: 'POST', token, body: {} }), 400, 'Un poste partiel ne peut pas être soumis');
        status(await save({ ...partial, entryStage: 'complete' }), 400, 'Un arrêt ouvert ne peut pas être clôturé');

        const complete = {
            shift: 'day', entryStage: 'complete', location: 'Fosse A', drillingType: 'production', materialType: 'OxM', bitType: 'carbure-115',
            metersDrilled: 8, hours: 8,
            holesWorked: [{ blockId: 'DAILY-A-BLOCK', holeId: 'T-01', meters: 8, finalDepth: 8 }],
            stoppages: [{ reason: 'maintenance', hours: 4, timeStart: '22:00', timeEnd: '02:00', detail: 'Passage minuit' }]
        };
        for (const [label, data, extra] of [
            ['Stade inconnu', { ...blank, entryStage: 'pending' }],
            ['Données non structurées', []],
            ['Shift inconnu', { ...blank, shift: 'unknown' }],
            ['Date civile invalide', blank, { date: '2026-02-30' }],
            ['Métrage négatif', { ...blank, metersDrilled: -1 }],
            ['Nombre booléen refusé', { ...blank, hours: false }],
            ['Heures non numériques', { ...blank, hours: 'abc' }],
            ['Arrêts non structurés', { ...blank, stoppages: {} }],
            ['Durée négative', { ...blank, stoppages: [{ reason: 'maintenance', hours: -1 }] }],
            ['Durée non numérique', { ...blank, stoppages: [{ reason: 'maintenance', hours: 'abc' }] }],
            ['Horaire invalide', { ...blank, stoppages: [{ reason: 'maintenance', timeStart: '26:00', hours: null }] }],
            ['Durée incohérente avec horaires', { ...complete, entryStage: 'draft', stoppages: [{ reason: 'maintenance', hours: 3, timeStart: '22:00', timeEnd: '02:00' }] }],
            ['Clôture sans lieu', { ...complete, location: '' }],
            ['Clôture sans type de forage', { ...complete, drillingType: '' }],
            ['Clôture sans matériau', { ...complete, materialType: '' }],
            ['Clôture sans trépan', { ...complete, bitType: '' }],
            ['Clôture sans métrage', { ...complete, metersDrilled: null }],
            ['Clôture sans heures machine', { ...complete, hours: '' }],
            ['Clôture sans durée arrêt', { ...complete, stoppages: [{ reason: 'maintenance', hours: null }] }],
            ['Clôture avec horaire inachevé', { ...complete, stoppages: [{ reason: 'maintenance', timeStart: '08:00', hours: 4 }] }],
            ['Clôture sans motif arrêt', { ...complete, stoppages: [{ reason: '', hours: 4 }] }],
            ['Bilan incomplet', { ...complete, hours: 7 }],
            ['Référence bloc manquante', { ...complete, holesWorked: [{ holeId: 'T-01', meters: 8 }] }],
            ['Trou dupliqué', { ...complete, holesWorked: [complete.holesWorked[0], complete.holesWorked[0]] }],
            ['Trou introuvable', { ...complete, holesWorked: [{ blockId: 'DAILY-A-BLOCK', holeId: 'ABSENT', meters: 8 }] }],
            ['Trou autre entreprise', { ...complete, holesWorked: [{ blockId: 'DAILY-B-BLOCK', holeId: 'T-01', meters: 8 }] }]
        ]) status(await save(data, extra), 400, label);

        status(await save({ ...complete, holesWorked: [] }), 200, 'Clôture sans détail de trous autorisée');

        status(await save({ ...complete, holesWorked: [{ blockId: 'DAILY-A-BLOCK', holeId: 'T-01', meters: null }] }), 200, 'Ligne de trou incomplète ignorée à la clôture');

        status(await save({ ...complete, holesWorked: [{ blockId: 'DAILY-A-BLOCK', holeId: 'T-01', meters: 7 }] }), 200, 'Détail partiel des trous autorisé');

        // Un ancien client garde la possibilité d'enregistrer avant soumission, sans confondre vide et zéro.
        const legacy = { ...complete, shift: 'night' };
        delete legacy.entryStage;
        for (const [field, value] of [['metersDrilled', null], ['metersDrilled', ''], ['hours', null], ['hours', '']]) {
            const saved = await save({ ...legacy, [field]: value });
            status(saved, 200, 'Compatibilité de sauvegarde ancien client');
            status(await request(`/api/daily-data/${saved.body.id}/submit`, { method: 'POST', token, body: {} }), 400, 'Soumission refuse une valeur requise vide');
        }
        const completeDraft = { ...complete, entryStage: 'draft' };
        status(await save(completeDraft), 200, 'Préenregistrement possible même si les données sont complètes');
        status(await request(`/api/daily-data/${id}/submit`, { method: 'POST', token, body: {} }), 400, 'Une clôture explicite reste requise pour un préenregistrement');

        status(await save(complete), 200, 'Clôture correcte avec arrêt nocturne');
        const completedRead = (await read()).body.find((row) => row.id === id);
        check(completedRead.data.entryStage, 'complete', 'Stade complet persisté');
        check(completedRead.workflowStatus, 'draft', 'Clôturer ne soumet pas automatiquement à la supervision');

        status(await request('/api/daily-data', { method: 'POST', token: tenantB.token, body: { ...recordKey, data: blank } }), 403, 'Autre entreprise ne peut pas écraser un brouillon');
        const outsider = await request('/api/daily-data?machineId=DAILY-A', { token: tenantB.token, enterpriseId: tenantA.id });
        status(outsider, 200, 'Lecture tenant');
        check(outsider.body, [], 'Aucun brouillon exposé hors entreprise malgré en-tête modifié');
        status(await request(`/api/daily-data/${id}/submit`, { method: 'POST', token: tenantB.token, body: {} }), 404, 'Soumission hors entreprise refusée');
        status(await save(blank, { machineId: 'DAILY-B' }), 403, 'Ingénieur limité aux machines de son entreprise');

        const submitted = await request(`/api/daily-data/${id}/submit`, { method: 'POST', token, body: {} });
        status(submitted, 200, 'Soumission complète');
        check(submitted.body.workflowStatus, 'submitted', 'Poste soumis');
        check(submitted.body.submittedByUsername, 'daily_engineer', 'Auteur de soumission tracé');
        status(await save(blank), 409, 'Préenregistrement interdit sur poste soumis');
        status(await save(complete), 409, 'Modification interdite sur poste soumis');
        const approved = await request(`/api/daily-data/${id}/approve`, { method: 'POST', token: tenantA.token, body: { comment: 'Contrôlé' } });
        status(approved, 200, 'Approbation après saisie complète');
        status(await save(blank), 409, 'Poste approuvé verrouillé');

        const zeroProduction = { ...complete, metersDrilled: 0, hours: 0, holesWorked: [], stoppages: [{ reason: 'maintenance', hours: 12 }] };
        const savedZero = await save(zeroProduction, { date: '2026-10-23' });
        status(savedZero, 200, 'Zéro explicite et durée manuelle sans horaires acceptés');
        status(await request(`/api/daily-data/${savedZero.body.id}/submit`, { method: 'POST', token, body: {} }), 200, 'Soumission valide avec zéro explicite');

        // Journée complète : le bilan conserve les 24 h historiques.
        const fullDay = { ...zeroProduction, shift: '', hours: 20, stoppages: [{ reason: 'maintenance', hours: 4 }] };
        const savedFullDay = await save(fullDay, { date: '2026-10-24' });
        status(savedFullDay, 200, 'Clôture journée complète de 24 h');
        status(await request(`/api/daily-data/${savedFullDay.body.id}/submit`, { method: 'POST', token, body: {} }), 200, 'Soumission journée complète');

        const unplannedHoles = [{source:'manual',blockId:'',holeId:'RC-001',meters:5,finalDepth:10}, {source:'automatic',blockId:'',holeId:'DAILY-A-20261025-J-001',meters:3,finalDepth:null}];
        const unplanned = {...complete,holesWorked:unplannedHoles};
        const newDay={date:'2026-10-25'};
        const planBefore=await request('/api/drilling-plan',{token});
        const savedManual=await save({...unplanned,entryStage:'draft'},newDay);
        status(savedManual,200,'Identifiants manuel et automatique préenregistrés sans plan');
        status(await save(unplanned,newDay),200,'Clôture des trous saisis hors plan');
        status(await save({...unplanned,holesWorked:[unplannedHoles[0],{...unplannedHoles[1],holeId:'rc-001'}]},newDay),400,'Identifiant hors plan dupliqué refusé sans distinction de casse');
        status(await save({...unplanned,holesWorked:[{...unplannedHoles[0],source:'unknown',meters:8}]},newDay),400,'Origine inconnue refusée');
        status(await save({...unplanned,holesWorked:[{...unplannedHoles[0],blockId:'DAILY-B-BLOCK',meters:8}]},newDay),400,'Un trou hors plan ne peut pas injecter une référence de bloc');
        status(await request(`/api/daily-data/${savedManual.body.id}/submit`,{method:'POST',token,body:{}}),200,'Soumission des trous hors plan');
        status(await request(`/api/daily-data/${savedManual.body.id}/approve`,{method:'POST',token:tenantA.token,body:{comment:'Contrôlé'}}),200,'Approbation des trous hors plan');
        const planAfter=await request('/api/drilling-plan',{token});
        check(planAfter.body.version,planBefore.body.version,'Les trous hors plan ne changent pas la version du plan');
        check(planAfter.body.plan,planBefore.body.plan,'Les profondeurs du plan restent inchangées');
        const persisted=await request('/api/daily-data?date=2026-10-25&machineId=DAILY-A',{token});
        check(persisted.body[0].data.holesWorked,unplannedHoles,'Identifiants et origines conservés après approbation');

        for (const invalid of [-1,'abc',false]) {
            status(await save({...blank,redrillMeters:invalid},{date:'2026-10-26'}),400,'Métrage reforé invalide refusé');
        }
        status(await save({...blank,redrillMeters:12.5,metersDrilled:null},{date:'2026-10-26'}),200,'Préenregistrement des reforés sans mètres nouveaux');
        const redrillDraft=await request('/api/daily-data?date=2026-10-26&machineId=DAILY-A',{token});
        check(redrillDraft.body[0].data.redrillMeters,12.5,'Reforage conservé à la reprise');
        check(redrillDraft.body[0].data.metersDrilled,null,'Le reforage ne crée pas de mètres nouveaux');
        status(await save({...zeroProduction,hours:12,stoppages:[],redrillMeters:12.5},{date:'2026-10-26'}),200,'Clôture de poste avec reforage seul');
        const redrillComplete=await request('/api/daily-data?date=2026-10-26&machineId=DAILY-A',{token});
        check(redrillComplete.body[0].data.redrillMeters,12.5,'Reforage conservé à la clôture');
        check(redrillComplete.body[0].data.metersDrilled,0,'Mètres nouveaux restent nuls à la clôture');

        const separateDate={date:'2026-10-27'};
        const dayData={...complete,metersDrilled:10,holesWorked:[],redrillMeters:2};
        const daySaved=await save(dayData,{...separateDate,notes:'Jour à conserver'});
        status(daySaved,200,'Enregistrement du Jour séparé');
        const nightData={...complete,shift:'night',metersDrilled:20,holesWorked:[],redrillMeters:3};
        const nightSaved=await save(nightData,{...separateDate,notes:'Nuit à conserver'});
        status(nightSaved,200,'Enregistrement de la Nuit séparée');
        check(daySaved.body.id===nightSaved.body.id,false,'Jour et Nuit ont des identifiants distincts');
        const pairRead=()=>request('/api/daily-data?date=2026-10-27&machineId=DAILY-A',{token});
        const beforeWrongId=(await pairRead()).body;
        check(beforeWrongId.length,2,'Les deux postes sont conservés');
        status(await save({...nightData,metersDrilled:999},{...separateDate,id:daySaved.body.id}),409,'Un ancien formulaire ne peut pas déplacer le Jour vers la Nuit');
        check((await pairRead()).body,beforeWrongId,'Une tentative de changement par ID ne modifie aucun poste');
        status(await save({...nightData,metersDrilled:25},{...separateDate,id:nightSaved.body.id,notes:'Nuit corrigée'}),200,'Correction de la Nuit existante');
        const afterCorrection=(await pairRead()).body;
        check(afterCorrection.find(r=>r.id===daySaved.body.id),beforeWrongId.find(r=>r.id===daySaved.body.id),'La correction Nuit ne touche pas au Jour');
        check(afterCorrection.find(r=>r.id===nightSaved.body.id).data.metersDrilled,25,'La Nuit conserve sa correction');
        check(afterCorrection.reduce((sum,r)=>sum+r.data.metersDrilled,0),35,'Le rapport journalier peut additionner les deux postes');

        console.log(`✅ Brouillons journaliers API : ${assertions} contrôles réussis (reprise, arrêts, clôture, soumission, isolation et verrouillage).`);
    } catch (error) {
        if (error && error.message && error.message.includes('Serveur indisponible')) process.stderr.write(logs);
        throw error;
    } finally {
        if (server && server.exitCode == null) {
            server.kill();
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 3000);
                server.once('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
        // Le nettoyage reste strictement dans le répertoire temporaire créé par ce test.
        if (path.resolve(tempDir).startsWith(tempRoot + path.sep) && path.basename(tempDir).startsWith('gedrilling-daily-drafts-')) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
}

main().catch((error) => {
    console.error('❌ Tests brouillons journaliers API échoués');
    console.error(error.stack || error);
    process.exitCode = 1;
});
