// API Client pour GOOD ENGINEERS-DRILL
// Remplace localStorage par des appels API REST
//
// URL de l'API :
// - En ligne : même origine que la page (ex. https://votredomaine.com/api)
// - Fichier local (file://) ou personnalisation : localhost ou window.__FORAGE_API_URL__

function getApiBaseUrl() {
    if (typeof window === 'undefined') {
        return process.env.API_PUBLIC_URL
            ? (process.env.API_PUBLIC_URL.endsWith('/api') ? process.env.API_PUBLIC_URL : process.env.API_PUBLIC_URL + '/api')
            : 'http://localhost:3000/api';
    }
    if (window.__FORAGE_API_URL__) {
        var u = String(window.__FORAGE_API_URL__).replace(/\/$/, '');
        return u.endsWith('/api') ? u : u + '/api';
    }
    var loc = window.location;
    if (loc.protocol === 'file:') {
        return 'http://localhost:3000/api';
    }
    return loc.origin + '/api';
}

// Contexte entreprise (multi-tenant) - utilisé par l'administrateur général
let currentEnterpriseId = null;

// Le JWT est désormais stocké dans un cookie httpOnly (inaccessible au JS).
// On garde un drapeau de session en localStorage pour savoir si tenter Auth.me au chargement.
let _isAuthenticated = false;
if (typeof window !== 'undefined') {
    try { _isAuthenticated = localStorage.getItem('forage_session') === '1'; } catch (e) {}
}

function setAuthToken(token) {
    const wasAuthenticated = _isAuthenticated;
    _isAuthenticated = !!token;
    if (typeof window !== 'undefined') {
        try {
            if (token) localStorage.setItem('forage_session', '1');
            else localStorage.removeItem('forage_session');
        } catch (e) {}
    }
    // Effacer le cookie httpOnly côté serveur lors de la déconnexion
    if (!token && wasAuthenticated) {
        fetch(`${getApiBaseUrl()}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
    }
}

function getAuthToken() {
    // Retourne un sentinel truthy si une session est connue — ne jamais retourner le token réel
    return _isAuthenticated ? '__session__' : null;
}

function setEnterpriseId(id) {
    currentEnterpriseId = id;
}

function getEnterpriseId() {
    return currentEnterpriseId;
}

// Fonction utilitaire pour les requêtes (cookie httpOnly envoyé automatiquement)
async function apiRequest(endpoint, method = 'GET', data = null, enterpriseId = undefined) {
    try {
        const options = {
            method,
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        };
        const entId = enterpriseId !== undefined ? enterpriseId : currentEnterpriseId;
        if (entId !== null && entId !== undefined && entId !== '') {
            options.headers['X-Enterprise-Id'] = String(entId);
        }
        if (data) {
            options.body = JSON.stringify(data);
        }
        const response = await fetch(`${getApiBaseUrl()}${endpoint}`, options);
        if (response.status === 401 && _isAuthenticated && endpoint !== '/auth/me') {
            setAuthToken(null);
        }
        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            const apiError = new Error(errBody.error || `HTTP error! status: ${response.status}`);
            apiError.status = response.status;
            apiError.details = errBody;
            throw apiError;
        }
        return await response.json();
    } catch (error) {
        console.error(`Erreur API ${method} ${endpoint}:`, error);
        throw error;
    }
}

// ============================================
// API - AUTHENTIFICATION
// ============================================
const AuthAPI = {
    login: async (username, password) => {
        const response = await fetch(`${getApiBaseUrl()}/auth/login`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || 'Identifiants incorrects');
        }
        // Le cookie httpOnly est posé par le serveur — marquer la session active côté JS
        setAuthToken(true);
        return data;
    },
    me: () => apiRequest('/auth/me', 'GET'),
    logout: () => apiRequest('/auth/logout', 'POST'),
    changePassword: (currentPassword, newPassword) =>
        apiRequest('/auth/change-password', 'POST', { currentPassword, newPassword })
};

// ============================================
// API - ENTREPRISES
// ============================================
const EnterprisesAPI = {
    getAll: () => apiRequest('/enterprises'),
    update: (id, data) => apiRequest(`/enterprises/${id}`, 'PUT', data),
    create: (data) => apiRequest('/enterprises', 'POST', data),
    remove: (id) => apiRequest(`/enterprises/${id}`, 'DELETE'),
    uploadLogo: async (id, file) => {
        const fd = new FormData();
        fd.append('logo', file);
        const res = await fetch(`${getApiBaseUrl()}/enterprises/${id}/logo`, {
            method: 'POST',
            credentials: 'include',
            body: fd
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Erreur upload logo');
        return data;
    },
    deleteLogo: (id) => apiRequest(`/enterprises/${id}/logo`, 'DELETE')
};

const EnterpriseRolePolicyAPI = {
    getMy: () => apiRequest('/enterprise-role-policy', 'GET'),
    getForEnterprise: (id) => apiRequest(`/enterprises/${id}/role-policy`, 'GET')
};

const PlanRolesAPI = {
    getDefaults: () => apiRequest('/plan-roles/defaults', 'GET')
};

const SubscriptionPlansAPI = {
    getAll: () => apiRequest('/subscription-plans', 'GET'),
    update: (plan, data) => apiRequest(`/subscription-plans/${encodeURIComponent(plan)}`, 'PUT', data)
};

// ============================================
// API - UTILISATEURS
// ============================================
const UsersAPI = {
    getAll: (opts) => {
        let url = '/users';
        if (opts && opts.enterpriseId != null && opts.enterpriseId !== '') {
            url += '?enterpriseId=' + encodeURIComponent(String(opts.enterpriseId));
        }
        return apiRequest(url, 'GET');
    },
    create: (user) => apiRequest('/users', 'POST', user),
    update: (username, user) => apiRequest(`/users/${encodeURIComponent(username)}`, 'PUT', user),
    delete: (username) => apiRequest(`/users/${encodeURIComponent(username)}`, 'DELETE')
};

// ============================================
// API - MACHINES
// ============================================
const DrillsAPI = {
    getAll: () => apiRequest('/drills'),
    create: (drill) => apiRequest('/drills', 'POST', drill),
    update: (id, drill) => apiRequest(`/drills/${id}`, 'PUT', drill),
    delete: (id) => apiRequest(`/drills/${encodeURIComponent(id)}`, 'DELETE')
};

// ============================================
// API - SITES
// ============================================
const SitesAPI = {
    getAll: (params = {}) => {
        const queryString = new URLSearchParams(params).toString();
        return apiRequest(`/sites${queryString ? '?' + queryString : ''}`);
    },
    create: (site) => apiRequest('/sites', 'POST', site),
    update: (id, site) => apiRequest(`/sites/${id}`, 'PUT', site),
    delete: (id) => apiRequest(`/sites/${id}`, 'DELETE')
};

// ============================================
// API - CLIENTS
// ============================================
const ClientsAPI = {
    getAll: () => apiRequest('/clients'),
    create: (client) => apiRequest('/clients', 'POST', client),
    update: (id, client) => apiRequest(`/clients/${id}`, 'PUT', client),
    delete: (id) => apiRequest(`/clients/${id}`, 'DELETE')
};

// ============================================
// API - CONTRATS
// ============================================
const ContractsAPI = {
    getAll: () => apiRequest('/contracts'),
    create: (contract) => apiRequest('/contracts', 'POST', contract),
    update: (id, contract) => apiRequest(`/contracts/${id}`, 'PUT', contract),
    delete: (id) => apiRequest(`/contracts/${id}`, 'DELETE')
};

// ============================================
// API - EMPLOYEES
// ============================================
const EmployeesAPI = {
    getAll: () => apiRequest('/employees'),
    create: (employee) => apiRequest('/employees', 'POST', employee),
    update: (id, employee) => apiRequest(`/employees/${id}`, 'PUT', employee),
    delete: (id) => apiRequest(`/employees/${id}`, 'DELETE')
};

// ============================================
// API - ASSIGNMENTS
// ============================================
const AssignmentsAPI = {
    getAll: () => apiRequest('/assignments'),
    create: (assignment) => apiRequest('/assignments', 'POST', assignment),
    update: (id, assignment) => apiRequest(`/assignments/${id}`, 'PUT', assignment),
    delete: (id) => apiRequest(`/assignments/${id}`, 'DELETE')
};

// ============================================
// API - INVOICES
// ============================================
const InvoicesAPI = {
    getAll: () => apiRequest('/invoices'),
    create: (invoice) => apiRequest('/invoices', 'POST', invoice),
    update: (id, invoice) => apiRequest(`/invoices/${encodeURIComponent(String(id))}`, 'PUT', invoice),
    delete: (id) => apiRequest(`/invoices/${encodeURIComponent(id)}`, 'DELETE')
};

const DrillMonthBillingAPI = {
    getAll: (params) => {
        var q = '';
        if (params && params.yearMonth != null && params.yearMonth !== '') {
            q = '?yearMonth=' + encodeURIComponent(String(params.yearMonth).slice(0, 7));
        }
        return apiRequest('/drill-month-billing' + q, 'GET');
    },
    upsert: (row) => apiRequest('/drill-month-billing', 'POST', row),
    remove: (drillId, yearMonth) =>
        apiRequest(
            '/drill-month-billing/' + encodeURIComponent(String(drillId)) + '/' + encodeURIComponent(String(yearMonth).slice(0, 7)),
            'DELETE'
        )
};

// ============================================
// API - INVENTORY
// ============================================
const InventoryAPI = {
    getAll: () => apiRequest('/inventory'),
    create: (item) => apiRequest('/inventory', 'POST', item),
    update: (id, item) => apiRequest(`/inventory/${id}`, 'PUT', item)
};

// ============================================
// API - DAILY DATA
// ============================================
const DailyDataAPI = {
    get: (params = {}) => {
        const queryString = new URLSearchParams(params).toString();
        return apiRequest(`/daily-data${queryString ? '?' + queryString : ''}`);
    },
    save: (record) => apiRequest('/daily-data', 'POST', record),
    submit: (id) => apiRequest(`/daily-data/${encodeURIComponent(id)}/submit`, 'POST', {}),
    approve: (id, comment = '') => apiRequest(`/daily-data/${encodeURIComponent(id)}/approve`, 'POST', { comment }),
    reject: (id, comment) => apiRequest(`/daily-data/${encodeURIComponent(id)}/reject`, 'POST', { comment }),
    reopen: (id, comment = '') => apiRequest(`/daily-data/${encodeURIComponent(id)}/reopen`, 'POST', { comment }),
    /** date/dateFrom+dateTo, optionnel machineId, optionnel shift (une ligne précise) */
    removeByFilter: (params = {}) => {
        const q = new URLSearchParams();
        Object.keys(params).forEach((k) => {
            const v = params[k];
            if (v !== undefined && v !== null) q.set(k, String(v));
        });
        const qs = q.toString();
        return apiRequest(`/daily-data${qs ? '?' + qs : ''}`, 'DELETE');
    }
};

// ============================================
// API - DRILLING PLAN
// ============================================
const DrillingPlanAPI = {
    get: () => apiRequest('/drilling-plan'),
    save: (plan) => apiRequest('/drilling-plan', 'PUT', plan)
};

// ============================================
// API - COMPANY
// ============================================
const CompanyAPI = {
    get: () => apiRequest('/company'),
    update: (company) => apiRequest('/company', 'POST', company),
    updateLogo: (logo) => apiRequest('/company/logo', 'POST', { logo })
};

const TranslateAPI = {
    run: (text, source, target, opts) => {
        const register =
            opts && (opts.register === 'standard' || opts.register === 'casual')
                ? 'standard'
                : 'professional';
        return apiRequest('/translate', 'POST', { text, source, target, register });
    }
};

const WorkerChatAPI = {
    getMessages: (sinceId) => {
        const sid = sinceId == null || sinceId === '' ? 0 : sinceId;
        return apiRequest(`/worker-chat/messages?sinceId=${encodeURIComponent(String(sid))}`, 'GET');
    },
    send: (body, toUserId) => apiRequest('/worker-chat/messages', 'POST', { body, toUserId }),
    uploadFormData: async (formData) => {
        const url = `${getApiBaseUrl()}/worker-chat/messages/upload`;
        const headers = {};
        if (currentEnterpriseId !== null && currentEnterpriseId !== undefined && currentEnterpriseId !== '') {
            headers['X-Enterprise-Id'] = String(currentEnterpriseId);
        }
        const response = await fetch(url, { method: 'POST', credentials: 'include', headers, body: formData });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP error! status: ${response.status}`);
        return data;
    }
};

const CompanyInfoAPI = {
    list: () => apiRequest('/company-info/posts', 'GET'),
    create: (payload) => apiRequest('/company-info/posts', 'POST', payload),
    remove: (id) => apiRequest(`/company-info/posts/${id}`, 'DELETE')
};

const ReportDistAPI = {
    create: (payload) => apiRequest('/report-distributions', 'POST', payload),
    mine: () => apiRequest('/report-distributions/mine', 'GET'),
    listAll: () => apiRequest('/report-distributions', 'GET'),
    remove: (id) => apiRequest(`/report-distributions/${encodeURIComponent(id)}`, 'DELETE')
};

// ============================================
// FONCTION DE CHARGEMENT COMPLET
// ============================================
async function loadAllData() {
    try {
        console.log('🔄 Chargement des données depuis l\'API...');
        
        const [
            usersData,
            drillsData,
            clientsData,
            sitesData,
            contractsData,
            employeesData,
            assignmentsData,
            invoicesData,
            inventoryData,
            companyData,
            drillMonthBillingData
        ] = await Promise.all([
            UsersAPI.getAll().catch((err) => {
                console.warn('API users:', err && err.message);
                return null;
            }),
            DrillsAPI.getAll().catch((err) => {
                console.warn('API drills:', err && err.message);
                return null;
            }),
            ClientsAPI.getAll().catch((err) => {
                console.warn('API clients:', err && err.message);
                return null;
            }),
            SitesAPI.getAll().catch((err) => {
                console.warn('API sites:', err && err.message);
                return null;
            }),
            ContractsAPI.getAll().catch((err) => {
                console.warn('API contracts:', err && err.message);
                return null;
            }),
            EmployeesAPI.getAll().catch((err) => {
                console.warn('API employees:', err && err.message);
                return null;
            }),
            AssignmentsAPI.getAll().catch((err) => {
                console.warn('API assignments:', err && err.message);
                return null;
            }),
            InvoicesAPI.getAll().catch((err) => {
                console.warn('API invoices:', err && err.message);
                return null;
            }),
            InventoryAPI.getAll().catch((err) => {
                console.warn('API inventory:', err && err.message);
                return null;
            }),
            CompanyAPI.get().catch(() => ({})),
            DrillMonthBillingAPI.getAll().catch((err) => {
                console.warn('API drill-month-billing:', err && err.message);
                return null;
            })
        ]);
        
        return {
            users: usersData,
            drills: drillsData,
            clients: clientsData,
            sites: sitesData,
            contracts: contractsData,
            employees: employeesData,
            assignments: assignmentsData,
            invoices: invoicesData,
            inventory: inventoryData,
            companyInfo: companyData,
            drillMonthBilling: drillMonthBillingData
        };
    } catch (error) {
        console.error('❌ Erreur lors du chargement des données:', error);
        throw error;
    }
}

// ============================================
// FONCTION DE SAUVEGARDE COMPLÈTE
// ============================================
async function saveAllData(data) {
    try {
        console.log('💾 Sauvegarde des données via l\'API...');
        
        // Sauvegarder chaque entité
        const promises = [];
        
        if (data.users) {
            // Pour les utilisateurs, on doit gérer individuellement
            // (création/mise à jour selon l'existence)
        }
        
        if (data.drills) {
            for (const drill of data.drills) {
                promises.push(
                    DrillsAPI.update(drill.id, drill).catch(() => 
                        DrillsAPI.create(drill).catch(console.error)
                    )
                );
            }
        }
        
        if (data.clients) {
            for (const client of data.clients) {
                promises.push(
                    ClientsAPI.update(client.id, client).catch(() => 
                        ClientsAPI.create(client).catch(console.error)
                    )
                );
            }
        }
        
        if (data.sites) {
            for (const site of data.sites) {
                if (site.id) {
                    promises.push(
                        SitesAPI.update(site.id, site).catch(() =>
                            SitesAPI.create(site).catch(console.error)
                        )
                    );
                } else {
                    promises.push(
                        SitesAPI.create(site).catch(console.error)
                    );
                }
            }
        }
        
        if (data.contracts) {
            for (const contract of data.contracts) {
                promises.push(
                    ContractsAPI.update(contract.id, contract).catch(() => 
                        ContractsAPI.create(contract).catch(console.error)
                    )
                );
            }
        }
        
        if (data.employees) {
            for (const employee of data.employees) {
                promises.push(
                    EmployeesAPI.update(employee.id, employee).catch(() => 
                        EmployeesAPI.create(employee).catch(console.error)
                    )
                );
            }
        }
        
        // Assignations : ne jamais enchaîner create si update échoue — cela dupliquait des lignes pour la même foreuse.
        if (data.assignments) {
            for (const assignment of data.assignments) {
                const rid = assignment && assignment.id;
                const hasServerId = rid != null && rid !== '' && !Number.isNaN(Number(rid));
                if (hasServerId) {
                    promises.push(
                        AssignmentsAPI.update(rid, assignment).catch((err) => {
                            console.warn('Sync assignation : mise à jour ignorée id=', rid, err && err.message);
                        })
                    );
                } else {
                    promises.push(
                        AssignmentsAPI.create(assignment).catch((err) => {
                            console.warn('Sync assignation : création ignorée', err && err.message);
                        })
                    );
                }
            }
        }
        
        if (data.invoices) {
            for (const invoice of data.invoices) {
                promises.push(
                    InvoicesAPI.update(invoice.id, invoice).catch(() => 
                        InvoicesAPI.create(invoice).catch(console.error)
                    )
                );
            }
        }
        
        if (data.inventory) {
            for (const item of data.inventory) {
                promises.push(
                    InventoryAPI.update(item.id, item).catch(() => 
                        InventoryAPI.create(item).catch(console.error)
                    )
                );
            }
        }
        
        if (data.companyInfo) {
            promises.push(CompanyAPI.update(data.companyInfo).catch(console.error));
        }
        
        await Promise.all(promises);
        console.log('✅ Données sauvegardées avec succès');
    } catch (error) {
        console.error('❌ Erreur lors de la sauvegarde:', error);
        throw error;
    }
}

// Exporter pour utilisation globale
if (typeof window !== 'undefined') {
    window.API = {
        getBaseUrl: () => getApiBaseUrl(),
        setAuthToken,
        getAuthToken,
        Auth: AuthAPI,
        logout: AuthAPI.logout,
        Enterprises: EnterprisesAPI,
        EnterpriseRolePolicy: EnterpriseRolePolicyAPI,
        PlanRoles: PlanRolesAPI,
        SubscriptionPlans: SubscriptionPlansAPI,
        setEnterpriseId,
        getEnterpriseId,
        Users: UsersAPI,
        Drills: DrillsAPI,
        Clients: ClientsAPI,
        Sites: SitesAPI,
        Contracts: ContractsAPI,
        Employees: EmployeesAPI,
        Assignments: AssignmentsAPI,
        Invoices: InvoicesAPI,
        DrillMonthBilling: DrillMonthBillingAPI,
        Inventory: InventoryAPI,
        DailyData: DailyDataAPI,
        DrillingPlan: DrillingPlanAPI,
        Company: CompanyAPI,
        Translate: TranslateAPI,
        WorkerChat: WorkerChatAPI,
        CompanyInfo: CompanyInfoAPI,
        ReportDist: ReportDistAPI,
        loadAllData,
        saveAllData
    };
}
