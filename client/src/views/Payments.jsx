import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { money, day, when, zoned, hasRole, PAYMENT_STATUS, BANK_STATUS, NOTICE_KIND } from '../format.js';
import { RecordList, useBusy } from '../shared.jsx';

// Payments by status: scheduled, processing at the (simulated) bank,
// completed, failed, cancelled. A scheduled payment is not a completed one.
const FILTERS = [
  ['queued', 'Scheduled'],
  ['processing', 'Processing'],
  ['paid', 'Completed'],
  ['failed', 'Failed'],
  ['cancelled', 'Cancelled'],
];

export default function PaymentsView({ user, onError }) {
  const [filter, setFilter] = useState('queued');
  const [list, setList] = useState({ items: [], counts: {} });
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [notices, setNotices] = useState({ items: [], delivery: null });
  const [metrics, setMetrics] = useState(null);
  const [busy, run] = useBusy(onError);
  const isAdmin = hasRole(user, 'admin');
  const canNotify = hasRole(user, 'payer', 'reviewer');

  const load = useCallback(async () => {
    const [l, n] = await Promise.all([api.payments(filter), api.paymentNotices('draft')]);
    setList(l);
    setNotices(n);
  }, [filter]);

  const open = useCallback(
    async (id) => {
      setSelectedId(id);
      try {
        setDetail(await api.payment(id));
      } catch (err) {
        onError(err.message);
      }
    },
    [onError],
  );

  useEffect(() => {
    load().catch((err) => onError(err.message));
  }, [load, onError]);

  const refresh = async () => {
    await load();
    if (selectedId) await open(selectedId);
  };

  const runDue = () =>
    run('run', async () => {
      setMetrics(await api.runDuePayments());
      await refresh();
    });

  const send = (id) => run(`send-${id}`, async () => (await api.sendNotice(id), await refresh()));
  const discard = (id) => {
    const note = window.prompt('Why is this notice not being sent?');
    if (note) run(`discard-${id}`, async () => (await api.discardNotice(id, note), await refresh()));
  };

  const rows = list.items.map((p) => ({
    id: p._id,
    title: p.vendorName || 'Supplier',
    right: money(p.amount, p.currency),
    status: PAYMENT_STATUS[p.status] || { label: p.status, tone: 'neutral' },
    meta: `${p.invoiceNumber || ''} · ${p.method || ''}${p.route === 'bank' ? ' · bank' : ''}`,
  }));

  return (
    <div className="layout">
      <aside className="side">
        {isAdmin && (
          <section className="card">
            <h2>Scheduler</h2>
            <p className="hint">Runs the same tick as the scheduler: submits due payments to the simulated bank and picks up what it has completed.</p>
            <button className="btn btn-primary btn-block" onClick={runDue} disabled={Boolean(busy)}>
              {busy === 'run' ? 'Running…' : 'Run due payments now'}
            </button>
            {metrics && (
              <p className="hint">
                Submitted {metrics.jobs.submitted}, completed {metrics.payments.completed}, failed {metrics.payments.failed + metrics.jobs.rejected}, waiting{' '}
                {metrics.jobs.deferred}
                {metrics.jobs.retried ? `, retrying ${metrics.jobs.retried}` : ''}. {metrics.dueRemaining ? `${metrics.dueRemaining} still due.` : ''}
              </p>
            )}
          </section>
        )}
        <section className="card">
          <h2>Payments</h2>
          <div className="tabs tabs-wrap" role="tablist">
            {FILTERS.map(([id, label]) => (
              <button key={id} role="tab" className="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>
                {label} <span className="count">{list.counts?.[id] ?? 0}</span>
              </button>
            ))}
          </div>
          <RecordList rows={rows} selectedId={selectedId} onSelect={open} empty="No payments here." />
        </section>
        <section className="card">
          <h2>Notices waiting for approval</h2>
          {notices.delivery && <p className="hint">{notices.delivery.note}</p>}
          {notices.items.length === 0 ? (
            <p className="empty-list">None.</p>
          ) : (
            <ul className="notices">
              {notices.items.map((n) => (
                <li key={n._id} className="notice">
                  <p>
                    <strong>{NOTICE_KIND[n.kind]}</strong> <span className="hint">to {n.to}</span>
                  </p>
                  <details>
                    <summary>{n.subject}</summary>
                    <pre className="letter">{n.body}</pre>
                  </details>
                  {canNotify && (
                    <div className="decision-actions">
                      <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => send(n._id)}>
                        {busy === `send-${n._id}` ? 'Sending…' : 'Approve and send'}
                      </button>
                      <button className="btn btn-outline" disabled={Boolean(busy)} onClick={() => discard(n._id)}>
                        Discard
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      <main className="main">
        {detail ? (
          <PaymentDetail data={detail} />
        ) : (
          <div className="blank">
            <p>Choose a payment to see its schedule, the simulated bank's transaction and the notices to the supplier.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function PaymentDetail({ data }) {
  const { payment: p, jobs, transaction: t, notices } = data;
  const status = PAYMENT_STATUS[p.status] || { label: p.status, tone: 'neutral' };
  const tz = p.timeZone || undefined;
  return (
    <article className="detail">
      <header className="detail-head">
        <div className="detail-title">
          <h1>Payment for invoice {p.invoiceNumber || ''}</h1>
          <p className="detail-sub">{p.vendorName}</p>
          <p className="detail-meta">
            {p.route === 'bank' ? 'Through the simulated bank' : 'Paid outside the system, recorded by hand'} <span className="tag tag-sim">Simulated: no money moves</span>
          </p>
        </div>
        <div className="detail-amount">
          <span className="amount">{money(p.amount, p.currency)}</span>
          <span className={`status status-lg status-${status.tone}`}>{status.label}</span>
        </div>
      </header>

      <section className="panel">
        <h2>Schedule</h2>
        <dl className="fields">
          <F label="Method" value={p.method} />
          <F label="Runs" value={p.scheduledAt ? zoned(p.scheduledAt, tz) : p.scheduledFor ? day(p.scheduledFor) : null} />
          <F label="Scheduled by" value={p.scheduledBy} />
          <F label="Approved by" value={p.approvalSnapshot?.decidedBy || p.approvedBy} />
          <F label="Schedule version" value={String(p.scheduleVersion || 1)} />
          {p.beneficiary?.masked && <F label="Bank details (verified)" value={`${p.beneficiary.accountName} · v${p.beneficiary.version}`} />}
          <F label="Paid" value={p.paidAmount ? `${money(p.paidAmount, p.currency)}${p.paidOn ? ` on ${day(p.paidOn)}` : ''}` : null} />
          {p.confirmation && <F label="Confirmed by the bank" value={`${p.confirmation.txnRef}, ${zoned(p.confirmation.confirmedAt, tz)}`} />}
          {p.failure && <F label="Why it failed" value={p.failure.reason} />}
        </dl>
      </section>

      {t && (
        <section className="panel">
          <h2>
            Simulated bank transaction <span className="tag tag-sim">Simulated</span>
          </h2>
          <dl className="fields">
            <F label="Reference" value={t.ref} />
            <F label="Status" value={BANK_STATUS[t.status]?.label || t.status} />
            <F label="Amount" value={money(t.amount, t.currency)} />
            <F label="Submitted" value={zoned(t.createdAt, tz)} />
            {t.completesAt && <F label="Completes" value={zoned(t.completesAt, tz)} />}
            {t.settledAt && <F label="Settled" value={zoned(t.settledAt, tz)} />}
            {t.failureMessage && <F label="Bank's reason" value={t.failureMessage} />}
            <F label="Scenario" value={t.scenario} />
          </dl>
        </section>
      )}

      {jobs.length > 0 && (
        <section className="panel">
          <h2>Scheduler jobs</h2>
          <div className="table-scroll">
            <table className="lines lines-narrow">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Status</th>
                  <th scope="col">Runs</th>
                  <th scope="col" className="num">
                    Attempts
                  </th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j._id}>
                    <td>v{j.scheduleVersion}</td>
                    <td>{j.status}</td>
                    <td>{zoned(j.runAt, tz)}</td>
                    <td className="num">{j.attempts}</td>
                    <td>{j.result || j.lastError || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {notices.length > 0 && (
        <section className="panel">
          <h2>Notices to the supplier</h2>
          <ul className="notices">
            {notices.map((n) => (
              <li key={n._id} className="notice">
                <strong>{NOTICE_KIND[n.kind]}</strong> · {n.status}
                {n.sentAt ? ` · ${when(n.sentAt)} by ${n.sentBy}` : ''}
                {n.delivery?.mode && (
                  <span className="hint">
                    {' '}
                    ·{' '}
                    {n.delivery.mode === 'live'
                      ? `emailed to ${n.delivery.deliveredTo}`
                      : n.delivery.mode === 'test_recipient'
                        ? `sent to the test recipient`
                        : 'simulated outbox only'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.history?.length > 0 && (
        <section className="panel history">
          <h2>History</h2>
          <ol>
            {p.history.map((h, i) => (
              <li key={i}>
                <span className="history-when">{when(h.at)}</span> <strong>{h.by}</strong>: {h.event}
                {h.detail ? `. ${h.detail}` : ''}
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}

function F({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={value ? undefined : 'missing'}>{value || '—'}</dd>
    </div>
  );
}
