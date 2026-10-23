import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { abn, when, hasRole } from '../format.js';
import { RecordList, useBusy } from '../shared.jsx';

// Suppliers' bank details (SIMULATED only). One person proposes a change, a
// different approver or administrator approves it. Payments to a supplier
// are blocked until its details are verified and while a change is pending.
const STATE = {
  verified: { label: 'Verified', tone: 'ok' },
  change_pending: { label: 'Change waiting for approval', tone: 'wait' },
  unverified: { label: 'Not verified', tone: 'err' },
};
const EMPTY = { accountName: '', bsb: '', accountNumber: '', billerCode: '', crn: '', cardToken: '', reason: '' };

export default function SuppliersView({ user, onError }) {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState(null);
  const [busy, run] = useBusy(onError);

  const load = useCallback(async () => {
    const { items: list } = await api.suppliers();
    setItems(list);
    return list;
  }, []);

  useEffect(() => {
    load()
      .then((list) => setSelected((s) => s || list[0]?.abn || null))
      .catch((err) => onError(err.message));
  }, [load, onError]);

  useEffect(() => {
    if (!selected) return;
    api
      .supplierHistory(selected)
      .then(setHistory)
      .catch((err) => onError(err.message));
  }, [selected, onError, items]);

  const supplier = items.find((s) => s.abn === selected) || null;
  const act = (key, fn) =>
    run(key, async () => {
      await fn();
      await load();
    });

  return (
    <div className="layout">
      <aside className="side">
        <section className="card">
          <h2>Suppliers</h2>
          <p className="hint">Bank details here are simulated. Real bank details are never stored.</p>
          <RecordList
            rows={items.map((s) => ({ id: s.abn, title: s.name, status: STATE[s.state], meta: `ABN ${abn(s.abn)}` }))}
            selectedId={selected}
            onSelect={setSelected}
            empty="No suppliers on file."
          />
        </section>
      </aside>
      <main className="main">
        {supplier ? (
          <SupplierDetail supplier={supplier} history={history} user={user} busy={busy} act={act} />
        ) : (
          <div className="blank">
            <p>Choose a supplier.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function SupplierDetail({ supplier: s, history, user, busy, act }) {
  const [form, setForm] = useState(EMPTY);
  const [note, setNote] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const p = s.pending;
  const mine = p && p.proposedById === user.id;
  const canApprove = p && !mine && hasRole(user, 'approver', 'admin');
  const canPropose = !p && hasRole(user, 'payer', 'admin');
  const b = s.beneficiary;
  const working = Boolean(busy);

  return (
    <article className="detail">
      <header className="detail-head">
        <div className="detail-title">
          <h1>{s.name}</h1>
          <p className="detail-sub">ABN {abn(s.abn)}</p>
          <p className="detail-meta">{s.email || 'No email on file'}</p>
        </div>
        <div className="detail-amount">
          <span className={`status status-lg status-${STATE[s.state].tone}`}>{STATE[s.state].label}</span>
        </div>
      </header>

      <section className="panel">
        <h2>
          Verified bank details <span className="tag tag-sim">Simulated</span>
        </h2>
        {b ? (
          <dl className="fields">
            <D label="Account name" value={b.accountName} />
            {b.bsb && <D label="BSB and account" value={`${b.bsb} ${b.accountNumber}`} />}
            {b.billerCode && <D label="BPAY" value={`Biller ${b.billerCode}, ref ${b.crn}`} />}
            {b.cardToken && <D label="Card" value={b.cardToken} />}
            <D label="Can be paid by" value={b.methods.join(', ')} />
            <D label="Verified by" value={`${b.verifiedBy}${b.verifiedAt ? `, ${when(b.verifiedAt)}` : ''} (version ${b.version})`} />
          </dl>
        ) : (
          <p className="hint">None. Bank payments (EFT, BPAY, Card) to this supplier are blocked until details are proposed and approved by a second person.</p>
        )}
      </section>

      {p && (
        <section className="outcome outcome-wait">
          <h2>Change proposed by {p.proposedBy}: payments are blocked until it is decided</h2>
          <dl className="fields">
            <D label="Account name" value={p.details.accountName} />
            {p.details.bsb && <D label="BSB and account" value={`${p.details.bsb} ${p.details.accountNumber}`} />}
            {p.details.billerCode && <D label="BPAY" value={`Biller ${p.details.billerCode}, ref ${p.details.crn}`} />}
            {p.details.cardToken && <D label="Card" value={p.details.cardToken} />}
            <D label="Where it came from" value={p.reason} />
            <D label="Proposed" value={when(p.proposedAt)} />
          </dl>
          <p className="outcome-note">Never approve a change only because an email or the AI suggested it: confirm it with the supplier on a number already on file.</p>
          {(canApprove || mine || hasRole(user, 'approver', 'admin')) && (
            <div className="decision-form">
              <div className="decision-fields">
                <div className="grow">
                  <label className="field-label" htmlFor="b-note">
                    Note {mine ? '(required to withdraw)' : '(required to reject)'}
                  </label>
                  <input id="b-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              </div>
              <div className="decision-actions">
                {canApprove && (
                  <button className="btn btn-primary" disabled={working} onClick={() => act('approve', () => api.approveBankDetails(p.id, note))}>
                    Approve the new details
                  </button>
                )}
                {(mine || canApprove) && (
                  <button className="btn btn-danger" disabled={working || !note.trim()} onClick={() => act('reject', () => api.rejectBankDetails(p.id, note))}>
                    {mine ? 'Withdraw my proposal' : 'Reject'}
                  </button>
                )}
              </div>
              {mine && <p className="hint">You proposed this change, so someone else must approve it.</p>}
            </div>
          )}
        </section>
      )}

      {canPropose && (
        <section className="panel">
          <h2>Propose new bank details</h2>
          <p className="hint">
            Simulated details only: BSBs start with 999, cards are tokens like SIMCARD-1234. A different approver or administrator must approve the change before anyone can be
            paid.
          </p>
          <div className="decision-fields">
            <In id="accountName" label="Account name" form={form} set={set} />
            <In id="bsb" label="BSB (999-xxx)" form={form} set={set} />
            <In id="accountNumber" label="Account number" form={form} set={set} />
            <In id="billerCode" label="BPAY biller code" form={form} set={set} />
            <In id="crn" label="BPAY reference (CRN)" form={form} set={set} />
            <In id="cardToken" label="Simulated card token" form={form} set={set} />
          </div>
          <div className="decision-fields">
            <div className="grow">
              <label className="field-label" htmlFor="b-reason">
                Where these details came from, and how they were confirmed (required)
              </label>
              <input id="b-reason" type="text" value={form.reason} onChange={set('reason')} />
            </div>
          </div>
          <div className="decision-actions">
            <button
              className="btn btn-primary"
              disabled={working || !form.reason.trim() || !form.accountName.trim()}
              onClick={() =>
                act('propose', async () => {
                  await api.proposeBankDetails(s.abn, form);
                  setForm(EMPTY);
                })
              }
            >
              Propose for approval
            </button>
          </div>
        </section>
      )}

      {history?.changes?.length > 0 && (
        <section className="panel">
          <h2>History of changes</h2>
          <div className="table-scroll">
            <table className="lines lines-narrow">
              <thead>
                <tr>
                  <th scope="col">Proposed</th>
                  <th scope="col">By</th>
                  <th scope="col">Details</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {history.changes.map((c) => (
                  <tr key={c.id}>
                    <td>{when(c.proposedAt)}</td>
                    <td>{c.proposedBy}</td>
                    <td>
                      {[c.masked.accountName, c.masked.bsb && `${c.masked.bsb} ${c.masked.accountNumber}`, c.masked.billerCode && `BPAY ${c.masked.billerCode}`, c.masked.cardToken]
                        .filter(Boolean)
                        .join(', ')}
                    </td>
                    <td>
                      {c.status}
                      {c.decidedBy ? ` by ${c.decidedBy}` : ''}
                      {c.decisionNote ? `: ${c.decisionNote}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">Every change is also in the audit log.</p>
        </section>
      )}
    </article>
  );
}

function D({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={value ? undefined : 'missing'}>{value || '—'}</dd>
    </div>
  );
}

function In({ id, label, form, set }) {
  return (
    <div>
      <label className="field-label" htmlFor={`b-${id}`}>
        {label}
      </label>
      <input id={`b-${id}`} type="text" value={form[id]} onChange={set(id)} autoComplete="off" />
    </div>
  );
}
