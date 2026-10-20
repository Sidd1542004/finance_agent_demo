// The daily summary email: gather what needs a person, build the email, and
// send it (or preview it). Called by GET /api/cron/daily-summary, which a
// Vercel cron job calls once a day with CRON_SECRET.

import { buildDailySummary, newExceptions, openBankLines, EXCEPTION_STATUSES } from '../agent/finance/dailySummary.js';
import { passwordMatches } from '../accessAuth.js';
import { Invoice, VendorQuery, BankStatement } from '../models/index.js';
import { getPayables } from './invoices.js';

/** Everything the summary needs, from the database. */
export async function gatherDailySummary(now = new Date()) {
  const [payables, invoices, queries, statements] = await Promise.all([
    getPayables(),
    Invoice.find({ status: { $in: EXCEPTION_STATUSES } })
      .select('status events extracted.invoiceNumber extracted.vendorName extracted.total extracted.currency decision.reasons')
      .lean(),
    VendorQuery.find({ status: 'needs_person' }).select('from subject createdAt supplier.name').sort({ createdAt: 1 }).lean(),
    BankStatement.find({ status: 'needs_person' }).select('source lines.n lines.date lines.amount lines.status').sort({ createdAt: 1 }).lean(),
  ]);
  return {
    payables,
    exceptions: newExceptions(invoices, now),
    queries: queries.map((q) => ({ id: String(q._id), from: q.from, subject: q.subject, supplierName: q.supplier?.name ?? null, createdAt: q.createdAt })),
    bankLines: openBankLines(statements),
  };
}

/** Is this the scheduler? `Authorization: Bearer <CRON_SECRET>`, compared in constant time. */
export function cronAuthorized(header, secret) {
  if (!secret) return false;
  const m = String(header || '').match(/^Bearer\s+(.+)$/i);
  return Boolean(m) && passwordMatches(m[1].trim(), secret);
}

/**
 * The route handler. With ?preview=1 it returns the email without sending it.
 * deps: { secret, recipients, appUrl, companyName, mailer, gather }
 */
export function createDailySummaryHandler({ secret, recipients, appUrl, companyName, mailer, gather = gatherDailySummary }) {
  return async (req, res) => {
    if (!secret) return res.status(503).json({ error: 'The daily summary is not set up: set CRON_SECRET.' });
    if (!cronAuthorized(req.headers.authorization, secret)) return res.status(401).json({ error: 'Not authorised.' });

    const email = buildDailySummary({ ...(await gather(new Date())), appUrl, companyName });
    const preview = ['1', 'true', 'yes'].includes(String(req.query.preview || '').toLowerCase());
    const summary = { subject: email.subject, counts: email.counts, recipients: recipients.length, via: mailer?.via ?? null };
    if (preview) return res.json({ preview: true, ...summary, text: email.text, html: email.html });

    if (!recipients.length) return res.json({ sent: false, reason: 'ALERT_EMAILS is not set.', ...summary });
    if (!mailer) return res.json({ sent: false, reason: 'No email service is set up (RESEND_API_KEY, or SMTP_HOST).', ...summary });
    try {
      const { id } = await mailer.send({ to: recipients, subject: email.subject, html: email.html, text: email.text });
      return res.json({ sent: true, id, ...summary });
    } catch (err) {
      console.error('Daily summary could not be sent:', err?.message || err);
      return res.status(502).json({ sent: false, error: `The summary could not be sent: ${err?.message || 'unknown error'}`, ...summary });
    }
  };
}
