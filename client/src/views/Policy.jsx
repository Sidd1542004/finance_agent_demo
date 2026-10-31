import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { when } from '../format.js';
import { useBusy } from '../shared.jsx';
import { toDisplay, fromDisplay, displayRange, formatValue, valueProblem, changedValues } from '../policyForm.js';

// Administrators: the agent's adjustable policy, as sliders. The limits come
// from the server, which checks every value again, saves it in MongoDB and
// logs the change. None of these values approves anything.
export default function Policy({ onError, onNotice, onSaved }) {
  const [view, setView] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, run] = useBusy(onError);

  const show = useCallback((v) => {
    setView(v);
    setDraft(Object.fromEntries(v.settings.map((s) => [s.key, s.value])));
  }, []);

  useEffect(() => {
    api
      .policy()
      .then(show)
      .catch((err) => onError(err.message));
  }, [show, onError]);

  if (!view) return null;
  const changes = changedValues(view.settings, draft);
  const problems = view.settings.map((s) => valueProblem(s, draft[s.key])).filter(Boolean);
  const anySaved = view.settings.some((s) => s.saved);
  const working = Boolean(busy);

  const save = (key, fn, message) =>
    run(key, async () => {
      show(await fn());
      onNotice?.(message);
      onSaved?.();
    });

  return (
    <section className="panel policy">
      <h2>Agent policy</h2>
      <p className="hint">
        These decide whether an invoice is only eligible for a person to approve, or goes to a person with reasons. The agent never approves or pays, whatever they are set to.
        Saved here, they replace the values in server/.env until you reset them.
      </p>
      {view.settings.map((s) => {
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
              {s.help} Default: {formatValue(s, s.default)}
              {s.saved ? '; a saved value is in use.' : '.'}
            </p>
          </div>
        );
      })}
      {problems.length > 0 && (
        <p className="form-hint" role="alert">
          {problems.join(' ')}
        </p>
      )}
      <div className="decision-actions">
        <button
          className="btn btn-primary"
          disabled={working || !Object.keys(changes).length || problems.length > 0}
          onClick={() => save('policy-save', () => api.savePolicy(changes), 'The agent policy was saved. It applies to invoices and emails processed from now on.')}
        >
          Save policy
        </button>
        <button className="btn btn-outline" disabled={working || !Object.keys(changes).length} onClick={() => show(view)}>
          Undo changes
        </button>
        <button
          className="btn btn-outline"
          disabled={working || !anySaved}
          onClick={() => {
            if (window.confirm('Go back to the values in server/.env (or the built-in defaults)?'))
              save('policy-reset', () => api.resetPolicy(), 'The agent policy is back to its defaults.');
          }}
        >
          Reset to defaults
        </button>
      </div>
      {view.updatedAt && (
        <p className="hint">
          Last changed {when(view.updatedAt)} by {view.updatedBy}. Invoices already processed keep their result until they are processed again.
        </p>
      )}
    </section>
  );
}
