// End-to-end smoke test against a running deployment (local or Vercel).
// It RESETS THE DATA (loads the demo month), so only point it at a demo.
//
//   node scripts/smoke.js http://localhost:3000
//   SMOKE_PASSWORD=... node scripts/smoke.js https://your-project.vercel.app
//
// SMOKE_PASSWORD is the ACCESS_PASSWORD, if one is set.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headers = process.env.SMOKE_PASSWORD ? { Authorization: `Basic ${Buffer.from(`smoke:${process.env.SMOKE_PASSWORD}`).toString('base64')}` } : {};

async function call(method, url, body) {
  const init = { method, headers: { ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${url}`, init);
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
