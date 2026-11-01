import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { when } from '../format.js';
import { useBusy } from '../shared.jsx';

// Administrators: connect a mailbox (read-only), turn polling on or off, sync
// now, and see what happened to each email attachment. Imported invoices are
// ordinary invoices on the Invoices screen. No token or secret ever reaches here.

const STATE = {
  connected: { label: 'Connected', tone: 'ok' },
  disabled: { label: 'Connected, polling off', tone: 'neutral' },
  disconnected: { label: 'Not connected', tone: 'neutral' },
  not_configured: { label: 'Not configured', tone: 'neutral' },
  error: { label: 'Error: reconnect needed', tone: 'err' },
};

const ITEM = {
  imported: { label: 'Imported', tone: 'ok' },
  duplicate: { label: 'Duplicate', tone: 'wait' },
  rejected: { label: 'Rejected', tone: 'err' },
  failed: { label: 'Failed', tone: 'err' },
  pending: { label: 'Waiting', tone: 'wait' },
  processing: { label: 'Processing', tone: 'wait' },
  skipped: { label: 'No invoice', tone: 'neutral' },
};

const FILTERS = [
  ['', 'All'],
  ['imported', 'Imported'],
  ['duplicate', 'Duplicates'],
  ['failed', 'Failed'],
  ['rejected', 'Rejected'],
  ['pending', 'Waiting'],
  ['skipped', 'No invoice'],
];

export default function Ingestion({ onError, onNotice, openInvoice }) {
  const [data, setData] = useState(null);
  const [list, setList] = useState({ items: [], nextCursor: null });
  const [filter, setFilter] = useState('');
  const [busy, run] = useBusy(onError);

  const load = useCallback(async () => {
    const [s, l] = await Promise.all([api.ingestion(), api.ingestionItems({ status: filter || undefined, limit: 25 })]);
    setData(s);
    setList(l);
  }, [filter]);

  useEffect(() => {
    load().catch((err) => onError(err.message));
  }, [load, onError]);

  const act = (key, fn) =>
    run(key, async () => {
      onNotice?.(null);
      await fn();
      await load();
    });

  const more = () =>
    run('more', async () => {
      const next = await api.ingestionItems({ status: filter || undefined, limit: 25, before: list.nextCursor });
      setList((l) => ({ items: [...l.items, ...next.items], nextCursor: next.nextCursor }));
    });

  if (!data) return null;
  const working = Boolean(busy);

  return (
    <section className="panel" aria-labelledby="ingestion-head">
      <h2 id="ingestion-head">Automatic invoice ingestion</h2>
      <p className="hint">
        Reads PDF, JPG and PNG attachments from a mailbox (read-only) and adds them to Invoices, where the agent checks them and a person decides. Nothing is approved or paid
        automatically, and email text is never read. Polled about every {data.settings.pollMinutes} minutes when on; files over {data.settings.maxAttachmentMb} MB are refused.
      </p>

      {data.providers.length === 0 && (
        <p className="hint">
          Not set up on this server. Set INGESTION_PROVIDERS, the provider’s OAuth client and INGESTION_ENCRYPTION_KEY (see docs/ingestion.md), then reload this page.
        </p>
      )}

      {data.providers.map((p) => (
        <Provider key={p.provider} p={p} working={working} busy={busy} act={act} onNotice={onNotice} />
      ))}

      <h3 className="sub-head">What happened to each email</h3>
      <div className="decision-fields">
        <div>
          <label className="field-label" htmlFor="ing-filter">
            Show
          </label>
          <select id="ing-filter" value={filter} onChange={(e) => setFilter(e.target.value)} disabled={working}>
            {FILTERS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {list.items.length === 0 ? (
        <p className="hint">Nothing yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="lines">
            <thead>
              <tr>
                <th scope="col">Received</th>
                <th scope="col">From</th>
                <th scope="col">File</th>
                <th scope="col">Result</th>
                <th scope="col">Invoice</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((i) => {
                const s = ITEM[i.status] || ITEM.pending;
                return (
                  <tr key={i.id}>
                    <td>{i.receivedAt ? when(i.receivedAt) : '—'}</td>
                    <td>{i.from || '—'}</td>
                    <td>
                      {i.filename || <em>{i.subject || 'No subject'}</em>}
                      <span className="hint"> {i.provider === 'outlook' ? 'Outlook' : 'Gmail'}</span>
                    </td>
                    <td>
                      <span className={`status status-${s.tone}`}>{s.label}</span>
                      {i.reason && <p className="hint">{i.reason}</p>}
                      {i.status === 'failed' && i.nextAttemptAt && <p className="hint">Next automatic try: {when(i.nextAttemptAt)}.</p>}
                      {i.duplicateOf && (
                        <p className="hint">
                          {i.status === 'duplicate' ? 'Same file as ' : 'Possible duplicate of '}
                          <InvoiceLink link={i.duplicateOf} openInvoice={openInvoice} />
                          {i.duplicateSignals.length > 0 && i.status !== 'duplicate' ? ` (${i.duplicateSignals.join(', ')})` : ''}.
                        </p>
                      )}
                    </td>
                    <td>{i.invoice ? <InvoiceLink link={i.invoice} openInvoice={openInvoice} /> : '—'}</td>
                    <td>
                      {i.retryable && (
                        <button
                          className="btn btn-outline"
                          disabled={working}
                          onClick={() =>
                            act(`retry-${i.id}`, async () => {
                              const r = await api.retryIngestion(i.id);
                              onNotice?.(r.note || `Retried ${i.filename}: ${ITEM[r.item?.status]?.label || r.item?.status}.`);
                            })
                          }
                        >
                          {busy === `retry-${i.id}` ? 'Retrying…' : 'Retry'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {list.nextCursor && (
        <div className="decision-actions">
          <button className="btn btn-outline" disabled={working} onClick={more}>
            {busy === 'more' ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
    </section>
  );
}

function InvoiceLink({ link, openInvoice }) {
  if (link.missing) return <span>an invoice that no longer exists</span>;
  return (
    <button type="button" className="inline-link" onClick={() => openInvoice?.(link.id)}>
      {link.number ? `Invoice ${link.number}` : 'Open the invoice'}
    </button>
  );
}

function Provider({ p, working, busy, act, onNotice }) {
  const state = STATE[p.state] || STATE.disconnected;
  const c = p.counts;
  const connected = ['connected', 'disabled', 'error'].includes(p.state);

  const connect = () => {
    if (!window.confirm(`Connect ${p.label}? You will sign in with the mailbox account and grant read-only access. Polling stays off until you turn it on.`)) return;
    act(`connect-${p.provider}`, async () => {
      const { url } = await api.connectMailbox(p.provider);
      window.location.assign(url); // the provider's sign-in page; it sends you back here
    });
  };
  const disconnect = () => {
    if (!window.confirm(`Disconnect ${p.label}? Polling stops and the stored access is deleted. Invoices already imported stay.`)) return;
    act(`disconnect-${p.provider}`, async () => {
      await api.disconnectMailbox(p.provider);
      onNotice?.(`${p.label} disconnected.`);
    });
  };
  const sync = () =>
    act(`sync-${p.provider}`, async () => {
      const r = await api.syncMailbox(p.provider);
      if (r.error) throw new Error(`Sync stopped: ${r.error}`);
      onNotice?.(
        `Sync finished: ${r.emailsChecked} new email${r.emailsChecked === 1 ? '' : 's'}, ${r.imported} imported, ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'}, ${r.rejected} rejected, ${r.failed} failed.${r.complete ? '' : ' More is waiting: it continues on the next sync.'}`,
      );
    });
  const toggle = () =>
    act(`enable-${p.provider}`, async () => {
      await api.setIngestionEnabled(p.provider, !p.enabled);
      onNotice?.(`${p.label}: automatic polling ${p.enabled ? 'turned off' : 'turned on'}.`);
    });

  return (
    <div className="ingestion-provider">
      <h3 className="sub-head">
        {p.label} <span className={`status status-${state.tone}`}>{state.label}</span>
        {p.syncing && <span className="tag">Syncing…</span>}
      </h3>
      {p.problem && <p className="hint">{p.problem}</p>}
      <dl className="fields">
        <div>
          <dt>Mailbox</dt>
          <dd>
            {p.account || (connected ? 'Connected' : 'Not connected')}, {p.where}
          </dd>
        </div>
        <div>
          <dt>Last checked</dt>
          <dd>{p.lastPollAt ? when(p.lastPollAt) : 'Never'}</dd>
        </div>
        <div>
          <dt>Last successful sync</dt>
          <dd>{p.lastSuccessAt ? when(p.lastSuccessAt) : 'Never'}</dd>
        </div>
        <div>
          <dt>Emails checked</dt>
          <dd>{c.emails}</dd>
        </div>
        <div>
          <dt>Imported</dt>
          <dd>{c.imported}</dd>
        </div>
        <div>
          <dt>Duplicates</dt>
          <dd>{c.duplicates}</dd>
        </div>
        <div>
          <dt>Failed / rejected</dt>
          <dd>
            {c.failed} / {c.rejected}
          </dd>
        </div>
        <div>
          <dt>Waiting</dt>
          <dd>{c.pending}</dd>
        </div>
        {p.connectedBy && (
          <div>
            <dt>Connected by</dt>
            <dd>
              {p.connectedBy}, {when(p.connectedAt)}
            </dd>
          </div>
        )}
      </dl>
      {p.lastError && (
        <p className="hint ingestion-error" role="status">
          Last error ({when(p.lastError.at)}): {p.lastError.message}
        </p>
      )}
      <div className="decision-actions">
        {p.state === 'disconnected' && (
          <button className="btn btn-primary" disabled={working} onClick={connect}>
            {busy === `connect-${p.provider}` ? 'Opening…' : `Connect ${p.label}`}
          </button>
        )}
        {p.state === 'error' && (
          <button className="btn btn-primary" disabled={working} onClick={connect}>
            Reconnect
          </button>
        )}
        {connected && (
          <>
            <button className="btn btn-outline" disabled={working} onClick={toggle}>
              {p.enabled ? 'Turn polling off' : 'Turn polling on'}
            </button>
            <button className="btn btn-outline" disabled={working || p.syncing} onClick={sync}>
              {busy === `sync-${p.provider}` ? 'Syncing…' : 'Sync inbox now'}
            </button>
            <button className="btn btn-danger" disabled={working} onClick={disconnect}>
              Disconnect
            </button>
          </>
        )}
      </div>
    </div>
  );
}
