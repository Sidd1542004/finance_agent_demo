// End-to-end smoke test against a running deployment (local or Vercel).
// It RESETS THE DATA (loads the demo month), so only point it at a demo.
//
//   SMOKE_EMAIL=... SMOKE_USER_PASSWORD=... node scripts/smoke.js http://localhost:3000
//   SMOKE_PASSWORD=... SMOKE_EMAIL=... SMOKE_USER_PASSWORD=... node scripts/smoke.js https://your-project.vercel.app
//
// SMOKE_EMAIL / SMOKE_USER_PASSWORD: an account with the admin, reviewer and
// payer roles (the demo month, adding invoices and reconciling need them).
// SMOKE_PASSWORD is the ACCESS_PASSWORD, if one is set.
// SMOKE_CRON_SECRET (optional): also calls the payment scheduler's tick.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Every call says it comes from the dashboard (the server refuses changes without it).
const headers = {
  'X-FOA-Request': '1',
  ...(process.env.SMOKE_PASSWORD ? { Authorization: `Basic ${Buffer.from(`smoke:${process.env.SMOKE_PASSWORD}`).toString('base64')}` } : {}),
};
let cookie = '';

async function call(method, url, body, extra = {}) {
  const init = { method, headers: { ...headers, ...(cookie ? { cookie } : {}), ...extra } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${url}`, init);
  const session = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('foa_session='));
  if (session) cookie = session.split(';')[0];
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${typeof data === 'string' ? data.slice(0, 200) : data.error}`);
  return { status: res.status, data, type: res.headers.get('content-type') || '' };
}

const ok = (label, detail = '') => console.log(`ok  ${label}${detail ? `: ${detail}` : ''}`);

const page = await call('GET', '/');
if (!/<div id="root">/.test(page.data)) throw new Error('The dashboard page did not load.');
ok('dashboard page', page.type);

const deep = await call('GET', '/some/client/route');
if (!/<div id="root">/.test(deep.data)) throw new Error('Client routes do not fall back to index.html.');
ok('client route falls back to index.html');

const health = (await call('GET', '/api/health')).data;
ok('/api/health', `database ${health.database}, reader ${health.reader.mode}, demo mode ${health.demoMode}`);

if (!process.env.SMOKE_EMAIL || !process.env.SMOKE_USER_PASSWORD) throw new Error('Set SMOKE_EMAIL and SMOKE_USER_PASSWORD (an account with the admin, reviewer and payer roles).');
const me = (await call('POST', '/api/auth/login', { email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_USER_PASSWORD })).data.user;
ok('signed in', `${me.name} (${me.roles.join(', ')})`);

if (process.env.SMOKE_CRON_SECRET) {
  const tick = (await call('GET', '/api/cron/tick', undefined, { Authorization: `Bearer ${process.env.SMOKE_CRON_SECRET}` })).data;
  ok('payment scheduler tick', `claimed ${tick.jobs.claimed}, submitted ${tick.jobs.submitted}, completed ${tick.payments.completed}, ${tick.durationMs} ms`);
}

const demo = (await call('POST', '/api/demo/load')).data;
ok('demo month loaded', JSON.stringify(demo.invoices));

const form = new FormData();
form.append('file', new Blob([fs.readFileSync(path.join(root, 'samples', 'clean.pdf'))], { type: 'application/pdf' }), 'clean.pdf');
const uploaded = (await call('POST', '/api/invoices', form)).data.invoice;
ok('PDF invoice uploaded', `${uploaded.extracted?.invoiceNumber} from ${uploaded.extracted?.vendorName}, status ${uploaded.status}`);

const detail = (await call('GET', `/api/invoices/${uploaded._id}`)).data.invoice;
if (detail._id !== uploaded._id) throw new Error('Invoice detail did not load.');
ok('invoice detail by id (path with an id survives the rewrite)');

const statement = (await call('POST', '/api/statements', { sampleId: 'october' })).data.statement;
ok('bank statement reconciled', `${statement.lines.length} lines, status ${statement.status}`);

const report = (await call('POST', '/api/reports', { month: '2026-10' })).data.report;
ok('month-end report', `${report.status}, ${report.figures?.invoices?.received} invoices received`);

const csv = await call('GET', `/api/reports/${report._id}/csv`);
if (!String(csv.data).startsWith('Section,Item,Value')) throw new Error('The CSV did not download.');
ok('report CSV', csv.type);

console.log('\nSmoke test passed.');
