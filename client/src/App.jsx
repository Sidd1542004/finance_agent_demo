import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useBusy } from './shared.jsx';
import InvoicesView from './views/Invoices.jsx';
import QueriesView from './views/Queries.jsx';
import ReconciliationView from './views/Reconciliation.jsx';
import ReportView from './views/Report.jsx';

// The Finance Operations Agent's four workflows.
const TABS = [
  ['invoices', 'Invoices', InvoicesView],
  ['queries', 'Supplier emails', QueriesView],
  ['bank', 'Bank reconciliation', ReconciliationView],
  ['report', 'Month-end report', ReportView],
];

export default function App() {
  const [health, setHealth] = useState(null);
  const [unreachable, setUnreachable] = useState(false);
  const [tab, setTab] = useState('invoices');
  const [version, setVersion] = useState(0); // bumped to reload every screen after a reset
  const [error, setError] = useState(null);
  const [busy, run] = useBusy(setError);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((err) => {
        setError(err.message);
        setUnreachable(true);
      });
  }, []);

  const loadDemo = () => {
    if (!window.confirm('Delete everything and load the demo month? This runs the eight sample invoices through the agent.')) return;
    run('demo', async () => {
      await api.loadDemo();
      setVersion((v) => v + 1);
    });
  };

  const reset = () => {
    if (!window.confirm('Delete every invoice, email, statement and report?')) return;
    run('reset', async () => {
      await api.reset();
      setVersion((v) => v + 1);
    });
  };

  const View = TABS.find(([id]) => id === tab)[2];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <span className="brand-name">Finance Operations Agent</span>
          <div className="topbar-right">
            {health && (
              <span className={`reader reader-${health.reader.mode}`}>
                {health.reader.mode === 'groq' ? `AI on: ${health.reader.model}` : 'AI off: no Groq key set'}
              </span>
            )}
            {health?.demoMode && (
              <>
                <button className="btn btn-on-navy" onClick={loadDemo} disabled={Boolean(busy)}>
                  {busy === 'demo' ? 'Loading…' : 'Load demo month'}
                </button>
                <button className="btn btn-on-navy" onClick={reset} disabled={Boolean(busy)}>
                  {busy === 'reset' ? 'Resetting…' : 'Reset'}
                </button>
              </>
            )}
          </div>
        </div>
        <nav className="mainnav" aria-label="Workflows">
          {TABS.map(([id, label]) => (
            <button key={id} className="mainnav-item" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
      </header>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button className="banner-close" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {health ? (
        <View key={`${tab}-${version}`} health={health} onError={setError} />
      ) : (
        <div className="layout">
          <div className="blank">
            {unreachable ? (
              <>
                <h1>The server is not answering</h1>
                <p>
                  Locally: start MongoDB, then run <code>npm run dev</code> in the project folder and reload this page.
                </p>
                <p>
                  On Vercel: open <code>/api/health</code>, and check the function logs, <code>MONGODB_URI</code> and MongoDB Atlas Network Access.
                </p>
              </>
            ) : (
              <p>Loading…</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
