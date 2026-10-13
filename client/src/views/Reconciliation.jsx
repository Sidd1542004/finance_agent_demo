import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { money, day, when, STATEMENT_STATUS, LINE_STATUS } from '../format.js';
import { Rail, Reasons, RecordList, AuditTrail, useBusy, useRecords } from '../shared.jsx';

const OPEN = ['suggested', 'exception', 'unmatched'];

export default function ReconciliationView({ onError }) {
  const records = useRecords(api.statements, api.statement, onError);
  const [busy, run] = useBusy(onError);
  const [sample, setSample] = useState(null);

  useEffect(() => {
    api.statementSample().then(setSample).catch((err) => onError(err.message));
  }, [onError]);

  const process = (call) =>
    run('process', async () => {
      const data = await call();
      await records.show(data, data.statement._id, { fresh: true });
    });

  const resolve = (n, body) =>
    run(`line-${n}`, async () => {
      try {
        const data = await api.resolveLine(records.selectedId, n, body);
        await records.show(data, data.statement._id);
      } catch (err) {
        records.select(records.selectedId);
        throw err;
      }
    });

  const rows = records.items.map((s) => ({
    id: s._id,
    title: s.source?.filename || 'Pasted statement',
    right: `${s.lineCount} line${s.lineCount === 1 ? '' : 's'}`,
    status: STATEMENT_STATUS[s.status] || STATEMENT_STATUS.received,
    meta: when(s.createdAt),
  }));

  return (
    <div className="layout">
      <aside className="side">
        <AddStatement
          sample={sample}
          busy={busy === 'process'}
          disabled={Boolean(busy)}
          onSample={() => process(() => api.processStatementSample(sample.id))}
          onFile={(file) => process(() => api.processStatementFile(file))}
          onText={(text) => process(() => api.processStatementText(text))}
        />
        <section className="card">
          <h2>Statements</h2>
          <RecordList rows={rows} selectedId={records.selectedId} onSelect={records.select} empty="No statements yet. Reconcile the sample above. It refers to the demo month, so load that first." />
        </section>
      </aside>

      <main className="main">
        {records.detail ? (
          <StatementDetail
            key={records.detail.statement._id}
            data={records.detail}
            fresh={records.freshId === records.detail.statement._id}
            busy={busy}
            onResolve={resolve}
            onRerun={() => process(() => api.rerunStatement(records.detail.statement._id))}
          />
        ) : (
          <div className="blank">
            {records.loaded ? (
              <>
                <h1>Give the agent a bank statement</h1>
                <p>
                  The agent matches each payment on the statement to an invoice that was approved, and marks those invoices as paid. Double
                  payments, payments nobody approved and lines it cannot place go to a person.
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

function AddStatement({ sample, busy, disabled, onSample, onFile, onText }) {
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  return (
    <section className="card add">
      <h2>Add a bank statement</h2>
      {sample && (
        <>
          <p className="sample-title">{sample.title}</p>
          <p className="hint">{sample.hint}</p>
        </>
      )}
      <button className="btn btn-primary btn-block" disabled={disabled || !sample} onClick={onSample}>
        {busy ? 'Reconciling…' : 'Reconcile the sample statement'}
      </button>
      <div className="add-alt">
        <label className={`btn btn-outline file-btn ${disabled ? 'is-disabled' : ''}`}>
          Upload a CSV
          <input
            className="sr-only"
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
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
      {pasting && (
        <div className="paste">
          <label className="field-label" htmlFor="st-paste">
            Statement as CSV, with a header row
          </label>
          <textarea id="st-paste" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Date,Description,Amount\n02/10/2026,SUPPLIER NAME INV-123,-1402.50'} />
          <button
            className="btn btn-primary btn-block"
            disabled={disabled || !text.trim()}
            onClick={() => {
              onText(text);
              setText('');
              setPasting(false);
            }}
          >
            Reconcile pasted statement
          </button>
        </div>
      )}
      <p className="hint">Needs columns for date, description and amount. Money out is negative.</p>
    </section>
  );
}

function StatementDetail({ data, fresh, busy, onResolve, onRerun }) {
  const { statement, run } = data;
  const [who, setWho] = useState('');
  const status = STATEMENT_STATUS[statement.status] || STATEMENT_STATUS.received;
  const lines = statement.lines || [];
  const open = lines.filter((l) => OPEN.includes(l.status));
  const matched = lines.filter((l) => l.status === 'matched' || l.status === 'confirmed');
  const total = (list) => list.reduce((sum, l) => sum + Math.round(Math.abs(l.amount) * 100), 0) / 100;
  const reasons = statement.decision?.reasons || [];
  const working = Boolean(busy);

  return (
    <article className="detail">
      <header className="detail-head">
        <div className="detail-title">
          <h1>{statement.source?.filename || 'Pasted statement'}</h1>
          <p className="detail-meta">
            Received {when(statement.createdAt)}, {lines.length} line{lines.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="detail-amount">
          <span className={`status status-lg status-${status.tone}`}>{status.label}</span>
        </div>
      </header>

      <Rail steps={run?.steps || []} fresh={fresh} />

      {statement.status === 'needs_person' && (
        <section className="outcome outcome-wait" aria-labelledby="st-decision">
          <h2 id="st-decision">
            {open.length} line{open.length === 1 ? ' needs' : 's need'} your decision
          </h2>
          <p>Each one is marked below. Enter your name once, then decide each line.</p>
          <div className="decision-form">
            <div className="decision-fields">
              <div>
                <label className="field-label" htmlFor="st-who">
                  Your name
                </label>
                <input id="st-who" type="text" value={who} onChange={(e) => setWho(e.target.value)} autoComplete="name" />
              </div>
            </div>
          </div>
        </section>
      )}

      {statement.status === 'reconciled' && (
        <section className="outcome outcome-ok">
          <h2>Every line is accounted for</h2>
          <p>
            {matched.length} payment{matched.length === 1 ? '' : 's'} matched to approved invoices, {money(total(matched))} in total.
          </p>
        </section>
      )}

      {statement.status === 'failed' && (
        <section className="outcome outcome-err">
          <h2>The agent could not reconcile this statement</h2>
          <Reasons reasons={reasons} />
          <p className="outcome-note">No payments were marked as paid.</p>
          <div className="decision-actions">
            <button className="btn btn-primary" disabled={working} onClick={onRerun}>
              {busy === 'process' ? 'Reconciling…' : 'Reconcile again'}
            </button>
          </div>
        </section>
      )}

      {lines.length > 0 && (
        <section className="panel">
          <h2>Statement lines</h2>
          <ol className="bank-lines">
            {lines.map((line) => (
              <BankLine key={line.n} line={line} who={who} canDecide={statement.status === 'needs_person'} busy={busy} onResolve={onResolve} />
            ))}
          </ol>
        </section>
      )}

      {statement.unpaid?.length > 0 && (
        <section className="panel">
          <h2>Approved, but not on this statement</h2>
          <div className="table-scroll">
            <table className="lines lines-narrow">
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Supplier</th>
                  <th scope="col">Due</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {statement.unpaid.map((u) => (
                  <tr key={u.invoiceNumber}>
                    <td>{u.invoiceNumber}</td>
                    <td>{u.vendorName}</td>
                    <td>{u.dueDate ? day(u.dueDate) : '—'}</td>
                    <td className="num">{money(u.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">These were still waiting to be paid when the statement was reconciled.</p>
        </section>
      )}

      <AuditTrail steps={run?.steps} />

      <details className="source">
        <summary>Original statement text</summary>
        <pre>{statement.rawText}</pre>
      </details>
    </article>
  );
}

function BankLine({ line, who, canDecide, busy, onResolve }) {
  const [note, setNote] = useState('');
  const status = LINE_STATUS[line.status] || LINE_STATUS.unmatched;
  const isOpen = OPEN.includes(line.status);
  const working = Boolean(busy);
  const candidate = line.candidate;
  const needsNote = line.kind === 'amount_differs';
  const r = line.resolution;

  return (
    <li className={`bank-line ${isOpen ? 'is-open' : ''}`}>
      <div className="bank-line-head">
        <div>
          <p className="bank-desc">{line.description || 'No description'}</p>
          <p className="bank-date">
            Line {line.n}
            {line.date ? `, ${day(line.date)}` : ''}
          </p>
        </div>
        <p className="bank-amount">
          {line.amount < 0 ? money(Math.abs(line.amount)) : `+${money(line.amount)}`}
          <span>{line.amount < 0 ? 'out' : 'in'}</span>
        </p>
      </div>
      <p className={`status status-${status.tone}`}>{status.label}</p>
      <p className="bank-reason">{line.reason}</p>
      {line.aiNote && <p className="bank-ai">AI note: {line.aiNote}</p>}
      {r && (
        <p className="bank-reason">
          {r.action === 'confirm' ? `Matched to invoice ${line.invoiceNumber}` : 'Dismissed'} by {r.decidedBy}, {when(r.decidedAt)}.{r.note ? ` Note: ${r.note}` : ''}
        </p>
      )}

      {isOpen && canDecide && (
        <div className="bank-actions">
          <div className="grow">
            <label className="field-label" htmlFor={`note-${line.n}`}>
              Note {candidate && !needsNote ? '(required to dismiss)' : '(required)'}
            </label>
            <input id={`note-${line.n}`} type="text" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {candidate && (
            <button className="btn btn-primary" disabled={working || !who.trim() || (needsNote && !note.trim())} onClick={() => onResolve(line.n, { action: 'confirm', decidedBy: who, note })}>
              Match to {candidate.invoiceNumber}
            </button>
          )}
          <button className="btn btn-outline" disabled={working || !who.trim() || !note.trim()} onClick={() => onResolve(line.n, { action: 'dismiss', decidedBy: who, note })}>
            Dismiss line
          </button>
        </div>
      )}
    </li>
  );
}
