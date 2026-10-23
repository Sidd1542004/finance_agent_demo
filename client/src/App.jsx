import { useCallback, useEffect, useState } from 'react';
import { api, SIGNED_OUT } from './api.js';
import { useBusy } from './shared.jsx';
import { hasRole, ROLE_LABEL } from './format.js';
import InvoicesView from './views/Invoices.jsx';
import PaymentsView from './views/Payments.jsx';
import SuppliersView from './views/Suppliers.jsx';
import QueriesView from './views/Queries.jsx';
import ReconciliationView from './views/Reconciliation.jsx';
import ReportView from './views/Report.jsx';
import AdminView from './views/Admin.jsx';
import Login from './views/Login.jsx';

// The Finance Operations Agent's workflows. `admin`: shown to administrators only.
const TABS = [
  ['invoices', 'Invoices', InvoicesView],
  ['payments', 'Payments', PaymentsView],
  ['suppliers', 'Suppliers', SuppliersView],
  ['queries', 'Supplier emails', QueriesView],
  ['bank', 'Bank reconciliation', ReconciliationView],
  ['report', 'Month-end report', ReportView],
  ['admin', 'Admin', AdminView, 'admin'],
];

export default function App() {
  const [health, setHealth] = useState(null);
  const [session, setSession] = useState(null); // { user, setupRequired, setupEnabled }
  const [unreachable, setUnreachable] = useState(false);
  const [tab, setTab] = useState('invoices');
  const [version, setVersion] = useState(0); // bumped to reload every screen after a reset
  const [error, setError] = useState(null);
  const [busy, run] = useBusy(setError);

  const loadSession = useCallback(() => api.me().then(setSession), []);

  useEffect(() => {
    Promise.all([api.health().then(setHealth), loadSession()]).catch((err) => {
      setError(err.message);
      setUnreachable(true);
    });
  }, [loadSession]);

  // Any request that finds the session gone brings back the sign-in page.
  useEffect(() => {
    const onSignedOut = () => setSession((s) => (s?.user ? { user: null, setupRequired: false, setupEnabled: false } : s));
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, []);

  const user = session?.user || null;

  const loadDemo = () => {
    if (!window.confirm('Delete everything and load the demo month? This runs the eight sample invoices through the agent.')) return;
    run('demo', async () => {
      await api.loadDemo();
      setVersion((v) => v + 1);
    });
  };

  const reset = () => {
    if (!window.confirm('Delete every invoice, payment, email, statement and report? Users and the audit log are kept.')) return;
    run('reset', async () => {
      await api.reset();
      setVersion((v) => v + 1);
    });
  };

  const signOut = () =>
    run('logout', async () => {
      await api.logout();
      setSession({ user: null, setupRequired: false, setupEnabled: false });
      setTab('invoices');
    });

  const tabs = TABS.filter(([, , , role]) => !role || hasRole(user, role));
  const View = (tabs.find(([id]) => id === tab) || tabs[0])[2];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <span className="brand-name">Finance Operations Agent</span>
          <div className="topbar-right">
            {health && <span className={`reader reader-${health.reader.mode}`}>{health.reader.mode === 'groq' ? `AI on: ${health.reader.model}` : 'AI off: no Groq key set'}</span>}
            {user && health?.demoMode && hasRole(user, 'admin') && (
              <>
                <button className="btn btn-on-navy" onClick={loadDemo} disabled={Boolean(busy)}>
                  {busy === 'demo' ? 'Loading…' : 'Load demo month'}
                </button>
                <button className="btn btn-on-navy" onClick={reset} disabled={Boolean(busy)}>
                  {busy === 'reset' ? 'Resetting…' : 'Reset'}
                </button>
              </>
            )}
            {user && (
              <span className="whoami">
                <span className="whoami-name">{user.name}</span>
                <span className="whoami-roles">{user.roles.map((r) => ROLE_LABEL[r] || r).join(', ') || 'No role yet'}</span>
                <button className="btn btn-on-navy" onClick={signOut} disabled={Boolean(busy)}>
                  Sign out
                </button>
              </span>
            )}
          </div>
        </div>
        {user && (
          <nav className="mainnav" aria-label="Workflows">
            {tabs.map(([id, label]) => (
              <button key={id} className="mainnav-item" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
        )}
      </header>

      {error && (
        <div className="banner" role="alert">
          <span>{error}</span>
          <button className="banner-close" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {health && session && !user ? (
        <Login
          setupRequired={session.setupRequired}
          setupEnabled={session.setupEnabled}
          onSignedIn={(u) => {
            setError(null);
            setSession({ user: u, setupRequired: false, setupEnabled: false });
          }}
        />
      ) : health && user ? (
        <View key={`${tab}-${version}`} health={health} user={user} onError={setError} />
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
