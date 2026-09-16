/**
 * Rôles autorisés par plan d'abonnement et résolution effective (liste personnalisable en base).
 */
const PLATFORM_ROLES = ['super_admin', 'platform_owner'];

/** Plans reconnus : tout autre libellé est traité comme free pour les rôles par défaut */
const DEFAULT_ROLES_BY_PLAN = {
    free: ['foreur', 'aideforeur', 'superviseur', 'santesecurite'],
    basic: ['foreur', 'aideforeur', 'superviseur', 'santesecurite', 'ingenieur'],
    premium: ['foreur', 'aideforeur', 'superviseur', 'santesecurite', 'ingenieur', 'gestionnaire', 'gestionnaire_site'],
    enterprise: ['foreur', 'aideforeur', 'superviseur', 'santesecurite', 'ingenieur', 'gestionnaire', 'gestionnaire_site', 'admin']
};

/** Vues métier (onglets) — hors « Entreprises » (réservé plateforme) */
const TENANT_MAIN_VIEWS = ['dashboard', 'connections', 'assignments', 'maintenance', 'invoices', 'contracts', 'sites', 'revenue', 'site_meals', 'reports', 'project_overview', 'rh', 'inventory', 'accounts', 'clients', 'translator', 'team_chat', 'company_info'];

/** Onglets inclus par défaut selon le plan d’abonnement */
const DEFAULT_TABS_BY_PLAN = {
    free: ['dashboard', 'reports', 'project_overview', 'assignments', 'translator', 'team_chat', 'company_info'],
    basic: ['dashboard', 'connections', 'assignments', 'maintenance', 'reports', 'project_overview', 'sites', 'clients', 'contracts', 'site_meals', 'translator', 'team_chat', 'company_info'],
    premium: ['dashboard', 'connections', 'assignments', 'maintenance', 'invoices', 'contracts', 'sites', 'revenue', 'site_meals', 'reports', 'project_overview', 'rh', 'inventory', 'clients', 'translator', 'team_chat', 'company_info'],
    enterprise: TENANT_MAIN_VIEWS.slice()
};

function normalizePlan(plan) {
    const p = String(plan || 'free').toLowerCase();
    return Object.prototype.hasOwnProperty.call(DEFAULT_ROLES_BY_PLAN, p) ? p : 'free';
}

function parseAllowedRolesJson(jsonStr) {
    if (jsonStr == null || jsonStr === '') return null;
    try {
        const a = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        return Array.isArray(a) ? a.map(String) : null;
    } catch (_) {
        return null;
    }
}

function getDefaultRolesForPlan(plan) {
    return DEFAULT_ROLES_BY_PLAN[normalizePlan(plan)] || DEFAULT_ROLES_BY_PLAN.free;
}

const ALL_TENANT_ROLES = [...new Set(Object.values(DEFAULT_ROLES_BY_PLAN).flat())];

/** Liste effective : personnalisation BDD si tableau valide, sinon défaut du plan */
function parseAllowedTabsJson(jsonStr) {
    if (jsonStr == null || jsonStr === '') return null;
    try {
        const a = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        return Array.isArray(a) ? a.map(String) : null;
    } catch (_) {
        return null;
    }
}

/** Surcharge catalogue BDD : { free: ['dashboard',...], ... } — null = uniquement les constantes */
let PLAN_DEFAULT_TABS_FROM_DB = null;

function setPlanDefaultTabsFromDatabase(map) {
    PLAN_DEFAULT_TABS_FROM_DB = map && typeof map === 'object' ? map : null;
}

/** Défaut d’onglets pour une formule : ligne catalogue si présente, sinon constantes embarquées */
function getDefaultTabsForPlan(plan) {
    const p = normalizePlan(plan);
    if (PLAN_DEFAULT_TABS_FROM_DB && Array.isArray(PLAN_DEFAULT_TABS_FROM_DB[p]) && PLAN_DEFAULT_TABS_FROM_DB[p].length > 0) {
        const cleaned = PLAN_DEFAULT_TABS_FROM_DB[p].filter((v) => TENANT_MAIN_VIEWS.includes(v));
        if (cleaned.length > 0) return cleaned;
    }
    return DEFAULT_TABS_BY_PLAN[p] || DEFAULT_TABS_BY_PLAN.free;
}

/** Liste d’onglets effective : personnalisation entreprise sinon défaut du plan (catalogue ou code) */
function getEffectiveAllowedTabs(entRow) {
    if (!entRow) return getDefaultTabsForPlan('free');
    const custom = parseAllowedTabsJson(entRow.allowedTabs);
    if (custom && custom.length > 0) {
        const cleaned = custom.filter((v) => TENANT_MAIN_VIEWS.includes(v));
        if (cleaned.length > 0) return cleaned;
    }
    return getDefaultTabsForPlan(entRow.plan);
}

function getEffectiveAllowedRoles(entRow) {
    if (!entRow) return DEFAULT_ROLES_BY_PLAN.free;
    const custom = parseAllowedRolesJson(entRow.allowedRoles);
    if (custom && custom.length > 0) {
        const cleaned = custom.filter((r) => ALL_TENANT_ROLES.includes(r) && !PLATFORM_ROLES.includes(r));
        if (cleaned.length > 0) return cleaned;
    }
    return getDefaultRolesForPlan(entRow.plan);
}

function isRoleAllowedForEnterprise(role, entRow) {
    if (!role) return false;
    if (PLATFORM_ROLES.includes(role)) return false;
    const allowed = getEffectiveAllowedRoles(entRow);
    return allowed.includes(role);
}

function enterpriseAllowsUserManagement(entRow) {
    if (!entRow) return { ok: false, reason: 'Entreprise introuvable' };
    if (parseInt(entRow.isActive, 10) !== 1) {
        return { ok: false, reason: 'Entreprise désactivée : la gestion des comptes est suspendue' };
    }
    const st = String(entRow.subscriptionStatus || 'active').toLowerCase();
    if (st !== 'active') {
        return { ok: false, reason: 'Abonnement non actif : la gestion des comptes est suspendue' };
    }
    return { ok: true };
}

module.exports = {
    PLATFORM_ROLES,
    DEFAULT_ROLES_BY_PLAN,
    TENANT_MAIN_VIEWS,
    DEFAULT_TABS_BY_PLAN,
    ALL_TENANT_ROLES,
    normalizePlan,
    parseAllowedRolesJson,
    parseAllowedTabsJson,
    getDefaultRolesForPlan,
    getDefaultTabsForPlan,
    setPlanDefaultTabsFromDatabase,
    getEffectiveAllowedTabs,
    getEffectiveAllowedRoles,
    isRoleAllowedForEnterprise,
    enterpriseAllowsUserManagement
};
