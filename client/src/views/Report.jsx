import { useState } from 'react';
import { api, API_BASE_URL } from '../api.js';
import { money, day, when, REPORT_STATUS } from '../format.js';
import { Rail, Reasons, RecordList, AuditTrail, useBusy, useRecords } from '../shared.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// This month and the eleven before it.
function recentMonths() {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return { value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` };
  });
}

export default function ReportView({ onError }) {
  const records = useRecords(api.reports, api.report, onError);
  const [busy, run] = useBusy(onError);
  const [months] = useState(recentMonths);
  const [month, setMonth] = useState(months[0].value);

  const write = () =>
    run('process', async () => {
      const data = await api.writeReport(month);
      await records.show(data, data.report._id, { fresh: true });
    });

  const rows = records.items.map((r) => ({
    id: r._id,
    title: r.figures?.label || r.month,
    status: REPORT_STATUS[r.status] || REPORT_STATUS.processing,
    meta: when(r.createdAt),
  }));

  return (
    <div className="layout">
      <aside className="side">
        <section className="card add">
          <h2>Write a month-end report</h2>
          <label className="field-label" htmlFor="r-month">
            Month
          </label>
          <select id="r-month" value={month} onChange={(e) => setMonth(e.target.value)} disabled={Boolean(busy)}>
            {months.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="hint">Covers invoices, supplier emails and bank statements received in that month.</p>
          <button className="btn btn-primary btn-block" disabled={Boolean(busy)} onClick={write}>
            {busy ? 'Writing…' : 'Write the report'}
          </button>
        </section>
        <section className="card">
          <h2>Reports</h2>
          <RecordList rows={rows} selectedId={records.selectedId} onSelect={records.select} empty="No reports yet." />
        </section>
      </aside>

      <main className="main">
        {records.detail ? (
          <ReportDetail key={records.detail.report._id} data={records.detail} fresh={records.freshId === records.detail.report._id} />
        ) : (
          <div className="blank">
            {records.loaded ? (
              <>
                <h1>Ask the agent for a month-end report</h1>
                <p>
                  The agent adds up the month from the records: what came in, what it approved on its own, what people decided, what has been paid and what is still open. Code
                  calculates every figure. AI only writes the summary paragraph.
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

function ReportDetail({ data, fresh }) {
  const { report, run } = data;
  const f = report.figures;
  const status = REPORT_STATUS[report.status] || REPORT_STATUS.processing;
  const reasons = report.decision?.reasons || [];
  const c = report.commentary;

  return (
    <article className="detail">
      <header className="detail-head">
        <div className="detail-title">
          <h1>Month-end report: {f?.label || report.month}</h1>
          <p className="detail-meta">Written {when(report.createdAt)}</p>
        </div>
        <div className="detail-amount">
          <span className={`status status-lg status-${status.tone}`}>{status.label}</span>
        </div>
      </header>

      <Rail steps={run?.steps || []} fresh={fresh} />

      {report.status === 'open_items' && (
        <section className="outcome outcome-wait">
          <h2>The month is not ready to close</h2>
          <Reasons reasons={reasons} />
          <p className="outcome-note">Deal with these in the other tabs, then write the report again.</p>
        </section>
      )}
      {report.status === 'ready' && (
        <section className="outcome outcome-ok">
          <h2>Nothing is open for this month</h2>
          <p>Every invoice, supplier email and bank line received in {f?.label} has been dealt with.</p>
        </section>
      )}
      {report.status === 'failed' && (
        <section className="outcome outcome-err">
          <h2>The agent could not complete this report</h2>
          <Reasons reasons={reasons} />
        </section>
      )}

      {f && c && (
        <section className="panel">
          <div className="panel-head">
            <h2>Summary</h2>

            <button
              className="btn btn-outline"
              type="button"
              onClick={async () => {
                try {
                  const response = await fetch(`${API_BASE_URL}/api/reports/${report._id}/csv`);

                  if (!response.ok) {
                    throw new Error(`CSV download failed: ${response.status}`);
                  }

                  const blob = await response.blob();
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement('a');

                  link.href = url;
                  link.download = 'month-end-report.csv';
                  document.body.appendChild(link);
                  link.click();
                  link.remove();
                  URL.revokeObjectURL(url);
                } catch (error) {
                  console.error('CSV download error:', error);
                  alert('CSV download failed. Please check the browser console.');
                }
              }}
            >
              Download figures (CSV)
            </button>
          </div>
          <p className="commentary">{c.text}</p>
          <p className="hint">
            {c.method === 'groq' ? `Written by the AI writer (${c.model}) and checked against the figures below.` : 'Standard wording, filled in from the figures below.'}
            {c.note ? ` ${c.note}` : ''}
          </p>
        </section>
      )}

      {f?.comparison && <Comparison c={f.comparison} />}

      {f && (
        <div className="figure-grid">
          <Figures
            title="Invoices"
            rows={[
              ['Received', f.invoices.received],
              ['Value received', money(f.invoices.valueReceived)],
              ['Cleared by the agent for approval review', f.invoices.clearedByAgent],
              ['Approved by a person', f.invoices.approvedByPerson],
              ['Waiting for a decision', f.invoices.waiting],
              ['Rejected', f.invoices.rejected],
              ['Cancelled', f.invoices.cancelled ?? 0],
              ['Could not be processed', f.invoices.failed],
              ['Possible duplicate copies (not counted again)', f.invoices.duplicateCopies ?? 0],
              ['Cleared with no exceptions, of those it could read', f.invoices.clearedPct === null || f.invoices.clearedPct === undefined ? '—' : `${f.invoices.clearedPct}%`],
            ]}
          />
          <Figures
            title="Payments"
            rows={[
              ['Approved by a person', `${money(f.payments.approvedValue)} (${f.payments.approvedCount})`],
              ['Scheduled, not yet paid (simulated)', money(f.payments.scheduledValue ?? 0)],
              ['Paid', `${money(f.payments.paidValue)} (${f.payments.paidCount})`],
              ['Still to pay', `${money(f.payments.outstandingValue)} (${f.payments.outstandingCount})`],
            ]}
          />
          <Figures
            title="Supplier emails"
            rows={[
              ['Received', f.queries.received],
              ['Answered by the agent', f.queries.answeredByAgent],
              ['Answered by a person', f.queries.answeredByPerson],
              ['Closed without a reply', f.queries.closedWithoutReply],
              ['Waiting', f.queries.waiting],
            ]}
          />
          <Figures
            title="Bank reconciliation"
            rows={[
              ['Statements', f.bank.statements],
              ['Lines matched to invoices', `${f.bank.linesMatched} (${money(f.bank.valueMatched)})`],
              ['Lines dismissed by a person', f.bank.linesDismissed],
              ['Lines needing a decision', f.bank.linesOpen],
              ['Repeated lines from re-run statements (counted once)', f.bank.linesRepeated ?? 0],
            ]}
          />
          <Figures
            title="Still to pay, by supplier"
            empty="Nothing is waiting to be paid."
            rows={f.outstandingBySupplier.map((s) => [`${s.vendorName}${s.earliestDue ? `, due ${day(s.earliestDue)}` : ''}`, money(s.value)])}
          />
          <Figures title="Why invoices needed a person" empty="No invoice needed a person." rows={f.heldReasons.map((r) => [r.label, r.count])} />
        </div>
      )}
      <AuditTrail steps={run?.steps} />
    </article>
  );
}

function Comparison({ c }) {
  const show = (r, v) => (r.money ? money(v) : v);
  return (
    <section className="panel compare">
      <h2>Compared with {c.label}</h2>
      {!c.hasData && <p className="hint">There are no records for {c.label}, so every change below is the whole of this month.</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col"></th>
              <th scope="col" className="num">
                This month
              </th>
              <th scope="col" className="num">
                {c.label}
              </th>
              <th scope="col" className="num">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {c.rows.map((r) => (
              <tr key={r.id}>
                <th scope="row">{r.label}</th>
                <td className="num">{show(r, r.current)}</td>
                <td className="num">{show(r, r.previous)}</td>
                <td className={`num ${r.change > 0 ? 'up' : r.change < 0 ? 'down' : ''}`}>
                  {r.change > 0 ? '+' : r.change < 0 ? '−' : ''}
                  {show(r, Math.abs(r.change))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Figures({ title, rows, empty }) {
  return (
    <section className="panel figures">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="hint">{empty}</p>
      ) : (
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
