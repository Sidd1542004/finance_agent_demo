// Viewing an invoice's original PDF in the app: what is kept, who may see it,
// how it is sent (inline, never sniffed, never cached), and the clear answers
// for invoices with no PDF, a damaged stored file, or one too large to send.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startApp, PASSWORD } from '../test-support/app.js';

const t = await startApp();
test.after(t.stop);

const { Invoice, InvoiceDocument } = await import('../src/models/index.js');
const { createUser } = await import('../src/services/users.js');
const { TEST_SETUP } = await import('../test-support/actors.js');
const { openInvoiceDocument, saveInvoiceDocument, inlineDisposition, looksLikePdf, MAX_RESPONSE_BYTES_ON_VERCEL } = await import('../src/services/invoiceDocuments.js');

const PDF = fs.readFileSync(new URL('./fixtures/INV-000003-po.pdf', import.meta.url));
const reviewer = await t.signIn('reviewer');

// A multipart upload, as the dashboard sends it.
async function upload(c, buffer, filename, type) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  const res = await fetch(`${t.base}/api/invoices`, { method: 'POST', headers: { cookie: c.cookie, 'X-FOA-Request': '1' }, body: form });
  return { status: res.status, data: await res.json() };
}

let uploadedId;

test('an uploaded PDF is kept and the invoice says it can be viewed', async () => {
  const res = await upload(reviewer, PDF, 'INV-000003-po.pdf', 'application/pdf');
  assert.equal(res.status, 201, JSON.stringify(res.data));
  uploadedId = res.data.invoice._id;
  assert.deepEqual(res.data.document, { available: true, filename: 'INV-000003-po.pdf', size: PDF.length, mimeType: 'application/pdf' });
  const doc = await InvoiceDocument.findOne({ invoiceId: uploadedId }).lean();
  assert.equal(doc.size, PDF.length);
  assert.ok(doc.sha256);
  // The invoice record itself does not carry the file.
  const invoice = await Invoice.findById(uploadedId).lean();
  assert.ok(!JSON.stringify(invoice).includes('%PDF-'));
});

test('every role that can open the invoice can view its PDF: inline, as a PDF, not cached, not framed by other sites', async () => {
  for (const role of ['reviewer', 'approver', 'payer', 'admin']) {
    const c = await t.signIn(role);
    const res = await fetch(`${t.base}/api/invoices/${uploadedId}/document`, { headers: { cookie: c.cookie } });
    assert.equal(res.status, 200, role);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /^inline; filename="INV-000003-po\.pdf"/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self'");
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(PDF), `${role}: the exact file`);
  }
});

test('signed out, or an account with no role, cannot view a PDF', async () => {
  assert.equal((await fetch(`${t.base}/api/invoices/${uploadedId}/document`)).status, 401);
  await createUser({ email: 'norole@test.example', name: 'No Role', password: PASSWORD, roles: [] }, TEST_SETUP);
  const c = t.client();
  assert.equal((await c.post('/api/auth/login', { email: 'norole@test.example', password: PASSWORD })).status, 200);
  const res = await fetch(`${t.base}/api/invoices/${uploadedId}/document`, { headers: { cookie: c.cookie } });
  assert.equal(res.status, 403);
  assert.notEqual(res.headers.get('content-type'), 'application/pdf');
});

test('no PDF to show: pasted text, a text file, an unknown or malformed id each get a clear answer', async () => {
  const pasted = await reviewer.post('/api/invoices', { text: fs.readFileSync(new URL('../../samples/clean.txt', import.meta.url), 'utf8') });
  assert.equal(pasted.status, 201);
  assert.equal(pasted.data.document.available, false);
  assert.equal(pasted.data.document.code, 'no_file');
  const a = await reviewer.get(`/api/invoices/${pasted.data.invoice._id}/document`);
  assert.equal(a.status, 404);
  assert.equal(a.data.code, 'no_file');
  assert.match(a.data.error, /pasted text/);

  const txt = await upload(reviewer, fs.readFileSync(new URL('../../samples/no-po.txt', import.meta.url)), 'no-po.txt', 'text/plain');
  assert.equal(txt.status, 201, JSON.stringify(txt.data));
  assert.equal(txt.data.document.code, 'not_pdf');
  assert.equal(await InvoiceDocument.exists({ invoiceId: txt.data.invoice._id }), null, 'a text file is not kept');
  const b = await reviewer.get(`/api/invoices/${txt.data.invoice._id}/document`);
  assert.equal(b.status, 404);
  assert.equal(b.data.code, 'not_pdf');
  assert.match(b.data.error, /Only PDF invoices/);

  assert.equal((await reviewer.get('/api/invoices/not-an-id/document')).status, 404);
  const gone = await reviewer.get('/api/invoices/0123456789abcdef01234567/document');
  assert.equal(gone.status, 404);
  assert.match(gone.data.error, /no longer exists/);
});

test('a PDF invoice added before PDFs were kept says so', async () => {
  const old = await Invoice.create({ source: { kind: 'upload', filename: 'old-invoice.pdf' }, rawText: 'An invoice uploaded before PDFs were kept. '.repeat(3) });
  const res = await reviewer.get(`/api/invoices/${old._id}/document`);
  assert.equal(res.status, 404);
  assert.equal(res.data.code, 'not_stored');
  assert.match(res.data.error, /was not kept/);
  const detail = await reviewer.get(`/api/invoices/${old._id}`);
  assert.equal(detail.data.document.code, 'not_stored');
});

test('a damaged upload is refused before anything is kept', async () => {
  const before = await InvoiceDocument.countDocuments();
  const res = await upload(reviewer, Buffer.from('%PDF-1.7\nthis is not really a PDF at all\n'), 'broken.pdf', 'application/pdf');
  assert.equal(res.status, 400);
  assert.match(res.data.error, /could not be opened as a PDF/);
  assert.equal(await InvoiceDocument.countDocuments(), before);
});

test('a stored file that is not a PDF is never sent as one', async () => {
  const inv = await Invoice.create({ source: { kind: 'upload', filename: 'tampered.pdf' }, rawText: 'An invoice whose stored file was replaced. '.repeat(3) });
  await InvoiceDocument.create({ invoiceId: inv._id, filename: 'tampered.pdf', size: 12, sha256: 'x', data: Buffer.from('<html>hi</html>') });
  const res = await reviewer.get(`/api/invoices/${inv._id}/document`);
  assert.equal(res.status, 415);
  assert.equal(res.data.code, 'invalid_pdf');
  assert.match(res.headers.get('content-type'), /application\/json/);
});

test('only PDFs are kept, whatever the file name says', async () => {
  const id = (await Invoice.create({ source: { kind: 'upload', filename: 'x.pdf' }, rawText: 'x'.repeat(60) }))._id;
  assert.equal(await saveInvoiceDocument(id, { buffer: Buffer.from('\x89PNG....not a pdf'), filename: 'x.pdf', mimetype: 'application/pdf' }), null);
  assert.equal(await saveInvoiceDocument(id, { buffer: Buffer.alloc(0), filename: 'x.pdf' }), null);
  assert.equal(looksLikePdf(PDF), true);
  assert.equal(await InvoiceDocument.exists({ invoiceId: id }), null);
});

test('on Vercel, a PDF too large for a function response is refused with a clear message', async () => {
  const inv = await Invoice.create({ source: { kind: 'email', filename: 'big.pdf' }, rawText: 'A large invoice imported from a mailbox. '.repeat(3) });
  const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.ceil(MAX_RESPONSE_BYTES_ON_VERCEL) + 10, 32)]);
  await InvoiceDocument.create({ invoiceId: inv._id, filename: 'big.pdf', size: big.length, sha256: 'x', data: big });
  await assert.rejects(openInvoiceDocument(inv._id, { onVercel: true }), (err) => err.status === 413 && err.extra.code === 'too_large');
  const ok = await openInvoiceDocument(inv._id, { onVercel: false });
  assert.equal(ok.buffer.length, big.length, 'served locally');
});

test('the file name in the header cannot break out of it', () => {
  assert.equal(inlineDisposition('a"b;c\r\nd.pdf'), `inline; filename="a_b_c__d.pdf"; filename*=UTF-8''${encodeURIComponent('a"b;c\r\nd.pdf')}`);
  assert.match(inlineDisposition('Rechnung März'), /^inline; filename="Rechnung M_rz\.pdf"; filename\*=UTF-8''Rechnung%20M%C3%A4rz\.pdf$/);
});
