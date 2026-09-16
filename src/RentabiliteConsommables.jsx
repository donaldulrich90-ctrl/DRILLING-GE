import React, { useState, useEffect, useMemo } from 'react';
import { apiFetch } from './api';

// ── Calculs rentabilité ───────────────────────────────────────────────────────
const enrich = (c) => {
  const actualCpm  = c.metersProduced > 0 ? c.unitCost / c.metersProduced : 0;
  const targetCpm  = c.plannedLife   > 0 ? c.unitCost / c.plannedLife    : 0;
  const yieldRatio = c.plannedLife   > 0 ? (c.metersProduced / c.plannedLife) * 100 : 0;
  const surplus    = c.metersProduced - c.plannedLife;
  const savings    = surplus * targetCpm;
  const grade =
    yieldRatio === 0 ? '—' :
    yieldRatio >= 110 ? 'EXCELLENT' :
    yieldRatio >= 90  ? 'BON'       :
    yieldRatio >= 70  ? 'PASSABLE'  : 'FAIBLE';
  return { ...c, actualCpm, targetCpm, yieldRatio, surplus, savings, grade };
};

const GRADE_CFG = {
  EXCELLENT: { cls: 'text-drill-green  bg-drill-green/15  border-drill-green/30',  dot: '#22C55E', label: 'Excellent'  },
  BON:       { cls: 'text-komatsu-yellow bg-komatsu-yellow/15 border-komatsu-yellow/30', dot: '#FFCD00', label: 'Bon'   },
  PASSABLE:  { cls: 'text-cat-orange   bg-cat-orange/15   border-cat-orange/30',   dot: '#FF6B35', label: 'Passable'   },
  FAIBLE:    { cls: 'text-drill-red    bg-drill-red/15    border-drill-red/30',    dot: '#EF4444', label: 'Faible'     },
  '—':       { cls: 'text-slate-500   bg-slate-600/15   border-slate-600/30',     dot: '#64748B', label: '—'          },
};

const STATUS_CFG = {
  'EN SERVICE': 'text-komatsu-yellow bg-komatsu-yellow/15 border-komatsu-yellow/30',
  'REMPLACÉ':   'text-slate-600      bg-slate-700/30      border-slate-600/30',
  'ALERTE':     'text-drill-red      bg-drill-red/15      border-drill-red/30',
};

const fmtXOF = (v) => {
  if (!v && v !== 0) return '—';
  return Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 0 }) + ' XOF';
};
const fmtN = (v, d = 2) => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(d);

// ── Export CSV ────────────────────────────────────────────────────────────────
const downloadCSV = (rows) => {
  const header = ['ID','Consommable','Catégorie','Statut','Prix unitaire (XOF)','Qté stock','Stock min','Unité','Mètres produits','Vie planifiée (m)','Rendement (%)','Économie','Évaluation'];
  const body   = rows.map(c => [
    c.id, c.name, c.cat, c.status,
    fmtN(c.unitCost, 0), c.quantity ?? '—', c.minStock ?? '—', c.unit ?? '—',
    c.metersProduced > 0 ? fmtN(c.metersProduced, 1) : '—',
    c.plannedLife   > 0 ? c.plannedLife : '—',
    c.yieldRatio    > 0 ? fmtN(c.yieldRatio, 1) : '—',
    c.plannedLife   > 0 ? fmtN(c.savings, 0) : '—',
    c.grade,
  ].join(';'));
  const csv = [header.join(';'), ...body].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'rentabilite_consommables.csv' });
  a.click();
  URL.revokeObjectURL(url);
};

// ── Component ─────────────────────────────────────────────────────────────────
const RentabiliteConsommables = () => {
  const [rawItems,   setRawItems]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [catFilter,  setCatFilter]  = useState('TOUS');
  const [sortKey,    setSortKey]    = useState('name');
  const [sortDir,    setSortDir]    = useState(1);

  useEffect(() => {
    apiFetch('/api/inventory')
      .then(data => {
        // Map inventory items to the enriched format
        const items = (Array.isArray(data) ? data : []).map(item => enrich({
          id:             item.id,
          name:           item.name,
          cat:            item.category,
          unitCost:       item.price ?? item.averagePrice ?? 0,
          quantity:       item.quantity,
          minStock:       item.minStock,
          unit:           item.unit,
          status:         item.alert ? 'ALERTE' : item.quantity > 0 ? 'EN SERVICE' : 'REMPLACÉ',
          metersProduced: 0,
          plannedLife:    0,
          machine:        null,
          serial:         null,
        }));
        setRawItems(items);
      })
      .catch(() => setRawItems([]))
      .finally(() => setLoading(false));
  }, []);

  const categories = useMemo(() => ['TOUS', ...new Set(rawItems.map(c => c.cat))], [rawItems]);

  const filtered = useMemo(() => {
    let rows = rawItems;
    if (catFilter !== 'TOUS') rows = rows.filter(c => c.cat === catFilter);
    return [...rows].sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      return (av > bv ? 1 : av < bv ? -1 : 0) * sortDir;
    });
  }, [rawItems, catFilter, sortKey, sortDir]);

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d * -1);
    else { setSortKey(key); setSortDir(1); }
  };

  // ── KPIs globaux ─────────────────────────────────────────────────────────────
  const totalCost   = rawItems.reduce((s, c) => s + (c.unitCost * (c.quantity ?? 0)), 0);
  const alertCount  = rawItems.filter(c => c.status === 'ALERTE').length;
  const stockValue  = rawItems.reduce((s, c) => s + (c.unitCost * (c.quantity ?? 0)), 0);

  // ── Résumé par catégorie ──────────────────────────────────────────────────────
  const byCategory = useMemo(() => {
    const map = {};
    rawItems.forEach(c => {
      if (!map[c.cat]) map[c.cat] = { cat: c.cat, count: 0, totalValue: 0, alerts: 0 };
      map[c.cat].count++;
      map[c.cat].totalValue += c.unitCost * (c.quantity ?? 0);
      if (c.status === 'ALERTE') map[c.cat].alerts++;
    });
    return Object.values(map).sort((a, b) => b.totalValue - a.totalValue);
  }, [rawItems]);

  const Th = ({ col, label, right }) => (
    <th
      onClick={() => handleSort(col)}
      className={`px-3 py-2.5 ${right ? 'text-right' : 'text-left'} cursor-pointer select-none hover:text-komatsu-yellow transition-colors whitespace-nowrap`}
    >
      {label} {sortKey === col ? (sortDir === 1 ? '↑' : '↓') : <span className="opacity-30">↕</span>}
    </th>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500 text-sm animate-pulse">
        Chargement inventaire…
      </div>
    );
  }

  if (rawItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-500">
        <p className="text-sm">Aucun consommable dans l'inventaire.</p>
        <p className="text-xs">Ajoutez des articles via la Plateforme de Gestion.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* ── KPI Bar ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { lbl: 'Articles en stock',    val: rawItems.length,         unit: '',     cls: 'text-slate-900' },
          { lbl: 'Valeur stock total',   val: fmtXOF(stockValue),      unit: '',     cls: 'text-komatsu-yellow' },
          { lbl: 'Alertes stock bas',    val: alertCount,              unit: '',     cls: alertCount > 0 ? 'text-drill-red' : 'text-drill-green' },
          { lbl: 'Catégories',           val: byCategory.length,       unit: '',     cls: 'text-slate-900' },
        ].map(({ lbl, val, unit, cls }) => (
          <div key={lbl} className="bg-mine-card border border-mine-border rounded-xl px-4 py-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">{lbl}</p>
            <p className={`text-xl font-black font-mono leading-tight ${cls}`}>{val}<span className="text-xs text-slate-500 ml-1">{unit}</span></p>
          </div>
        ))}
      </div>

      {/* ── Note informative ─────────────────────────────────── */}
      <div className="bg-komatsu-yellow/10 border border-komatsu-yellow/30 rounded-xl px-5 py-3 text-xs text-komatsu-dark">
        <b>Données réelles depuis l'inventaire.</b> Les colonnes Mètres Produits et Vie Planifiée nécessitent un suivi du cycle de vie par article — à renseigner via la plateforme de gestion.
      </div>

      {/* ── Résumé par catégorie ─────────────────────────────── */}
      <div className="bg-mine-card border border-mine-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-mine-border bg-mine-panel">
          <h3 className="font-semibold text-sm">Valeur de Stock par Catégorie</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-mine-border text-[11px] text-slate-500 uppercase tracking-wider bg-mine-panel/50">
                {['Catégorie','Nb articles','Valeur totale (XOF)','Alertes stock'].map(h => (
                  <th key={h} className="px-4 py-2 text-left whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {byCategory.map((r, i) => (
                <tr key={r.cat} className={`border-b border-mine-border/25 ${i % 2 ? 'bg-mine-panel/20' : ''}`}>
                  <td className="px-4 py-2.5 text-komatsu-yellow font-semibold">{r.cat}</td>
                  <td className="px-4 py-2.5 font-mono text-slate-700">{r.count}</td>
                  <td className="px-4 py-2.5 font-mono text-slate-900">{fmtXOF(r.totalValue)}</td>
                  <td className="px-4 py-2.5">
                    {r.alerts > 0
                      ? <span className="text-drill-red font-bold text-xs">{r.alerts} alerte{r.alerts > 1 ? 's' : ''}</span>
                      : <span className="text-drill-green text-xs">OK</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Filtres + Export ─────────────────────────────────── */}
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-slate-500 text-xs">Catégorie :</span>
          {categories.map(c => (
            <button key={c} onClick={() => setCatFilter(c)}
              className={`px-2.5 py-1 text-xs font-semibold rounded-lg border transition-all ${catFilter === c ? 'bg-komatsu-yellow text-black border-komatsu-yellow' : 'bg-mine-card border-mine-border text-slate-600 hover:border-mine-border-hi hover:text-slate-900'}`}>
              {c}
            </button>
          ))}
        </div>
        <button
          onClick={() => downloadCSV(filtered)}
          className="flex items-center gap-2 bg-mine-card border border-mine-border-hi hover:bg-mine-card2 text-komatsu-yellow px-4 py-1.5 rounded-lg text-xs font-semibold transition-all"
        >
          ⬇ Exporter CSV ({filtered.length})
        </button>
      </div>

      {/* ── Tableau détaillé ─────────────────────────────────── */}
      <div className="bg-mine-card border border-mine-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-mine-border bg-mine-panel flex justify-between items-center">
          <h3 className="font-semibold text-sm">Inventaire Consommables</h3>
          <span className="text-xs text-slate-500">{filtered.length} article(s)</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-mine-border text-[11px] text-slate-500 uppercase tracking-wider bg-mine-panel/50">
                <Th col="name"      label="Article"               />
                <Th col="cat"       label="Catégorie"              />
                <Th col="status"    label="Statut"                 />
                <Th col="unitCost"  label="Prix unitaire"   right  />
                <Th col="quantity"  label="Qté stock"       right  />
                <Th col="minStock"  label="Stock min"       right  />
                <Th col="unit"      label="Unité"                  />
                <th className="px-3 py-2.5 text-right whitespace-nowrap">Valeur stock</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, idx) => {
                const sc = STATUS_CFG[c.status] ?? STATUS_CFG['EN SERVICE'];
                const stockVal = c.unitCost * (c.quantity ?? 0);
                const stockLow = c.quantity != null && c.minStock != null && c.quantity <= c.minStock;
                return (
                  <tr key={c.id} className={`border-b border-mine-border/25 hover:bg-mine-card2 transition-colors ${idx % 2 ? 'bg-mine-panel/20' : ''}`}>
                    <td className="px-3 py-2.5 text-slate-900 font-semibold">{c.name}</td>
                    <td className="px-3 py-2.5 text-slate-600">{c.cat}</td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${sc}`}>{c.status}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-900">{fmtXOF(c.unitCost)}</td>
                    <td className={`px-3 py-2.5 text-right font-mono font-bold ${stockLow ? 'text-drill-red' : 'text-slate-700'}`}>
                      {c.quantity ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-500">{c.minStock ?? '—'}</td>
                    <td className="px-3 py-2.5 text-slate-600">{c.unit ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-komatsu-yellow font-bold">{fmtXOF(stockVal)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-mine-border bg-mine-panel text-xs font-bold">
                <td className="px-3 py-2.5 text-slate-600" colSpan={3}>TOTAL ({filtered.length} articles)</td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-500">—</td>
                <td className="px-3 py-2.5 text-right font-mono text-slate-900">
                  {filtered.reduce((s, c) => s + (c.quantity ?? 0), 0)}
                </td>
                <td colSpan={2} />
                <td className="px-3 py-2.5 text-right font-mono text-komatsu-yellow">
                  {fmtXOF(filtered.reduce((s, c) => s + c.unitCost * (c.quantity ?? 0), 0))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
};

export default RentabiliteConsommables;
