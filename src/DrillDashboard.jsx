import React, { useState, useEffect } from 'react';
import RentabiliteConsommables from './RentabiliteConsommables';
import DepensesMaintenance     from './DepensesMaintenance';
import SaisieManuelle          from './SaisieManuelle';
import { apiFetch } from './api';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rnd   = (n) => Math.random() * n * 2 - n;

const initDrillsData = (drills) => drills.map(d => {
  const fuelLevel = d.fuel?.level != null && d.fuel?.capacity
    ? Math.round(d.fuel.level / d.fuel.capacity * 100)
    : 60 + Math.random() * 30;
  return {
    ...d,
    telemetry: {
      rotation_pressure: d.telemetry?.rotation_pressure ?? 100 + Math.random() * 50,
      hyd_temp:          d.telemetry?.hyd_temp          ?? 70  + Math.random() * 20,
      depth:             d.telemetry?.depth             ?? Math.random() * 80 + 10,
      rop:               2.5 + Math.random() * 4.5,
      wob:               5   + Math.random() * 8,
      rpm:               48  + Math.random() * 35,
      fuel_level:        fuelLevel,
    },
    metersShift:    0,
    holesCompleted: 0,
  };
});

// ── Statuts de trous (couleurs) ───────────────────────────────────────────────
const HOLE_STATUS = { COMPLETÉ: '#22C55E', 'EN COURS': '#FFCD00', PLANIFIÉ: '#374151', PROBLÈME: '#EF4444' };

// ── Helpers ─────────────────────────────────────────────────────────────────
const STATUS_BADGE = {
  'EN FORAGE':      'bg-drill-green/20   text-drill-green  border border-drill-green/40',
  'EN PAUSE':       'bg-komatsu-yellow/20 text-komatsu-dark border border-komatsu-yellow/40',
  'EN MAINTENANCE': 'bg-drill-red/20     text-drill-red    border border-drill-red/40',
  'HORS SERVICE':   'bg-slate-600/20     text-slate-600    border border-slate-600/40',
};

const safeParseConsumables = (raw) => {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || '[]'); } catch { return []; }
};

// ── KPI Card ─────────────────────────────────────────────────────────────────
const KPI = ({ label, value, unit, sub, highlight }) => (
  <div className={`bg-mine-card border ${highlight ? 'border-komatsu-yellow' : 'border-mine-border'} rounded-xl px-5 py-4 flex-1 min-w-[130px]`}>
    <p className="text-slate-500 text-[10px] uppercase tracking-widest mb-1">{label}</p>
    <p className={`text-3xl font-black font-mono leading-none ${highlight ? 'text-komatsu-dark' : 'text-slate-900'}`}>
      {value}
      {unit && <span className="text-base font-semibold text-slate-500 ml-1">{unit}</span>}
    </p>
    {sub && <p className="text-slate-600 text-[11px] mt-1">{sub}</p>}
  </div>
);

// ── Tabs ─────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'dashboard',    label: 'Tableau de Bord'          },
  { id: 'plan',         label: 'Plan de Forage'           },
  { id: 'consumables',  label: 'Consommables & Coûts'     },
  { id: 'rentabilite',  label: 'Rentabilité Consommables' },
  { id: 'depenses_pm',  label: 'Dépenses Maintenance'     },
  { id: 'maintenance',  label: 'Planification Maintenance' },
  { id: 'saisie',       label: '✎ Saisie Manuelle'        },
];

// ── Main Component ────────────────────────────────────────────────────────────
const DrillDashboard = ({ drills, onSelectDrill, onDrillsChange }) => {
  const [drillsData, setDrillsData] = useState(() => initDrillsData(drills));

  // Resync when drills prop changes (first load or after manual save)
  useEffect(() => {
    setDrillsData(initDrillsData(drills));
  }, [drills]);

  const [activeTab,       setActiveTab]       = useState('dashboard');
  const [consumablesData, setConsumablesData] = useState([]);
  const [statusFilter,    setStatusFilter]    = useState('TOUS');
  const [holes,           setHoles]           = useState([]);
  const [planMeta,        setPlanMeta]        = useState(null);
  const [planLoading,     setPlanLoading]     = useState(false);
  const [selectedHole,    setSelectedHole]    = useState(null);

  // ── Live telemetry simulation ───────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      setDrillsData(prev => prev.map(d => {
        if (d.status !== 'EN FORAGE') return d;
        const t = d.telemetry;
        return {
          ...d,
          metersShift: d.metersShift + Math.random() * 0.006,
          telemetry: {
            rotation_pressure: clamp(t.rotation_pressure + rnd(10), 75,  165),
            hyd_temp:          clamp(t.hyd_temp          + rnd(1.5),65,  100),
            depth:             t.depth + Math.random() * 0.08,
            rop:               clamp(t.rop               + rnd(0.5), 0.5, 9),
            wob:               clamp(t.wob               + rnd(0.3), 3,   16),
            rpm:               clamp(t.rpm               + rnd(3),  38,   92),
            fuel_level:        Math.max(0, t.fuel_level - 0.001),
          },
        };
      }));
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // ── Drilling Plan API ────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab !== 'plan' || planMeta !== null) return;
    setPlanLoading(true);
    apiFetch('/api/drilling-plan')
      .then(plan => {
        setPlanMeta({ version: plan.version, updatedAt: plan.updatedAt });
        // Flatten blocks → holes, computing row/col from index
        const flatHoles = [];
        (plan.blocks || []).forEach(block => {
          const cols = block.cols || 5;
          (block.holes || []).forEach((h, i) => {
            flatHoles.push({
              id:            h.id,
              row:           Math.floor(i / cols),
              col:           i % cols,
              plannedDepth:  h.planDepth  ?? 0,
              actualDepth:   h.actDepth   ?? 0,
              azimuth:       h.azimuth    ?? 0,
              inclination:   h.inclination ?? 90,
              status:        h.status,
              machine:       h.drillId    || null,
              operator:      h.operatorName || null,
              startTime:     h.startDate  || null,
              endTime:       h.endDate    || null,
              block:         block.id,
            });
          });
        });
        setHoles(flatHoles);
      })
      .catch(() => { setPlanMeta({}); setHoles([]); })
      .finally(() => setPlanLoading(false));
  }, [activeTab]);

  // ── Consumables API ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab === 'consumables') loadConsumables();
  }, [activeTab]);

  const loadConsumables = async () => {
    try {
      const today      = new Date().toISOString().split('T')[0];
      const twoYrsAgo  = new Date(Date.now() - 730 * 86400000).toISOString().split('T')[0];
      const data = await apiFetch(`/api/consumables-cost-summary?dateFrom=${twoYrsAgo}&dateTo=${today}`);
      setConsumablesData(Array.isArray(data) ? data : []);
    } catch {
      setConsumablesData([]);
    }
  };

  // ── Derived KPIs ────────────────────────────────────────────────────────────
  const active       = drillsData.filter(d => d.status === 'EN FORAGE').length;
  const totalM       = drillsData.reduce((s, d) => s + d.metersShift, 0).toFixed(1);
  const avail        = Math.round((drillsData.filter(d => d.status !== 'EN MAINTENANCE').length / drillsData.length) * 100);
  const alertCount   = drillsData.filter(d => d.telemetry.hyd_temp > 90 || d.maintenance < 48).length;
  const completedH   = holes.filter(h => h.status === 'COMPLETÉ').length;
  const inProgH      = holes.filter(h => h.status === 'EN COURS').length;
  const totalMHoles  = holes.reduce((s, h) => s + h.actualDepth, 0).toFixed(1);
  const pctBloc      = holes.length ? Math.round((completedH / holes.length) * 100) : 0;
  const filtered     = statusFilter === 'TOUS' ? drillsData : drillsData.filter(d => d.status === statusFilter);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="bg-mine-bg text-slate-900 min-h-screen">

      {/* KPI Bar */}
      <div className="bg-mine-panel border-b border-mine-border px-6 py-4">
        <div className="flex gap-3 overflow-x-auto">
          <KPI label="Machines Actives"    value={`${active}/${drillsData.length}`} sub="En forage"           highlight />
          <KPI label="Mètres Shift"        value={totalM}  unit="m"   sub="Tous équipements"             />
          <KPI label="Disponibilité"       value={avail}   unit="%"   sub="Machines opérationnelles"     />
          <KPI label="Alertes"             value={alertCount}          sub={alertCount ? 'Attention !' : 'Aucune alerte'} />
          <KPI label="Avancement Bloc"     value={`${completedH}/${holes.length}`} sub={`${pctBloc}% complété`} />
        </div>
      </div>

      {/* Tab bar */}
      <div className="bg-mine-panel border-b border-mine-border px-6">
        <div className="flex gap-0">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-3 text-sm font-semibold border-b-2 transition-all ${
                activeTab === tab.id
                  ? 'text-komatsu-dark border-komatsu-yellow bg-mine-bg/50'
                  : 'text-slate-600 border-transparent hover:text-slate-700 hover:border-mine-border-hi'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6">

        {/* ═══════════════════ TABLEAU DE BORD ═══════════════════ */}
        {activeTab === 'dashboard' && (
          <>
            <div className="flex flex-wrap justify-between items-center gap-3 mb-5">
              <h2 className="text-xl font-bold">Surveillance — Toutes les Foreuses</h2>
              <div className="flex gap-2 flex-wrap">
                {['TOUS', 'EN FORAGE', 'EN PAUSE', 'EN MAINTENANCE'].map(s => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
                      statusFilter === s
                        ? 'bg-komatsu-yellow text-black border-komatsu-yellow'
                        : 'bg-mine-card border-mine-border text-slate-600 hover:border-mine-border-hi hover:text-slate-900'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map(d => {
                const hot   = d.telemetry.hyd_temp > 90;
                const soon  = d.maintenance < 48;
                const fuelC = d.telemetry.fuel_level < 20 ? 'bg-drill-red' : d.telemetry.fuel_level < 45 ? 'bg-drill-amber' : 'bg-komatsu-yellow';

                return (
                  <div
                    key={d.id}
                    onClick={() => onSelectDrill(d.id)}
                    className="bg-mine-card border border-mine-border rounded-xl p-5 cursor-pointer hover:border-komatsu-yellow hover:shadow-xl hover:shadow-komatsu-yellow/10 transition-all hover:-translate-y-0.5 group"
                  >
                    {/* Header */}
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className="font-black text-base group-hover:text-komatsu-dark transition-colors">{d.id}</h3>
                        <p className="text-slate-500 text-xs mt-0.5">{d.location}</p>
                        {d.model && <p className="text-slate-600 text-[11px]">{d.model}</p>}
                      </div>
                      <div className="text-right flex flex-col items-end gap-1">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${STATUS_BADGE[d.status] || STATUS_BADGE['HORS SERVICE']}`}>
                          {d.status}
                        </span>
                        {d.operator && d.operator !== '—' && (
                          <span className="text-slate-500 text-[11px]">👷 {d.operator}</span>
                        )}
                      </div>
                    </div>

                    {/* 3 main metrics */}
                    <div className="grid grid-cols-3 gap-2 mb-4">
                      {[
                        { lbl: 'Profondeur', val: `${d.telemetry.depth.toFixed(1)}`, unit: 'm',   cls: 'text-komatsu-dark' },
                        { lbl: 'ROP',        val: d.status === 'EN FORAGE' ? d.telemetry.rop.toFixed(1) : '—', unit: d.status === 'EN FORAGE' ? 'm/h' : '', cls: d.status === 'EN FORAGE' ? 'text-drill-green' : 'text-slate-500' },
                        { lbl: 'Temp.',      val: `${Math.round(d.telemetry.hyd_temp)}`, unit: '°C', cls: hot ? 'text-drill-red' : 'text-green-400' },
                      ].map(({ lbl, val, unit, cls }) => (
                        <div key={lbl} className="bg-mine-panel rounded-lg p-2 text-center">
                          <p className="text-slate-600 text-[10px] mb-0.5">{lbl}</p>
                          <p className={`text-lg font-black font-mono leading-none ${cls}`}>
                            {val}<span className="text-[10px] text-slate-500 ml-0.5">{unit}</span>
                          </p>
                        </div>
                      ))}
                    </div>

                    {/* Secondary params */}
                    <div className="border-t border-mine-border/40 pt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                      <Row k="Pression"  v={`${Math.round(d.telemetry.rotation_pressure)} bar`} />
                      <Row k="WOB"       v={`${d.telemetry.wob.toFixed(1)} t`} />
                      <Row k="RPM"       v={`${Math.round(d.telemetry.rpm)}`} />
                      <Row k="Révision"  v={`${d.maintenance}h`} warn={soon} />
                    </div>

                    {/* Fuel bar */}
                    <div className="mt-3">
                      <div className="flex justify-between text-[11px] text-slate-500 mb-1">
                        <span>Carburant</span>
                        <span className={d.telemetry.fuel_level < 20 ? 'text-drill-red font-bold' : ''}>{Math.round(d.telemetry.fuel_level)}%</span>
                      </div>
                      <div className="w-full bg-mine-panel h-1.5 rounded-full overflow-hidden">
                        <div className={`h-1.5 rounded-full transition-all duration-700 ${fuelC}`} style={{ width: `${d.telemetry.fuel_level}%` }} />
                      </div>
                    </div>

                    {/* Alert badges */}
                    {(hot || soon) && (
                      <div className="mt-3 flex gap-2 flex-wrap">
                        {hot  && <Badge color="red">⚠ Temp. élevée</Badge>}
                        {soon && <Badge color="orange">🔧 Révision proche</Badge>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ═══════════════════ PLAN DE FORAGE ═══════════════════ */}
        {activeTab === 'plan' && (
          <>
            {planLoading && (
              <div className="flex items-center justify-center py-20 text-slate-500 text-sm animate-pulse">
                Chargement du plan de forage…
              </div>
            )}
            {!planLoading && holes.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-500">
                <p className="text-4xl">📋</p>
                <p className="text-sm font-semibold">Aucun plan de forage défini.</p>
                <p className="text-xs">Créez un plan via la Plateforme de Gestion.</p>
              </div>
            )}
            {!planLoading && holes.length > 0 && (
            <>
            <div className="flex flex-wrap justify-between items-center gap-3 mb-5">
              <h2 className="text-xl font-bold">Plan de Forage — Bloc Alpha-1</h2>
              <div className="flex gap-4 text-sm">
                {Object.entries(HOLE_STATUS).map(([s, c]) => (
                  <span key={s} className="flex items-center gap-1.5 text-slate-600 text-xs">
                    <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: c }} />
                    {s}
                  </span>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
              {/* SVG patron */}
              <div className="lg:col-span-2 bg-mine-card border border-mine-border rounded-xl p-5">
                <p className="text-[11px] uppercase tracking-widest text-slate-500 mb-3">Visualisation du Patron (Espacement 4m × 4m)</p>
                <div className="flex justify-center">
                  <svg viewBox="0 0 320 250" className="w-full max-w-md">
                    {/* Grid lines */}
                    {[...Array(6)].map((_, i) => <line key={`v${i}`} x1={50+i*48} y1={15} x2={50+i*48} y2={235} stroke="#CBD5E1" strokeWidth="0.5" strokeDasharray="3,3" />)}
                    {[...Array(5)].map((_, i) => <line key={`h${i}`} x1={20}      y1={35+i*46} x2={300} y2={35+i*46} stroke="#CBD5E1" strokeWidth="0.5" strokeDasharray="3,3" />)}
                    {/* Labels */}
                    <text x={295} y={13} fill="#475569" fontSize={8} textAnchor="middle">N↑</text>
                    <line x1={25} y1={242} x2={73} y2={242} stroke="#94A3B8" strokeWidth={1} />
                    <text x={49} y={248} fill="#475569" fontSize={7} textAnchor="middle">4 m</text>
                    {/* Holes */}
                    {holes.map(h => {
                      const cx = 74 + h.col * 48;
                      const cy = 58 + h.row * 46;
                      const fill = HOLE_STATUS[h.status];
                      const sel  = selectedHole?.id === h.id;
                      return (
                        <g key={h.id} onClick={() => setSelectedHole(h)} style={{ cursor: 'pointer' }}>
                          <circle cx={cx} cy={cy} r={sel ? 15 : 13} fill={fill} opacity={0.15} />
                          <circle cx={cx} cy={cy} r={sel ? 11 : 9}  fill={fill} stroke={sel ? '#FFCD00' : fill} strokeWidth={sel ? 2 : 0.8} />
                          <text x={cx} y={cy+4} textAnchor="middle" fill={h.status === 'PLANIFIÉ' ? '#94A3B8' : '#000'} fontSize={6.5} fontWeight="bold">
                            {h.id.replace('T-', '')}
                          </text>
                          {h.status === 'EN COURS' && (
                            <circle cx={cx} cy={cy} r={13} fill="none" stroke="#FFCD00" strokeWidth={1.5} strokeDasharray="4,2" opacity={0.7}>
                              <animateTransform attributeName="transform" type="rotate" from={`0 ${cx} ${cy}`} to={`360 ${cx} ${cy}`} dur="3s" repeatCount="indefinite" />
                            </circle>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>

              {/* Detail panel */}
              <div className="bg-mine-card border border-mine-border rounded-xl p-5">
                <p className="text-[11px] uppercase tracking-widest text-slate-500 mb-3">
                  {selectedHole ? `Détails — ${selectedHole.id}` : 'Statistiques du Bloc'}
                </p>
                {selectedHole ? (
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2 mb-4">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: HOLE_STATUS[selectedHole.status] }} />
                      <span className={`text-sm font-bold ${selectedHole.status === 'COMPLETÉ' ? 'text-drill-green' : selectedHole.status === 'EN COURS' ? 'text-komatsu-dark' : 'text-slate-600'}`}>
                        {selectedHole.status}
                      </span>
                    </div>
                    {[
                      ['Prof. planifiée', `${selectedHole.plannedDepth.toFixed(1)} m`],
                      ['Prof. actuelle',  selectedHole.actualDepth > 0 ? `${selectedHole.actualDepth.toFixed(1)} m` : '—'],
                      ['Azimut',          `${selectedHole.azimuth}°`],
                      ['Inclinaison',     `${selectedHole.inclination}°`],
                      ['Machine',         selectedHole.machine   || '—'],
                      ['Opérateur',       selectedHole.operator  || '—'],
                      ['Début',           selectedHole.startTime || '—'],
                      ['Fin',             selectedHole.endTime   || '—'],
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between text-sm border-b border-mine-border/30 pb-1.5">
                        <span className="text-slate-500">{k}</span>
                        <span className="text-slate-900 font-mono text-xs">{v}</span>
                      </div>
                    ))}
                    <button onClick={() => setSelectedHole(null)} className="mt-3 w-full text-xs text-slate-500 hover:text-komatsu-dark border border-mine-border hover:border-mine-border-hi rounded-lg py-1.5 transition-all">
                      ← Retour aux stats
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {[
                      ['Trous planifiés',  holes.length,                                   'text-slate-900'],
                      ['Complétés',        completedH,                                     'text-drill-green'],
                      ['En cours',         inProgH,                                        'text-komatsu-dark'],
                      ['Restants',         holes.length - completedH - inProgH,            'text-slate-600'],
                      ['Mètres forés',     `${totalMHoles} m`,                             'text-komatsu-dark'],
                      ['Avancement',       `${pctBloc}%`, pctBloc > 70 ? 'text-drill-green' : pctBloc > 40 ? 'text-komatsu-dark' : 'text-drill-red'],
                    ].map(([k, v, c]) => (
                      <div key={k} className="flex justify-between text-sm border-b border-mine-border/30 pb-1.5">
                        <span className="text-slate-500">{k}</span>
                        <span className={`font-black font-mono ${c}`}>{v}</span>
                      </div>
                    ))}
                    <div className="mt-4">
                      <div className="flex justify-between text-[11px] text-slate-500 mb-1"><span>Progression</span><span>{pctBloc}%</span></div>
                      <div className="w-full bg-mine-panel rounded-full h-3 overflow-hidden">
                        <div className="h-3 rounded-full bg-gradient-to-r from-komatsu-yellow to-drill-green transition-all" style={{ width: `${pctBloc}%` }} />
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-600 italic mt-1">Cliquez sur un trou pour les détails</p>
                  </div>
                )}
              </div>
            </div>

            {/* Holes table */}
            <div className="bg-mine-card border border-mine-border rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-mine-border bg-mine-panel flex justify-between items-center">
                <h3 className="font-semibold text-sm">Journal des Trous — Bloc Alpha-1</h3>
                <span className="text-xs text-slate-500">{completedH} / {holes.length} complétés</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-mine-border text-[11px] text-slate-500 uppercase tracking-wider bg-mine-panel/60">
                      {['N° Trou','Statut','Prof. Plan. (m)','Prof. Act. (m)','Azimut','Incl.','Machine','Opérateur','Début','Fin'].map(h => (
                        <th key={h} className="px-4 py-2 text-left whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {holes.map((h, idx) => (
                      <tr
                        key={h.id}
                        onClick={() => setSelectedHole(h)}
                        className={`border-b border-mine-border/25 hover:bg-mine-card2 cursor-pointer transition-colors ${idx % 2 ? 'bg-mine-panel/25' : ''}`}
                      >
                        <td className="px-4 py-2 font-mono text-komatsu-dark font-semibold">{h.id}</td>
                        <td className="px-4 py-2">
                          <span className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: HOLE_STATUS[h.status] }}>
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: HOLE_STATUS[h.status] }} />
                            {h.status}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono text-slate-700">{h.plannedDepth.toFixed(1)}</td>
                        <td className="px-4 py-2 font-mono">
                          <span className={h.actualDepth > 0 ? (Math.abs(h.actualDepth - h.plannedDepth) > 0.5 ? 'text-drill-amber' : 'text-drill-green') : 'text-slate-600'}>
                            {h.actualDepth > 0 ? h.actualDepth.toFixed(1) : '—'}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono text-slate-500">{h.azimuth}°</td>
                        <td className="px-4 py-2 font-mono text-slate-500">{h.inclination}°</td>
                        <td className="px-4 py-2 text-slate-600 text-xs">{h.machine   || '—'}</td>
                        <td className="px-4 py-2 text-slate-600 text-xs">{h.operator  || '—'}</td>
                        <td className="px-4 py-2 font-mono text-slate-500 text-xs">{h.startTime || '—'}</td>
                        <td className="px-4 py-2 font-mono text-slate-500 text-xs">{h.endTime   || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            </>
            )}
          </>
        )}

        {/* ═══════════════════ CONSOMMABLES ═══════════════════ */}
        {activeTab === 'consumables' && (
          <>
            <h2 className="text-xl font-bold mb-5">Consommables & Coûts — 7 Derniers Jours</h2>
            {consumablesData.length === 0 ? (
              <div className="bg-mine-card border border-mine-border rounded-xl p-14 text-center">
                <p className="text-5xl mb-4">📊</p>
                <p className="text-slate-600 font-semibold">Aucune donnée disponible</p>
                <p className="text-slate-600 text-sm mt-2">Connectez-vous au serveur pour accéder aux données de consommables</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {consumablesData.map(item => {
                  const consumables = safeParseConsumables(item.consumables);
                  return (
                    <div key={`${item.machineId}-${item.date}`} className="bg-mine-card border border-mine-border rounded-xl p-5">
                      <div className="flex justify-between items-start mb-4">
                        <h3 className="font-bold text-komatsu-dark">{item.machineId}</h3>
                        <span className="text-slate-500 text-xs">{item.date}</span>
                      </div>
                      <div className="space-y-2 text-sm mb-4">
                        <div className="flex justify-between"><span className="text-slate-600">Production</span>   <span className="font-mono text-drill-green font-bold">{item.production?.toFixed(1) ?? '—'} m</span></div>
                        <div className="flex justify-between"><span className="text-slate-600">Coût total</span>   <span className="font-mono text-drill-red   font-bold">{item.totalCost?.toFixed(2)   ?? '—'} {item.currency}</span></div>
                        <div className="flex justify-between"><span className="text-slate-600">Coût / mètre</span><span className="font-mono text-komatsu-dark font-bold">{item.costPerMeter?.toFixed(2) ?? '—'} {item.currency}</span></div>
                      </div>
                      {consumables.length > 0 && (
                        <details className="group">
                          <summary className="text-xs text-slate-500 hover:text-komatsu-dark cursor-pointer transition-colors">
                            ▸ Détails ({consumables.length} postes)
                          </summary>
                          <ul className="mt-2 space-y-1 border-t border-mine-border pt-2">
                            {consumables.map((c, i) => (
                              <li key={i} className="flex justify-between text-xs text-slate-600">
                                <span>{c.consumableName}</span>
                                <span className="font-mono text-komatsu-dark">{c.totalCost?.toFixed(2)} {item.currency}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ═══════════════ RENTABILITÉ CONSOMMABLES ═══════════════ */}
        {activeTab === 'rentabilite' && (
          <>
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-xl font-bold">Rentabilité des Consommables</h2>
              <p className="text-slate-500 text-sm">Analyse rendement réel vs vie planifiée · économies et pertes</p>
            </div>
            <RentabiliteConsommables />
          </>
        )}

        {/* ═══════════════════ DÉPENSES PM ═══════════════════ */}
        {activeTab === 'depenses_pm' && (
          <>
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-xl font-bold">Dépenses Maintenance — PM Effectués</h2>
              <p className="text-slate-500 text-sm">Coûts directs + impact production · export fiche par PM</p>
            </div>
            <DepensesMaintenance />
          </>
        )}

        {/* ═══════════════════ MAINTENANCE ═══════════════════ */}
        {activeTab === 'maintenance' && (
          <>
            <h2 className="text-xl font-bold mb-5">Planification de la Maintenance</h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {drillsData.map(d => {
                const urg = d.maintenance < 24 ? 'red' : d.maintenance < 72 ? 'orange' : 'green';
                const urgLabel = { red: 'URGENT', orange: 'BIENTÔT', green: 'OK' }[urg];
                const urgCls   = { red: 'text-drill-red border-drill-red', orange: 'text-cat-orange border-cat-orange', green: 'text-drill-green border-mine-border' }[urg];
                const barCls   = { red: 'bg-drill-red', orange: 'bg-cat-orange', green: 'bg-drill-green' }[urg];
                const pct = Math.min(100, Math.round((d.maintenance / 250) * 100));

                return (
                  <div key={d.id} className={`bg-mine-card border ${urg === 'red' ? 'border-drill-red/60' : urg === 'orange' ? 'border-cat-orange/60' : 'border-mine-border'} rounded-xl p-5`}>
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3 className="font-bold text-slate-900">{d.id}</h3>
                        <p className="text-slate-500 text-xs">{d.location}</p>
                        {d.model && <p className="text-slate-600 text-xs">{d.model}</p>}
                      </div>
                      <div className="text-right">
                        <span className={`text-xs font-black ${urgCls.split(' ')[0]}`}>{urgLabel}</span>
                        <p className={`text-3xl font-black font-mono ${urgCls.split(' ')[0]}`}>{d.maintenance}h</p>
                        <p className="text-slate-600 text-xs">avant révision</p>
                      </div>
                    </div>
                    <div className="w-full bg-mine-panel h-2.5 rounded-full overflow-hidden mb-4">
                      <div className={`h-2.5 rounded-full ${barCls}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      {[['Huile moteur', 'À jour'], ['Filtres air', d.maintenance < 60 ? 'Vérifier' : 'À jour'], ['Courroies', d.maintenance < 40 ? 'Vérifier' : 'OK']].map(([item, stat]) => (
                        <div key={item} className="bg-mine-panel rounded-lg p-2 text-center">
                          <p className="text-slate-500 mb-0.5">{item}</p>
                          <p className={`font-bold ${stat === 'Vérifier' ? 'text-cat-orange' : 'text-drill-green'}`}>{stat}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ═══════════════════ SAISIE MANUELLE ═══════════════════ */}
        {activeTab === 'saisie' && (
          <>
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-xl font-bold">Saisie Manuelle des Données</h2>
              <p className="text-slate-500 text-sm">Télémétrie · Production · Consommables · Plan de forage</p>
            </div>
            <SaisieManuelle drills={drills} onDrillsChange={onDrillsChange} />
          </>
        )}

      </div>
    </div>
  );
};

const Row = ({ k, v, warn }) => (
  <div className="flex justify-between">
    <span className={warn ? 'text-cat-orange' : 'text-slate-500'}>{k}</span>
    <span className={`font-mono font-semibold ${warn ? 'text-cat-orange' : 'text-slate-700'}`}>{v}</span>
  </div>
);

const Badge = ({ color, children }) => {
  const cls = color === 'red' ? 'bg-drill-red/15 text-drill-red border-drill-red/30' : 'bg-cat-orange/15 text-cat-orange border-cat-orange/30';
  return <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${cls}`}>{children}</span>;
};

export default DrillDashboard;
