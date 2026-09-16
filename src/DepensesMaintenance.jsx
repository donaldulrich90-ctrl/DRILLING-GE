import React, { useState, useMemo } from 'react';

// ── Taux de facturation du forage ($/m) — permet de valoriser la prod. perdue ──
const DRILL_RATE_PER_METER = 28; // CAD$/m (à ajuster selon contrat)

// ── Données PM ────────────────────────────────────────────────────────────────
const PM_EVENTS = [
  {
    id: 'PM-2024-001', machine: 'FOR-2024-001', type: 'PM 250h',
    date: '2024-10-15', hoursAtPM: 252, durationH: 4.5,
    avgRopBeforePM: 4.8, technician: 'R. Bergeron', status: 'COMPLÉTÉ',
    notes: 'RAS. Machine en bon état général.',
    parts: [
      { name: 'Huile moteur 15W-40 (20L)', qty: 1, unitCost: 145 },
      { name: 'Filtre à huile moteur',      qty: 1, unitCost: 38  },
      { name: 'Filtre air primaire',        qty: 1, unitCost: 95  },
      { name: 'Filtre carburant',           qty: 1, unitCost: 42  },
    ],
    laborHours: 4.5, laborRate: 85,
  },
  {
    id: 'PM-2024-002', machine: 'FOR-2024-002', type: 'PM 500h',
    date: '2024-10-22', hoursAtPM: 504, durationH: 8.0,
    avgRopBeforePM: 5.1, technician: 'R. Bergeron', status: 'COMPLÉTÉ',
    notes: 'Remplacement courroie alternateur. Légère usure sur joint rotatif à surveiller.',
    parts: [
      { name: 'Huile moteur 15W-40 (20L)',    qty: 1, unitCost: 145 },
      { name: 'Filtre à huile moteur',         qty: 1, unitCost: 38  },
      { name: 'Filtre air primaire',           qty: 1, unitCost: 95  },
      { name: 'Filtre carburant',              qty: 1, unitCost: 42  },
      { name: 'Huile hydraulique (50L)',        qty: 1, unitCost: 185 },
      { name: 'Filtre hydraulique retour',     qty: 2, unitCost: 68  },
      { name: 'Courroie alternateur',          qty: 1, unitCost: 85  },
    ],
    laborHours: 8.0, laborRate: 85,
  },
  {
    id: 'PM-2024-003', machine: 'FOR-2024-001', type: 'PM 250h',
    date: '2024-11-02', hoursAtPM: 502, durationH: 5.0,
    avgRopBeforePM: 4.6, technician: 'S. Lavoie', status: 'COMPLÉTÉ',
    notes: 'Filtre air encrassé prématurément — conditions très poussiéreuses Site A. Recommandation : inspection filtres toutes les 100h sur ce site.',
    parts: [
      { name: 'Huile moteur 15W-40 (20L)', qty: 1, unitCost: 145 },
      { name: 'Filtre à huile moteur',      qty: 1, unitCost: 38  },
      { name: 'Filtre air primaire',        qty: 2, unitCost: 95  },
      { name: 'Filtre carburant',           qty: 1, unitCost: 42  },
      { name: 'Graisse lithium 10 kg',      qty: 1, unitCost: 55  },
    ],
    laborHours: 5.0, laborRate: 85,
  },
  {
    id: 'PM-2024-004', machine: 'FOR-2024-005', type: 'PM 1000h — Réparation majeure',
    date: '2024-11-08', hoursAtPM: 1008, durationH: 24.0,
    avgRopBeforePM: 3.2, technician: 'R. Bergeron + S. Lavoie', status: 'COMPLÉTÉ',
    notes: 'Remplacement joint rotatif principal et roulement pompe hydraulique. Fuite huile stoppée. Débit d\'air rétabli à 100%.',
    parts: [
      { name: 'Huile moteur 15W-40 (20L)',    qty: 2, unitCost: 145  },
      { name: 'Filtre à huile moteur',         qty: 2, unitCost: 38   },
      { name: 'Filtre air primaire',           qty: 1, unitCost: 95   },
      { name: 'Filtre carburant',              qty: 2, unitCost: 42   },
      { name: 'Huile hydraulique 210L',        qty: 1, unitCost: 680  },
      { name: 'Filtre hydraulique retour',     qty: 4, unitCost: 68   },
      { name: 'Joint rotatif principal',       qty: 1, unitCost: 1250 },
      { name: 'Courroie entraînement',         qty: 2, unitCost: 185  },
      { name: 'Roulement pompe hydraulique',   qty: 1, unitCost: 430  },
    ],
    laborHours: 24.0, laborRate: 85,
  },
  {
    id: 'PM-2024-005', machine: 'FOR-2024-003', type: 'PM 250h',
    date: '2024-11-05', hoursAtPM: 253, durationH: 4.0,
    avgRopBeforePM: 4.2, technician: 'S. Lavoie', status: 'COMPLÉTÉ',
    notes: 'RAS. Graissage complet effectué.',
    parts: [
      { name: 'Huile moteur 15W-40 (20L)', qty: 1, unitCost: 145 },
      { name: 'Filtre à huile moteur',      qty: 1, unitCost: 38  },
      { name: 'Filtre air primaire',        qty: 1, unitCost: 95  },
      { name: 'Filtre carburant',           qty: 1, unitCost: 42  },
      { name: 'Graisse lithium 10 kg',      qty: 1, unitCost: 55  },
    ],
    laborHours: 4.0, laborRate: 85,
  },
  {
    id: 'PM-2024-006', machine: 'FOR-2024-004', type: 'PM 500h',
    date: '2024-11-09', hoursAtPM: 498, durationH: 9.0,
    avgRopBeforePM: 4.9, technician: 'R. Bergeron', status: 'COMPLÉTÉ',
    notes: 'Contrôle complet. Remplacement courroie entraînement préventif.',
    parts: [
      { name: 'Huile moteur 15W-40 (20L)',    qty: 1, unitCost: 145 },
      { name: 'Filtre à huile moteur',         qty: 1, unitCost: 38  },
      { name: 'Filtre air primaire',           qty: 1, unitCost: 95  },
      { name: 'Filtre carburant',              qty: 1, unitCost: 42  },
      { name: 'Huile hydraulique (50L)',        qty: 1, unitCost: 185 },
      { name: 'Filtre hydraulique retour',     qty: 2, unitCost: 68  },
      { name: 'Courroie entraînement',         qty: 1, unitCost: 185 },
      { name: 'Filtre huile de mât',           qty: 1, unitCost: 55  },
    ],
    laborHours: 9.0, laborRate: 85,
  },
];

// ── Calculs PM ─────────────────────────────────────────────────────────────────
const enrichPM = (pm) => {
  const partsCost     = pm.parts.reduce((s, p) => s + p.qty * p.unitCost, 0);
  const laborCost     = pm.laborHours * pm.laborRate;
  const totalCost     = partsCost + laborCost;
  const prodLostM     = pm.durationH * pm.avgRopBeforePM;
  const prodLostValue = prodLostM * DRILL_RATE_PER_METER;
  const grandTotal    = totalCost + prodLostValue;
  return { ...pm, partsCost, laborCost, totalCost, prodLostM, prodLostValue, grandTotal };
};

const ALL_PM = PM_EVENTS.map(enrichPM);

const fmtCAD = (v) => v.toLocaleString('fr-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2 });
const fmtN   = (v, d = 1) => Number(v).toFixed(d);

// ── Impression Fiche PM ────────────────────────────────────────────────────────
const printPM = (pm) => {
  const rows = pm.parts.map(p => `
    <tr>
      <td>${p.name}</td>
      <td style="text-align:center">${p.qty}</td>
      <td style="text-align:right">${fmtCAD(p.unitCost)}</td>
      <td style="text-align:right">${fmtCAD(p.qty * p.unitCost)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <title>Fiche PM — ${pm.id}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; color: #222; padding: 28px; font-size: 13px; }
    .header { border-bottom: 4px solid #FFCD00; padding-bottom: 12px; margin-bottom: 18px; }
    .header h1 { font-size: 22px; font-weight: 900; color: #111; }
    .header .sub { color: #666; font-size: 12px; margin-top: 2px; }
    .badge { display: inline-block; background: #FFCD00; color: #000; font-weight: 700; font-size: 11px; padding: 2px 8px; border-radius: 12px; margin-left: 8px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 20px; }
    .info-box { background: #f8f8f8; border: 1px solid #e0e0e0; border-radius: 6px; padding: 10px; }
    .info-box .lbl { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
    .info-box .val { font-size: 15px; font-weight: 700; color: #111; margin-top: 2px; }
    h2 { font-size: 14px; font-weight: 700; color: #333; margin: 16px 0 8px; border-left: 4px solid #FFCD00; padding-left: 8px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { background: #111; color: #FFCD00; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 7px 10px; text-align: left; }
    td { border-bottom: 1px solid #eee; padding: 7px 10px; font-size: 13px; }
    tr:last-child td { border-bottom: none; }
    .total-row td { font-weight: 700; background: #f0f0f0; border-top: 2px solid #ccc; }
    .summary { border: 2px solid #FFCD00; border-radius: 8px; padding: 14px 16px; margin-top: 16px; }
    .summary .row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #eee; font-size: 13px; }
    .summary .row:last-child { border-bottom: none; }
    .summary .grand { font-size: 15px; font-weight: 900; color: #111; margin-top: 8px; border-top: 2px solid #111; padding-top: 8px; }
    .prod-loss { background: #FFF3CD; border: 1px solid #FFCD00; border-radius: 6px; padding: 10px 14px; margin-top: 16px; }
    .prod-loss .title { font-weight: 700; color: #856404; font-size: 13px; }
    .prod-loss .detail { color: #856404; font-size: 12px; margin-top: 4px; }
    .notes { background: #f4f4f4; border-left: 4px solid #888; padding: 10px 12px; border-radius: 4px; font-size: 12px; color: #555; }
    .footer { margin-top: 30px; border-top: 1px solid #ddd; padding-top: 10px; display: flex; justify-content: space-between; font-size: 11px; color: #999; }
    .sign-box { border: 1px solid #ccc; border-radius: 4px; height: 50px; width: 180px; display: inline-block; margin-top: 6px; }
    @media print { @page { size: A4; margin: 20mm; } body { padding: 0; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>FICHE DE MAINTENANCE — ${pm.id} <span class="badge">${pm.type}</span></h1>
    <div class="sub">GOOD ENGINEERS-DRILL &nbsp;·&nbsp; Plateforme de Gestion de Forage Minier</div>
  </div>

  <div class="info-grid">
    <div class="info-box"><div class="lbl">Machine</div><div class="val">${pm.machine}</div></div>
    <div class="info-box"><div class="lbl">Date</div><div class="val">${pm.date}</div></div>
    <div class="info-box"><div class="lbl">Heures machine</div><div class="val">${pm.hoursAtPM} h</div></div>
    <div class="info-box"><div class="lbl">Technicien(s)</div><div class="val">${pm.technician}</div></div>
    <div class="info-box"><div class="lbl">Durée arrêt</div><div class="val">${pm.durationH} h</div></div>
    <div class="info-box"><div class="lbl">ROP avant PM</div><div class="val">${pm.avgRopBeforePM} m/h</div></div>
  </div>

  <h2>Liste des Pièces et Consommables</h2>
  <table>
    <thead><tr><th>Article</th><th style="text-align:center">Qté</th><th style="text-align:right">Prix unitaire</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>
      ${rows}
      <tr class="total-row">
        <td colspan="3">Sous-total Pièces</td>
        <td style="text-align:right">${fmtCAD(pm.partsCost)}</td>
      </tr>
    </tbody>
  </table>

  <h2>Main d'Œuvre</h2>
  <table>
    <thead><tr><th>Description</th><th style="text-align:center">Heures</th><th style="text-align:right">Taux ($/h)</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>
      <tr><td>Technicien de maintenance</td><td style="text-align:center">${pm.laborHours}</td><td style="text-align:right">${fmtCAD(pm.laborRate)}</td><td style="text-align:right">${fmtCAD(pm.laborCost)}</td></tr>
      <tr class="total-row"><td colspan="3">Sous-total Main d'Œuvre</td><td style="text-align:right">${fmtCAD(pm.laborCost)}</td></tr>
    </tbody>
  </table>

  <div class="prod-loss">
    <div class="title">⚠ Production Perdue (Coût d'opportunité)</div>
    <div class="detail">
      Durée d'arrêt : ${pm.durationH} h &nbsp;×&nbsp; ROP moyen : ${pm.avgRopBeforePM} m/h
      = <b>${fmtN(pm.prodLostM)} m non forés</b>
      &nbsp;×&nbsp; ${DRILL_RATE_PER_METER} $/m = <b>${fmtCAD(pm.prodLostValue)}</b>
    </div>
  </div>

  <div class="summary">
    <div class="row"><span>Pièces et consommables</span><span>${fmtCAD(pm.partsCost)}</span></div>
    <div class="row"><span>Main d'œuvre</span><span>${fmtCAD(pm.laborCost)}</span></div>
    <div class="row"><span>Sous-total coûts directs</span><span>${fmtCAD(pm.totalCost)}</span></div>
    <div class="row"><span>Coût d'opportunité (production perdue)</span><span>${fmtCAD(pm.prodLostValue)}</span></div>
    <div class="row grand"><span>COÛT TOTAL PM (Direct + Opportunité)</span><span>${fmtCAD(pm.grandTotal)}</span></div>
  </div>

  ${pm.notes ? `<h2>Notes et Observations</h2><div class="notes">${pm.notes}</div>` : ''}

  <div style="margin-top:28px; display:flex; justify-content:space-between;">
    <div><div style="font-size:11px;color:#888;">Technicien responsable</div><div class="sign-box"></div></div>
    <div><div style="font-size:11px;color:#888;">Ingénieur / Superviseur</div><div class="sign-box"></div></div>
    <div><div style="font-size:11px;color:#888;">Date de validation</div><div class="sign-box"></div></div>
  </div>

  <div class="footer">
    <span>GOOD ENGINEERS-DRILL — Document généré le ${new Date().toLocaleDateString('fr-CA')} à ${new Date().toLocaleTimeString('fr-CA',{hour:'2-digit',minute:'2-digit'})}</span>
    <span>Fiche PM ${pm.id}</span>
  </div>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=850,height=900');
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 600);
};

// ── Export CSV tous PM ────────────────────────────────────────────────────────
const exportAllCSV = (rows) => {
  const header = ['ID','Machine','Type PM','Date','Heures machine','Durée arrêt (h)','Technicien','Coût pièces (CAD)','Coût M.O. (CAD)','Total direct (CAD)','Prod. perdue (m)','Coût prod. perdue (CAD)','Coût total + opport. (CAD)','Statut'];
  const body   = rows.map(pm => [
    pm.id, pm.machine, pm.type, pm.date, pm.hoursAtPM, pm.durationH, `"${pm.technician}"`,
    fmtN(pm.partsCost,2), fmtN(pm.laborCost,2), fmtN(pm.totalCost,2),
    fmtN(pm.prodLostM,1), fmtN(pm.prodLostValue,2), fmtN(pm.grandTotal,2), pm.status,
  ].join(';'));
  const csv = [header.join(';'), ...body].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'depenses_maintenance_pm.csv' });
  a.click();
  URL.revokeObjectURL(url);
};

// ── Component ─────────────────────────────────────────────────────────────────
const DepensesMaintenance = () => {
  const [machFilter,   setMachFilter]   = useState('TOUS');
  const [typeFilter,   setTypeFilter]   = useState('TOUS');
  const [expandedPM,   setExpandedPM]   = useState(null);

  const machines = ['TOUS', ...new Set(ALL_PM.map(p => p.machine))];
  const types    = ['TOUS', ...new Set(ALL_PM.map(p => p.type.split('—')[0].trim()))];

  const filtered = useMemo(() => {
    let rows = ALL_PM;
    if (machFilter !== 'TOUS') rows = rows.filter(p => p.machine === machFilter);
    if (typeFilter !== 'TOUS') rows = rows.filter(p => p.type.startsWith(typeFilter));
    return rows;
  }, [machFilter, typeFilter]);

  // ── KPIs globaux ─────────────────────────────────────────────────────────────
  const totalDirect    = ALL_PM.reduce((s, p) => s + p.totalCost, 0);
  const totalParts     = ALL_PM.reduce((s, p) => s + p.partsCost, 0);
  const totalLabor     = ALL_PM.reduce((s, p) => s + p.laborCost, 0);
  const totalProdLostM = ALL_PM.reduce((s, p) => s + p.prodLostM, 0);
  const totalOpport    = ALL_PM.reduce((s, p) => s + p.prodLostValue, 0);
  const totalGrand     = ALL_PM.reduce((s, p) => s + p.grandTotal, 0);
  const totalStopH     = ALL_PM.reduce((s, p) => s + p.durationH, 0);

  // ── Coût par machine ──────────────────────────────────────────────────────────
  const byMachine = useMemo(() => {
    const map = {};
    ALL_PM.forEach(p => {
      if (!map[p.machine]) map[p.machine] = { machine: p.machine, count: 0, totalCost: 0, totalProdLost: 0, totalStopH: 0 };
      map[p.machine].count++;
      map[p.machine].totalCost     += p.totalCost;
      map[p.machine].totalProdLost += p.prodLostM;
      map[p.machine].totalStopH    += p.durationH;
    });
    return Object.values(map).sort((a, b) => b.totalCost - a.totalCost);
  }, []);

  const maxCost = Math.max(...byMachine.map(r => r.totalCost));

  return (
    <div className="space-y-6">

      {/* ── KPI Bar ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {[
          { lbl: 'Nb PM effectués',        val: ALL_PM.length,          unit: '',    cls: 'text-white'          },
          { lbl: 'Coût pièces total',      val: fmtCAD(totalParts),     unit: '',    cls: 'text-komatsu-yellow' },
          { lbl: 'Coût M.O. total',        val: fmtCAD(totalLabor),     unit: '',    cls: 'text-komatsu-yellow' },
          { lbl: 'Coût direct total',      val: fmtCAD(totalDirect),    unit: '',    cls: 'text-white'          },
          { lbl: 'Production perdue',      val: fmtN(totalProdLostM,0), unit: 'm',   cls: 'text-cat-orange'     },
          { lbl: 'Coût opport. total',     val: fmtCAD(totalOpport),    unit: '',    cls: 'text-drill-red'      },
        ].map(({ lbl, val, unit, cls }) => (
          <div key={lbl} className="bg-mine-card border border-mine-border rounded-xl px-4 py-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">{lbl}</p>
            <p className={`text-xl font-black font-mono leading-tight ${cls}`}>{val}<span className="text-xs text-slate-500 ml-1">{unit}</span></p>
          </div>
        ))}
      </div>

      {/* ── Coût total (direct + opportunité) ───────────────── */}
      <div className="bg-mine-card border border-komatsu-yellow/40 rounded-xl p-5 flex flex-wrap gap-8 items-center">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Coût Total Maintenance (Direct + Opportunité)</p>
          <p className="text-4xl font-black font-mono text-komatsu-yellow">{fmtCAD(totalGrand)}</p>
          <p className="text-slate-500 text-xs mt-1">Sur {ALL_PM.length} PM · {totalStopH.toFixed(1)} h d'arrêt · {fmtN(totalProdLostM,0)} m de prod. perdue</p>
        </div>
        <div className="flex-1 grid grid-cols-3 gap-4 min-w-[280px]">
          {[
            { lbl: 'Pièces',       val: totalParts,    pct: totalParts   / totalGrand * 100, c: 'bg-komatsu-yellow' },
            { lbl: 'Main d\'œuvre',val: totalLabor,    pct: totalLabor   / totalGrand * 100, c: 'bg-mine-border-hi' },
            { lbl: 'Opportunité',  val: totalOpport,   pct: totalOpport  / totalGrand * 100, c: 'bg-cat-orange'     },
          ].map(r => (
            <div key={r.lbl} className="text-center">
              <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{r.lbl}</p>
              <p className="text-lg font-bold text-white">{fmtCAD(r.val)}</p>
              <div className="w-full bg-mine-panel h-1.5 rounded-full mt-1 overflow-hidden">
                <div className={`h-1.5 rounded-full ${r.c}`} style={{ width: `${r.pct}%` }} />
              </div>
              <p className="text-slate-500 text-[10px] mt-0.5">{fmtN(r.pct,1)}%</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Coût par machine ─────────────────────────────────── */}
      <div className="bg-mine-card border border-mine-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-mine-border bg-mine-panel">
          <h3 className="font-semibold text-sm">Coûts Maintenance par Machine</h3>
        </div>
        <div className="p-4 space-y-3">
          {byMachine.map(r => (
            <div key={r.machine} className="flex items-center gap-4">
              <span className="font-mono text-komatsu-yellow text-sm font-bold w-32 shrink-0">{r.machine}</span>
              <div className="flex-1 bg-mine-panel h-5 rounded-lg overflow-hidden relative">
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-komatsu-yellow to-komatsu-gold rounded-lg flex items-center px-2 transition-all"
                  style={{ width: `${(r.totalCost / maxCost) * 100}%`, minWidth: 60 }}
                >
                  <span className="text-black font-bold text-[11px] truncate">{fmtCAD(r.totalCost)}</span>
                </div>
              </div>
              <span className="text-slate-400 text-xs w-24 text-right shrink-0">{r.count} PM · {r.totalStopH.toFixed(1)}h arrêt</span>
              <span className="text-cat-orange text-xs w-20 text-right shrink-0 font-mono">{fmtN(r.totalProdLost,0)} m perdus</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Filtres + Export ─────────────────────────────────── */}
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-slate-500 text-xs">Machine :</span>
          {machines.map(m => (
            <button key={m} onClick={() => setMachFilter(m)}
              className={`px-2.5 py-1 text-xs font-semibold rounded-lg border transition-all ${machFilter === m ? 'bg-komatsu-yellow text-black border-komatsu-yellow' : 'bg-mine-card border-mine-border text-slate-400 hover:border-mine-border-hi hover:text-white'}`}>
              {m}
            </button>
          ))}
          <span className="text-slate-500 text-xs ml-3">Type :</span>
          {types.map(t => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`px-2.5 py-1 text-xs font-semibold rounded-lg border transition-all ${typeFilter === t ? 'bg-komatsu-yellow text-black border-komatsu-yellow' : 'bg-mine-card border-mine-border text-slate-400 hover:border-mine-border-hi hover:text-white'}`}>
              {t}
            </button>
          ))}
        </div>
        <button
          onClick={() => exportAllCSV(filtered)}
          className="flex items-center gap-2 bg-mine-card border border-mine-border-hi hover:bg-mine-card2 text-komatsu-yellow px-4 py-1.5 rounded-lg text-xs font-semibold transition-all"
        >
          ⬇ Exporter CSV ({filtered.length} PM)
        </button>
      </div>

      {/* ── Cartes PM ────────────────────────────────────────── */}
      <div className="space-y-4">
        {filtered.map(pm => {
          const open = expandedPM === pm.id;
          return (
            <div key={pm.id} className="bg-mine-card border border-mine-border rounded-xl overflow-hidden">
              {/* Header ligne */}
              <div
                onClick={() => setExpandedPM(open ? null : pm.id)}
                className="flex flex-wrap items-center gap-4 px-5 py-4 cursor-pointer hover:bg-mine-card2 transition-colors"
              >
                {/* PM ID + Type */}
                <div className="flex-1 min-w-[180px]">
                  <div className="flex items-center gap-2">
                    <span className="font-black text-komatsu-yellow">{pm.id}</span>
                    <span className="text-[11px] bg-mine-border text-slate-300 px-2 py-0.5 rounded-full font-semibold">{pm.type}</span>
                  </div>
                  <div className="text-slate-500 text-xs mt-0.5">{pm.date} · {pm.machine} · {pm.technician}</div>
                </div>

                {/* Coûts sommaires */}
                <div className="flex flex-wrap gap-4 text-sm">
                  <div className="text-center">
                    <p className="text-[10px] text-slate-500 uppercase">Pièces</p>
                    <p className="font-mono font-bold text-komatsu-yellow">{fmtCAD(pm.partsCost)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-slate-500 uppercase">M.O.</p>
                    <p className="font-mono font-bold text-white">{fmtCAD(pm.laborCost)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-slate-500 uppercase">Direct</p>
                    <p className="font-mono font-bold text-white">{fmtCAD(pm.totalCost)}</p>
                  </div>
                  <div className="text-center border-l border-mine-border pl-4">
                    <p className="text-[10px] text-slate-500 uppercase">Prod. perdue</p>
                    <p className="font-mono font-bold text-cat-orange">{fmtN(pm.prodLostM)} m</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-slate-500 uppercase">Opport.</p>
                    <p className="font-mono font-bold text-cat-orange">{fmtCAD(pm.prodLostValue)}</p>
                  </div>
                  <div className="text-center border-l border-mine-border pl-4">
                    <p className="text-[10px] text-slate-500 uppercase">Grand Total</p>
                    <p className="font-mono font-black text-drill-red">{fmtCAD(pm.grandTotal)}</p>
                  </div>
                </div>

                {/* Expand arrow */}
                <span className={`text-slate-400 text-lg transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
              </div>

              {/* Détails expandables */}
              {open && (
                <div className="border-t border-mine-border px-5 pb-5">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-4">

                    {/* Pièces */}
                    <div>
                      <h4 className="text-[11px] uppercase tracking-widest text-slate-500 mb-2">Pièces et Consommables</h4>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-mine-border text-[11px] text-slate-500">
                            <th className="text-left py-1.5">Article</th>
                            <th className="text-center py-1.5">Qté</th>
                            <th className="text-right py-1.5">Prix unit.</th>
                            <th className="text-right py-1.5">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pm.parts.map((p, i) => (
                            <tr key={i} className={`border-b border-mine-border/20 ${i % 2 ? 'bg-mine-panel/20' : ''}`}>
                              <td className="py-1.5 text-slate-300">{p.name}</td>
                              <td className="py-1.5 text-center font-mono text-slate-400">{p.qty}</td>
                              <td className="py-1.5 text-right font-mono text-slate-400">{fmtCAD(p.unitCost)}</td>
                              <td className="py-1.5 text-right font-mono text-komatsu-yellow font-semibold">{fmtCAD(p.qty * p.unitCost)}</td>
                            </tr>
                          ))}
                          <tr className="border-t border-mine-border">
                            <td colSpan={3} className="py-1.5 text-slate-400 font-semibold text-xs">Sous-total pièces</td>
                            <td className="py-1.5 text-right font-mono font-black text-komatsu-yellow">{fmtCAD(pm.partsCost)}</td>
                          </tr>
                          <tr>
                            <td colSpan={2} className="py-1.5 text-slate-400 text-xs">Main d'œuvre ({pm.laborHours}h × {fmtCAD(pm.laborRate)}/h)</td>
                            <td></td>
                            <td className="py-1.5 text-right font-mono font-bold text-white">{fmtCAD(pm.laborCost)}</td>
                          </tr>
                          <tr className="border-t-2 border-komatsu-yellow/40">
                            <td colSpan={3} className="py-2 font-black text-white">Total coûts directs</td>
                            <td className="py-2 text-right font-mono font-black text-komatsu-yellow text-base">{fmtCAD(pm.totalCost)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    {/* Production + Résumé */}
                    <div className="space-y-4">
                      {/* Impact production */}
                      <div>
                        <h4 className="text-[11px] uppercase tracking-widest text-slate-500 mb-2">Impact Production</h4>
                        <div className="bg-mine-panel rounded-xl p-4 border border-mine-border space-y-2.5 text-sm">
                          {[
                            ['Durée d\'arrêt',      `${pm.durationH} h`],
                            ['ROP moyen avant PM',  `${pm.avgRopBeforePM} m/h`],
                            ['Mètres non forés',    `${fmtN(pm.prodLostM)} m`, 'text-cat-orange'],
                            ['Taux facturation',    `${DRILL_RATE_PER_METER} $/m`],
                            ['Valeur prod. perdue', fmtCAD(pm.prodLostValue), 'text-cat-orange font-black'],
                          ].map(([k, v, c = 'text-white']) => (
                            <div key={k} className="flex justify-between border-b border-mine-border/30 pb-1.5">
                              <span className="text-slate-400">{k}</span>
                              <span className={`font-mono font-semibold ${c}`}>{v}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Grand total */}
                      <div className="bg-drill-red/10 border border-drill-red/30 rounded-xl p-4">
                        <p className="text-[10px] uppercase tracking-widest text-slate-400 mb-1">Coût Total PM (Direct + Opportunité)</p>
                        <p className="text-3xl font-black font-mono text-drill-red">{fmtCAD(pm.grandTotal)}</p>
                        <p className="text-slate-500 text-xs mt-1">= {fmtCAD(pm.totalCost)} direct + {fmtCAD(pm.prodLostValue)} opport.</p>
                      </div>

                      {/* Notes */}
                      {pm.notes && (
                        <div>
                          <h4 className="text-[11px] uppercase tracking-widest text-slate-500 mb-1.5">Notes</h4>
                          <p className="text-slate-400 text-xs leading-relaxed bg-mine-panel rounded-lg p-3 border border-mine-border">{pm.notes}</p>
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={() => printPM(pm)}
                          className="flex-1 flex items-center justify-center gap-2 bg-komatsu-yellow hover:bg-komatsu-gold text-black font-bold text-sm px-4 py-2 rounded-lg transition-all"
                        >
                          🖨 Imprimer Fiche PM
                        </button>
                        <button
                          onClick={() => exportAllCSV([pm])}
                          className="flex items-center gap-1 bg-mine-card2 border border-mine-border-hi text-komatsu-yellow text-xs font-semibold px-3 py-2 rounded-lg hover:bg-mine-card transition-all"
                        >
                          ⬇ CSV
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default DepensesMaintenance;
