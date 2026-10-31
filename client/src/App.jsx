import { useCallback, useEffect, useRef, useState } from 'react';
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

// Why connecting a mailbox did not work (codes from server/src/services/ingestion.js).
const CONNECT_ERROR = {
  signin: 'sign in to the dashboard as an administrator first, then connect again.',
  state: 'the sign-in expired, was already used, or was started by someone else. Connect again.',
  denied: 'access was not granted.',
  exchange: 'the provider did not complete the sign-in. Check the OAuth client settings and connect again.',
  scope: 'read access to the mailbox was not granted. Connect again and allow it.',
  config: 'the mail provider is not fully set up on the server.',
};

// What Reset deletes and keeps (server/src/seed/seed.js and services/demoReset.js).
const RESET_SCOPE = [
  'Reset the demo data?',
  '',
  'Deleted: every invoice (with its original PDF), payment and scheduled payment job, supplier email and outbox message, bank statement, month-end report, learned supplier hint, agent run, the record of imported email attachments, and the simulated bank’s account and transactions.',
  'Replaced with the samples: suppliers (with their sample bank details), purchase orders, deliveries; pending bank-detail proposals are removed.',
  'Kept: user accounts and sign-ins, settings, the simulated bank’s test scenarios, connected mailboxes, and the audit log (the reset is added to it).',
  '',
  'Next you will be asked to type RESET.',
].join('\n');

export default function App() {
  const [health, setHealth] = useState(null);
  const [session, setSession] = useState(null); // { user, setupRequired, setupEnabled }
  const [unreachable, setUnreachable] = useState(false);
  const [tab, setTab] = useState('invoices');
  const [openInvoiceId, setOpenInvoiceId] = useState(null); // asked for by another screen
  const openInvoice = useCallback((id) => {
    setOpenInvoiceId(id);
    setTab('invoices');
  }, []);
  const [version, setVersion] = useState(0); // bumped to reload every screen after a reset
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null); // a confirmed outcome, e.g. after Reset
  const [busy, run] = useBusy(setError);

  const loadSession = useCallback(() => api.me().then(setSession), []);

  useEffect(() => {
    Promise.all([api.health().then(setHealth), loadSession()]).catch((err) => {
      setError(err.message);
      setUnreachable(true);
    });
  }, [loadSession]);

  // Back from connecting a mailbox: the server redirects to /?ingestion=connected|error&provider=..&code=..
  // (a code, never a token). Say what happened, open Admin, and tidy the address bar.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const result = q.get('ingestion');
    if (!result) return;
    const name = q.get('provider') === 'outlook' ? 'Outlook' : 'Gmail';
    if (result === 'connected') setNotice(`${name} connected, read-only. Polling is off until you turn it on in Admin > Automatic invoice ingestion.`);
    else setError(`${name} was not connected: ${CONNECT_ERROR[q.get('code')] || 'the sign-in could not be completed.'}`);
    setTab('admin');
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  // Any request that finds the session gone brings back the sign-in page.
  useEffect(() => {
    const onSignedOut = () => setSession((s) => (s?.user ? { user: null, setupRequired: false, setupEnabled: false } : s));
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, []);

  const user = session?.user || null;

  const loadDemo = () => {
    setNotice(null);
    if (!window.confirm('Delete everything and load the demo month? This runs the eight sample invoices through the agent.')) return;
    run('demo', async () => {
      await api.loadDemo();
      setVersion((v) => v + 1);
    });
  };

  // Two confirmations, then the server's answer. The ref stops a double click
  // starting a second reset before the buttons are disabled; the server also
  // refuses a second reset while one is running.
  const resetting = useRef(false);
  const reset = () => {
    if (resetting.current) return;
    setNotice(null);
    if (!window.confirm(RESET_SCOPE)) return;
    const typed = window.prompt('This cannot be undone. Type RESET to delete the demo data.');
    if (typed === null) return;
    if (typed.trim() !== 'RESET') {
      setError('Reset cancelled: the confirmation word did not match. Nothing was deleted.');
      return;
    }
    resetting.current = true;
    run('reset', async () => {
      try {
        const result = await api.reset('RESET');
        setVersion((v) => v + 1);
        setNotice(result.warning || `Reset complete: ${result.total} demo record${result.total === 1 ? '' : 's'} removed and the sample suppliers loaded again.`);
      } finally {
        resetting.current = false;
      }
    });
  };

  const signOut = () =>
    run('logout', async () => {
      await api.logout();
      setSession({ user: null, setupRequired: false, setupEnabled: false });
      setTab('invoices');
    });

  // The server shows nothing to an account with no role; say so instead of failing on every screen.
  const noRole = Boolean(user) && !hasRole(user, ...Object.keys(ROLE_LABEL));
  const tabs = noRole ? [] : TABS.filter(([, , , role]) => !role || hasRole(user, role));
  const View = noRole ? NoRole : (tabs.find(([id]) => id === tab) || tabs[0])[2];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row">
          <span className="brand-name">Finance Operations Agent</span>
          <div className="topbar-right">
            {health && <span className={`reader reader-${health.reader.mode}`}>{health.reader.mode === 'groq' ? `AI on: ${health.reader.model}` : 'AI off: no Groq key set'}</span>}
            {user && health?.demoReset && hasRole(user, 'admin') && (
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
        {user && tabs.length > 0 && (
          <nav className="mainnav" aria-label="Workflows">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                className="mainnav-item"
                aria-current={tab === id ? 'page' : undefined}
                onClick={() => {
                  setOpenInvoiceId(null);
                  setTab(id);
                }}
              >
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
      {notice && !error && (
        <div className="banner banner-ok" role="status">
          <span>{notice}</span>
          <button className="banner-close" onClick={() => setNotice(null)}>
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
        <View
          key={`${tab}-${version}-${tab === 'invoices' ? openInvoiceId || '' : ''}`}
          health={health}
          user={user}
          onError={setError}
          onNotice={setNotice}
          onHealthChange={() => api.health().then(setHealth)}
          openInvoice={openInvoice}
          openId={tab === 'invoices' ? openInvoiceId : null}
        />
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

function NoRole() {
  return (
    <div className="layout">
      <div className="blank">
        <h1>Your account has no role yet</h1>
        <p>Ask an administrator to give you the Reviewer, Approver, Payer or Administrator role, then reload this page.</p>
      </div>
    </div>
  );
}
