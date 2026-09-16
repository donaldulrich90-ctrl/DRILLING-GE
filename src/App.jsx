import React, { useState, useEffect } from 'react';
import DrillMonitor from './DPI';
import DrillDashboard from './DrillDashboard';
import { apiFetch, getToken } from './api';

function HeaderClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const date = now.toLocaleDateString('fr-CA', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <div className="text-right hidden md:block">
      <div className="text-slate-600 text-xs capitalize">{date}</div>
      <div className="text-komatsu-dark font-mono font-bold text-sm tracking-widest">{time}</div>
    </div>
  );
}

function App() {
  const [selectedDrill, setSelectedDrill] = useState(null);
  const [drills,        setDrills]        = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState(null);

  useEffect(() => {
    if (!getToken()) {
      setError('non_auth');
      setLoading(false);
      return;
    }
    apiFetch('/api/drills')
      .then(data => { setDrills(data); setLoading(false); })
      .catch(err => {
        if (err.status === 401 || err.status === 403) setError('non_auth');
        else setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-mine-bg flex items-center justify-center">
        <div className="text-slate-600 text-sm animate-pulse">Chargement des foreuses…</div>
      </div>
    );
  }

  if (error === 'non_auth') {
    return (
      <div className="min-h-screen bg-mine-bg flex flex-col items-center justify-center gap-4">
        <div className="text-slate-700 text-base font-semibold">Session expirée ou non authentifié.</div>
        <a
          href="/"
          className="px-4 py-2 bg-komatsu-yellow text-black text-sm font-bold rounded-lg hover:opacity-90 transition"
        >
          Se connecter
        </a>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-mine-bg flex flex-col items-center justify-center gap-4">
        <div className="text-drill-red text-sm font-semibold">Erreur : {error}</div>
        <button
          onClick={() => { setError(null); setLoading(true); apiFetch('/api/drills').then(d => { setDrills(d); setLoading(false); }).catch(e => { setError(e.message); setLoading(false); }); }}
          className="px-4 py-2 bg-mine-card border border-mine-border text-slate-700 text-sm rounded-lg hover:border-mine-border-hi transition"
        >
          Réessayer
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-mine-bg flex flex-col">

      {/* ── Header ─────────────────────────────────────────── */}
      <header className="bg-mine-panel border-b border-mine-border shadow-lg shadow-black/40">
        <div className="h-1 bg-komatsu-yellow" />

        <div className="flex items-center justify-between px-6 py-3 gap-4">
          <div className="flex items-center gap-3">
            {selectedDrill ? (
              <button
                onClick={() => setSelectedDrill(null)}
                className="flex items-center gap-2 text-sm font-semibold border border-mine-border hover:border-komatsu-yellow text-slate-700 hover:text-komatsu-dark bg-mine-card px-3 py-1.5 rounded-lg transition-all"
              >
                ← Tableau de bord
              </button>
            ) : (
              <div className="flex items-center justify-center w-9 h-9 bg-komatsu-yellow rounded-lg text-black font-black text-base select-none">
                ⛏
              </div>
            )}
            <div>
              <div className="text-komatsu-dark font-black text-lg uppercase tracking-[0.18em] leading-none">
                GOOD ENGINEERS
              </div>
              <div className="text-slate-500 text-[11px] tracking-wide mt-0.5">
                {selectedDrill
                  ? `Monitoring Foreuse — ${selectedDrill}`
                  : 'Plateforme de Gestion de Forage Minier'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <HeaderClock />
            <div className="flex items-center gap-2 bg-mine-card border border-mine-border px-3 py-1.5 rounded-lg">
              <span className="w-2 h-2 rounded-full bg-drill-green animate-pulse" />
              <span className="text-slate-700 text-xs font-semibold">Système Actif</span>
            </div>
          </div>
        </div>
      </header>

      {/* ── Main content ───────────────────────────────────── */}
      <main className="flex-1">
        {selectedDrill
          ? <DrillMonitor machineId={selectedDrill} drills={drills} />
          : <DrillDashboard drills={drills} onSelectDrill={setSelectedDrill} onDrillsChange={setDrills} />
        }
      </main>

      {/* ── Footer ─────────────────────────────────────────── */}
      <footer className="bg-mine-panel border-t border-mine-border py-2 text-center text-[11px] text-slate-700 tracking-wide">
        GOOD ENGINEERS-DRILL v2.0 &nbsp;·&nbsp; Plateforme de Monitoring Minier
      </footer>
    </div>
  );
}

export default App;
