import React, { useState, useEffect } from 'react';
import { apiFetch } from './api';

const todayStr = () => new Date().toISOString().split('T')[0];
const SHIFTS = ['AM', 'PM', 'NUIT', 'JOURNÉE'];
const DRILL_STATUSES = ['EN FORAGE', 'EN ATTENTE', 'EN MAINTENANCE', 'ARRÊTÉE'];
const HOLE_STATUSES  = ['PLANIFIÉ', 'EN COURS', 'COMPLETÉ', 'PROBLÈME'];

// ── Shared primitives ─────────────────────────────────────────────────────────
function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

const inputCls = 'bg-mine-bg border border-mine-border rounded px-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-komatsu-yellow w-full';

function Input({ className = '', ...props }) {
  return <input {...props} className={`${inputCls} ${className}`} />;
}

function Sel({ children, className = '', ...props }) {
  return (
    <select {...props} className={`${inputCls} ${className}`}>
      {children}
    </select>
  );
}

function SaveBtn({ loading, disabled, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading || disabled}
      className="px-5 py-2 bg-komatsu-yellow text-black text-sm font-bold rounded-lg hover:opacity-90 disabled:opacity-50 transition"
    >
      {loading ? 'Enregistrement…' : children}
    </button>
  );
}

function Notice({ ok, err }) {
  if (!ok && !err) return null;
  const cls = ok
    ? 'border-drill-green text-drill-green bg-drill-green/5'
    : 'border-drill-red text-drill-red bg-drill-red/5';
  return <div className={`border rounded px-3 py-2 text-sm ${cls}`}>{ok || err}</div>;
}

// ── Télémétrie ────────────────────────────────────────────────────────────────
function TelemetrieForm({ drills, onDrillsChange }) {
  const [drillId, setDrillId] = useState(drills[0]?.id || '');
  const [status,  setStatus]  = useState('');
  const [t, setT] = useState({ rotation_pressure: '', hyd_temp: '', depth: '', fuel_level: '' });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState({});

  const drill = drills.find(d => d.id === drillId);

  useEffect(() => {
    if (!drill) return;
    setStatus(drill.status || '');
    const fuelPct = drill.fuel?.level && drill.fuel?.capacity
      ? Math.round(drill.fuel.level / drill.fuel.capacity * 100)
      : (drill.telemetry?.fuel_level ?? '');
    setT({
      rotation_pressure: drill.telemetry?.rotation_pressure ?? '',
      hyd_temp:          drill.telemetry?.hyd_temp          ?? '',
      depth:             drill.telemetry?.depth             ?? '',
      fuel_level:        fuelPct,
    });
  }, [drillId, drills]);

  const setTF = k => e => setT(p => ({ ...p, [k]: e.target.value }));

  const save = async () => {
    if (!drill) return;
    setSaving(true);
    setNotice({});
    try {
      const merged = { ...drill.telemetry };
      Object.entries(t).forEach(([k, v]) => { if (v !== '') merged[k] = Number(v); });
      await apiFetch(`/api/drills/${drillId}`, {
        method: 'PUT',
        body: JSON.stringify({
          location:         drill.location,
          status:           status || drill.status,
          siteId:           drill.siteId     || null,
          contractId:       drill.contractId || null,
          telemetry:        merged,
          maintenance:      drill.maintenance,
          fuel:             drill.fuel             || {},
          rods:             drill.rods             || {},
          consumables:      drill.consumables      || {},
          connectionMode:   drill.connectionMode   || 'manual',
          connectionStatus: drill.connectionStatus || 'offline',
          connectionConfig: drill.connectionConfig || {},
        }),
      });
      setNotice({ ok: 'Télémétrie mise à jour avec succès' });
      const fresh = await apiFetch('/api/drills');
      onDrillsChange(fresh);
    } catch (err) {
      setNotice({ err: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5 max-w-lg">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Foreuse">
          <Sel value={drillId} onChange={e => setDrillId(e.target.value)}>
            {drills.map(d => <option key={d.id} value={d.id}>{d.id} — {d.location}</option>)}
          </Sel>
        </Field>
        <Field label="Statut machine">
          <Sel value={status} onChange={e => setStatus(e.target.value)}>
            {DRILL_STATUSES.map(s => <option key={s}>{s}</option>)}
          </Sel>
        </Field>
        <Field label="Pression rotation (bar)">
          <Input type="number" min="0" max="300" step="0.1" value={t.rotation_pressure} onChange={setTF('rotation_pressure')} placeholder="ex: 120" />
        </Field>
        <Field label="Temp. hydraulique (°C)">
          <Input type="number" min="0" max="200" step="0.1" value={t.hyd_temp} onChange={setTF('hyd_temp')} placeholder="ex: 75" />
        </Field>
        <Field label="Profondeur (m)">
          <Input type="number" min="0" max="5000" step="0.1" value={t.depth} onChange={setTF('depth')} placeholder="ex: 45.2" />
        </Field>
        <Field label="Niveau carburant (%)">
          <Input type="number" min="0" max="100" step="1" value={t.fuel_level} onChange={setTF('fuel_level')} placeholder="ex: 75" />
        </Field>
      </div>
      <Notice {...notice} />
      <div>
        <SaveBtn loading={saving} onClick={save}>Enregistrer la télémétrie</SaveBtn>
      </div>
    </div>
  );
}

// ── Production journalière ────────────────────────────────────────────────────
function ProductionForm({ drills }) {
  const [form, setForm]   = useState({ drillId: drills[0]?.id || '', date: todayStr(), shift: 'AM', metersDrilled: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState({});

  const set = k => e => setForm(p => ({ ...p, [k]: e.target.value }));

  const save = async () => {
    if (!form.metersDrilled) { setNotice({ err: 'Saisir les mètres forés' }); return; }
    setSaving(true);
    setNotice({});
    try {
      await apiFetch('/api/daily-data', {
        method: 'POST',
        body: JSON.stringify({
          date:      form.date,
          machineId: form.drillId,
          shift:     form.shift,
          data:      { metersDrilled: Number(form.metersDrilled), shift: form.shift },
          notes:     form.notes,
        }),
      });
      setNotice({ ok: `${form.metersDrilled} m enregistrés pour ${form.drillId}` });
      setForm(p => ({ ...p, metersDrilled: '', notes: '' }));
    } catch (err) {
      setNotice({ err: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5 max-w-lg">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Foreuse">
          <Sel value={form.drillId} onChange={set('drillId')}>
            {drills.map(d => <option key={d.id} value={d.id}>{d.id}</option>)}
          </Sel>
        </Field>
        <Field label="Date">
          <Input type="date" value={form.date} onChange={set('date')} />
        </Field>
        <Field label="Poste (shift)">
          <Sel value={form.shift} onChange={set('shift')}>
            {SHIFTS.map(s => <option key={s}>{s}</option>)}
          </Sel>
        </Field>
        <Field label="Mètres forés">
          <Input type="number" min="0" step="0.1" value={form.metersDrilled} onChange={set('metersDrilled')} placeholder="ex: 45.5" />
        </Field>
      </div>
      <Field label="Notes">
        <textarea
          value={form.notes} onChange={set('notes')} rows={2}
          className={`${inputCls} resize-none`}
        />
      </Field>
      <Notice {...notice} />
      <div>
        <SaveBtn loading={saving} onClick={save}>Enregistrer la production</SaveBtn>
      </div>
    </div>
  );
}

// ── Consommables ──────────────────────────────────────────────────────────────
function ConsommablesForm({ drills }) {
  const [inventory, setInventory] = useState([]);
  const [form, setForm]   = useState({ drillId: drills[0]?.id || '', date: todayStr(), shift: 'AM', consumableId: '', qty: '', unitPrice: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState({});

  useEffect(() => {
    apiFetch('/api/inventory').then(setInventory).catch(() => {});
  }, []);

  const item = inventory.find(i => String(i.id) === form.consumableId);

  useEffect(() => {
    if (item) setForm(p => ({ ...p, unitPrice: String(item.price || item.averagePrice || '') }));
  }, [form.consumableId]);

  const set = k => e => setForm(p => ({ ...p, [k]: e.target.value }));

  const save = async () => {
    if (!form.consumableId || !form.qty) { setNotice({ err: 'Consommable et quantité requis' }); return; }
    setSaving(true);
    setNotice({});
    try {
      await apiFetch('/api/daily-consumables', {
        method: 'POST',
        body: JSON.stringify({
          date:          form.date,
          machineId:     form.drillId,
          shift:         form.shift,
          consumableId:  Number(form.consumableId),
          quantityUsed:  Number(form.qty),
          unitPrice:     Number(form.unitPrice) || 0,
          currency:      'XOF',
          notes:         form.notes,
        }),
      });
      const itemName = item?.name || `#${form.consumableId}`;
      setNotice({ ok: `${form.qty} ${item?.unit || 'u.'} de "${itemName}" enregistrés` });
      setForm(p => ({ ...p, consumableId: '', qty: '', notes: '' }));
    } catch (err) {
      setNotice({ err: err.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5 max-w-lg">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Foreuse">
          <Sel value={form.drillId} onChange={set('drillId')}>
            {drills.map(d => <option key={d.id} value={d.id}>{d.id}</option>)}
          </Sel>
        </Field>
        <Field label="Date">
          <Input type="date" value={form.date} onChange={set('date')} />
        </Field>
        <Field label="Poste">
          <Sel value={form.shift} onChange={set('shift')}>
            {SHIFTS.map(s => <option key={s}>{s}</option>)}
          </Sel>
        </Field>
        <Field label="Consommable">
          <Sel value={form.consumableId} onChange={set('consumableId')}>
            <option value="">— Choisir —</option>
            {inventory.map(i => (
              <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>
            ))}
          </Sel>
        </Field>
        <Field label={`Quantité${item ? ` (${item.unit})` : ''}`}>
          <Input type="number" min="0" step="0.01" value={form.qty} onChange={set('qty')} placeholder="0" />
        </Field>
        <Field label="Prix unitaire (XOF)">
          <Input type="number" min="0" step="1" value={form.unitPrice} onChange={set('unitPrice')} placeholder="auto" />
        </Field>
      </div>
      {item && (
        <div className="text-xs text-slate-500 -mt-2">
          Stock actuel : {item.quantity} {item.unit} · Alerte stock bas : {item.alert ? 'oui' : 'non'}
        </div>
      )}
      <Field label="Notes">
        <textarea value={form.notes} onChange={set('notes')} rows={2} className={`${inputCls} resize-none`} />
      </Field>
      <Notice {...notice} />
      <div>
        <SaveBtn loading={saving} onClick={save}>Enregistrer le consommable</SaveBtn>
      </div>
    </div>
  );
}

// ── Plan de Forage ────────────────────────────────────────────────────────────
function PlanForageForm() {
  const [plan,    setPlan]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [notice,  setNotice]  = useState({});
  const [edits,   setEdits]   = useState({});
  const [nb, setNb] = useState({ code: '', name: '', cols: 5, count: 5, planDepth: 10, azimuth: 0, inclination: 90 });

  useEffect(() => {
    apiFetch('/api/drilling-plan')
      .then(p => { setPlan(p); setLoading(false); })
      .catch(() => { setPlan({ version: 0, blocks: [] }); setLoading(false); });
  }, []);

  const setNbF = k => e => setNb(p => ({ ...p, [k]: e.target.value }));
  const setEdit = (key, field) => e => setEdits(p => ({ ...p, [key]: { ...(p[key] || {}), [field]: e.target.value } }));

  const addBlock = () => {
    if (!nb.code.trim()) { setNotice({ err: 'Code du bloc requis' }); return; }
    const count = Math.max(1, Math.min(500, parseInt(nb.count) || 5));
    const cols  = Math.max(1, Math.min(100, parseInt(nb.cols)  || 5));
    const prefix = nb.code.trim().toUpperCase().replace(/\s+/g, '_');
    const holes = Array.from({ length: count }, (_, i) => ({
      id:          `${prefix}-T${String(i + 1).padStart(3, '0')}`,
      status:      'PLANIFIÉ',
      planDepth:   Number(nb.planDepth) || 0,
      actDepth:    0,
      azimuth:     Number(nb.azimuth)     || 0,
      inclination: Number(nb.inclination) || 90,
    }));
    setPlan(p => ({ ...p, blocks: [...(p?.blocks || []), { id: prefix, name: nb.name.trim() || prefix, cols, holes }] }));
    setNb({ code: '', name: '', cols: 5, count: 5, planDepth: 10, azimuth: 0, inclination: 90 });
    setNotice({ ok: `Bloc "${prefix}" ajouté (${count} trous) — cliquez Sauvegarder pour confirmer` });
  };

  const savePlan = async () => {
    if (!plan) return;
    setSaving(true);
    setNotice({});
    try {
      const blocks = (plan.blocks || []).map(block => ({
        ...block,
        holes: (block.holes || []).map(hole => {
          const e = edits[`${block.id}:${hole.id}`];
          if (!e) return hole;
          return {
            ...hole,
            status:   e.status   || hole.status,
            actDepth: e.actDepth !== undefined && e.actDepth !== '' ? Number(e.actDepth) : hole.actDepth,
          };
        }),
      }));
      const saved = await apiFetch('/api/drilling-plan', {
        method: 'PUT',
        body: JSON.stringify({ ...plan, blocks, baseVersion: plan.version }),
      });
      setPlan(saved);
      setEdits({});
      setNotice({ ok: `Plan sauvegardé — version ${saved.version}` });
    } catch (err) {
      setNotice({ err: err.message });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-slate-500 text-sm animate-pulse">Chargement du plan…</div>;

  const totalHoles = (plan?.blocks || []).reduce((s, b) => s + (b.holes || []).length, 0);

  return (
    <div className="flex flex-col gap-6 max-w-2xl">

      {/* Summary */}
      <div className="bg-mine-card border border-mine-border rounded-lg px-4 py-3 flex justify-between items-center">
        <span className="text-sm font-semibold">{(plan?.blocks || []).length} blocs · {totalHoles} trous</span>
        <span className="text-xs text-slate-500">Version {plan?.version ?? 0}{plan?.updatedAt ? ` · ${plan.updatedAt.split('T')[0]}` : ''}</span>
      </div>

      {/* Hole updates */}
      {(plan?.blocks || []).length > 0 && (
        <div>
          <h4 className="font-semibold text-sm mb-3 text-slate-700">Mettre à jour les trous existants</h4>
          <div className="flex flex-col gap-3">
            {plan.blocks.map(block => (
              <div key={block.id} className="border border-mine-border rounded-lg overflow-hidden">
                <div className="bg-mine-panel px-4 py-2 text-xs font-bold text-slate-600 uppercase tracking-wide">
                  {block.name} — {block.holes?.length || 0} trous
                </div>
                <div className="p-3 max-h-56 overflow-y-auto flex flex-col gap-1.5">
                  {(block.holes || []).map(hole => {
                    const key = `${block.id}:${hole.id}`;
                    const e = edits[key] || {};
                    return (
                      <div key={hole.id} className="grid grid-cols-3 gap-2 items-center">
                        <span className="font-mono text-xs text-slate-600 truncate">{hole.id}</span>
                        <Sel
                          value={e.status || hole.status}
                          onChange={setEdit(key, 'status')}
                          className="text-xs py-1 px-2"
                        >
                          {HOLE_STATUSES.map(s => <option key={s}>{s}</option>)}
                        </Sel>
                        <Input
                          type="number" min="0" step="0.1"
                          value={e.actDepth ?? hole.actDepth ?? ''}
                          onChange={setEdit(key, 'actDepth')}
                          className="text-xs py-1 px-2"
                          placeholder="Prof. réelle (m)"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add block */}
      <div>
        <h4 className="font-semibold text-sm mb-3 text-slate-700">Ajouter un nouveau bloc</h4>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Code bloc"><Input value={nb.code} onChange={setNbF('code')} placeholder="ex: ALPHA-2" /></Field>
          <Field label="Nom du bloc"><Input value={nb.name} onChange={setNbF('name')} placeholder="(optionnel)" /></Field>
          <Field label="Nombre de trous"><Input type="number" min="1" max="500" value={nb.count} onChange={setNbF('count')} /></Field>
          <Field label="Colonnes (grille)"><Input type="number" min="1" max="100" value={nb.cols} onChange={setNbF('cols')} /></Field>
          <Field label="Prof. planifiée (m)"><Input type="number" min="0" step="0.1" value={nb.planDepth} onChange={setNbF('planDepth')} /></Field>
          <Field label="Azimut (°)"><Input type="number" min="0" max="360" value={nb.azimuth} onChange={setNbF('azimuth')} /></Field>
          <Field label="Inclinaison (°)"><Input type="number" min="-90" max="180" value={nb.inclination} onChange={setNbF('inclination')} /></Field>
        </div>
        <button
          type="button"
          onClick={addBlock}
          className="mt-4 px-4 py-2 border border-komatsu-yellow text-komatsu-dark text-sm font-semibold rounded-lg hover:bg-komatsu-yellow/10 transition"
        >
          + Ajouter bloc au plan local
        </button>
      </div>

      <Notice {...notice} />

      <div className="flex items-center gap-4">
        <SaveBtn loading={saving} onClick={savePlan} disabled={!plan}>
          Sauvegarder le plan ({(plan?.blocks || []).length} blocs · {totalHoles} trous)
        </SaveBtn>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
const SAISIE_TABS = [
  { id: 'telemetrie',  label: 'Télémétrie' },
  { id: 'production',  label: 'Production journalière' },
  { id: 'consommables', label: 'Consommables' },
  { id: 'plan',        label: 'Plan de Forage' },
];

export default function SaisieManuelle({ drills, onDrillsChange }) {
  const [sub, setSub] = useState('telemetrie');

  if (!drills?.length) {
    return <p className="text-slate-500 text-sm py-8 text-center">Aucune foreuse disponible.</p>;
  }

  return (
    <div>
      <div className="flex gap-0 border-b border-mine-border mb-6">
        {SAISIE_TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSub(t.id)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-all ${
              sub === t.id
                ? 'text-komatsu-dark border-komatsu-yellow'
                : 'text-slate-500 border-transparent hover:text-slate-700 hover:border-mine-border-hi'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {sub === 'telemetrie'   && <TelemetrieForm  drills={drills} onDrillsChange={onDrillsChange} />}
      {sub === 'production'   && <ProductionForm  drills={drills} />}
      {sub === 'consommables' && <ConsommablesForm drills={drills} />}
      {sub === 'plan'         && <PlanForageForm />}
    </div>
  );
}
