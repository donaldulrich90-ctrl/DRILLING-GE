'use strict';

// Run the production entry helpers in a small browser fixture. API failures,
// incomplete values and side effects are exercised without a live mine account.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.resolve(__dirname, '..', 'plateforme-forage.html');
const source = fs.readFileSync(htmlPath, 'utf8');

function declaration(name) {
    const matches = [...source.matchAll(new RegExp('^        (?:async )?function ' + name + '\\(', 'gm'))];
    assert.ok(matches.length, `Missing daily-entry function: ${name}`);
    const start = matches[matches.length - 1].index;
    for (let end = source.indexOf('}', start); end >= 0; end = source.indexOf('}', end + 1)) {
        const candidate = source.slice(start, end + 1);
        try {
            new vm.Script(candidate);
            return candidate;
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    }
    throw new Error(`Incomplete daily-entry declaration: ${name}`);
}

function plain(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function element(value = '') {
    const attributes = {};
    const classes = new Set();
    return {
        value: value == null ? '' : String(value), checked: false, disabled: false,
        textContent: '', innerHTML: '', dataset: {}, style: {},
        classList: {
            add: (...names) => names.forEach((name) => classes.add(name)),
            remove: (...names) => names.forEach((name) => classes.delete(name)),
            contains: (name) => classes.has(name),
            toggle: (name, force) => {
                if (force === undefined) force = !classes.has(name);
                if (force) classes.add(name); else classes.delete(name);
                return force;
            }
        },
        setAttribute: (name, val) => { attributes[name] = String(val); },
        getAttribute: (name) => attributes[name] == null ? null : attributes[name],
        removeAttribute: (name) => { delete attributes[name]; },
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: () => {}, focus: () => {}, scrollIntoView: () => {},
        checkValidity: () => true, reportValidity: () => true,
        reset: () => {}, appendChild: () => {}
    };
}

function stoppageRow(values = {}) {
    const fields = {
        '.daily-stoppage-reason': element(values.reason || 'autre'),
        '.daily-stoppage-hours': element(values.hours),
        '.daily-stoppage-detail': element(values.detail),
        '.daily-stoppage-time-start': element(values.timeStart),
        '.daily-stoppage-time-end': element(values.timeEnd),
        '.daily-stoppage-hours-source': element(values.hoursSource || 'manual'),
        '.daily-stoppage-status': element(values.status || '')
    };
    const row = element();
    row.dataset.hoursSource = values.hoursSource || 'manual';
    row.querySelector = (selector) => fields[selector] || null;
    row.querySelectorAll = () => Object.values(fields);
    row.fields = fields;
    return row;
}

function holeRow(values = {}) {
    const fields = {
        '.daily-hole-source': element(values.source || 'plan'),
        '.daily-hole-id': element(values.holeId),
        '.daily-hole-ref': element(values.ref),
        '.daily-hole-meters': element(values.meters),
        '.daily-hole-final-depth': element(values.finalDepth)
    };
    const row = element();
    row.querySelector = (selector) => fields[selector] || null;
    row.querySelectorAll = () => Object.values(fields);
    return row;
}

const entryFunctionNames = [
    'getReportTenantKey', '_rpData', 'isDailyRecordIncompleteDraft', 'nextDailyEntryHoleId',
    'findDrillByMachineId', 'drillIdsMatch', 'dailyRecordShiftKey', 'normalizeDailyRecordShiftFields',
    'getShiftNominalHours', 'getShiftLabelForReport', 'computeShiftAvailabilityKpis',
    'computeDailyEntryCounterDelta', 'dailyStoppageTimeToMinutes', 'computeHoursFromStoppageTimeRange',
    'formatStoppageHoursExactForInput', 'formatStoppageHoursExactDisplay',
    'normalizeStoppageTimeForInput', 'collectDailyEntryStoppages', 'collectDailyEntryHoles',
    'decodeDailyHoleRef', 'getCurrentDailyEntryRecordMeta', 'loadDailyEntryFormFromRecord',
    'dailyEntryNumberOrNull', 'dailyEntryText', 'dailyEntryChecked',
    'setDailyEntrySaveStatus', 'dailyEntryFormSnapshot', 'markDailyEntryFormClean',
    'saveDailyEntry', 'saveDailyEntryDraft', 'persistDailyEntry'
];

function fixture(options = {}) {
    const fields = {};
    for (const id of [...source.matchAll(/\bid="(dailyEntry[^"\s]*)"/g)].map((match) => match[1])) {
        fields[id] = element();
        fields[id].id = id;
    }
    const defaults = {
        dailyEntryDate: '2026-10-22', dailyEntryMachineId: 'A', dailyEntryShift: 'day',
        dailyEntryFuelPriceCurrency: 'USD'
    };
    for (const [id, value] of Object.entries({ ...defaults, ...options.fields })) {
        fields[id] = fields[id] || element();
        fields[id].value = value == null ? '' : String(value);
    }
    const stopRows = (options.stoppages || []).map(stoppageRow);
    const holeRows = (options.holes || []).map(holeRow);
    if (fields.dailyEntryStoppagesContainer) {
        fields.dailyEntryStoppagesContainer.querySelectorAll = () => stopRows;
    }
    if (fields.dailyEntryHolesContainer) {
        fields.dailyEntryHolesContainer.querySelectorAll = () => holeRows;
    }
    const calls = {
        api: [], alerts: [], errors: [], close: 0, telemetry: 0, holes: 0,
        dashboard: 0, resources: 0, savedData: 0, loadedHoles: [], loadedStops: []
    };
    const drills = [{
        id: 'A', siteId: 1, location: 'Banc Nord',
        telemetry: { depth: 200, rotation_pressure: 90 },
        fuel: { level: 300, capacity: 1000, consumption: 12, price: 1.2, priceCurrency: 'USD' },
        consumables: { oil: 60, filters: 2 }
    }];
    const sandbox = {
        console,
        currentUser: { id: 7, username: 'engineer', role: 'ingenieur', enterpriseId: 1 },
        currentSiteId: 1, drills,
        dailyDataRecords: plain(options.records || []),
        SHIFT_NOMINAL_HOURS: { day: 12, night: 12, full: 24 },
        dailyEntrySaveInFlight: false, dailyEntryLoadedSnapshot: '', dailyEntryLoadedContext: null,
        useAPI: true, allowLocalCache: false,
        localStorage: { setItem: () => {}, getItem: () => null },
        document: {
            getElementById: (id) => fields[id] || null,
            querySelectorAll: (selector) => selector.includes('daily-hole-row') ? holeRows : selector.includes('.daily-hole-id') ? holeRows.map(row => row.querySelector('.daily-hole-id')) : [],
            createElement: () => element()
        },
        window: { API: { DailyData: {
            save: async (candidate) => {
                calls.api.push(plain(candidate));
                if (options.save) return options.save(candidate);
                return { ...plain(candidate), id: candidate.id || 501 };
            }
        } } },
        alert: (message) => calls.alerts.push(String(message)),
        canEnterDailyData: () => options.canEnter !== false,
        isDailyDataRecordReadOnlyForCurrentUser: () => !!options.locked,
        getDailyDataActorUsername: () => 'engineer',
        getDailyDataActorDisplayName: () => 'Ingénieur Test',
        touchDailyDataLastModified: (record) => { record.lastModifiedByUsername = 'engineer'; },
        normalizeFuelPriceCurrency: (value) => value || 'USD',
        fuelPricePerLiterLabel: () => 'USD/L',
        computeShiftFuelLitersStored: (start, end, added, initial) => initial ? 0 : added > 0 ? added : start != null && end != null ? Math.max(0, start - end) : 0,
        deriveFuelLitersFromDailyData: (data) => Number(data.fuelConsumptionEffective) || 0,
        getMaterialTypeLabel: (value) => value,
        clearDailyEntryError: () => {},
        showDailyEntryError: (message) => calls.errors.push(String(message)),
        alertDailySaveApiError: (error) => calls.errors.push(error.message),
        closeDailyEntryModal: () => { calls.close += 1; },
        syncAllDrillsTelemetryFromDailyRecords: () => { calls.telemetry += 1; },
        applyDailyHoleProgress: () => { calls.holes += 1; },
        renderResources: () => { calls.resources += 1; },
        renderTelemetry: () => {},
        renderDashboard: () => { calls.dashboard += 1; },
        saveData: async () => { calls.savedData += 1; },
        loadDailyEntryHoles: (rows) => { calls.loadedHoles = plain(rows); },
        refreshDailyEntryStoppagesFromRecord: () => {},
        updateDailyEntryFuelDerivedHint: () => {},
        updateDailyEntryCounterDeltas: () => {},
        updateDailyEntryKpiPreview: () => {},
        updateDailyEntryModalSummary: () => {},
        updateDailyEntryDeleteButtonVisibility: () => {},
        applyDailyEntryAuditAndLockUi: () => {},
        setDailyEntryFormInputsDisabled: () => {},
        formatDateTimeAudit: (value) => value,
        refreshDailyEntryFuelFieldsFromContract: () => {},
        findPreviousDailyRecord: () => null,
        getDailyEntryHoleChoices: () => [],
        getContractForDrillFuel: () => null,
        resolveContractFuelCurrency: () => 'USD',
        ...options.globals
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(entryFunctionNames.map(declaration).join('\n'), context, { filename: htmlPath });
    return { app: context, fields, calls, stopRows, holeRows };
}

const checks = [];
function check(name, body) { checks.push({ name, body }); }

check('a draft saves an identified shift with missing metrics as null', async () => {
    const { app, calls } = fixture();
    const saved = await app.saveDailyEntryDraft({ keepOpen: true });
    assert.equal(calls.api.length, 1);
    const payload = calls.api[0];
    assert.equal(payload.date, '2026-10-22');
    assert.equal(payload.machineId, 'A');
    assert.equal(payload.data.entryStage, 'draft');
    assert.equal(payload.workflowStatus, 'draft');
    for (const field of ['metersDrilled', 'hours', 'fuelAdded', 'counterStart', 'counterEnd', 'hammerCounterEnd', 'hoursCounterEnd']) {
        assert.equal(payload.data[field], null, `${field} must remain missing`);
    }
    assert.equal(saved.id, 501);
    assert.equal(app.dailyDataRecords.length, 1);
    assert.equal(calls.close, 0);
});

check('genuine zero input is preserved while an untouched field stays missing', async () => {
    const { app, calls } = fixture({ fields: { dailyEntryMeters: '0', dailyEntryFuelAdded: '0' } });
    await app.saveDailyEntryDraft({ keepOpen: true });
    assert.equal(calls.api[0].data.metersDrilled, 0);
    assert.equal(calls.api[0].data.fuelAdded, 0);
    assert.equal(calls.api[0].data.hours, null);
});

check('draft capture preserves manual downtime and an unfinished stop', async () => {
    const { app, calls } = fixture({ stoppages: [
        { reason: 'hydraulic-bdn', hours: '1.75', detail: 'Réparation du flexible' },
        { reason: 'autre', timeStart: '11:20' }
    ] });
    await app.saveDailyEntryDraft({ keepOpen: true });
    const stops = calls.api[0].data.stoppages;
    assert.equal(stops.length, 2);
    assert.equal(stops[0].hours, 1.75);
    assert.equal(stops[1].timeStart, '11:20');
    assert.ok(!stops[1].timeEnd);
    assert.equal(stops[1].hours, null);
});

check('a cross-midnight stop keeps the exact elapsed duration', () => {
    const { app } = fixture({ stoppages: [{ reason: 'hydraulic-bdn', timeStart: '23:50', timeEnd: '00:10', hoursSource: 'time' }] });
    const stops = app.collectDailyEntryStoppages();
    assert.equal(stops.length, 1);
    assert.ok(Math.abs(stops[0].hours - 1 / 3) < 1e-10);
});

check('saving a draft never advances telemetry, fuel or holes', async () => {
    const { app, calls } = fixture({ fields: { dailyEntryMeters: '35', dailyEntryHours: '4', dailyEntryFuelAdded: '70', dailyEntryCounterEnd: '240' } });
    const before = plain(app.drills);
    await app.saveDailyEntryDraft({ keepOpen: true });
    assert.deepEqual(plain(app.drills), before);
    assert.equal(calls.telemetry, 0);
    assert.equal(calls.holes, 0);
    assert.equal(calls.savedData, 0);
});

check('a failed server save keeps the existing record and the form open', async () => {
    const original = { id: 18, date: '2026-10-22', machineId: 'A', shift: 'day', workflowStatus: 'draft', data: { shift: 'day', entryStage: 'draft', metersDrilled: 10, hours: null }, notes: 'À compléter' };
    const { app, fields, calls } = fixture({
        records: [original], fields: { dailyEntryMeters: '25' },
        save: async () => { throw new Error('Connexion interrompue'); }
    });
    const result = await app.saveDailyEntryDraft({ keepOpen: true });
    assert.equal(result, null);
    assert.deepEqual(plain(app.dailyDataRecords), [original]);
    assert.equal(fields.dailyEntryMeters.value, '25');
    assert.equal(calls.close, 0);
    assert.equal(calls.alerts.length, 0);
    assert.ok(calls.errors.some((message) => /connexion|interrompue|enregistr/i.test(message)));
});

check('a save is not locally confirmed while the server is still pending', async () => {
    let resolveSave;
    const wait = new Promise((resolve) => { resolveSave = resolve; });
    const { app, calls } = fixture({ save: () => wait });
    const pending = app.saveDailyEntryDraft({ keepOpen: true });
    await Promise.resolve();
    assert.equal(calls.api.length, 1);
    assert.equal(app.dailyDataRecords.length, 0);
    assert.equal(calls.alerts.length, 0);
    assert.equal(calls.close, 0);
    resolveSave({ ...calls.api[0], id: 501 });
    const result = await pending;
    assert.equal(result.id, 501);
    assert.equal(app.dailyDataRecords.length, 1);
});

check('required date, a known machine and write access still apply to drafts', async () => {
    for (const options of [
        { fields: { dailyEntryDate: '' } },
        { fields: { dailyEntryMachineId: '' } },
        { fields: { dailyEntryMachineId: 'UNKNOWN' } },
        { canEnter: false }, { locked: true, records: [{ id: 18, date: '2026-10-22', machineId: 'A', shift: 'day', data: { shift: 'day' } }] }
    ]) {
        const { app, calls } = fixture(options);
        assert.equal(await app.saveDailyEntryDraft({ keepOpen: true }), null);
        assert.equal(calls.api.length, 0);
        assert.ok(calls.errors.length > 0);
    }
});

check('resuming the saved draft restores actual zeroes, blanks and entered notes', () => {
    const draft = { id: 18, date: '2026-10-22', machineId: 'A', shift: 'day', data: {
        shift: 'day', entryStage: 'draft', metersDrilled: 0, hours: null,
        fuelAdded: null, counterStart: 300, counterEnd: null,
        hammerCounterStart: 1250, hammerCounterEnd: null,
        hoursCounterStart: 100, hoursCounterEnd: null,
        location: 'Banc Nord', holesWorked: [{ blockId: 'B1', holeId: 'H1', meters: null, finalDepth: null }]
    }, notes: 'Flexible à contrôler à la relève' };
    const { app, fields, calls } = fixture({ records: [draft] });
    app.loadDailyEntryFormFromRecord();
    assert.equal(fields.dailyEntryMeters.value, '0');
    assert.equal(fields.dailyEntryHours.value, '');
    assert.equal(fields.dailyEntryFuelAdded.value, '');
    assert.equal(fields.dailyEntryCounterStart.value, '300');
    assert.equal(fields.dailyEntryCounterEnd.value, '');
    assert.equal(fields.dailyEntryHammerStart.value, '1250');
    assert.equal(fields.dailyEntryHammerEnd.value, '');
    assert.equal(fields.dailyEntryNotes.value, draft.notes);
    assert.deepEqual(calls.loadedHoles, draft.data.holesWorked);
});

check('finalization continues to reject an unbalanced or incomplete shift', async () => {
    const { app, calls } = fixture({ fields: { dailyEntryMeters: '30', dailyEntryHours: '4' } });
    await app.saveDailyEntry({ preventDefault() {} });
    assert.equal(calls.api.length, 0);
    assert.ok(calls.errors.length > 0);
    assert.equal(calls.holes, 0);
});

check('official aggregates exclude incomplete drafts but retain legacy completed entries', () => {
    const { app } = fixture({ records: [
        { id: 1, machineId: 'A', date: '2026-10-20', data: { metersDrilled: 80, hours: 12 } },
        { id: 2, machineId: 'A', date: '2026-10-21', data: { entryStage: 'complete', metersDrilled: 90, hours: 12 } },
        { id: 3, machineId: 'A', date: '2026-10-22', data: { entryStage: 'draft', metersDrilled: 5000, hours: null } }
    ] });
    vm.runInContext(['isDailyRecordIncompleteDraft', 'getDrillsForSite', 'getDailyDataForSite'].map(declaration).join('\n'), app);
    assert.deepEqual(plain(app.getDailyDataForSite()).map((record) => record.id), [1, 2]);
    assert.deepEqual(plain(app.getDailyDataForSite(true)).map((record) => record.id), [1, 2, 3]);
    app.currentSiteId = null;
    assert.deepEqual(plain(app.getDailyDataForSite()).map((record) => record.id), [1, 2]);
});

check('reloading data cannot let a partial entry advance or erase machine telemetry', () => {
    const draft = { id: 3, machineId: 'A', date: '2026-10-22', data: { entryStage: 'draft', depth: 9000, metersDrilled: 8000, hours: 1, counterEnd: 1 } };
    const { app } = fixture({ records: [draft] });
    vm.runInContext(['isDailyRecordIncompleteDraft', 'dailyRecordShiftOrder', 'compareDailyRecordsChronological', 'syncDrillTelemetryFromDailyRecords'].map(declaration).join('\n'), app);
    const initial = plain(app.drills[0]);
    app.syncDrillTelemetryFromDailyRecords(app.drills[0]);
    assert.deepEqual(plain(app.drills[0]), initial);
    app.dailyDataRecords.unshift({ id: 1, machineId: 'A', date: '2026-10-21', data: { depth: 200, metersDrilled: 80, hours: 8, counterEnd: 250, fuelConsumptionEffective: 96, oilLevel: 50, filters: 1 } });
    app.syncDrillTelemetryFromDailyRecords(app.drills[0]);
    assert.equal(app.drills[0].telemetry.depth, 200);
    assert.equal(app.drills[0].fuel.level, 250);
    assert.equal(app.drills[0].fuel.consumption, 12);
});

check('saving an edited completed entry preserves its status and does not add old metres twice', async () => {
    const existing = { id: 18, machineId: 'A', date: '2026-10-22', shift: 'day',
        data: { shift: 'day', entryStage: 'complete', depth: 200, metersDrilled: 20, hours: 12 } };
    const { app, calls, fields } = fixture({ records: [existing], holes: [{ ref: 'B1::H1', meters: '30' }],
        fields: { dailyEntryMeters: '30', dailyEntryHours: '12', dailyEntryLocation: 'Banc Nord',
            dailyEntryDrillingType: 'production', dailyEntryMaterialType: 'FrM', dailyEntryBitType: 'carbure-115' } });
    const draft = await app.saveDailyEntryDraft({ keepOpen: true });
    assert.equal(draft.data.entryBaseDepth, 180);
    assert.equal(draft.data.entryStage, 'complete');
    assert.equal(calls.telemetry, 1);
    fields.dailyEntryMeters.value = '30';
    const complete = await app.saveDailyEntry({ preventDefault() {} });
    assert.equal(complete.data.entryStage, 'complete');
    assert.equal(complete.data.depth, 210);
    assert.equal(calls.telemetry, 2);
    assert.equal(calls.holes, 2);
});

check('two pre-saved shifts accumulate correctly even when completed in reverse order', async () => {
    const { app, fields, holeRows } = fixture({ holes: [{ ref: 'B1::H1', meters: '10' }],
        fields: { dailyEntryMeters: '10', dailyEntryHours: '12', dailyEntryLocation: 'Banc Nord',
            dailyEntryDrillingType: 'production', dailyEntryMaterialType: 'FrM', dailyEntryBitType: 'carbure-115' } });
    vm.runInContext(['dailyRecordShiftOrder', 'compareDailyRecordsChronological', 'syncDrillTelemetryFromDailyRecords'].map(declaration).join('\n'), app);
    app.syncAllDrillsTelemetryFromDailyRecords = () => app.syncDrillTelemetryFromDailyRecords(app.drills[0]);
    await app.saveDailyEntryDraft();
    fields.dailyEntryShift.value = 'night';
    fields.dailyEntryMeters.value = '20'; holeRows[0].querySelector('.daily-hole-meters').value = '20';
    await app.saveDailyEntryDraft();
    await app.saveDailyEntry();
    assert.equal(app.drills[0].telemetry.depth, 220);
    fields.dailyEntryShift.value = 'day';
    fields.dailyEntryMeters.value = '10'; holeRows[0].querySelector('.daily-hole-meters').value = '10';
    await app.saveDailyEntry();
    assert.equal(app.drills[0].telemetry.depth, 230);
    app.syncAllDrillsTelemetryFromDailyRecords();
    assert.equal(app.drills[0].telemetry.depth, 230);
});

check('a midshift preview of a completed entry keeps it complete', async () => {
    const record = { id: 18, machineId: 'A', date: '2026-10-22', shift: 'day', data: {
        entryStage: 'complete', shift: 'day', depth: 200, metersDrilled: 0, hours: 12 } };
    const { app, calls } = fixture({ records: [record], fields: { dailyEntryMeters: '0', dailyEntryHours: '12',
        dailyEntryLocation: 'Banc Nord', dailyEntryDrillingType: 'production', dailyEntryMaterialType: 'FrM', dailyEntryBitType: 'carbure-115' } });
    app.window.open = () => ({ document: { write() {}, close() {} }, close() {} });
    app.buildMidshiftReportDocumentHtml = () => 'provisoire';
    app.printDailyReport = () => {};
    vm.runInContext(declaration('generateMidshiftReportFromEntry'), app);
    const result = await app.generateMidshiftReportFromEntry();
    assert.equal(result.data.entryStage, 'complete');
    assert.equal(calls.api[0].data.entryStage, 'complete');
});

check('a response cannot inject the previous company draft into a newly selected company', async () => {
    let resolveSave;
    const { app, calls } = fixture({ save: () => new Promise(resolve => { resolveSave = resolve; }) });
    const pending = app.saveDailyEntryDraft({ keepOpen: true });
    app.currentUser.enterpriseId = 99;
    resolveSave({ id: 501 });
    assert.equal(await pending, null);
    assert.equal(app.dailyDataRecords.length, 0);
    assert.equal(calls.telemetry, 0);
});

check('midshift report keeps missing data distinct from recorded zero and includes open stops', () => {
    const { fixture: reportFixture } = require('./test-daily-report.js');
    const app = reportFixture();
    const records = [{ machineId: 'A', date: '2026-10-22', data: {
        entryStage: 'draft', shift: 'day', metersDrilled: null, hours: 0,
        stoppages: [{ reason: 'hoses-bdn', timeStart: '10:30', hours: null, detail: 'Intervention en cours' },
            { reason: 'blast-stb', hours: 1.5, detail: 'Arrêt saisi manuellement' }]
    }, notes: '<script>alert("draft")</script>' }];
    const html = app.buildMidshiftReportDocumentHtml('2026-10-22', records);
    const body = html.replace(/<style>[\s\S]*?<\/style>/g, '');
    assert.match(body, /RAPPORT DE MI-POSTE/);
    assert.match(body, /PROVISOIRE/);
    assert.match(body, /Non renseigné/);
    assert.match(body, /0,0 h/);
    assert.match(body, /En cours \/ à compléter/);
    assert.match(body, /1,5 h/);
    assert.match(body, /Intervention en cours/);
    assert.match(body, /&lt;script&gt;/);
    assert.doesNotMatch(body, /<script|<canvas|Disponibilité méca\.|Taux de réalisation/i);
});

check('a draft is visible at midshift but is excluded from the final daily document', () => {
    const { fixture: reportFixture } = require('./test-daily-report.js');
    const app = reportFixture();
    const draft = { machineId: 'A', date: '2026-10-22', data: { entryStage: 'draft', shift: 'day', metersDrilled: 98765, hours: 4 } };
    assert.match(app.buildMidshiftReportDocumentHtml('2026-10-22', [draft]), /98[   ]765/);
    assert.doesNotMatch(app.buildDailyReportDocumentHtml('2026-10-22', [draft]), /98[   ]765|98765/);
});

check('completing without a fuel reading preserves the known tank level while recorded zero remains zero', async () => {
    const { app, fields } = fixture({ holes: [{ ref: 'B1::H1', meters: '10' }], fields: {
        dailyEntryMeters: '10', dailyEntryHours: '12', dailyEntryLocation: 'Banc Nord',
        dailyEntryDrillingType: 'production', dailyEntryMaterialType: 'FrM', dailyEntryBitType: 'carbure-115'
    } });
    vm.runInContext(['isDailyRecordIncompleteDraft', 'dailyRecordShiftOrder', 'compareDailyRecordsChronological',
        'syncDrillTelemetryFromDailyRecords', 'syncAllDrillsTelemetryFromDailyRecords'].map(declaration).join('\n'), app);
    const saved = await app.saveDailyEntry();
    assert.ok(saved, 'La clôture réussit même sans données carburant optionnelles');
    assert.equal(saved.data.counterEnd, null, 'Une absence de relevé reste absente');
    assert.equal(app.drills[0].fuel.level, 300, 'Le niveau connu ne devient pas zéro faute de relevé');

    fields.dailyEntryCounterEnd.value = '0';
    const emptied = await app.saveDailyEntry();
    assert.ok(emptied);
    assert.equal(emptied.data.counterEnd, 0, 'Un zéro explicitement relevé est conservé');
    assert.equal(app.drills[0].fuel.level, 0, 'Un relevé zéro remplace bien le niveau antérieur');
});

check('manual and generated identifiers can be saved without a planning reference and then completed', async () => {
    const {app,calls}=fixture({holes:[{source:'manual',holeId:'RC-001',meters:'5'}, {source:'automatic',holeId:'A-20261022-J-001',meters:'3'}], fields:{
        dailyEntryMeters:'8',dailyEntryHours:'12',dailyEntryLocation:'Banc Nord',dailyEntryDrillingType:'production',dailyEntryMaterialType:'FrM',dailyEntryBitType:'carbure-115'
    }});
    const draft=await app.saveDailyEntryDraft();
    assert.equal(draft.data.holesWorked[0].source,'manual'); assert.equal(draft.data.holesWorked[0].blockId,'');
    const completed=await app.saveDailyEntry();
    assert.ok(completed, calls.errors.join('; ')); assert.equal(completed.data.entryStage,'complete');
    assert.equal(completed.data.holesWorked[1].holeId,'A-20261022-J-001');
});

check('automatic identifiers avoid saved and currently entered identifiers and distinguish the night shift', () => {
    const {app,fields}=fixture({records:[{machineId:'A',data:{holesWorked:[{holeId:'A-20261022-J-001'}]}}],holes:[{source:'manual',holeId:'a-20261022-j-002'}]});
    assert.equal(app.nextDailyEntryHoleId(),'A-20261022-J-003');
    fields.dailyEntryShift.value='night';
    assert.equal(app.nextDailyEntryHoleId(),'A-20261022-N-001');
});

check('out of plan holes never advance a planned hole even if an old block reference is present', () => {
    const {app}=fixture();
    const plan={blocks:[{id:'B1',holes:[{id:'H1',actDepth:2,status:'PLANIFIÉ'}]}]};
    let writes=0; app.getFPData=()=>plan; app.saveFPData=()=>{writes+=1;};
    vm.runInContext(declaration('applyDailyHoleProgress'),app);
    app.applyDailyHoleProgress('2026-10-22','A',[{source:'manual',blockId:'B1',holeId:'H1',meters:8,finalDepth:10}]);
    assert.equal(plan.blocks[0].holes[0].actDepth,2); assert.equal(writes,0);
});

async function main() {
    let completed = 0;
    for (const { name, body } of checks) {
        await body();
        completed += 1;
        process.stdout.write(`ok ${completed} - ${name}\n`);
    }
    process.stdout.write(`${completed} daily-entry regression checks passed.\n`);
}

if (require.main === module) {
    main().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { fixture, declaration, plain };
