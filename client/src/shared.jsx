// Pieces every workflow screen uses: the six-step rail, the checks list, the
// record list on the left, and two small hooks.

import { useCallback, useEffect, useRef, useState } from 'react';

// The six stages every agent runs, in order.
export const STAGES = [
  ['receive', 'Receive'],
  ['understand', 'Understand'],
  ['decide', 'Decide'],
  ['act', 'Act'],
  ['verify', 'Verify'],
  ['escalate', 'Escalate'],
];

const STEP_NOTE = { error: 'Failed', skipped: 'Skipped' };

export function Rail({ steps, fresh }) {
  return (
    <ol className={`rail ${fresh ? 'rail-fresh' : ''}`} aria-label="What the agent did, step by step">
      {STAGES.map(([id, name], i) => {
        const step = steps.find((s) => s.stage === id);
        let state = 'pending';
        let note = null;
        if (step) {
          state = step.status === 'done' ? 'done' : step.status === 'error' ? 'error' : 'idle';
          note = STEP_NOTE[step.status] || null;
          if (id === 'escalate') {
            state = step.status === 'done' ? 'flag' : step.status === 'error' ? 'error' : 'idle';
            note = step.status === 'done' ? 'Sent to a person' : step.status === 'error' ? 'Failed' : 'Not needed';
          }
        }
        return (
          <li key={id} className={`station station-${state}`} style={{ '--i': i }}>
            <span className="marker" aria-hidden="true">
              {i + 1}
            </span>
            <div className="station-body">
              <p className="station-name">
                {name}
                {note && <span className="station-note">{note}</span>}
              </p>
              <p className="station-text">{step ? step.summary : 'Not run yet.'}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function CheckIcon({ status }) {
  const label = { pass: 'Passed', fail: 'Needs a person', skip: 'Not checked', unverified: 'Not verified' }[status];
  return (
    <span className="check-icon" role="img" aria-label={label}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        {status === 'pass' && <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
        {status === 'fail' && (
          <>
            <path d="M8 3.5v5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="8" cy="12.2" r="1.2" fill="currentColor" />
          </>
        )}
        {status === 'skip' && <path d="M4 8h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
        {status === 'unverified' && <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />}
      </svg>
    </span>
  );
}

export function Checks({ checks }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.id} className={`check check-${c.status}`}>
          <CheckIcon status={c.status} />
          <div>
            <p className="check-label">{c.label}</p>
            <p className="check-detail">{c.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Reasons({ reasons }) {
  return (
    <ul className="reasons">
      {reasons.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}

// The list of records on the left of each screen.
// rows: [{ id, title, right, status: { label, tone }, meta }]
export function RecordList({ rows, selectedId, onSelect, empty }) {
  if (rows.length === 0) return <p className="empty-list">{empty}</p>;
  return (
    <ul className="inv-list">
      {rows.map((row) => (
        <li key={row.id}>
          <button className="inv-item" aria-current={row.id === selectedId ? 'true' : undefined} onClick={() => onSelect(row.id)}>
            <span className="inv-top">
              <span className="inv-vendor">{row.title}</span>
              {row.right && <span className="inv-total">{row.right}</span>}
            </span>
            <span className="inv-bottom">
              <span className={`status status-${row.status.tone}`}>{row.status.label}</span>
              <span className="inv-meta">{row.meta}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// Run one action at a time, with a busy flag and one place for errors.
export function useBusy(onError) {
  const [busy, setBusy] = useState(null);
  const run = useCallback(
    async (kind, action) => {
      setBusy(kind);
      onError(null);
      try {
        await action();
      } catch (err) {
        onError(err.message);
      } finally {
        setBusy(null);
      }
    },
    [onError],
  );
  return [busy, run];
}

// A list of records plus the one that is open. `listFn` and `getFn` must be
// stable functions (the ones from api.js are).
export function useRecords(listFn, getFn, onError) {
  const [items, setItems] = useState([]);
  const [detail, setDetail] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [freshId, setFreshId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const list = await listFn();
    setItems(list);
    return list;
  }, [listFn]);

  const select = useCallback(
    async (id) => {
      const request = ++latest.current;
      setSelectedId(id);
      setFreshId(null);
      try {
        const data = await getFn(id);
        if (request === latest.current) setDetail(data);
      } catch (err) {
        if (request === latest.current) onError(err.message);
      }
    },
    [getFn, onError],
  );

  // Show a record the server just returned. `fresh` replays the six steps.
  const show = useCallback(
    async (data, id, { fresh = false } = {}) => {
      latest.current += 1;
      setDetail(data);
      setSelectedId(id);
      setFreshId(fresh ? id : null);
      // On a phone the result is below the form, so bring it into view.
      if (fresh) requestAnimationFrame(() => document.querySelector('.main')?.scrollIntoView({ block: 'start', behavior: 'auto' }));
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    (async () => {
      try {
        const list = await refresh();
        if (list.length) select(list[0]._id);
      } catch (err) {
        onError(err.message);
      } finally {
        setLoaded(true);
      }
    })();
  }, [refresh, select, onError]);

  return { items, detail, selectedId, freshId, loaded, select, show, refresh };
}

const STAGE_NAME = Object.fromEntries(STAGES);

// Timestamped log of what happened, and who did it: the agent, a fixed rule, or a person.
export function AuditTrail({ steps }) {
  if (!steps?.length) return null;
  const stamp = (iso) => {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `${date} ${time}`;
  };
  return (
    <section className="panel audit">
      <h2>Audit trail</h2>
      <ol>
        {steps.map((s, i) => {
          const who = s.stage === 'human' ? 'Person' : s.stage === 'decide' ? 'Rule' : 'Agent';
          return (
            <li key={i} className={`who-${who.toLowerCase()}`}>
              <time dateTime={s.at}>{stamp(s.at)}</time>
              <span className="who">{who}</span>
              <span className="what">
                {s.stage !== 'human' && <span className="stage">{STAGE_NAME[s.stage] || s.stage}: </span>}
                {s.status === 'error' && <span className="failed">Failed. </span>}
                {s.summary}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
