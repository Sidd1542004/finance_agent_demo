import { useState } from 'react';
import { api } from '../api.js';

// Sign in with email and password. While no account exists and the server has
// ADMIN_SETUP_TOKEN set, the first administrator can be created here.
export default function Login({ setupRequired, setupEnabled, onSignedIn }) {
  const [mode, setMode] = useState(setupRequired && setupEnabled ? 'setup' : 'login');
  const [form, setForm] = useState({ email: '', password: '', name: '', token: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = mode === 'setup' ? await api.setup(form) : await api.login(form.email, form.password);
      onSignedIn(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit} aria-labelledby="login-title">
        <h1 id="login-title">{mode === 'setup' ? 'Create the first administrator' : 'Sign in'}</h1>
        <p className="hint">Finance Operations Agent. Payments use a simulated bank: no real money moves.</p>
        {setupRequired && !setupEnabled && (
          <p className="form-hint">
            No account exists yet. Create the first administrator from a terminal: <code>npm run create-admin --prefix server</code>.
          </p>
        )}
        {mode === 'setup' && (
          <>
            <label className="field-label" htmlFor="l-token">
              Setup token (ADMIN_SETUP_TOKEN)
            </label>
            <input id="l-token" type="password" value={form.token} onChange={set('token')} autoComplete="off" required />
            <label className="field-label" htmlFor="l-name">
              Your name
            </label>
            <input id="l-name" type="text" value={form.name} onChange={set('name')} autoComplete="name" required />
          </>
        )}
        <label className="field-label" htmlFor="l-email">
          Email
        </label>
        <input id="l-email" type="email" value={form.email} onChange={set('email')} autoComplete="username" required />
        <label className="field-label" htmlFor="l-password">
          Password{mode === 'setup' ? ' (at least 12 characters)' : ''}
        </label>
        <input id="l-password" type="password" value={form.password} onChange={set('password')} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} required />
        {error && (
          <p className="form-hint" role="alert">
            {error}
          </p>
        )}
        <div className="decision-actions">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Working…' : mode === 'setup' ? 'Create and sign in' : 'Sign in'}
          </button>
          {setupRequired && setupEnabled && (
            <button type="button" className="btn btn-outline" onClick={() => setMode(mode === 'setup' ? 'login' : 'setup')}>
              {mode === 'setup' ? 'I already have an account' : 'First-time setup'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
