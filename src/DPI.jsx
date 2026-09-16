import React, { useState, useEffect, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

// ── Mock data ─────────────────────────────────────────────────────────────────
const genRopHistory = () => {
  let rop = 4.0;
  return Array.from({ length: 24 }, (_, i) => {
    rop = clamp(rop + (Math.random() * 1.2 - 0.6), 0.5, 9.5);
    const h = new Date(Date.now() - (23 - i) * 3600000);
    return { time: `${String(h.getHours()).padStart(2, '0')}h`, rop: parseFloat(rop.toFixed(2)) };
  });
};

const INITIAL_HOLE_LOG = [
  { id: 'T-001', depth: 8.5, start: '07:12', end: '08:04', dur: '52 min', rop: 5.2, status: 'OK'       },
  { id: 'T-002', depth: 8.5, start: '08:10', end: '09:05', dur: '55 min', rop: 4.9, status: 'OK'       },
  { id: 'T-003', depth: 8.3, start: '09:12', end: '10:02', dur: '50 min', rop: 5.5, status: 'OK'       },
  { id: 'T-004', depth: 5.1, start: '10:15', end: null,    dur: '—',      rop: 3.8, status: 'EN COURS' },
];

const BIT_INFO = {
  type:     'DTH QL60',
  diam:     '127 mm',
  serial:   'BIT-2024-047',
  meters:   342.5,
  lifespan: 800,
};

// ── Gauge component ───────────────────────────────────────────────────────────
const Gauge = ({ label, value, unit, min, max, warnAt, critAt, fmt }) => {
  const pct   = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  const isCrit = critAt && value >= critAt;
  const isWarn = warnAt && value >= warnAt;
  const barC  = isCrit ? 'bg-drill-red' : isWarn ? 'bg-cat-orange' : 'bg-komatsu-yellow';
  const valC  = isCrit ? 'text-drill-red' : isWarn ? 'text-cat-orange' : 'text-slate-900';

  return (
    <div className="bg-mine-card border border-mine-border rounded-xl p-4 flex flex-col gap-2">
      <p className="text-[10px] uppercase tracking-widest text-slate-500">{label}</p>
      <p className={`text-2xl font-black font-mono leading-none ${valC}`}>
        {fmt ? fmt(value) : Math.round(value)}
        <span className="text-xs font-semibold text-slate-500 ml-1">{unit}</span>
      </p>
      <div className="relative w-full bg-mine-panel h-1.5 rounded-full overflow-hidden">
        <div className={`absolute inset-y-0 left-0 rounded-full transition-all duration-700 ${barC}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-slate-600">
        <span>{min}</span>
        {warnAt && <span className="text-slate-500">⚠ {warnAt}</span>}
        <span>{max}</span>
      </div>
    </div>
  );
};

// ── Metric card ───────────────────────────────────────────────────────────────
const MetricCard = ({ label, value, unit, color = 'text-slate-900' }) => (
  <div className="bg-mine-card border border-mine-border rounded-xl p-4 text-center">
    <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">{label}</p>
    <p className={`text-3xl font-black font-mono leading-none ${color}`}>
      {value}<span className="text-base font-semibold text-slate-500 ml-1">{unit}</span>
    </p>
  </div>
);

// ── Main component ────────────────────────────────────────────────────────────
const DrillMonitor = ({ machineId, drills }) => {
  const drill = drills?.find(d => d.id === machineId) ?? { id: machineId, location: 'Site A', status: 'EN FORAGE', operator: 'J. Tremblay', model: 'Sandvik DX800' };

  const [tel, setTel] = useState({
    rotation_pressure:  125,
    percussion_pressure: 185,
    feed_pressure:       42,
    wob:                 8.5,
    rpm:                 65,
    air_flow:            320,
    hyd_temp:            76,
    depth:               45.2,
    rop:                 4.2,
    fuel_level:          72,
  });

  const [chartData] = useState(genRopHistory);
  const [holeLog]   = useState(INITIAL_HOLE_LOG);
  const [alerts, setAlerts] = useState([]);

  const shiftStart  = useRef(new Date(Date.now() - 4.5 * 3600000));
  const shiftMeters = useRef(34.8);

  // Live simulation
  useEffect(() => {
    const id = setInterval(() => {
      setTel(prev => {
        const next = {
          rotation_pressure:   clamp(prev.rotation_pressure   + rnd(8),   75,  165),
          percussion_pressure: clamp(prev.percussion_pressure + rnd(6),  140,  225),
          feed_pressure:       clamp(prev.feed_pressure       + rnd(2.5), 20,   72),
          wob:                 clamp(prev.wob                 + rnd(0.3),  3,   16),
          rpm:                 clamp(prev.rpm                 + rnd(3),   38,   92),
          air_flow:            clamp(prev.air_flow            + rnd(15), 180,  510),
          hyd_temp:            clamp(prev.hyd_temp            + rnd(0.8), 62,  102),
          depth:               prev.depth + Math.random() * 0.07,
          rop:                 clamp(prev.rop                 + rnd(0.4),  0.5,  9.5),
          fuel_level:          Math.max(0, prev.fuel_level - 0.001),
        };
        shiftMeters.current += Math.random() * 0.005;

        // Alert generation
        const a = [];
        if (next.hyd_temp       >= 95)  a.push({ id: 'tc',  lvl: 'critical', msg: `Temp. hydraulique CRITIQUE : ${Math.round(next.hyd_temp)} °C` });
        else if (next.hyd_temp  >= 86)  a.push({ id: 'tw',  lvl: 'warning',  msg: `Temp. hydraulique élevée : ${Math.round(next.hyd_temp)} °C` });
        if (next.rotation_pressure >= 155) a.push({ id: 'pw', lvl: 'warning', msg: `Pression rotation élevée : ${Math.round(next.rotation_pressure)} bar` });
        if (next.fuel_level       <  18)  a.push({ id: 'fw', lvl: 'warning', msg: `Carburant bas : ${Math.round(next.fuel_level)} %` });
        setAlerts(a);

        return next;
      });
    }, 2000);
    return () => clearInterval(id);
  }, []);

  const shiftH    = ((Date.now() - shiftStart.current.getTime()) / 3600000).toFixed(1);
  const efficiency = Math.min(99, Math.round((shiftMeters.current / (parseFloat(shiftH) * 6)) * 100));
  const completed  = holeLog.filter(h => h.status === 'OK').length;
  const bitWear    = Math.round((BIT_INFO.meters / BIT_INFO.lifespan) * 100);

  const statusCls = {
    'EN FORAGE':      'bg-drill-green/20 text-drill-green border-drill-green/40',
    'EN PAUSE':       'bg-komatsu-yellow/20 text-komatsu-dark border-komatsu-yellow/40',
    'EN MAINTENANCE': 'bg-drill-red/20 text-drill-red border-drill-red/40',
  }[drill.status] ?? 'bg-slate-600/20 text-slate-600 border-slate-600/40';

  return (
    <div className="bg-mine-bg text-slate-900 min-h-screen">

      {/* ── Machine header ──────────────────────────────────── */}
      <div className="bg-mine-panel border-b border-mine-border px-6 py-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-2xl font-black text-komatsu-dark tracking-widest">{machineId}</h1>
              <p className="text-slate-600 text-sm">{drill.location}{drill.model ? ` — ${drill.model}` : ''}</p>
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-bold border ${statusCls}`}>{drill.status}</span>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            {[
              ['Opérateur', `👷 ${drill.operator ?? 'N/D'}`],
              ['Début shift', shiftStart.current.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })],
              ['Durée',       `${shiftH} h`],
            ].map(([lbl, val]) => (
              <div key={lbl} className="bg-mine-card border border-mine-border rounded-lg px-3 py-2 min-w-[100px]">
                <p className="text-slate-500 text-[10px]">{lbl}</p>
                <p className="text-slate-900 font-semibold text-sm">{val}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">

        {/* ── Alerts ─────────────────────────────────────────── */}
        {alerts.length > 0 && (
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border text-sm font-semibold ${
                a.lvl === 'critical'
                  ? 'bg-drill-red/15 border-drill-red/40 text-drill-red'
                  : 'bg-cat-orange/15 border-cat-orange/40 text-cat-orange'
              }`}>
                <span>{a.lvl === 'critical' ? '🔴' : '🟡'}</span>
                <span>{a.msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── Shift KPIs ─────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="Profondeur Actuelle" value={tel.depth.toFixed(1)}         unit="m"     color="text-komatsu-dark" />
          <MetricCard label="Mètres / Shift"      value={shiftMeters.current.toFixed(1)} unit="m"   color="text-drill-green"   />
          <MetricCard label="Trous Complétés"     value={completed}                     unit="trous"                            />
          <MetricCard label="ROP Actuel"           value={tel.rop.toFixed(1)}            unit="m/h"  color="text-drill-green"   />
        </div>

        {/* ── Engineering parameters ─────────────────────────── */}
        <div>
          <p className="text-[11px] uppercase tracking-widest text-slate-500 mb-3">Paramètres de Forage — Temps Réel</p>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <Gauge label="Pression Rotation"     value={tel.rotation_pressure}   unit="bar"    min={0} max={200} warnAt={140} critAt={158} />
            <Gauge label="Pression Percussion"   value={tel.percussion_pressure} unit="bar"    min={0} max={250} warnAt={200} critAt={220} />
            <Gauge label="Pression Avance"       value={tel.feed_pressure}       unit="bar"    min={0} max={100} warnAt={60}  critAt={75}  />
            <Gauge label="Poids sur Outil (WOB)" value={tel.wob}                 unit="t"      min={0} max={20}  warnAt={12}  critAt={16}  fmt={v => v.toFixed(1)} />
            <Gauge label="Rotation"              value={tel.rpm}                 unit="tr/min" min={0} max={120} warnAt={85}  critAt={100} />
            <Gauge label="Temp. Hydraulique"     value={tel.hyd_temp}            unit="°C"     min={0} max={110} warnAt={86}  critAt={95}  />
          </div>
        </div>

        {/* ── Hole log + Trépan + Efficacité ─────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* Hole log */}
          <div className="lg:col-span-2 bg-mine-card border border-mine-border rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-mine-border bg-mine-panel flex justify-between items-center">
              <h3 className="font-semibold text-sm">Journal du Shift — Trous Forés</h3>
              <span className="text-xs text-slate-500">{completed} complétés / {holeLog.length} total</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-mine-border text-[11px] text-slate-500 uppercase tracking-wider bg-mine-panel/50">
                    {['Trou', 'Prof. (m)', 'Début', 'Fin', 'Durée', 'ROP moy.', 'Statut'].map(h => (
                      <th key={h} className="px-4 py-2 text-left whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {holeLog.map((h, i) => (
                    <tr key={h.id} className={`border-b border-mine-border/25 ${i % 2 ? 'bg-mine-panel/20' : ''}`}>
                      <td className="px-4 py-2.5 font-mono text-komatsu-dark font-semibold">{h.id}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-900">{h.depth}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-600">{h.start}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-600">{h.end ?? '—'}</td>
                      <td className="px-4 py-2.5 text-slate-600">{h.dur}</td>
                      <td className="px-4 py-2.5 font-mono text-drill-green">{h.rop} m/h</td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                          h.status === 'OK'       ? 'bg-drill-green/20 text-drill-green'     :
                          h.status === 'EN COURS' ? 'bg-komatsu-yellow/20 text-komatsu-dark' :
                                                    'bg-drill-red/20 text-drill-red'
                        }`}>{h.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Trépan + Efficacité */}
          <div className="space-y-4">

            {/* Trépan */}
            <div className="bg-mine-card border border-mine-border rounded-xl p-4">
              <p className="text-[11px] uppercase tracking-widest text-slate-500 mb-3">Trépan Actuel</p>
              <div className="space-y-2.5 text-sm">
                {[
                  ['Type',            BIT_INFO.type],
                  ['Diamètre',        BIT_INFO.diam],
                  ['N° Série',        BIT_INFO.serial],
                  ['Mètres forés',    `${BIT_INFO.meters} m`],
                  ['Durée vie est.',  `${BIT_INFO.lifespan} m`],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between border-b border-mine-border/30 pb-1.5">
                    <span className="text-slate-500">{k}</span>
                    <span className="text-slate-900 font-mono text-xs">{v}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <div className="flex justify-between text-[11px] text-slate-500 mb-1">
                  <span>Usure</span>
                  <span className={bitWear > 75 ? 'text-drill-red font-bold' : bitWear > 50 ? 'text-cat-orange' : 'text-drill-green'}>{bitWear}%</span>
                </div>
                <div className="w-full bg-mine-panel h-2.5 rounded-full overflow-hidden">
                  <div
                    className={`h-2.5 rounded-full transition-all ${bitWear > 75 ? 'bg-drill-red' : bitWear > 50 ? 'bg-cat-orange' : 'bg-drill-green'}`}
                    style={{ width: `${bitWear}%` }}
                  />
                </div>
                {bitWear > 75 && <p className="text-drill-red text-[11px] mt-1 font-semibold">⚠ Remplacement recommandé</p>}
              </div>
            </div>

            {/* Efficacité shift */}
            <div className="bg-mine-card border border-mine-border rounded-xl p-4">
              <p className="text-[11px] uppercase tracking-widest text-slate-500 mb-3">Efficacité du Shift</p>
              <div className="space-y-2.5 text-sm">
                {[
                  ['Durée shift',   `${shiftH} h`,                                'text-slate-900'],
                  ['Mètres forés',  `${shiftMeters.current.toFixed(1)} m`,         'text-slate-900'],
                  ['Carburant',     `${Math.round(tel.fuel_level)} %`,             tel.fuel_level < 20 ? 'text-drill-red font-bold' : 'text-slate-900'],
                  ['Débit d\'air',  `${Math.round(tel.air_flow)} L/min`,           'text-slate-900'],
                  ['Efficacité',    `${efficiency} %`,                             efficiency > 80 ? 'text-drill-green' : efficiency > 55 ? 'text-komatsu-dark' : 'text-drill-red'],
                ].map(([k, v, c]) => (
                  <div key={k} className="flex justify-between border-b border-mine-border/30 pb-1.5">
                    <span className="text-slate-500">{k}</span>
                    <span className={`font-mono font-bold text-xs ${c}`}>{v}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <div className="flex justify-between text-[11px] text-slate-500 mb-1"><span>Efficacité globale</span><span>{efficiency}%</span></div>
                <div className="w-full bg-mine-panel h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-2 rounded-full transition-all ${efficiency > 80 ? 'bg-drill-green' : efficiency > 55 ? 'bg-komatsu-yellow' : 'bg-drill-red'}`}
                    style={{ width: `${efficiency}%` }}
                  />
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* ── ROP Chart ──────────────────────────────────────── */}
        <div className="bg-mine-card border border-mine-border rounded-xl p-5">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
              Vitesse de Pénétration (ROP) — Dernières 24 h
            </h3>
            <span className="text-xs text-slate-500">m/h</span>
          </div>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#D1D9E6" />
                <XAxis dataKey="time" stroke="#94A3B8" tick={{ fontSize: 11, fill: '#475569' }} />
                <YAxis stroke="#94A3B8" tick={{ fontSize: 11, fill: '#475569' }} domain={[0, 10]} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#FFFFFF', border: '1px solid #D1D9E6', borderRadius: '8px', fontSize: '12px' }}
                  labelStyle={{ color: '#475569' }}
                  itemStyle={{ color: '#7A5800' }}
                />
                <ReferenceLine y={3} stroke="#FF6B35" strokeDasharray="4 2" label={{ value: 'Min', fill: '#FF6B35', fontSize: 10, position: 'insideTopLeft' }} />
                <Line type="monotone" dataKey="rop" stroke="#FFCD00" strokeWidth={2.5} dot={false} name="ROP (m/h)" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

      </div>
    </div>
  );
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rnd   = n => Math.random() * n * 2 - n;

export default DrillMonitor;
