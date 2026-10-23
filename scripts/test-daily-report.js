'use strict';

// Exercise the report's real browser helpers without booting the full application.
// The VM parser finds each complete declaration; no duplicate production logic.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.resolve(__dirname, '..', 'plateforme-forage.html');
const source = fs.readFileSync(htmlPath, 'utf8');

function declaration(kind, name, endCharacter) {
    const pattern = new RegExp('^        ' + kind + ' ' + name + (kind === 'function' ? '\\(' : '\\s*='), 'gm');
    const matches = [...source.matchAll(pattern)];
    assert.ok(matches.length, `Missing report ${kind}: ${name}`);
    const start = matches[matches.length - 1].index;
    for (let end = source.indexOf(endCharacter, start); end >= 0; end = source.indexOf(endCharacter, end + 1)) {
        const candidate = source.slice(start, end + 1);
        try {
            new vm.Script(candidate);
            return candidate;
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    }
    throw new Error(`Incomplete declaration: ${name}`);
}

const helperNames = [
    'reportCalendarDayNumber', 'getReportPlannedProduction', 'getReportTenantKey', 'ensureReportPlanLoaded',
    'isDailyRecordIncompleteDraft', 'buildMidshiftReportDocumentHtml',
    'getReportUsedMachineCount', 'buildDailyProductionChart', 'buildDailyHoleTraceability',
    'findDrillByMachineId', 'dailyRecordShiftKey', 'getShiftNominalHours', 'getShiftLabelForReport',
    'computeShiftAvailabilityKpis', 'computeDailyEntryCounterDelta', 'deriveFuelLitersFromDailyData',
    'getEffectiveFuelConsumptionFromData', 'classifyStoppageReasonToBucket', 'aggregateStoppageHoursByCategory',
    'computeOperationalReportMetrics', 'escapeHtmlReportCell', '_rpNa', '_rpStopCat', '_rpData',
    '_rpMachineName', '_rpZoneForRecord', 'buildProductionZoneSection', 'getDailyStoppageReasonLabel',
    'buildPannesSection', 'buildStandbySection', 'buildCommentGeneralSection', 'buildReportKpiBandeau',
    'getSubscriberLogoSrcForReport', 'findPartnerClientForReport', 'getPartnerClientLogoSrc',
    'buildReportLogoImgHtml', 'buildReportLogosRowHtml', 'getReportProjectLabel', 'getReportMachinesLabel',
    'getReportShiftsLabel', 'getReportResponsableLabel', 'buildReportMetaRowsHtml',
    'buildReportStandardEnteteHtml', 'formatDate', 'buildDailyReportDocumentHtml',
    'generateDailyReport', 'printDailyReport'
];
const helpers = helperNames.map((name) => declaration('function', name, '}')).join('\n');
const reportVariables = ['REPORT_PRINT_ENTETE_CSS', 'DAILY_REPORT_PRINT_CSS', 'DAILY_STOPPAGE_REASONS']
    .map((name) => declaration('var', name, ';')).join('\n');

function fixture(overrides = {}) {
    const context = vm.createContext({
        console,
        currentUser: { enterpriseId: 7 },
        currentSiteId: 1,
        window: { API: { getEnterpriseId: () => 7 } },
        sites: [{ id: 1, name: 'Mine Ouest', code: 'MO' }],
        drills: [{ id: 'A', siteId: 1 }, { id: 'B', siteId: 1 }],
        clients: [], contracts: [], dailyDataRecords: [],
        companyInfo: { name: 'Société de forage & services' }, companyLogo: '',
        REPORT_BRAND_SUBSCRIBER_NAME: 'GOOD ENGINEERS',
        SHIFT_NOMINAL_HOURS: { day: 12, night: 12, full: 24 },
        reportPlanSnapshot: { plan: null, version: 0, error: '' },
        reportPlanRequestSeq: 0,
        resolveStaticAssetUrl: (file) => 'https://forage.example/' + file,
        getFPData: () => ({ blocks: [] }),
        ...overrides
    });
    vm.runInContext(reportVariables + '\n' + helpers, context, { filename: htmlPath });
    return context;
}

function savedPlan(overrides = {}) {
    return {
        metric: 'metres', startDate: '2026-10-01', endDate: '2026-10-31',
        weeks: [{ start: '2026-10-15', end: '2026-10-21', target: 700 }],
        months: [{ start: '2026-10-01', end: '2026-10-31', target: 3100 }],
        ...overrides
    };
}

function usePlan(context, plan, extras = {}) {
    context.reportPlanSnapshot = { plan, version: 4, error: '', ...extras };
}

function record(machineId, shift, production, date = '2026-10-16', extras = {}) {
    return { machineId, date, data: { shift, metersDrilled: production, hours: 8, ...extras } };
}

function textContent(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function kpiValue(html, label) {
    const values = [...html.matchAll(/class="report-kpi-label">([^<]*)<\/div>\s*<div class="report-kpi-value"[^>]*>([\s\S]*?)<\/div>/g)];
    const card = values.find((match) => match[1] === label);
    assert.ok(card, `Missing KPI: ${label}`);
    return textContent(card[2]);
}

const checks = [];
function check(name, body) { checks.push({ name, body }); }

check('saved weekly objective is prorated by inclusive calendar days', () => {
    const app = fixture();
    usePlan(app, savedPlan({ months: [{ start: '2026-10-01', end: '2026-10-31', target: 9300 }] }));
    const goal = app.getReportPlannedProduction('2026-10-16', [record('A', 'day', 80)]);
    assert.equal(goal.value, 100);
    assert.match(goal.note, /hebdomadaire/);
    assert.match(goal.note, /7 jour/);
    assert.match(goal.note, /v4/);
});

check('monthly and whole-plan objectives work when finer schedules are absent', () => {
    const app = fixture();
    usePlan(app, savedPlan({ weeks: [] }));
    assert.equal(app.getReportPlannedProduction('2026-10-31', []).value, 100);
    usePlan(app, savedPlan({ weeks: [], months: [], totalTarget: 1550 }));
    assert.equal(app.getReportPlannedProduction('2026-10-01', []).value, 50);
    assert.equal(app.getReportPlannedProduction('2026-10-31', []).value, 50);
});

check('a weekly schedule gap never silently uses the monthly objective', () => {
    const app = fixture();
    usePlan(app, savedPlan());
    assert.equal(app.getReportPlannedProduction('2026-10-22', []).value, null);
});

check('a genuine zero goal is retained while absent or invalid targets remain unavailable', () => {
    const app = fixture();
    for (const target of [0, '0']) {
        usePlan(app, savedPlan({ weeks: [{ start: '2026-10-15', end: '2026-10-21', target }] }));
        assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, 0);
    }
    for (const target of [undefined, null, '', '   ', -1, '-1', true, false, NaN, Infinity, '125 metres']) {
        usePlan(app, savedPlan({ weeks: [{ start: '2026-10-15', end: '2026-10-21', target }] }));
        assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, null, `Invalid target: ${String(target)}`);
    }
});

check('holes and missing plans cannot produce a metre objective', () => {
    const app = fixture();
    assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, null);
    usePlan(app, savedPlan({ metric: 'trous' }));
    assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, null);
    usePlan(app, savedPlan(), { error: 'Chargement impossible' });
    assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, null);
    assert.match(app.getReportPlannedProduction('2026-10-16', []).note, /Chargement impossible/);
});

check('dates are strict, leap days valid, and plan boundaries inclusive', () => {
    const app = fixture();
    assert.equal(app.reportCalendarDayNumber('2024-02-29') + 1, app.reportCalendarDayNumber('2024-03-01'));
    for (const date of ['2026-02-29', '2026-04-31', '2026-1-16', '2026-10-16T00:00:00Z', '', null]) {
        assert.equal(app.reportCalendarDayNumber(date), null);
    }
    usePlan(app, savedPlan());
    assert.equal(app.getReportPlannedProduction('2026-10-15', []).value, 100);
    assert.equal(app.getReportPlannedProduction('2026-10-21', []).value, 100);
    assert.equal(app.getReportPlannedProduction('2026-11-01', []).value, null);
    usePlan(app, savedPlan({ startDate: '2026-10-32' }));
    assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, null);
});

check('invalid or overlapping periods are unavailable rather than double-counted', () => {
    const app = fixture();
    const period = { start: '2026-10-15', end: '2026-10-21', target: 700 };
    usePlan(app, savedPlan({ weeks: [period, { ...period, target: 1400 }] }));
    assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, null);
    usePlan(app, savedPlan({ weeks: [{ start: '2026-10-21', end: '2026-10-15', target: 700 }] }));
    assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, null);
});

check('a company-wide objective is not passed off as the objective of one of several sites', () => {
    const app = fixture({ sites: [{ id: 1, name: 'Ouest' }, { id: 2, name: 'Est' }] });
    usePlan(app, savedPlan());
    assert.equal(app.getReportPlannedProduction('2026-10-16', [record('A', 'day', 80)]).value, null);
    app.currentSiteId = null;
    assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, 100);
});

check('explicit site objectives require an unambiguous matching site', () => {
    const app = fixture({ sites: [{ id: 1, name: 'Ouest', code: 'MO' }, { id: 2, name: 'Est', code: 'ME' }] });
    usePlan(app, savedPlan({ site: 'mo' }));
    assert.equal(app.getReportPlannedProduction('2026-10-16', [record('A', 'day', 80)]).value, 100);
    app.currentSiteId = 2;
    assert.equal(app.getReportPlannedProduction('2026-10-16', [record('A', 'day', 80)]).value, null);
    app.currentSiteId = null;
    app.drills.push({ id: 'C', siteId: 2 });
    assert.equal(app.getReportPlannedProduction('2026-10-16', [record('A', 'day', 80)]).value, 100);
    assert.equal(app.getReportPlannedProduction('2026-10-16', [record('C', 'day', 80)]).value, null);
    app.sites.push({ id: 3, name: 'MO' });
    assert.equal(app.getReportPlannedProduction('2026-10-16', [record('A', 'day', 80)]).value, null);
});

check('operational totals keep new metres, redrill, flushing, standby and breakdown separate', () => {
    const app = fixture();
    const metrics = app.computeOperationalReportMetrics({
        shift: 'day', hours: 8, metersDrilled: 80, redrillMeters: 7, flushingMeters: 3,
        stoppages: [{ reason: 'hydraulic-bdn', hours: 2 }, { reason: 'blast-stb', hours: 1 }, { reason: 'move-gsa', hours: 1 }],
        hoursCounterStart: 200, hoursCounterEnd: 208, fuelAdded: 120
    });
    assert.equal(metrics.production, 80);
    assert.equal(metrics.redrillM, 7);
    assert.equal(metrics.flushM, 3);
    assert.equal(metrics.bdn, 2);
    assert.equal(metrics.stb, 1);
    assert.equal(metrics.gsa, 1);
    assert.equal(metrics.fuel, 120);
    assert.equal(metrics.productivity, 10);
    assert.equal(metrics.smuHours, 8);
});

check('the KPI banner compares new metres with the saved goal and reports the signed variance', () => {
    const app = fixture();
    usePlan(app, savedPlan());
    const rows = [record('A', 'day', 80, '2026-10-16', {
        redrillMeters: 7, flushingMeters: 3,
        stoppages: [{ reason: 'hydraulic-bdn', hours: 2 }, { reason: 'blast-stb', hours: 1 }]
    })];
    const html = app.buildReportKpiBandeau(rows, '2026-10-16');
    assert.equal(kpiValue(html, 'Production réalisée'), '80,0 m');
    assert.equal(kpiValue(html, 'Production planifiée'), '100,0 m');
    assert.equal(kpiValue(html, 'Taux de réalisation'), '80,0 %');
    assert.equal(kpiValue(html, 'Écart (réel − plan)'), '-20,0 m');
    assert.equal(kpiValue(html, 'Heures de panne'), '2,0 h');
    assert.equal(kpiValue(html, 'Heures de standby'), '1,0 h');
    assert.match(textContent(html), /Reforage : 7,0 m/);
    assert.match(textContent(html), /Flushing : 3,0 m/);
});

check('a zero goal displays zero and a finite variance but no fabricated percentage', () => {
    const app = fixture();
    usePlan(app, savedPlan({ weeks: [{ start: '2026-10-15', end: '2026-10-21', target: 0 }] }));
    const html = app.buildReportKpiBandeau([record('A', 'day', 80)], '2026-10-16');
    assert.equal(kpiValue(html, 'Production planifiée'), '0,0 m');
    assert.equal(kpiValue(html, 'Taux de réalisation'), 'N/A');
    assert.equal(kpiValue(html, 'Écart (réel − plan)'), '+80,0 m');
    assert.doesNotMatch(html, /\bNaN\b|\bInfinity\b/);
    assert.match(html, /objectif nul/);
});

check('an unavailable goal leaves both achievement and variance unavailable', () => {
    const app = fixture();
    const html = app.buildReportKpiBandeau([record('A', 'day', 80)], '2026-10-16');
    assert.equal(kpiValue(html, 'Production planifiée'), 'Non renseigné');
    assert.equal(kpiValue(html, 'Taux de réalisation'), 'N/A');
    assert.equal(kpiValue(html, 'Écart (réel − plan)'), 'N/A');
});

check('mechanical availability is weighted by scheduled hours', () => {
    const app = fixture();
    const rows = [
        record('A', 'day', 80, '2026-10-16', { shiftNominalHours: 12, availabilityPct: 50 }),
        record('B', '', 120, '2026-10-16', { shiftNominalHours: 24, availabilityPct: 100 })
    ];
    assert.equal(kpiValue(app.buildReportKpiBandeau(rows, '2026-10-16'), 'Disponibilité méca.'), '83,3 %');
});

check('the previous comparison requires every exact machine/post pair, including serialized records', () => {
    const app = fixture();
    const rows = [record('A', 'day', 100), record('B', 'night', 100)];
    // More recent cross-pairs and incomplete scopes are not comparable.
    app.dailyDataRecords = [
        record('A', 'night', 1000, '2026-10-15'), record('B', 'day', 1000, '2026-10-15'),
        record('A', 'day', 500, '2026-10-14')
    ];
    assert.equal(kpiValue(app.buildReportKpiBandeau(rows, '2026-10-16'), 'Production précédente'), 'N/A');
    const serialized = record('B', 'night', 80, '2026-10-13');
    serialized.data = JSON.stringify(serialized.data);
    app.dailyDataRecords.push(record('A', 'day', 80, '2026-10-13'), serialized, record('C', 'day', 99999, '2026-10-13'));
    const html = app.buildReportKpiBandeau(rows, '2026-10-16');
    assert.equal(kpiValue(html, 'Production précédente'), '160,0 m');
    assert.match(textContent(html), /\+25 %.*2026-10-13/);
});

check('a zero previous production is visible without an infinite growth rate', () => {
    const app = fixture({ dailyDataRecords: [record('A', 'day', 0, '2026-10-15')] });
    const html = app.buildReportKpiBandeau([record('A', 'day', 80)], '2026-10-16');
    assert.equal(kpiValue(html, 'Production précédente'), '0,0 m');
    assert.match(textContent(html), /évol\. N\/A/);
    assert.doesNotMatch(html, /\bNaN\b|\bInfinity\b/);
});

check('previous production uses the current site history when available', () => {
    const app = fixture({ dailyDataRecords: [record('A', 'day', 9999, '2026-10-15')] });
    app.getDailyDataForSite = () => [record('A', 'day', 60, '2026-10-14')];
    const html = app.buildReportKpiBandeau([record('A', 'day', 80)], '2026-10-16');
    assert.equal(kpiValue(html, 'Production précédente'), '60,0 m');
});

check('standby and services have distinct totals even when both modern and legacy codes are present', () => {
    const app = fixture();
    const rows = [record('A', 'day', 80, '2026-10-16', {
        stoppages: [
            { reason: 'blast-stb', hours: 1.25 }, { reason: 'blast', hours: 0.75 },
            { reason: 'move-gsa', hours: 2.5 }, { reason: 'deplacement', hours: 0.5 },
            { reason: 'hydraulic-bdn', hours: 9 }
        ]
    })];
    const section = textContent(app.buildStandbySection(rows));
    assert.match(section, /Standby \(STB\) : 2,0 h/);
    assert.match(section, /Services \(GSA\) : 3,0 h/);
    assert.doesNotMatch(section, /hydraulic-bdn|9,0 h/);
    const kpis = app.buildReportKpiBandeau(rows, '2026-10-16');
    assert.equal(kpiValue(kpis, 'Heures de standby'), '2,0 h');
    assert.equal(kpiValue(kpis, 'Heures de panne'), '9,0 h');
});

check('loading uses the active API tenant rather than a stale user tenant', async () => {
    const app = fixture({ currentUser: { enterpriseId: 3 } });
    let argumentsUsed;
    app.apiRequest = (...args) => { argumentsUsed = args; return Promise.resolve({ plan: savedPlan(), version: 9 }); };
    await new Promise((resolve) => app.ensureReportPlanLoaded(resolve));
    assert.equal(argumentsUsed[0], '/planification');
    assert.equal(argumentsUsed[1], 'GET');
    assert.equal(argumentsUsed[3], '7');
    assert.equal(app.reportPlanSnapshot.version, 9);
    assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, 100);
});

check('load failure clears old data and still permits an explicitly unavailable report', async () => {
    const app = fixture();
    usePlan(app, savedPlan());
    app.apiRequest = () => Promise.reject(new Error('Network failure'));
    await new Promise((resolve) => app.ensureReportPlanLoaded(resolve));
    assert.equal(app.reportPlanSnapshot.plan, null);
    assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, null);
    assert.match(app.reportPlanSnapshot.error, /indisponible/);
});

check('a response for a previous tenant or site never reaches the report', async () => {
    for (const switchScope of [(app) => { app.window.API.getEnterpriseId = () => 8; }, (app) => { app.currentSiteId = 2; }]) {
        const app = fixture();
        let resolveRequest, reported = false;
        app.apiRequest = () => new Promise((resolve) => { resolveRequest = resolve; });
        const cancelled = new Promise((resolve) => app.ensureReportPlanLoaded(() => { reported = true; }, resolve));
        switchScope(app);
        resolveRequest({ plan: savedPlan(), version: 1 });
        await cancelled;
        assert.equal(reported, false);
        assert.equal(app.reportPlanSnapshot.plan, null);
    }
});

check('an older concurrent request cannot replace the newer saved plan', async () => {
    const app = fixture();
    const requests = [];
    let firstReported = false;
    app.apiRequest = () => new Promise((resolve) => requests.push(resolve));
    const firstCancelled = new Promise((resolve) => app.ensureReportPlanLoaded(() => { firstReported = true; }, resolve));
    const secondReady = new Promise((resolve) => app.ensureReportPlanLoaded(resolve));
    requests[1]({ plan: savedPlan(), version: 2 });
    await secondReady;
    requests[0]({ plan: savedPlan({ metric: 'trous' }), version: 1 });
    await firstCancelled;
    assert.equal(firstReported, false);
    assert.equal(app.reportPlanSnapshot.version, 2);
    assert.equal(app.getReportPlannedProduction('2026-10-16', []).value, 100);
});

check('generation opens one window during the click before asynchronously fetching the plan', async () => {
    const app = fixture();
    const events = [];
    const rows = [record('A', 'day', 80), record('B', 'night', 100, '2026-10-15')];
    const popup = { document: { write: () => events.push('loading'), close: () => {} } };
    app.document = { getElementById: () => ({ value: '2026-10-16' }) };
    app.alert = (message) => assert.fail(message);
    app.getDailyDataForSite = () => rows;
    app.window.open = () => { events.push('open'); return popup; };
    app.apiRequest = () => { events.push('fetch'); return Promise.resolve({ plan: savedPlan(), version: 5 }); };
    const generated = new Promise((resolve) => {
        app.printDailyReport = (date, records, reportWindow) => {
            assert.equal(date, '2026-10-16');
            assert.equal(records.length, 1);
            assert.equal(records[0], rows[0]);
            assert.equal(reportWindow, popup);
            resolve();
        };
    });
    app.generateDailyReport();
    assert.deepEqual(events, ['open', 'loading', 'fetch']);
    await generated;
    assert.equal(app.window._lastReportShare.recordCount, 1);
});

check('a blocked popup stops generation before a plan request is sent', () => {
    const app = fixture();
    const alerts = [];
    app.document = { getElementById: () => ({ value: '2026-10-16' }) };
    app.getDailyDataForSite = () => [record('A', 'day', 80)];
    app.window.open = () => null;
    app.alert = (message) => alerts.push(message);
    app.apiRequest = () => assert.fail('Plan loading must not start without a report window');
    app.generateDailyReport();
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /fenêtre/);
});

check('printing waits for fonts and logo load or error in the prepared window', async () => {
    const app = fixture();
    let finishFonts;
    const fontsReady = new Promise((resolve) => { finishFonts = resolve; });
    const imageEvents = {};
    let printed = 0;
    let writes = '';
    app.setTimeout = () => 0; // The all-assets-ready branch wins without real timers.
    app.alert = (message) => assert.fail(message);
    app.window.open = () => assert.fail('Printing must reuse the window opened during the click');
    const popup = {
        closed: false,
        document: {
            open: () => {}, write: (html) => { writes = html; }, close: () => {},
            images: [{ complete: false, addEventListener: (event, handler) => { imageEvents[event] = handler; } }],
            fonts: { ready: fontsReady }
        },
        requestAnimationFrame: (callback) => callback(), focus: () => {}, print: () => { printed += 1; }
    };
    assert.equal(app.printDailyReport('2026-10-16', [record('A', 'day', 80)], popup), true);
    assert.match(writes, /RAPPORT JOURNALIER DE FORAGE/);
    assert.equal(printed, 0);
    assert.equal(typeof imageEvents.load, 'function');
    assert.equal(typeof imageEvents.error, 'function');
    imageEvents.error(); // A missing logo must not prevent printing the rest of the report.
    await new Promise(setImmediate);
    assert.equal(printed, 0);
    finishFonts();
    await new Promise(setImmediate);
    assert.equal(printed, 1);
});

check('the landscape daily document contains visible KPIs, printable charts and signatures without external chart resources', () => {
    const app = fixture();
    usePlan(app, savedPlan());
    const html = app.buildDailyReportDocumentHtml('2026-10-16', [record('A', 'day', 80)]);
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /RAPPORT JOURNALIER DE FORAGE/);
    for (const title of ['INDICATEURS CLÉS', 'Activité et performance', 'Répartition des arrêts', 'Production par zone', 'Observations générales', 'Établi par', 'Contrôlé par', 'Visé par']) {
        assert.ok(html.includes(title), `Missing report section: ${title}`);
    }
    assert.doesNotMatch(html, /<canvas\b|<script\b|chart\.js|cdn\.jsdelivr|Forage nouveau réalisé \/ planifié — 7 jours/i);
    assert.match(html, /@page\{size:A4 landscape/);
    assert.match(html, /INDICATEURS CLÉS — KPI ET PRODUCTION/);
    assert.match(html, /daily-chart-bar/);
    assert.match(html, /text-align:center!important;font-weight:700!important/);
    assert.match(html, /table-header-group/);
    assert.match(html, /Imprimer \/ Enregistrer en PDF/);
});

check('the report header names the full multi-site scope rather than only the first machine site', () => {
    const app = fixture({
        currentSiteId: null,
        sites: [{ id: 1, name: 'Mine Ouest' }, { id: 2, name: 'Mine Est' }],
        drills: [{ id: 'A', siteId: 1 }, { id: 'B', siteId: 2 }]
    });
    const mixed = app.buildDailyReportDocumentHtml('2026-10-16', [record('A', 'day', 80), record('B', 'night', 100)]);
    assert.match(textContent(mixed), /Projet \/ site : Tous les sites/);
    assert.match(textContent(mixed), /INDICATEURS CLÉS — KPI ET PRODUCTION/);
    const single = app.buildDailyReportDocumentHtml('2026-10-16', [record('A', 'day', 80), record('A', 'night', 100)]);
    assert.match(textContent(single), /Projet \/ site : Mine Ouest/);
    assert.doesNotMatch(textContent(single), /Projet \/ site : Tous les sites/);
});

check('the recorded breakdown detail is labelled as an observation rather than a confirmed intervention', () => {
    const app = fixture();
    const section = app.buildPannesSection([record('A', 'day', 80, '2026-10-16', {
        stoppages: [{ reason: 'hydraulic-bdn', hours: 2, detail: 'Fuite hydraulique à contrôler' }]
    })]);
    assert.match(section, /<th>Observation enregistrée<\/th>/);
    assert.match(section, /Fuite hydraulique à contrôler/);
    assert.doesNotMatch(section, /<th>Solution \/ intervention<\/th>/);
});

check('report comments, machine names and intervention details remain text', () => {
    const app = fixture();
    const attack = '<script>alert("injected")</script>';
    const rows = [record('A', 'day', 80, '2026-10-16', {
        notes: attack,
        location: '<img src=x onerror=alert(1)>',
        stoppages: [{ reason: 'hydraulic-bdn', hours: 2, detail: attack, timeStart: attack, timeEnd: '08:00' }]
    })];
    app.drills[0].id = 'A';
    rows[0].enteredByName = attack;
    const html = app.buildDailyReportDocumentHtml('2026-10-16', rows);
    assert.doesNotMatch(html, /<script\b|<img src=x/i);
    assert.ok(html.includes('&lt;script&gt;alert("injected")&lt;/script&gt;'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(textContent(html).includes('80'));
});

check('an empty daily selection still produces a complete, finite printable document', () => {
    const app = fixture();
    const html = app.buildDailyReportDocumentHtml('2026-10-16', []);
    assert.match(html, /Aucune donnée enregistrée/);
    assert.doesNotMatch(html, /\bNaN\b|\bInfinity\b|\bundefined\b/);
    assert.match(html, /Visa et signatures/);
});

check('one machine working day and night is counted once in the header while both shifts sum in KPIs and charts', () => {
    const app = fixture();
    const rows = [record('A', 'day', 100), record('A', 'night', 80), record('B', 'day', 0, '2026-10-16', {hours: 0})];
    assert.equal(app.getReportUsedMachineCount(rows), 1);
    const html = app.buildDailyReportDocumentHtml('2026-10-16', rows);
    const header = html.match(/<header>([\s\S]*?)<\/header>/)[1];
    assert.match(header, /Machines utilisées :/);
    assert.doesNotMatch(header, /Machine\(s\) :/);
    assert.equal(kpiValue(html, 'Production réalisée'), '180,0 m');
    const chart = app.buildDailyProductionChart(rows, '2026-10-16', false);
    assert.match(chart, />100 m</); assert.match(chart, />80 m</); assert.match(chart, />180 m</);
    assert.match(chart, /Planifié/); assert.match(chart, /Non renseigné/);
});

check('the chart retains explicit zero goals and the provisional chart never invents a goal', () => {
    const app = fixture();
    usePlan(app, savedPlan({weeks: [{start:'2026-10-15',end:'2026-10-21',target:0}]}));
    const rows = [record('A','day',0)];
    const html = app.buildDailyProductionChart(rows,'2026-10-16',false);
    assert.match(html,/Planifié/); assert.match(html,/>0 m</); assert.doesNotMatch(html,/NaN|Infinity/);
    assert.doesNotMatch(app.buildDailyProductionChart(rows,'2026-10-16',true),/Planifié|Réalisé et objectif/);
});

check('manual and generated hole identifiers remain visible and escaped in both reports', () => {
    const app = fixture();
    const rows=[record('A','day',8,'2026-10-16',{holesWorked:[{source:'manual',blockId:'',holeId:'RC-001 <test>',meters:5,finalDepth:10},{source:'automatic',blockId:'',holeId:'A-20261016-J-001',meters:3,finalDepth:null}]})];
    for (const html of [app.buildDailyReportDocumentHtml('2026-10-16',rows), app.buildMidshiftReportDocumentHtml('2026-10-16',rows)]) {
        assert.match(html,/RC-001 &lt;test&gt;/); assert.match(html,/A-20261016-J-001/);
        assert.match(html,/>Manuel</); assert.match(html,/>Automatique</);
        assert.match(html,/@page\{size:A4 landscape/);
    }
});

async function main() {
    let completed = 0;
    for (const { name, body } of checks) {
        await body();
        completed += 1;
        process.stdout.write(`ok ${completed} - ${name}\n`);
    }
    process.stdout.write(`${completed} daily-report regression checks passed.\n`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = { fixture, record, savedPlan, usePlan };
