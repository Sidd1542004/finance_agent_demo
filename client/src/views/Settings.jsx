import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { when } from '../format.js';
import { useBusy } from '../shared.jsx';
import { toDisplay, fromDisplay, displayRange, formatValue, valueProblem, changedValues } from '../policyForm.js';

// Administrators: the agent's policy, as three sliders. The server sends the
// limits, checks every value again, saves only from the version shown here
// (someone else's save first is refused), and logs every change with the
// reason. None of these values approves anything, and none switches off a
// mandatory check.
export default function SettingsView({ onError, onNotice, onHealthChange }) {
  const [view, setView] = useState(null);
  const [draft, setDraft] = useState({});
  const [reason, setReason] = useState('');
  const [busy, run] = useBusy(onError);

  const show = useCallback((v) => {
    setView(v);
    setDraft(Object.fromEntries(v.fields.map((f) => [f.key, f.value])));
    setReason('');
  }, []);
  const load = useCallback(() => api.policySettings().then(show), [show]);

  useEffect(() => {
    load().catch((err) => onError(err.message));
  }, [load, onError]);

  if (!view) return null;
  const settings = view.fields;
  const changes = changedValues(settings, draft);
  const problems = settings.map((s) => valueProblem(s, draft[s.key])).filter(Boolean);
  const working = Boolean(busy);
  const canSave = !working && Object.keys(changes).length > 0 && !problems.length && reason.trim().length >= 3;

  const save = () =>
    run('policy-save', async () => {
      try {
        show(await api.savePolicySettings({ ...changes, expectedVersion: view.version, reason: reason.trim() }));
        onNotice?.('Settings saved. They apply to invoices processed from now on; invoices already processed keep their result until they are processed again.');
        onHealthChange?.();
      } catch (err) {
        // Someone else saved first: show their values, keep nothing of ours.
        if (/saved the settings first/.test(err.message)) await load();
        throw err;
      }
    });

  return (
    <div className="layout">
      <main className="main">
        <section className="panel policy">
          <h2>Agent policy</h2>
          <p className="hint">
            These decide whether an invoice is only eligible for a person to approve, or goes to a person with reasons. The agent never approves or pays, whatever they are set to,
            and they cannot switch off a mandatory check (for example an invoice read by the rules reader while the AI reader was down stays blocked). Version {view.version}
            {view.updatedBy ? `, last changed by ${view.updatedBy.name}${view.updatedAt ? ` ${when(view.updatedAt)}` : ''}` : ''}.
          </p>
          {settings.map((s) => {
            const range = displayRange(s);
            const id = `policy-${s.key}`;
            const moved = draft[s.key] !== s.value;
            return (
              <div className="policy-row" key={s.key}>
                <div className="policy-head">
                  <label className="field-label" htmlFor={id}>
                    {s.label}
                  </label>
                  <output htmlFor={id} className={`policy-value${moved ? ' policy-moved' : ''}`}>
                    {formatValue(s, draft[s.key])}
                  </output>
                </div>
                <input
                  id={id}
                  type="range"
                  min={range.min}
                  max={range.max}
                  step={range.step}
                  value={toDisplay(s, draft[s.key])}
                  disabled={working}
                  aria-describedby={`${id}-help`}
                  onChange={(e) => setDraft((d) => ({ ...d, [s.key]: fromDisplay(s, e.target.value) }))}
                />
                <div className="policy-scale" aria-hidden="true">
                  <span>{formatValue(s, s.min)}</span>
                  <span>{formatValue(s, s.max)}</span>
                </div>
                <p className="hint" id={`${id}-help`}>
                  {s.help} Allowed: {formatValue(s, s.min)} to {formatValue(s, s.max)}. Default: {formatValue(s, s.default)}.
                </p>
              </div>
            );
          })}
          <div className="policy-row">
            <label className="field-label" htmlFor="policy-reason">
              Reason for the change (required, kept in the audit log)
            </label>
            <input id="policy-reason" type="text" value={reason} maxLength={500} disabled={working} onChange={(e) => setReason(e.target.value)} />
          </div>
          {problems.length > 0 && (
            <p className="form-hint" role="alert">
              {problems.join(' ')}
            </p>
          )}
          <div className="decision-actions">
            <button className="btn btn-primary" disabled={!canSave} onClick={save}>
              {busy === 'policy-save' ? 'Saving…' : 'Save'}
            </button>
            <button className="btn btn-outline" disabled={working || !Object.keys(changes).length} onClick={() => show(view)}>
              Undo changes
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Recent changes</h2>
          {view.history.length ? (
            <ul className="policy-history">
              {view.history.map((h, i) => (
                <li key={`${h.at}-${i}`}>
                  <strong>
                    {h.from} to {h.to}
                  </strong>{' '}
                  by {h.actor}, {when(h.at)}: {h.detail}. <span className="hint">Reason: {h.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No changes yet: the values are the defaults from server/.env.</p>
          )}
        </section>
      </main>
    </div>
  );
}
