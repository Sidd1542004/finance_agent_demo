import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { money, day, when, QUERY_STATUS, STATUS } from '../format.js';
import { Rail, Checks, Reasons, RecordList, AuditTrail, useBusy, useRecords } from '../shared.jsx';

const INTENT = {
  payment_status: 'Payment status question',
  bank_details_change: 'Change of bank or payment details',
  dispute: 'Dispute or complaint',
  other: 'Something else',
};

export default function QueriesView({ onError }) {
  const records = useRecords(api.queries, api.query, onError);
  const [busy, run] = useBusy(onError);
  const [samples, setSamples] = useState([]);

  useEffect(() => {
    api.querySamples().then(setSamples).catch((err) => onError(err.message));
  }, [onError]);

  const process = (call) =>
    run('process', async () => {
      const data = await call();
      await records.show(data, data.query._id, { fresh: true });
    });

  const resolve = (body) =>
    run('resolve', async () => {
      try {
        const data = await api.resolveQuery(records.selectedId, body);
        await records.show(data, data.query._id);
      } catch (err) {
        // Someone else may have handled it: show the current state with the message.
        records.select(records.selectedId);
        records.refresh().catch(() => {});
        throw err;
      }
    });

  const rows = records.items.map((q) => ({
    id: q._id,
    title: q.subject || 'No subject',
    status: QUERY_STATUS[q.status] || QUERY_STATUS.received,
    meta: q.supplier?.name || q.from,
  }));

  return (
    <div className="layout">
      <aside className="side">
        <AddEmail samples={samples} busy={busy === 'process'} disabled={Boolean(busy)} onSample={(id) => process(() => api.processQuerySample(id))} onEmail={(email) => process(() => api.processQuery(email))} />
        <section className="card">
          <h2>Emails</h2>
          <RecordList rows={rows} selectedId={records.selectedId} onSelect={records.select} empty="No emails yet. Process a sample above. The samples refer to the demo month, so load that first." />
        </section>
      </aside>

      <main className="main">
        {records.detail ? (
          <QueryDetail
            key={records.detail.query._id}
            data={records.detail}
            fresh={records.freshId === records.detail.query._id}
            busy={busy}
            onResolve={resolve}
            onRerun={() => process(() => api.rerunQuery(records.detail.query._id))}
          />
        ) : (
          <div className="blank">
            {records.loaded ? (
              <>
                <h1>Give the agent a supplier email</h1>
                <p>
                  The agent works out which invoices the supplier is asking about, looks them up, and replies with the status from the accounts
                  records. Anything about bank details, a dispute or an address it does not recognise goes to a person instead.
                </p>
              </>
            ) : (
              <p>Loading…</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function AddEmail({ samples, busy, disabled, onSample, onEmail }) {
  const [sampleId, setSampleId] = useState('');
  const [writing, setWriting] = useState(false);
  const [email, setEmail] = useState({ from: '', subject: '', body: '' });
  const sample = samples.find((s) => s.id === sampleId) || samples[0];
  const set = (field) => (e) => setEmail((prev) => ({ ...prev, [field]: e.target.value }));

  return (
    <section className="card add">
      <h2>Add a supplier email</h2>
      <label className="field-label" htmlFor="q-sample">
        Sample email
      </label>
      <select id="q-sample" value={sample?.id || ''} onChange={(e) => setSampleId(e.target.value)} disabled={disabled}>
        {samples.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
      {sample && <p className="hint">{sample.hint}</p>}
      <button className="btn btn-primary btn-block" disabled={disabled || !sample} onClick={() => onSample(sample.id)}>
        {busy ? 'Processing…' : 'Process this email'}
      </button>
      <div className="add-alt add-alt-one">
        <button className="btn btn-outline" aria-expanded={writing} onClick={() => setWriting((w) => !w)} disabled={disabled}>
          Paste an email
        </button>
      </div>
      {writing && (
        <div className="paste">
          <label className="field-label" htmlFor="q-from">
            From
          </label>
          <input id="q-from" type="text" value={email.from} onChange={set('from')} placeholder="name@supplier.example" />
          <label className="field-label" htmlFor="q-subject">
            Subject
          </label>
          <input id="q-subject" type="text" value={email.subject} onChange={set('subject')} />
          <label className="field-label" htmlFor="q-body">
            Message
          </label>
          <textarea id="q-body" rows={6} value={email.body} onChange={set('body')} />
          <button
            className="btn btn-primary btn-block"
            disabled={disabled || !email.from.trim() || !email.body.trim()}
            onClick={() => {
              onEmail(email);
              setWriting(false);
            }}
          >
            Process pasted email
          </button>
        </div>
      )}
    </section>
  );
}

function QueryDetail({ data, fresh, busy, onResolve, onRerun }) {
  const { query, run, message } = data;
  const status = QUERY_STATUS[query.status] || QUERY_STATUS.received;
  const u = query.understood;

  return (
    <article className="detail">
      <header className="detail-head">
        <div className="detail-title">
          <h1>{query.subject || 'No subject'}</h1>
          <p className="detail-sub">{query.from}</p>
          <p className="detail-meta">Received {when(query.createdAt)}</p>
        </div>
        <div className="detail-amount">
          <span className={`status status-lg status-${status.tone}`}>{status.label}</span>
        </div>
      </header>

      <Rail steps={run?.steps || []} fresh={fresh} />

      <QueryOutcome query={query} message={message} busy={busy} onResolve={onResolve} onRerun={onRerun} />

      <div className="panels">
        <section className="panel">
          <h2>Email from the supplier</h2>
          <pre className="letter">{query.body}</pre>
        </section>

        {u && (
          <section className="panel">
            <h2>What the agent understood</h2>
            <dl className="fields">
              <div>
                <dt>Request</dt>
                <dd>{INTENT[u.intent] || INTENT.other}</dd>
              </div>
              <div>
                <dt>Supplier</dt>
                <dd className={query.supplier ? undefined : 'missing'}>{query.supplier?.name || 'Sender not recognised'}</dd>
              </div>
              <div>
                <dt>Invoices mentioned</dt>
                <dd className={u.invoiceNumbers.length ? undefined : 'missing'}>{u.invoiceNumbers.join(', ') || 'None'}</dd>
              </div>
            </dl>

            {query.matchedInvoices?.length > 0 && (
              <div className="table-scroll">
                <table className="lines lines-narrow">
                  <thead>
                    <tr>
                      <th scope="col">Invoice</th>
                      <th scope="col">In our records</th>
                      <th scope="col" className="num">
                        Amount
                      </th>
                      <th scope="col">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.matchedInvoices.map((m) => (
                      <tr key={m.invoiceNumber}>
                        <td>{m.invoiceNumber}</td>
                        <td>
                          {m.belongsToSender
                            ? m.paymentStatus === 'paid'
                              ? `Paid${m.paidOn ? ` on ${day(m.paidOn)}` : ''}`
                              : STATUS[m.status]?.label || m.status
                            : query.supplier
                              ? 'Not on file for this supplier'
                              : 'Not shown: sender not recognised'}
                        </td>
                        <td className="num">{m.belongsToSender ? money(m.total) : '—'}</td>
                        <td>{m.belongsToSender && m.dueDate ? day(m.dueDate) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {query.reading && (
              <p className="hint">
                Read by the {query.reading.method === 'groq' ? `AI reader (${query.reading.model})` : 'keyword reader'}, {Math.round(query.reading.confidence * 100)}% confident.
                {query.reading.notes ? ` ${query.reading.notes}` : ''}
              </p>
            )}
          </section>
        )}

        {query.checks?.length > 0 && (
          <section className="panel">
            <h2>Checks</h2>
            <Checks checks={query.checks} />
          </section>
        )}
      </div>

      <AuditTrail steps={run?.steps} />
    </article>
  );
}

function QueryOutcome({ query, message, busy, onResolve, onRerun }) {
  const [name, setName] = useState('');
  const [reply, setReply] = useState(query.draft?.body || '');
  const [note, setNote] = useState('');
  const reasons = query.decision?.reasons || [];
  const working = Boolean(busy);
  const sent = message?.status === 'sent' ? message : null;

  if (query.status === 'needs_person') {
    return (
      <section className="outcome outcome-wait" aria-labelledby="q-decision">
        <h2 id="q-decision">The agent did not reply and needs your decision</h2>
        <Reasons reasons={reasons} />
        <div className="decision-form">
          <label className="field-label" htmlFor="q-reply">
            Reply to the supplier{query.draft ? ' (drafted by the agent from the records, edit as needed)' : ''}
          </label>
          <textarea id="q-reply" rows={query.draft ? 12 : 5} value={reply} onChange={(e) => setReply(e.target.value)} />
          <div className="decision-fields">
            <div>
              <label className="field-label" htmlFor="q-who">
                Your name
              </label>
              <input id="q-who" type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </div>
            <div className="grow">
              <label className="field-label" htmlFor="q-note">
                Note (required to close without a reply)
              </label>
              <input id="q-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <div className="decision-actions">
            <button className="btn btn-primary" disabled={working || !name.trim() || !reply.trim()} onClick={() => onResolve({ action: 'send', decidedBy: name, body: reply, note })}>
              Send reply
            </button>
            <button className="btn btn-danger" disabled={working || !name.trim() || !note.trim()} onClick={() => onResolve({ action: 'close', decidedBy: name, note })}>
              Close without replying
            </button>
            <button className="btn btn-outline" disabled={working} onClick={onRerun}>
              {busy === 'process' ? 'Processing…' : 'Process again'}
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (query.status === 'answered') {
    const r = query.resolution;
    return (
      <section className="outcome outcome-ok">
        <h2>{r ? `Reply sent by ${r.decidedBy}` : 'Answered by the agent'}</h2>
        {sent ? (
          <>
            <p className="outcome-note">
              To {sent.to}, {when(sent.sentAt)}. Subject: {sent.subject}
            </p>
            <pre className="letter">{sent.body}</pre>
            <p className="outcome-note">This is a sample outbox. Nothing was actually emailed.</p>
          </>
        ) : (
          <p>No reply was found in the outbox.</p>
        )}
        {r?.note && <p className="outcome-note">Note: {r.note}</p>}
        {r && reasons.length > 0 && (
          <>
            <p className="outcome-note">The agent had flagged:</p>
            <Reasons reasons={reasons} />
          </>
        )}
      </section>
    );
  }

  if (query.status === 'closed') {
    return (
      <section className="outcome">
        <h2>Closed without a reply by {query.resolution?.decidedBy}</h2>
        <p>{query.resolution?.note}</p>
        <p className="outcome-note">{when(query.resolution?.decidedAt)}. The agent had flagged:</p>
        <Reasons reasons={reasons} />
      </section>
    );
  }

  if (query.status === 'failed') {
    return (
      <section className="outcome outcome-err">
        <h2>The agent could not finish this email</h2>
        <Reasons reasons={reasons} />
        <p className="outcome-note">Nothing was sent. Fix the cause, then process it again.</p>
        <div className="decision-actions">
          <button className="btn btn-primary" disabled={working} onClick={onRerun}>
            {busy === 'process' ? 'Processing…' : 'Process again'}
          </button>
        </div>
      </section>
    );
  }

  return null;
}
