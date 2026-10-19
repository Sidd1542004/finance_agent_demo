import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { money, abn, acn, day, when, STATUS, AWAITING_DECISION, TO_PAY } from '../format.js';
import { Rail, CheckIcon, AuditTrail } from '../shared.jsx';

// The reviewer's name is remembered on this computer so it does not have to be
// typed for every decision. Storage can be unavailable; the form still works.
const NAME_KEY = 'finance-agent.reviewer';
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
};
const saveName = (name) => {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* not available */
  }
};

export default function InvoicesView({ health, onError }) {
  const setError = onError;
  const [samples, setSamples] = useState([]);
  const [reference, setReference] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [payables, setPayables] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [freshId, setFreshId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const latestRequest = useRef(0);

  const refreshList = useCallback(async () => {
    const [list, due] = await Promise.all([api.invoices(), api.payables().catch(() => null)]);
    setInvoices(list);
    setPayables(due);
    return list;
  }, []);

  const select = useCallback(async (id) => {
    const request = ++latestRequest.current;
    setSelectedId(id);
    setFreshId(null);
    try {
      const data = await api.invoice(id);
      if (request === latestRequest.current) setDetail(data);
    } catch (err) {
      if (request === latestRequest.current) setError(err.message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [s, r, list, due] = await Promise.all([api.samples(), api.reference(), api.invoices(), api.payables().catch(() => null)]);
        setSamples(s);
        setReference(r);
        setInvoices(list);
        setPayables(due);
        if (list.length) select(list[0]._id);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoaded(true);
      }
    })();
  }, [select]);

  // Run an action with a busy flag and one place for errors.
  const run = async (kind, action) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const showProcessed = async (data) => {
    latestRequest.current += 1;
    setDetail(data);
    setSelectedId(data.invoice._id);
    setFreshId(data.invoice._id);
    setFilter('all');
    // On a phone the result is below the form, so bring it into view.
    requestAnimationFrame(() => document.querySelector('.main')?.scrollIntoView({ block: 'start', behavior: 'auto' }));
    await refreshList();
  };

  const processWith = (call) => run('process', async () => showProcessed(await call()));

  // Every person's action goes through the same endpoint; the server checks the
  // status, the role and the note, and refuses anything out of order.
  const act = (action, body) =>
    run(action, async () => {
      try {
        const data = await api.action(selectedId, action, body);
        setDetail(data);
        if (['link_po', 'clear_duplicate', 'rerun'].includes(action)) setFreshId(data.invoice._id);
      } catch (err) {
        // Someone else may have changed it: show the current state alongside the message.
        select(selectedId);
        throw err;
      } finally {
        refreshList().catch(() => {});
      }
    });

  const waiting = invoices.filter((i) => AWAITING_DECISION.includes(i.status) || i.status === 'failed');
  const toPay = invoices.filter((i) => TO_PAY.includes(i.status));
  const shown = filter === 'waiting' ? waiting : filter === 'pay' ? toPay : invoices;

  return (
    <div className="layout">
        <aside className="side">
          <AddInvoice
            samples={samples}
            vision={Boolean(health?.reader?.vision)}
            busy={busy === 'process'}
            disabled={Boolean(busy) || !health}
            onSample={(id) => processWith(() => api.processSample(id))}
            onFile={(file) => processWith(() => api.processFile(file))}
            onText={(text) => processWith(() => api.processText(text))}
          />

          <section className="card">
            <div className="tabs" role="tablist" aria-label="Invoices">
              <button role="tab" aria-selected={filter === 'all'} className="tab" onClick={() => setFilter('all')}>
                All <span className="count">{invoices.length}</span>
              </button>
              <button role="tab" aria-selected={filter === 'waiting'} className="tab" onClick={() => setFilter('waiting')}>
                Needs a person <span className={`count ${waiting.length ? 'count-wait' : ''}`}>{waiting.length}</span>
              </button>
              <button role="tab" aria-selected={filter === 'pay'} className="tab" onClick={() => setFilter('pay')}>
                To pay <span className="count">{toPay.length}</span>
              </button>
            </div>
            {shown.length === 0 ? (
              <p className="empty-list">
                {invoices.length === 0 ? 'No invoices yet. Process a sample above to see the agent work.' : filter === 'pay' ? 'Nothing is approved and waiting to be paid.' : 'Nothing is waiting for a person.'}
              </p>
            ) : (
              <ul className="inv-list">
                {shown.map((inv) => {
                  const status = STATUS[inv.status] || STATUS.received;
                  const score = inv.match?.score?.total;
                  const overdue = inv.due?.state === 'overdue' && !['payment_completed', 'rejected', 'cancelled'].includes(inv.status);
                  return (
                    <li key={inv._id}>
                      <button className="inv-item" aria-current={inv._id === selectedId ? 'true' : undefined} onClick={() => select(inv._id)}>
                        <span className="inv-top">
                          <span className="inv-vendor">{inv.extracted?.vendorName || 'Unread invoice'}</span>
                          <span className="inv-total">{money(inv.extracted?.total, inv.extracted?.currency)}</span>
                        </span>
                        <span className="inv-bottom">
                          <span className={`status status-${status.tone}`}>{status.label}</span>
                          <span className="inv-meta">
                            {overdue && <span className="tag tag-err">Overdue</span>}
                            {inv.recovery?.status === 'open' && <span className="tag tag-err">Recovery</span>}
                            {typeof score === 'number' && <span className="tag">{score}%</span>}
                            {inv.extracted?.invoiceNumber || when(inv.createdAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {payables && <Payables data={payables} onSelect={select} />}
          {health && <Rules health={health} />}
          {reference && <Reference data={reference} />}
        </aside>

        <main className="main">
          {invoices.length > 0 && <Kpis invoices={invoices} />}
          {detail ? (
            <Detail
              key={detail.invoice._id}
              data={detail}
              fresh={freshId === detail.invoice._id}
              busy={busy}
              onAct={act}
            />
          ) : (
            <div className="blank">
              {!loaded ? (
                <p>Loading…</p>
              ) : !health ? (
                <>
                  <h1>The server is not answering</h1>
                  <p>
                    Start MongoDB, then run <code>npm run dev</code> in the project folder and reload this page.
                  </p>
                </>
              ) : (
                <>
                  <h1>Give the agent an invoice</h1>
                  <p>
                    Pick a sample on the left and process it. The agent reads the invoice, checks the supplier and tax, matches it to the purchase
                    order and what was delivered, and scores the match. It never approves or pays: a clean invoice goes to you as eligible for
                    approval, anything else goes to you with the reasons.
                  </p>
                </>
              )}
            </div>
          )}
        </main>
    </div>
  );
}

function AddInvoice({ samples, vision, busy, disabled, onSample, onFile, onText }) {
  const [sampleId, setSampleId] = useState('');
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  const sample = samples.find((s) => s.id === sampleId) || samples[0];

  return (
    <section className="card add">
      <h2>Add an invoice</h2>

      <label className="field-label" htmlFor="sample">
        Sample invoice
      </label>
      <select id="sample" value={sample?.id || ''} onChange={(e) => setSampleId(e.target.value)} disabled={disabled}>
        {samples.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
      {sample && (
        <p className="hint">
          {sample.vendorName}, {money(sample.total)}. {sample.hint}
        </p>
      )}
      <button className="btn btn-primary btn-block" disabled={disabled || !sample} onClick={() => onSample(sample.id)}>
        {busy ? 'Processing…' : 'Process this sample'}
      </button>

      <div className="add-alt">
        <label className={`btn btn-outline file-btn ${disabled ? 'is-disabled' : ''}`}>
          Upload a file
          <input
            className="sr-only"
            type="file"
            accept={vision ? '.pdf,.txt,.jpg,.jpeg,.png,application/pdf,text/plain,image/jpeg,image/png' : '.pdf,.txt,application/pdf,text/plain'}
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) onFile(file);
            }}
          />
        </label>
        <button className="btn btn-outline" aria-expanded={pasting} onClick={() => setPasting((p) => !p)} disabled={disabled}>
          Paste text
        </button>
      </div>
      <p className="hint">
        {vision ? 'PDF, JPG, PNG or text, up to 4 MB. Scans and photos are read by the AI vision reader and always go to a person to confirm.' : 'PDF or text, up to 4 MB. Scans and photos need the AI reader (a Groq key).'}
      </p>

      {pasting && (
        <div className="paste">
          <label className="field-label" htmlFor="paste">
            Invoice text
          </label>
          <textarea id="paste" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the text of an invoice here" />
          <button
            className="btn btn-primary btn-block"
            disabled={disabled || !text.trim()}
            onClick={() => {
              onText(text);
              setText('');
              setPasting(false);
            }}
          >
            Process pasted invoice
          </button>
        </div>
      )}
    </section>
  );
}

function Rules({ health }) {
  const policy = health.policy;
  return (
    <section className="card rules">
      <h2>Rules the agent follows</h2>
      <dl>
        <div>
          <dt>Match score for approval review</dt>
          <dd>{policy.matchThreshold}% or more</dd>
        </div>
        <div>
          <dt>Approves or pays on its own</dt>
          <dd>Never</dd>
        </div>
        <div>
          <dt>Unit price may differ from the order by</dt>
          <dd>{policy.priceTolerancePct}%</dd>
        </div>
        <div>
          <dt>Minimum reading confidence</dt>
          <dd>{Math.round(policy.minConfidence * 100)}%</dd>
        </div>
        <div>
          <dt>Australian invoice with no ABN</dt>
          <dd>{policy.missingAbn === 'hold' ? 'On Hold' : 'Needs Review'}</dd>
        </div>
        <div>
          <dt>ABN register lookup</dt>
          <dd>{health.abr ? 'On' : 'Off (unverified)'}</dd>
        </div>
        <div>
          <dt>Approver can also pay</dt>
          <dd>{policy.segregateDuties ? 'No' : 'Yes'}</dd>
        </div>
      </dl>
      <p className="hint">
        A score at or above the threshold makes an invoice eligible for a person to approve. It is never approved or paid automatically, and a
        failed mandatory check still stops it. Change these in server/.env.
      </p>
    </section>
  );
}

function Reference({ data }) {
  const received = (poNumber, sku) =>
    data.goodsReceipts.filter((r) => r.poNumber === poNumber).reduce((sum, r) => sum + r.lines.filter((l) => l.sku === sku).reduce((s, l) => s + l.qty, 0), 0);
  return (
    <details className="card reference">
      <summary>Purchase orders on file ({data.purchaseOrders.length})</summary>
      {data.purchaseOrders.map((po) => (
        <div className="po" key={po.poNumber}>
          <p className="po-head">
            <strong>{po.poNumber}</strong> {po.vendorName}
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="num">
                  Ordered
                </th>
                <th scope="col" className="num">
                  Received
                </th>
                <th scope="col" className="num">
                  Price
                </th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((l) => (
                <tr key={l.sku}>
                  <td>{l.sku}</td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{received(po.poNumber, l.sku)}</td>
                  <td className="num">{money(l.unitPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </details>
  );
}

const daysFromToday = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  const now = new Date();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
};

function Payables({ data, onSelect }) {
  const rows = [...data.overdue, ...data.dueSoon];
  return (
    <section className="card payables">
      <h2>Due and overdue</h2>
      <dl className="cash">
        <div>
          <dt>Approved, due in 7 days</dt>
          <dd>{money(data.cash.approvedDue7)}</dd>
        </div>
        <div>
          <dt>Approved, due in 30 days</dt>
          <dd>{money(data.cash.approvedDue30)}</dd>
        </div>
        <div>
          <dt>Awaiting a decision, due in 7 days</dt>
          <dd>{money(data.cash.awaitingDecisionDue7)}</dd>
        </div>
      </dl>
      {rows.length === 0 ? (
        <p className="hint">Nothing unpaid is overdue or due in the next 7 days.</p>
      ) : (
        <ul className="due-list">
          {rows.map((r) => (
            <li key={r.id}>
              <button className="link-btn" onClick={() => onSelect(r.id)}>
                <span>
                  {r.invoiceNumber || 'No number'} · {r.vendorName || 'Unknown supplier'}
                </span>
                <span className={r.state === 'overdue' ? 'due-over' : 'due-soon'}>
                  {r.state === 'overdue' ? `${Math.abs(r.daysUntil)} days overdue` : r.daysUntil === 0 ? 'due today' : `due in ${r.daysUntil} days`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">Australian dollars only. {data.noDueDate ? `${data.noDueDate} unpaid invoice(s) have no due date.` : ''}</p>
    </section>
  );
}

function Detail({ data, fresh, busy, onAct }) {
  const { invoice, run, payment } = data;
  const e = invoice.extracted || {};
  const cur = e.currency || 'AUD';
  const status = STATUS[invoice.status] || STATUS.received;
  const steps = run?.steps || [];
  const sourceLabel = { sample: 'from the sample set', upload: 'as an uploaded file', paste: 'as pasted text' }[invoice.source?.kind] || '';
  const score = invoice.match?.score;
  const checks = invoice.checks || [];
  const order = { fail: 0, unverified: 1, skip: 2, pass: 3 };
  const sortedChecks = [...checks].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4));
  const exceptions = checks.filter((c) => c.status === 'fail').length;

  return (
    <article className="detail">
      <header className="detail-head">
        <div className="detail-title">
          <h1>{e.invoiceNumber ? `Invoice ${e.invoiceNumber}` : 'Unread invoice'}</h1>
          <p className="detail-sub">{e.vendorName || 'Supplier not identified'}</p>
          <p className="detail-meta">
            Received {when(invoice.createdAt)} {sourceLabel}
            {invoice.source?.filename ? ` (${invoice.source.filename})` : ''}
          </p>
        </div>
        <div className="detail-amount">
          <span className="amount">{money(e.total, cur)}</span>
          <span className={`status status-lg status-${status.tone}`}>{status.label}</span>
          {score && (
            <span className={`score-chip ${score.eligible ? 'score-ok' : 'score-low'}`}>
              Match {score.total}% <small>(threshold {score.threshold}%)</small>
            </span>
          )}
        </div>
      </header>

      <Rail steps={steps} fresh={fresh} />

      <Outcome invoice={invoice} payment={payment} />

      <Actions data={data} busy={busy} onAct={onAct} />

      {invoice.extracted && (
        <>
          <Summary invoice={invoice} exceptions={exceptions} />

          <div className="panels panels-2">
            {score && <ScorePanel score={score} />}
            <section className="panel">
              <h2>
                Checks{' '}
                <span className="panel-count">
                  {exceptions ? `${exceptions} exception${exceptions === 1 ? '' : 's'}` : 'no exceptions'}
                </span>
              </h2>
              <ul className="checks">
                {sortedChecks.map((c) => (
                  <li key={c.id} className={`check check-${c.status}`}>
                    <CheckIcon status={c.status} />
                    <div>
                      <p className="check-label">
                        {c.label}
                        {c.status === 'fail' && <span className={`sev sev-${c.severity}`}>{c.severity === 'hold' ? 'On hold' : 'Review'}</span>}
                        {c.status === 'unverified' && <span className="sev sev-unverified">Unverified</span>}
                      </p>
                      <p className="check-detail">{c.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {invoice.match?.comparison?.length > 0 && <Comparison rows={invoice.match.comparison} po={invoice.match.po} linkedBy={invoice.match.linkedBy} />}

          {invoice.match?.suggestions?.length > 0 && !invoice.matchedPo && (
            <section className="panel">
              <h2>Possible purchase orders</h2>
              <p className="hint">The invoice quotes no purchase order the agent could use. These are suggestions, not confirmed matches: a reviewer must check and link one. Nothing is linked or approved on the amount alone.</p>
              <ul className="suggestions">
                {invoice.match.suggestions.map((s) => (
                  <li key={s.poNumber}>
                    <strong>
                      {s.poNumber} · {s.vendorName}
                    </strong>{' '}
                    <span className="tag">Suggested · {s.score}%</span>{' '}
                    {s.supplierOwnership && s.supplierOwnership !== 'confirmed_by_abn' && <span className="sev sev-review">Supplier not verified</span>}
                    <p className="check-detail">{s.explanation}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            <h2>What the agent read</h2>
            <dl className="fields">
              <Field label="Supplier" value={e.vendorName} />
              {e.gstin ? <Field label="GSTIN" value={e.gstin} /> : <Field label="ABN" value={e.abn ? abn(e.abn) : null} />}
              {e.acn && <Field label="ACN" value={acn(e.acn)} />}
              {e.vatNumber && <Field label="VAT number (not an ABN)" value={e.vatNumber} />}
              <Field label="Customer / Bill to" value={e.customerName} />
              {e.customerAbn && <Field label="Customer ABN" value={abn(e.customerAbn)} />}
              {e.customerAcn && <Field label="Customer ACN" value={acn(e.customerAcn)} />}
              <Field label="Invoice number" value={e.invoiceNumber} />
              <Field label="Purchase order" value={e.poNumber} />
              <Field label="Invoice date" value={e.invoiceDate ? day(e.invoiceDate) : null} />
              <Field label="Due date" value={e.dueDate ? day(e.dueDate) : null} />
              {e.paymentTerms && <Field label="Payment terms" value={e.paymentTerms} />}
              <Field label="Currency" value={cur} />
            </dl>

            {invoice.lineMatches?.length > 0 && (
              <div className="table-scroll">
                <table className="lines">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col" className="num">
                        Invoiced
                      </th>
                      <th scope="col" className="num">
                        Ordered
                      </th>
                      <th scope="col" className="num">
                        Received
                      </th>
                      <th scope="col" className="num">
                        Left on PO
                      </th>
                      <th scope="col" className="num">
                        Invoice price
                      </th>
                      <th scope="col" className="num">
                        Order price
                      </th>
                      <th scope="col" className="num">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoice.lineMatches.map((m, i) => (
                      <tr key={i} className={m.issues?.length ? 'has-issue' : undefined}>
                        <td>
                          <span className="line-name">{m.description || m.sku}</span>
                          {m.sku && m.description && <span className="line-sku">{m.sku}</span>}
                          {m.issues?.map((issue) => (
                            <span className="line-issue" key={issue}>
                              {issue}
                            </span>
                          ))}
                        </td>
                        <td className="num">{m.qtyInvoiced ?? '—'}</td>
                        <td className="num">{m.qtyOrdered ?? '—'}</td>
                        <td className="num">{m.qtyReceived ?? '—'}</td>
                        <td className="num">{m.qtyRemaining ?? '—'}</td>
                        <td className="num">{money(m.priceInvoiced, cur)}</td>
                        <td className="num">{money(m.pricePo, cur)}</td>
                        <td className="num">{money(m.amount, cur)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={7}>
                        Subtotal
                      </th>
                      <td className="num">{money(e.subtotal, cur)}</td>
                    </tr>
                    {e.taxLines?.length > 0 ? (
                      e.taxLines.map((t) => (
                        <tr key={t.type}>
                          <th scope="row" colSpan={7}>
                            {t.type}
                            {typeof t.rate === 'number' ? ` @ ${t.rate}%` : ''}
                          </th>
                          <td className="num">{money(t.amount, cur)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <th scope="row" colSpan={7}>
                          GST
                        </th>
                        <td className="num">{money(e.gst, cur)}</td>
                      </tr>
                    )}
                    <tr className="grand">
                      <th scope="row" colSpan={7}>
                        Total
                      </th>
                      <td className="num">{money(e.total, cur)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {invoice.corrections?.length > 0 && (
              <ul className="corrections">
                {invoice.corrections.map((c, i) => (
                  <li key={i}>
                    <strong>Corrected by {c.by}</strong>: {correctionText(c, cur)} <span className="history-when">{when(c.at)}</span>
                    {c.note && <p className="check-detail">Note: {c.note}</p>}
                  </li>
                ))}
              </ul>
            )}

            {invoice.extraction && (
              <p className="hint">
                Read by the {invoice.extraction.method === 'groq-vision' ? `AI vision reader (${invoice.extraction.model}), from an image` : invoice.extraction.method === 'groq' ? `AI reader (${invoice.extraction.model})` : 'basic pattern reader'},{' '}
                {Math.round(invoice.extraction.confidence * 100)}% confident.
                {invoice.extraction.notes ? ` ${invoice.extraction.notes}` : ''}
              </p>
            )}
          </section>
        </>
      )}

      {payment && <PaymentPanel payment={payment} currency={cur} />}

      <StatusHistory events={invoice.events || []} currency={cur} />

      <AuditTrail steps={steps} />

      <details className="source">
        <summary>Original invoice text</summary>
        <pre>{invoice.rawText}</pre>
      </details>
    </article>
  );
}

// Found and validated / found but not verified / missing / ambiguous - for a
// tax identifier that has already been checked for a valid format (ABN, ACN).
const fmtId = (type, value) => (type === 'ABN' ? abn(value) : type === 'ACN' ? acn(value) : value);
const idState = (id) =>
  !id || id.format === 'missing'
    ? `Missing: no ${id?.type || 'tax number'} on the invoice`
    : !id.value || id.format === 'unknown'
      ? 'Not checked: the tax rules were not identified'
      : id.format === 'invalid'
        ? `Found but invalid: ${fmtId(id.type, id.value)} fails the checksum`
        : id.verification === 'verified'
          ? `Found and validated: ${fmtId(id.type, id.value)}, verified with the register`
          : id.verification === 'failed'
            ? `Found but invalid: ${fmtId(id.type, id.value)}, not active on the register`
            : id.verification === 'not_checked'
              ? `Found, not checked: ${fmtId(id.type, id.value)} (the tax rules were not identified, so it was not validated)`
              : `Found, not verified: ${fmtId(id.type, id.value)} (valid format; identity not verified against the register)`;

// What the agent could tell you about the purchase order match, as one of
// the five states a reviewer needs to see at a glance.
function poMatchStatus(invoice) {
  if (invoice.matchedPo) {
    const poCheck = (invoice.checks || []).find((c) => c.id === 'po_found');
    return poCheck?.status === 'pass' ? 'Matched' : 'Needs review';
  }
  const resolution = invoice.match?.poResolution;
  if (resolution?.how === 'ambiguous') return `Ambiguous: "${resolution.reference}" fits ${resolution.candidates.join(', ')}`;
  const n = invoice.match?.suggestions?.length || 0;
  const suggested = n === 0 ? '' : n === 1 ? 'suggested match (not confirmed)' : `${n} possible matches (not confirmed)`;
  if (resolution?.reference) return `Not found: "${resolution.reference}" is not a known purchase order${suggested ? `; ${suggested}` : ''}`;
  return n === 0 ? 'No match' : suggested.charAt(0).toUpperCase() + suggested.slice(1);
}

// Supplier, tax, PO and due date at a glance.
function Summary({ invoice, exceptions }) {
  const v = invoice.validation || {};
  const id = v.identifier;
  const acnCheck = (invoice.checks || []).find((c) => c.id === 'supplier_acn');
  const juris = { AU: 'Australia (ABN and 10% GST)', IN: 'India (GSTIN and CGST/SGST/IGST)', unknown: 'Not identified' }[v.jurisdiction?.code] || '—';
  const due = invoice.due;
  const days = due?.date ? daysFromToday(due.date) : null;
  const closed = ['payment_completed', 'rejected', 'cancelled'].includes(invoice.status);
  const e = invoice.extracted || {};
  const supplierValue = invoice.supplier?.name
    ? `${invoice.supplier.name} (matched by ${invoice.supplier.by === 'abn' ? 'ABN' : 'name only'})`
    : invoice.supplier?.conflict
      ? e.abn
        ? `Ambiguous: the name matches ${invoice.supplier.conflict.name}, but the ABN does not`
        : `Ambiguous: the name is similar to ${invoice.supplier.conflict.name}, with no ABN to confirm it`
      : null;
  const poStatus = poMatchStatus(invoice);
  return (
    <section className="panel summary">
      <h2>Summary</h2>
      <dl className="fields">
        <Field label="Tax rules" value={juris} />
        <Field label="Supplier tax number" value={idState(id)} />
        {acnCheck && <Field label="Supplier ACN" value={acnCheck.status === 'fail' ? `Found but invalid: ${acn(e.acn)}` : `Found, not verified: ${acn(e.acn)}`} flag={acnCheck.status === 'fail'} />}
        <Field label="Customer / Bill to" value={e.customerName} missing="Missing" />
        <Field label="Customer ABN" value={e.customerAbn ? abn(e.customerAbn) : null} missing="Not shown on the invoice" />
        <Field
          label="Approved supplier"
          value={supplierValue}
          missing="Supplier not matched"
          flag={Boolean(invoice.supplier?.conflict)}
        />
        <Field label="Purchase order match" value={`${poStatus}${invoice.matchedPo ? `: ${invoice.matchedPo}` : ''}`} flag={poStatus !== 'Matched'} />
        {invoice.match?.linkedBy && <Field label="Linked by" value={`${invoice.match.linkedBy.decidedBy}${invoice.match.linkedBy.note ? `: ${invoice.match.linkedBy.note}` : ''}`} />}
        <Field
          label="Due"
          value={due?.date ? `${day(due.date)}${due.source === 'terms' ? ` (from terms: ${due.terms})` : ''}${closed ? '' : days < 0 ? `, ${-days} days overdue` : days === 0 ? ', due today' : `, in ${days} days`}` : null}
          missing="No due date or terms"
          flag={!closed && days !== null && days < 0}
        />
        <Field label="Exceptions" value={exceptions ? String(exceptions) : 'None'} flag={exceptions > 0} />
      </dl>
    </section>
  );
}

function ScorePanel({ score }) {
  return (
    <section className="panel">
      <h2>
        Match score <span className="panel-count">{score.total}%</span>
      </h2>
      <div className="score-bar" role="img" aria-label={`Match score ${score.total} percent, threshold ${score.threshold} percent`}>
        <span className={`score-fill ${score.eligible ? 'score-ok' : 'score-low'}`} style={{ width: `${Math.min(100, score.total)}%` }} />
        <span className="score-mark" style={{ left: `${score.threshold}%` }} />
      </div>
      <p className="hint">
        {score.eligible
          ? `At or above ${score.threshold}%: eligible for approval review. Not approved, and any failed mandatory check still applies.`
          : `Below ${score.threshold}%: a person must review the differences.`}
      </p>
      <table className="score-table">
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col" className="num">
              Weight
            </th>
            <th scope="col" className="num">
              Points
            </th>
          </tr>
        </thead>
        <tbody>
          {score.components.map((c) => (
            <tr key={c.id}>
              <td>
                <span className="line-name">{c.label}</span>
                <span className="line-sku">{c.detail}</span>
              </td>
              <td className="num">{c.weight}</td>
              <td className="num">{c.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const RESULT = { match: 'Match', mismatch: 'Mismatch', missing: 'Missing', check: 'Check', linked: 'Linked' };

function Comparison({ rows, po, linkedBy }) {
  return (
    <section className="panel">
      <h2>Invoice against {po ? po.poNumber : 'purchase order'}</h2>
      {linkedBy && <p className="hint">Purchase order linked by {linkedBy.decidedBy}{linkedBy.note ? `: ${linkedBy.note}` : ''}.</p>}
      <div className="table-scroll">
        <table className="lines po-compare">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Invoice</th>
              <th scope="col">PO</th>
              <th scope="col">Difference</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.result === 'mismatch' ? 'has-issue' : undefined}>
                <th scope="row">{r.field}</th>
                <td>{r.invoice}</td>
                <td>{r.po}</td>
                <td>{r.difference}</td>
                <td>
                  <span className={`result result-${r.result}`}>{RESULT[r.result] || r.result}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PaymentPanel({ payment, currency }) {
  const label = { queued: 'Scheduled', paid: 'Paid', failed: 'Failed', cancelled: 'Cancelled', on_hold: 'On hold' }[payment.status] || payment.status;
  const paid = payment.paidAmount || 0;
  return (
    <section className="panel">
      <h2>
        Payment <span className="tag tag-sim">Simulated: no money moves</span>
      </h2>
      <dl className="fields">
        <Field label="Status" value={label} flag={payment.status === 'failed'} />
        <Field label="Amount" value={money(payment.amount, currency)} />
        <Field label="Method" value={payment.method} />
        <Field label="Scheduled for" value={payment.scheduledFor ? day(payment.scheduledFor) : null} />
        <Field label="Scheduled by" value={payment.scheduledBy} />
        <Field label="Reference" value={payment.reference} missing="None yet" />
        <Field label="Paid" value={paid ? `${money(paid, currency)}${paid < payment.amount ? ` of ${money(payment.amount, currency)} (part payment)` : ''}` : null} missing="Nothing yet" flag={paid > 0 && paid < payment.amount} />
        <Field label="Paid on" value={payment.paidOn ? day(payment.paidOn) : null} missing="—" />
        {payment.bank && <Field label="Bank line" value={`${payment.bank.description} (${day(payment.bank.date)})`} />}
        {payment.failure && <Field label="Why it failed" value={payment.failure.reason} flag />}
        {payment.recovery && <Field label="Recovery" value={`${payment.recovery.status === 'open' ? 'Open' : 'Closed'}: ${payment.recovery.note}${payment.recovery.closeNote ? ` / ${payment.recovery.closeNote}` : ''}`} flag={payment.recovery.status === 'open'} />}
      </dl>
    </section>
  );
}

function StatusHistory({ events, currency }) {
  if (!events.length) return null;
  return (
    <section className="panel history">
      <h2>Status history</h2>
      <ol>
        {[...events].reverse().map((ev, i) => (
          <li key={i}>
            <p>
              <strong>{ev.actor}</strong> · {STATUS[ev.from]?.label || ev.from || '—'} → {STATUS[ev.to]?.label || ev.to}
              <span className="history-when">{when(ev.at)}</span>
            </p>
            {ev.changes?.length > 0
              ? ev.changes.map((c) => (
                  <p className="check-detail" key={c.field}>
                    Corrected by {ev.actor}: {correctionText(c, currency)}
                  </p>
                ))
              : ev.detail && <p className="check-detail">{ev.detail}</p>}
            {ev.reason && <p className="check-detail">Reason: {ev.reason}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}

// The four counts the landing page shows, under the new lifecycle.
function Kpis({ invoices }) {
  const items = [
    ['In queue', invoices.filter((i) => !['payment_completed', 'rejected', 'cancelled'].includes(i.status)).length],
    ['Matched by agent', invoices.filter((i) => i.decision?.outcome === 'under_review' && i.status !== 'cancelled').length],
    ['Exceptions', invoices.filter((i) => ['needs_review', 'on_hold', 'failed', 'payment_failed'].includes(i.status)).length, true],
    ['Awaiting payment', invoices.filter((i) => TO_PAY.includes(i.status)).length],
  ];
  return (
    <dl className="kpis">
      {items.map(([label, value, flag]) => (
        <div key={label} className={flag ? 'kpi-flag' : undefined}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Field({ label, value, missing = 'Not found', flag = false }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={!value ? 'missing' : flag ? 'flagged' : undefined}>{value || missing}</dd>
    </div>
  );
}

// What state the invoice is in, in words.
function Outcome({ invoice, payment }) {
  const e = invoice.extracted || {};
  const cur = e.currency || 'AUD';
  const reasons = invoice.decision?.reasons || [];
  const score = invoice.match?.score;
  const list = (items) => (
    <ul className="reasons">
      {items.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );

  switch (invoice.status) {
    case 'under_review':
      return (
        <section className="outcome outcome-wait">
          <h2>Eligible for approval: waiting for a person</h2>
          <p>
            Every check passed{score ? ` and the match score is ${score.total}% (threshold ${score.threshold}%)` : ''}. This is not an approval. Nothing is
            paid until a person approves it and then schedules the payment.
          </p>
        </section>
      );
    case 'needs_review':
    case 'on_hold': {
      // Only treat this as "just reopened" while that is still the last thing
      // that happened to it - once a person decides it again, the reopen is
      // just a line in the history below, not the headline.
      const justReopened = invoice.reopened && invoice.events?.at(-1)?.action === 'reopen';
      return (
        <section className="outcome outcome-wait">
          <h2>{justReopened ? 'Reopened for review' : invoice.status === 'on_hold' ? 'On hold: the agent stopped here' : 'Needs review: the agent stopped here'}</h2>
          {justReopened ? (
            <p>
              {invoice.reopened.decidedBy} reopened this invoice{invoice.reopened.from ? ` from ${STATUS[invoice.reopened.from]?.label || invoice.reopened.from}` : ''}: {invoice.reopened.note}
            </p>
          ) : (
            reasons.length > 0 && list(reasons)
          )}
          {justReopened && invoice.reopened.priorDecision && (
            <p className="outcome-note">
              The earlier {invoice.reopened.priorDecision.type} by {invoice.reopened.priorDecision.decidedBy} is kept in the status history below, not deleted.
            </p>
          )}
          {invoice.hold && <p className="outcome-note">Placed on hold by {invoice.hold.decidedBy}: {invoice.hold.note}</p>}
          {invoice.correction && <p className="outcome-note">Corrected invoice requested by {invoice.correction.decidedBy}: {invoice.correction.note}</p>}
        </section>
      );
    }
    case 'approved':
      return (
        <section className="outcome outcome-ok">
          <h2>
            {invoice.approval?.decision === 'approve_received' ? 'Approved for the received quantity only' : 'Approved'} by {invoice.approval?.decidedBy}: not paid
          </h2>
          <p>
            {money(invoice.approval?.amount, cur)} approved{invoice.approval?.amount !== e.total ? ` of ${money(e.total, cur)}` : ''}. No payment is scheduled yet.
          </p>
          <ApprovalNote approval={invoice.approval} />
        </section>
      );
    case 'payment_pending':
      return (
        <section className="outcome outcome-ok">
          <h2>Payment scheduled (simulated)</h2>
          <p>
            {money(payment?.amount, cur)} to {payment?.vendorName || e.vendorName}
            {payment?.scheduledFor ? ` on ${day(payment.scheduledFor)}` : ''} by {payment?.method || 'EFT'}.
            {payment?.paidAmount ? ` ${money(payment.paidAmount, cur)} recorded so far (part payment).` : ' Not paid yet.'}
          </p>
          <ApprovalNote approval={invoice.approval} />
        </section>
      );
    case 'payment_completed':
      return (
        <section className={`outcome ${invoice.recovery?.status === 'open' ? 'outcome-err' : 'outcome-ok'}`}>
          <h2>{invoice.recovery?.status === 'open' ? 'Paid: recovery open' : 'Paid'}</h2>
          <p>
            {money(payment?.paidAmount ?? payment?.amount, cur)} paid{payment?.paidOn ? ` on ${day(payment.paidOn)}` : ''}
            {payment?.reference ? `, reference ${payment.reference}` : ''}
            {payment?.recordedBy ? `, recorded by ${payment.recordedBy}` : ''}. Simulated: no money moved.
          </p>
          {invoice.recovery && (
            <p className="outcome-note">
              Recovery {invoice.recovery.status} by {invoice.recovery.openedBy}: {invoice.recovery.note}
              {invoice.recovery.closeNote ? `. Closed by ${invoice.recovery.closedBy}: ${invoice.recovery.closeNote}` : ''}
            </p>
          )}
        </section>
      );
    case 'payment_failed':
      return (
        <section className="outcome outcome-err">
          <h2>Payment failed</h2>
          <p>{payment?.failure?.reason || 'The payment did not go through.'} Schedule it again once the cause is fixed, or cancel the invoice.</p>
        </section>
      );
    case 'rejected':
      return (
        <section className="outcome outcome-err">
          {invoice.reversal ? (
            <>
              <h2>Approval reversed by {invoice.reversal.decidedBy}</h2>
              <p>{invoice.reversal.note}</p>
              {invoice.reversal.approval && (
                <p className="outcome-note">
                  Originally approved by {invoice.reversal.approval.decidedBy} on {when(invoice.reversal.approval.decidedAt)} for{' '}
                  {money(invoice.reversal.approval.amount, cur)}. Kept for the record.
                </p>
              )}
            </>
          ) : (
            <>
              <h2>Rejected by {invoice.rejection?.decidedBy || invoice.approval?.decidedBy || 'a person'}</h2>
              <p>{invoice.rejection?.note || invoice.approval?.note}</p>
            </>
          )}
          <p className="outcome-note">No payment will be made.</p>
        </section>
      );
    case 'cancelled':
      return (
        <section className="outcome">
          <h2>Cancelled by {invoice.cancellation?.decidedBy}</h2>
          <p>{invoice.cancellation?.note}</p>
          <p className="outcome-note">No payment will be made.</p>
        </section>
      );
    case 'failed':
      return (
        <section className="outcome outcome-err">
          <h2>The agent could not finish this invoice</h2>
          {list(reasons)}
          <p className="outcome-note">No payment exists. Fix the cause, then process it again.</p>
        </section>
      );
    default:
      return null;
  }
}

function ApprovalNote({ approval }) {
  if (!approval) return null;
  return (
    <p className="outcome-note">
      {when(approval.decidedAt)}
      {approval.score !== null && approval.score !== undefined ? `. Match score at approval ${approval.score}%` : ''}
      {approval.exceptions?.length ? `. Approved with ${approval.exceptions.length} exception(s)` : ''}
      {approval.note ? `. Note: ${approval.note}` : ''}
    </p>
  );
}

const PRIMARY = ['approve', 'approve_received', 'schedule_payment', 'record_payment'];
const DANGER = ['reject', 'reverse_approval', 'cancel', 'payment_failed', 'start_recovery'];
const WITH_FIELDS = ['link_po', 'schedule_payment', 'record_payment', 'edit_fields'];

// Fields a reviewer can correct (the server checks them again: see corrections.js).
const EDIT_FIELDS = [
  ['vendorName', 'Supplier', 'text'],
  ['abn', 'ABN', 'text'],
  ['gstin', 'GSTIN', 'text'],
  ['invoiceNumber', 'Invoice number', 'text'],
  ['invoiceDate', 'Invoice date', 'date'],
  ['dueDate', 'Due date', 'date'],
  ['poNumber', 'Purchase order', 'text'],
  ['currency', 'Currency', 'text'],
  ['subtotal', 'Subtotal', 'number'],
  ['gst', 'GST', 'number'],
  ['total', 'Total', 'number'],
];
const FIELD_LABEL = { ...Object.fromEntries(EDIT_FIELDS.map(([k, label]) => [k, label])), lines: 'Line items' };
const LINE_COLUMNS = [
  ['sku', 'Item code', 'text'],
  ['description', 'Description', 'text'],
  ['qty', 'Qty', 'number'],
  ['unitPrice', 'Unit price', 'number'],
  ['amount', 'Amount', 'number'],
];
const asInput = (v) => (v === null || v === undefined ? '' : String(v));
const editableFrom = (e) => ({
  ...Object.fromEntries(EDIT_FIELDS.map(([k]) => [k, asInput(e[k])])),
  lines: (e.lines || []).map((l) => ({ ...Object.fromEntries(LINE_COLUMNS.map(([k]) => [k, asInput(l[k])])), unit: l.unit ?? null })),
});

// A corrected value as a person reads it: "blank", an ABN in groups, money, a date, or the line items in brief.
function shownValue(field, value, cur) {
  if (value === null || value === undefined || value === '') return 'blank';
  if (field === 'abn') return abn(value);
  if (['subtotal', 'gst', 'total'].includes(field)) return money(value, cur);
  if (field === 'invoiceDate' || field === 'dueDate') return day(value);
  if (field === 'lines') return value.length ? `${value.length} line${value.length === 1 ? '' : 's'} (${value.map((l) => `${l.sku || l.description}: ${l.qty ?? '?'} × ${money(l.unitPrice, cur)}`).join('; ')})` : 'no line items';
  return String(value);
}
const correctionText = (c, cur) => `${FIELD_LABEL[c.field] || c.field}: ${shownValue(c.field, c.from, cur)} → ${shownValue(c.field, c.to, cur)}`;
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// What a person can do next. The buttons come from the server, which decides
// what is allowed; consequential actions ask for confirmation first.
function Actions({ data, busy, onAct }) {
  const { invoice, payment, actions = [], receivedOnly: partial, linkablePos = [], paymentMethods = ['EFT'] } = data;
  const e = invoice.extracted || {};
  const cur = e.currency || 'AUD';
  const [name, setName] = useState(readName);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(null);
  const [fields, setFields] = useState({});
  const [hint, setHint] = useState(null);

  useEffect(() => {
    setPending(null);
    setNote('');
    setHint(null);
  }, [invoice.status, invoice.events?.length]);

  if (!actions.length) return null;
  const enabled = actions.filter((a) => a.enabled);
  // Only explain a blocked approval; the other unavailable actions are noise.
  const blocked = actions.filter((a) => !a.enabled && a.id === 'approve');
  const working = Boolean(busy);
  const remaining = payment ? Math.round((payment.amount - (payment.paidAmount || 0)) * 100) / 100 : null;

  const start = (a) => {
    setHint(null);
    if (!name.trim()) return setHint('Enter your name so the decision is on record.');
    if (a.noteRequired && !note.trim()) return setHint(`Add a note with the reason to ${a.label.toLowerCase()}.`);
    if (a.id === 'link_po') setFields({ poNumber: invoice.match?.suggestions?.[0]?.poNumber || linkablePos[0]?.poNumber || '' });
    if (a.id === 'schedule_payment') setFields({ method: payment?.method || 'EFT', scheduledFor: invoice.due?.date && invoice.due.date >= todayIso() ? invoice.due.date : todayIso(), reference: '' });
    if (a.id === 'edit_fields') setFields(editableFrom(e));
    if (a.id === 'record_payment') setFields({ amount: remaining ?? '', paidOn: todayIso(), method: payment?.method || 'EFT', reference: '' });
    if (a.confirm || WITH_FIELDS.includes(a.id)) return setPending(a);
    submit(a, {});
  };
  const submit = (a, extra) => {
    saveName(name.trim());
    onAct(a.id, { decidedBy: name.trim(), note: note.trim(), ...extra });
  };

  const amountFor = (id) => (id === 'approve_received' ? partial?.total : id === 'approve' ? e.total : payment?.amount ?? invoice.approval?.amount);
  const confirmText = (a) => {
    const who = e.vendorName || 'this supplier';
    switch (a.id) {
      case 'approve':
        return `Approve ${money(e.total, cur)} to ${who}? This approves the invoice only. Payment is a separate step.`;
      case 'approve_received':
        return `Approve ${money(partial?.total, cur)} of ${money(e.total, cur)} (the received quantity only)? Payment is a separate step.`;
      case 'reject':
        return `Reject invoice ${e.invoiceNumber || ''}? It will not be paid.`;
      case 'clear_duplicate':
        return 'Confirm this is not a duplicate of the earlier invoice? The agent will check it again. A second payment for the same invoice is still refused.';
      case 'schedule_payment':
        return `Schedule a payment of ${money(amountFor(a.id), cur)} to ${who}? Simulated: no money moves.`;
      case 'record_payment':
        return 'Record this payment as made? Enter the reference as evidence.';
      case 'reverse_approval':
        return `Reverse the approval${payment?.status === 'queued' ? ' and cancel the scheduled payment' : ''}? The original approval is kept in the history.`;
      case 'cancel':
        return `Cancel invoice ${e.invoiceNumber || ''}${payment?.status === 'queued' ? ' and its scheduled payment' : ''}?`;
      case 'reopen':
        return `Reopen this invoice for review?${payment?.status === 'queued' ? ' The scheduled payment will be cancelled first; it never moved any money.' : ''} The earlier decision is kept in the history, not deleted.`;
      case 'start_recovery':
        return 'This invoice has already been paid. Open a recovery to get the money back? The payment record is kept.';
      case 'link_po':
        return 'Link a purchase order. The agent will match the invoice against it again.';
      case 'edit_fields':
        return 'Correct what the reader got wrong. The agent checks the invoice again on the corrected values; every other check still applies, and nothing is approved. Your note is kept with the correction.';
      default:
        return `${a.label}?`;
    }
  };
  const set = (k) => (ev) => setFields((f) => ({ ...f, [k]: ev.target.value }));
  const poChoices = [
    ...(invoice.match?.suggestions || []).map((s) => ({ poNumber: s.poNumber, label: `${s.poNumber} · ${s.vendorName} (suggested, not confirmed, ${s.score}%${s.supplierOwnership && s.supplierOwnership !== 'confirmed_by_abn' ? ', supplier not verified' : ''})` })),
    ...linkablePos.filter((p) => !(invoice.match?.suggestions || []).some((s) => s.poNumber === p.poNumber)).map((p) => ({ poNumber: p.poNumber, label: `${p.poNumber} · ${p.vendorName}` })),
  ];
  const fieldsOk =
    !pending ||
    (pending.id === 'link_po' ? Boolean(fields.poNumber) : pending.id === 'record_payment' ? Boolean(String(fields.reference || '').trim()) && Number(fields.amount) > 0 : true);

  return (
    <section className="actions-card" aria-labelledby="actions-title">
      <h2 id="actions-title">What you can do</h2>
      <div className="decision-fields">
        <div>
          <label className="field-label" htmlFor="who">
            Your name
          </label>
          <input id="who" type="text" value={name} onChange={(ev) => setName(ev.target.value)} autoComplete="name" />
        </div>
        <div className="grow">
          <label className="field-label" htmlFor="note">
            Note or reason {enabled.some((a) => a.noteRequired) ? '(required for some actions)' : '(optional)'}
          </label>
          <input id="note" type="text" value={note} onChange={(ev) => setNote(ev.target.value)} />
        </div>
      </div>

      {!pending && (
        <div className="decision-actions">
          {enabled.map((a) => (
            <button
              key={a.id}
              className={`btn ${PRIMARY.includes(a.id) ? 'btn-primary' : DANGER.includes(a.id) ? 'btn-danger' : 'btn-outline'}`}
              disabled={working}
              onClick={() => start(a)}
              title={a.noteRequired ? 'Needs a note' : undefined}
            >
              {busy === a.id ? 'Working…' : a.id === 'approve_received' && partial ? `${a.label} (${money(partial.total, cur)})` : a.label}
              {a.noteRequired ? ' *' : ''}
            </button>
          ))}
        </div>
      )}
      {!pending && enabled.some((a) => a.noteRequired) && <p className="hint">* needs a note with the reason.</p>}
      {hint && <p className="form-hint" role="alert">{hint}</p>}

      {!pending && blocked.length > 0 && (
        <ul className="blocked">
          {blocked.map((a) => (
            <li key={a.id}>
              <strong>{a.label}</strong> is not available: {a.reason}
            </li>
          ))}
        </ul>
      )}

      {pending && (
        <div className="confirm" role="group" aria-label={`Confirm: ${pending.label}`}>
          <p className="confirm-text">{confirmText(pending)}</p>
          {pending.id === 'link_po' && (
            <div className="decision-fields">
              <div className="grow">
                <label className="field-label" htmlFor="po">
                  Purchase order
                </label>
                <select id="po" value={fields.poNumber} onChange={set('poNumber')}>
                  {poChoices.map((p) => (
                    <option key={p.poNumber} value={p.poNumber}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {pending.id === 'edit_fields' && <EditFields fields={fields} setFields={setFields} />}
          {(pending.id === 'schedule_payment' || pending.id === 'record_payment') && (
            <div className="decision-fields">
              {pending.id === 'record_payment' && (
                <div>
                  <label className="field-label" htmlFor="pay-amount">
                    Amount paid
                  </label>
                  <input id="pay-amount" type="number" step="0.01" min="0" value={fields.amount} onChange={set('amount')} />
                </div>
              )}
              <div>
                <label className="field-label" htmlFor="pay-date">
                  {pending.id === 'record_payment' ? 'Paid on' : 'Pay on'}
                </label>
                <input id="pay-date" type="date" value={pending.id === 'record_payment' ? fields.paidOn : fields.scheduledFor} onChange={set(pending.id === 'record_payment' ? 'paidOn' : 'scheduledFor')} />
              </div>
              <div>
                <label className="field-label" htmlFor="pay-method">
                  Method
                </label>
                <select id="pay-method" value={fields.method} onChange={set('method')}>
                  {paymentMethods.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="grow">
                <label className="field-label" htmlFor="pay-ref">
                  Reference {pending.id === 'record_payment' ? '(required)' : '(optional)'}
                </label>
                <input id="pay-ref" type="text" value={fields.reference} onChange={set('reference')} />
              </div>
            </div>
          )}
          {pending.id === 'record_payment' && remaining !== null && Number(fields.amount) > 0 && Number(fields.amount) < remaining && (
            <p className="form-hint">This is a part payment. {money(remaining - Number(fields.amount), cur)} will still be due and the invoice stays Payment Pending.</p>
          )}
          <div className="decision-actions">
            <button className={`btn ${DANGER.includes(pending.id) ? 'btn-danger' : 'btn-primary'}`} disabled={working || !fieldsOk} onClick={() => submit(pending, pending.id === 'record_payment' ? { ...fields, amount: Number(fields.amount) } : pending.id === 'edit_fields' ? { fields } : fields)}>
              {busy === pending.id ? 'Working…' : `Confirm: ${pending.label}`}
            </button>
            <button className="btn btn-outline" disabled={working} onClick={() => setPending(null)}>
              Back
            </button>
          </div>
        </div>
      )}

      {partial && actions.some((a) => a.id === 'approve_received' && a.enabled) && !pending && (
        <div className="partial">
          <strong>
            Received quantity only: {money(partial.total, cur)} of {money(partial.invoiceTotal, cur)}
          </strong>
          <ul>
            {partial.lines
              .filter((l) => l.payQty !== l.qtyInvoiced)
              .map((l) => (
                <li key={l.sku || l.description}>
                  {l.description || l.sku}: pays {l.payQty} of the {l.qtyInvoiced} invoiced.
                </li>
              ))}
            <li>
              Subtotal {money(partial.subtotal, cur)}, GST {money(partial.gst, cur)}. The rest stays unpaid until the goods arrive.
            </li>
          </ul>
        </div>
      )}
    </section>
  );
}

// The reviewer's corrections form: every editable field, prefilled with what
// the agent read, and the line items. Empty means "not on the invoice".
function EditFields({ fields, setFields }) {
  const set = (k) => (ev) => setFields((f) => ({ ...f, [k]: ev.target.value }));
  const setLine = (i, k) => (ev) => setFields((f) => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, [k]: ev.target.value } : l)) }));
  const addLine = () => setFields((f) => ({ ...f, lines: [...(f.lines || []), { sku: '', description: '', qty: '', unitPrice: '', amount: '', unit: null }] }));
  const removeLine = (i) => setFields((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }));
  return (
    <>
      <div className="decision-fields">
        {EDIT_FIELDS.map(([k, label, type]) => (
          <div key={k}>
            <label className="field-label" htmlFor={`edit-${k}`}>
              {label}
            </label>
            <input id={`edit-${k}`} type={type} step={type === 'number' ? '0.01' : undefined} value={fields[k] ?? ''} onChange={set(k)} />
          </div>
        ))}
      </div>
      <div className="table-scroll">
        <table className="lines edit-lines">
          <thead>
            <tr>
              {LINE_COLUMNS.map(([k, label, type]) => (
                <th key={k} scope="col" className={type === 'number' ? 'num' : undefined}>
                  {label}
                </th>
              ))}
              <th scope="col">Remove</th>
            </tr>
          </thead>
          <tbody>
            {(fields.lines || []).map((l, i) => (
              <tr key={i}>
                {LINE_COLUMNS.map(([k, label, type]) => (
                  <td key={k} className={type === 'number' ? 'num' : undefined}>
                    <input aria-label={`Line ${i + 1} ${label.toLowerCase()}`} type={type} step={type === 'number' ? 'any' : undefined} value={l[k] ?? ''} onChange={setLine(i, k)} />
                  </td>
                ))}
                <td>
                  <button type="button" className="btn btn-outline" onClick={() => removeLine(i)} aria-label={`Remove line ${i + 1}`}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="decision-actions">
        <button type="button" className="btn btn-outline" onClick={addLine}>
          Add line
        </button>
      </div>
    </>
  );
}
