// The daily summary email: what needs a person today. Plain functions.
//
// Only what someone needs to act on, with a link to the dashboard: invoice
// numbers, suppliers, amounts, dates and statuses. Never a secret, a bank
// account number or a bank line's description (which can carry account details).

import { money, day } from './rules.js';
import { fmtMoney } from './validation.js';
import { STATUS_LABEL } from './lifecycle.js';

// Statuses that mean something went wrong and a person must look.
export const EXCEPTION_STATUSES = ['needs_review', 'on_hold', 'payment_failed', 'failed'];
const OPEN_LINE = ['suggested', 'exception', 'unmatched'];

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1).trimEnd()}…` : String(s));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Invoices that moved into an exception status in the 24 hours before `now`, and are still there. */
export function newExceptions(invoices, now = new Date()) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  return invoices
    .filter((i) => EXCEPTION_STATUSES.includes(i.status))
    .map((i) => ({ i, at: [...(i.events || [])].reverse().find((e) => e.to === i.status && String(e.at) >= since)?.at }))
    .filter((x) => x.at)
    .map(({ i, at }) => ({ id: String(i._id ?? i.id), invoiceNumber: i.extracted?.invoiceNumber ?? null, vendorName: i.extracted?.vendorName ?? null, total: i.extracted?.total ?? null, currency: i.extracted?.currency || 'AUD', status: i.status, at, reason: i.decision?.reasons?.[0] ?? null }));
}

/** Bank lines still waiting for a decision, without their descriptions. */
export function openBankLines(statements) {
  const out = [];
  for (const s of statements) {
    for (const l of s.lines || []) {
      if (OPEN_LINE.includes(l.status)) out.push({ statementId: String(s._id ?? s.id), filename: s.source?.filename ?? s.filename ?? null, n: l.n, date: l.date ?? null, amount: l.amount, status: l.status });
    }
  }
  return out;
}

/**
 * @param payables   payablesSummary() output: { today, overdue, dueSoon }
 * @param exceptions newExceptions() output
 * @param queries    supplier emails waiting for a person: [{ id, from, subject, supplierName, createdAt }]
 * @param bankLines  openBankLines() output
 * @param appUrl     the dashboard's address (APP_URL), or ''
 */
export function buildDailySummary({ payables, exceptions, queries, bankLines, appUrl = '', companyName = '' }) {
  const link = String(appUrl || '').replace(/\/+$/, '');
  const m = (n, cur = 'AUD') => (cur === 'AUD' ? money(n) : fmtMoney(n, cur));
  const inv = (r) => `${r.invoiceNumber || '(no number)'} from ${r.vendorName || 'an unknown supplier'}`;
  const due = (r) => (r.daysUntil < 0 ? `${plural(-r.daysUntil, 'day')} overdue (due ${day(r.dueDate)})` : r.daysUntil === 0 ? 'due today' : `due ${day(r.dueDate)}, in ${plural(r.daysUntil, 'day')}`);

  const sections = [
    {
      title: 'Overdue',
      items: payables.overdue.map((r) => `${inv(r)}, ${m(r.amount, r.currency)}: ${due(r)}. ${STATUS_LABEL[r.status] || r.status}.`),
    },
    {
      title: 'Due in the next 7 days',
      items: payables.dueSoon.map((r) => `${inv(r)}, ${m(r.amount, r.currency)}: ${due(r)}. ${STATUS_LABEL[r.status] || r.status}.`),
    },
    {
      title: 'New exceptions in the last 24 hours',
      items: exceptions.map((r) => `${inv(r)}, ${m(r.total, r.currency)}: ${STATUS_LABEL[r.status] || r.status}.${r.reason ? ` ${clip(r.reason, 200)}` : ''}`),
    },
    {
      title: 'Supplier emails waiting for a reply',
      items: queries.map((q) => `${q.supplierName || q.from}: "${String(q.subject || '(no subject)').slice(0, 120)}", received ${day(String(q.createdAt instanceof Date ? q.createdAt.toISOString() : q.createdAt).slice(0, 10))}.`),
    },
    {
      title: 'Bank lines needing a decision',
      items: bankLines.map((l) => `Line ${l.n}${l.filename ? ` of ${l.filename}` : ''}${l.date ? `, ${day(l.date)}` : ''}: ${m(Math.abs(l.amount))} ${l.amount < 0 ? 'out' : 'in'}.`),
    },
  ];

  const total = sections.reduce((s, x) => s + x.items.length, 0);
  const counts = Object.fromEntries(sections.map((s) => [s.title, s.items.length]));
  const subject = total
    ? `Finance Operations Agent: ${plural(payables.overdue.length, 'overdue invoice')}, ${plural(exceptions.length, 'new exception')}, ${plural(total, 'item')} to look at`
    : 'Finance Operations Agent: nothing needs attention today';
  const intro = `Daily summary for ${day(payables.today)}${companyName ? `, ${companyName}` : ''}. ${total ? `${plural(total, 'item needs', 'items need')} a person.` : 'Nothing needs a person today.'}`;
  const footer = 'Sent by the Finance Operations Agent. The agent approves and pays nothing: every decision is made by a person in the dashboard. Payments in this prototype are simulated.';

  const text = [
    intro,
    link ? `Open the dashboard: ${link}` : '',
    ...sections.map((s) => `${s.title} (${s.items.length})\n${s.items.length ? s.items.map((i) => `- ${i}`).join('\n') : '- None.'}`),
    footer,
  ]
    .filter(Boolean)
    .join('\n\n');

  const html = `<!doctype html>
<html><body style="font-family: Arial, Helvetica, sans-serif; color: #1b2a41; line-height: 1.5; max-width: 640px;">
<p>${escapeHtml(intro)}</p>
${link ? `<p><a href="${escapeHtml(link)}" style="color: #1b4f8a;">Open the dashboard</a></p>` : ''}
${sections
  .map(
    (s) => `<h3 style="margin: 20px 0 6px; font-size: 16px;">${escapeHtml(s.title)} (${s.items.length})</h3>
${s.items.length ? `<ul style="margin: 0; padding-left: 20px;">${s.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '<p style="margin: 0; color: #5b6b80;">None.</p>'}`,
  )
  .join('\n')}
<p style="margin-top: 24px; font-size: 13px; color: #5b6b80;">${escapeHtml(footer)}</p>
</body></html>`;

  return { subject, text, html, counts, total };
}
