// The daily summary email: what it contains, what it never contains, and who
// may trigger it.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { buildDailySummary, newExceptions, openBankLines } from '../src/agent/finance/dailySummary.js';
import { payablesSummary } from '../src/agent/finance/due.js';
import { cronAuthorized, createDailySummaryHandler } from '../src/services/dailySummary.js';
import { createMailer } from '../src/services/mailer.js';

const NOW = new Date('2026-10-20T03:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();

function data() {
  const payables = payablesSummary(
    [
      { id: 'a', status: 'approved', extracted: { invoiceNumber: 'HOS-1', vendorName: 'Harbour Office Supplies Pty Ltd', total: 1402.5, dueDate: '2026-10-14' } },
      { id: 'b', status: 'needs_review', extracted: { invoiceNumber: 'SCP-2', vendorName: 'Southern Cross Pallets Pty Ltd', total: 811.8, dueDate: '2026-10-24' } },
      { id: 'c', status: 'approved', extracted: { invoiceNumber: 'BG-3', vendorName: 'Bluegum IT Services Pty Ltd', total: 99, dueDate: '2026-12-01' } },
    ],
    '2026-10-20',
  );
  const exceptions = newExceptions(
    [
      { _id: 'x1', status: 'needs_review', extracted: { invoiceNumber: 'CPS-0388', vendorName: 'Coastal Print & Sign <Pty> Ltd', total: 550, currency: 'AUD' }, decision: { reasons: ['Supplier is not on the approved list.'] }, events: [{ to: 'needs_review', at: hoursAgo(3) }] },
      { _id: 'x2', status: 'on_hold', extracted: { invoiceNumber: 'OLD-1' }, events: [{ to: 'on_hold', at: hoursAgo(30) }] },
      { _id: 'x3', status: 'payment_failed', extracted: { invoiceNumber: 'PF-1', total: 10 }, events: [{ to: 'payment_failed', at: hoursAgo(1) }] },
    ],
    NOW,
  );
  const queries = [{ id: 'q1', from: 'accounts@harbouroffice.example', subject: 'Change of bank details', supplierName: 'Harbour Office Supplies Pty Ltd', createdAt: new Date('2026-10-19T22:00:00Z') }];
  const bankLines = openBankLines([
    {
      _id: 's1',
      source: { filename: 'bank-statement-october.csv' },
      lines: [
        { n: 1, status: 'confirmed', amount: -1402.5, date: '2026-10-02', description: 'EFT HARBOUR' },
        { n: 2, status: 'exception', amount: -727.1, date: '2026-10-03', description: 'EFT TO BSB 062-000 ACC 12345678' },
      ],
    },
  ]);
  return { payables, exceptions, queries, bankLines };
}

test('the summary lists overdue and due-soon invoices, new exceptions, supplier emails and open bank lines, with a link', () => {
  const d = data();
  assert.deepEqual(d.exceptions.map((e) => e.invoiceNumber), ['CPS-0388', 'PF-1'], 'only exceptions from the last 24 hours');
  const email = buildDailySummary({ ...d, appUrl: 'https://finance-demo.vercel.app/', companyName: 'Meridian Logistics Pty Ltd' });

  assert.equal(email.subject, 'Finance Operations Agent: 1 overdue invoice, 2 new exceptions, 6 items to look at');
  assert.deepEqual(email.counts, { Overdue: 1, 'Due in the next 7 days': 1, 'New exceptions in the last 24 hours': 2, 'Supplier emails waiting for a reply': 1, 'Bank lines needing a decision': 1 });
  assert.match(email.text, /^Daily summary for 20 Oct 2026, Meridian Logistics Pty Ltd\. 6 items need a person\./);
  assert.match(email.text, /Open the dashboard: https:\/\/finance-demo\.vercel\.app\n/);
  assert.match(email.text, /- HOS-1 from Harbour Office Supplies Pty Ltd, \$1,402\.50: 6 days overdue \(due 14 Oct 2026\)\. Approved\./);
  assert.match(email.text, /- SCP-2 from Southern Cross Pallets Pty Ltd, \$811\.80: due 24 Oct 2026, in 4 days\. Needs Review\./);
  assert.doesNotMatch(email.text, /BG-3/, 'not due within 7 days');
  assert.match(email.text, /- CPS-0388 from Coastal Print & Sign <Pty> Ltd, \$550\.00: Needs Review\. Supplier is not on the approved list\./);
  assert.match(email.text, /Harbour Office Supplies Pty Ltd: "Change of bank details", received 19 Oct 2026\./);
  assert.match(email.text, /- Line 2 of bank-statement-october\.csv, 3 Oct 2026: \$727\.10 out\./);
  assert.match(email.text, /The agent approves and pays nothing/);

  assert.match(email.html, /<a href="https:\/\/finance-demo\.vercel\.app"/);
  assert.match(email.html, /Coastal Print &amp; Sign &lt;Pty&gt; Ltd/, 'HTML is escaped');
  assert.doesNotMatch(email.html, /<Pty>/);
});

test('the summary never includes bank account details or bank line descriptions', () => {
  const email = buildDailySummary({ ...data(), appUrl: '' });
  for (const body of [email.text, email.html]) {
    assert.doesNotMatch(body, /12345678|062-000|BSB|EFT HARBOUR/);
  }
  assert.doesNotMatch(email.text, /Open the dashboard/, 'no link without APP_URL');
});

test('a quiet day says so', () => {
  const email = buildDailySummary({ payables: payablesSummary([], '2026-10-20'), exceptions: [], queries: [], bankLines: [] });
  assert.equal(email.subject, 'Finance Operations Agent: nothing needs attention today');
  assert.match(email.text, /Nothing needs a person today\./);
  assert.equal(email.total, 0);
});

test('only the scheduler with CRON_SECRET may call it', () => {
  assert.equal(cronAuthorized('Bearer s3cret-value', 's3cret-value'), true);
  assert.equal(cronAuthorized('bearer  s3cret-value', 's3cret-value'), true);
  assert.equal(cronAuthorized('Bearer wrong', 's3cret-value'), false);
  assert.equal(cronAuthorized('Basic czNjcmV0LXZhbHVl', 's3cret-value'), false);
  assert.equal(cronAuthorized(undefined, 's3cret-value'), false);
  assert.equal(cronAuthorized('Bearer anything', ''), false, 'no secret set: nobody');
});

async function call(handler, { auth, query = '' } = {}) {
  const app = express();
  app.get('/api/cron/daily-summary', handler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/cron/daily-summary${query}`, { headers: auth ? { Authorization: auth } : {} });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('the cron route: refused without the secret, previews without sending, sends with it', async () => {
  const sent = [];
  const mailer = { via: 'resend', send: async (msg) => (sent.push(msg), { id: 'em_1' }) };
  const deps = { secret: 'cron-secret', recipients: ['ap@meridian.example', 'cfo@meridian.example'], appUrl: 'https://x.vercel.app', companyName: '', mailer, gather: async () => data() };

  assert.equal((await call(createDailySummaryHandler(deps))).status, 401);
  assert.equal((await call(createDailySummaryHandler(deps), { auth: 'Bearer nope' })).status, 401);
  assert.equal((await call(createDailySummaryHandler(deps), { auth: 'Bearer nope', query: '?preview=1' })).status, 401, 'preview needs the secret too');
  assert.equal((await call(createDailySummaryHandler({ ...deps, secret: '' }), { auth: 'Bearer ' })).status, 503);

  const preview = await call(createDailySummaryHandler(deps), { auth: 'Bearer cron-secret', query: '?preview=1' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview, true);
  assert.match(preview.body.subject, /1 overdue invoice/);
  assert.match(preview.body.html, /<html>/);
  assert.equal(preview.body.recipients, 2);
  assert.equal(sent.length, 0, 'a preview sends nothing');

  const real = await call(createDailySummaryHandler(deps), { auth: 'Bearer cron-secret' });
  assert.deepEqual([real.status, real.body.sent, real.body.id, real.body.via], [200, true, 'em_1', 'resend']);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['ap@meridian.example', 'cfo@meridian.example']);
  assert.ok(!JSON.stringify(real.body).includes('cron-secret'));

  const noMailer = await call(createDailySummaryHandler({ ...deps, mailer: null }), { auth: 'Bearer cron-secret' });
  assert.deepEqual([noMailer.status, noMailer.body.sent], [200, false]);
  assert.match(noMailer.body.reason, /No email service/);
  const noRecipients = await call(createDailySummaryHandler({ ...deps, recipients: [] }), { auth: 'Bearer cron-secret' });
  assert.match(noRecipients.body.reason, /ALERT_EMAILS is not set/);

  const failing = await call(createDailySummaryHandler({ ...deps, mailer: { via: 'smtp', send: async () => { throw new Error('connection refused'); } } }), { auth: 'Bearer cron-secret' });
  assert.equal(failing.status, 502);
  assert.match(failing.body.error, /could not be sent: connection refused/);
});

test('mailers: Resend over HTTP when its key is set, SMTP when SMTP_HOST is set, otherwise none', async () => {
  assert.equal(createMailer({ resendApiKey: '', smtp: {}, from: 'x' }), null);

  const requests = [];
  const resend = createMailer({ resendApiKey: 're_test_key', smtp: { host: 'smtp.example' }, from: 'Agent <a@example.com>' }, {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ id: 'abc' }) };
    },
  });
  assert.equal(resend.via, 'resend', 'Resend wins when both are set');
  assert.deepEqual(await resend.send({ to: ['a@b.c'], subject: 'S', html: '<p>h</p>', text: 't' }), { id: 'abc' });
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer re_test_key');
  assert.deepEqual(JSON.parse(requests[0].init.body), { from: 'Agent <a@example.com>', to: ['a@b.c'], subject: 'S', html: '<p>h</p>', text: 't' });

  const refused = createMailer({ resendApiKey: 're_bad', from: 'x' }, { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'domain not verified' }) }) });
  await assert.rejects(refused.send({ to: ['a@b.c'], subject: 'S', html: '', text: '' }), (err) => /Resend refused the request \(403\)/.test(err.message) && !err.message.includes('re_bad'));

  const mails = [];
  const smtp = createMailer({ smtp: { host: 'smtp.example', port: 587, secure: false, user: 'u', pass: 'p' }, from: 'a@example.com' }, {
    loadNodemailer: async () => ({ default: { createTransport: (opts) => ({ sendMail: async (m) => (mails.push({ opts, m }), { messageId: '<1@x>' }) }) } }),
  });
  assert.equal(smtp.via, 'smtp');
  assert.deepEqual(await smtp.send({ to: ['a@b.c', 'd@e.f'], subject: 'S', html: 'h', text: 't' }), { id: '<1@x>' });
  assert.equal(mails[0].m.to, 'a@b.c, d@e.f');
  assert.deepEqual(mails[0].opts.auth, { user: 'u', pass: 'p' });
});
