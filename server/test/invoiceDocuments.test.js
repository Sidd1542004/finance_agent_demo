// The documents behind an invoice: its original file (byte for byte), its text
// when there is no file, and the purchase order and delivery slip made as PDFs
// from the records. Who may see them, the headers they are sent with, and that
// a stored file can never come back as HTML or SVG.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { extractText, getDocumentProxy } from 'unpdf';
import { startApp, PASSWORD } from '../test-support/app.js';

const t = await startApp();
test.after(t.stop);

const { Invoice, InvoiceDocument } = await import('../src/models/index.js');
const { createUser } = await import('../src/services/users.js');
const { TEST_SETUP } = await import('../test-support/actors.js');
const { sniffContentType, saveInvoiceDocument, inlineDisposition, MAX_DOCUMENT_BYTES } = await import('../src/services/invoiceDocuments.js');

const PDF = fs.readFileSync(new URL('./fixtures/INV-000003-po.pdf', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const reviewer = await t.signIn('reviewer');

async function upload(c, buffer, filename, type) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), filename);
  const res = await fetch(`${t.base}/api/invoices`, { method: 'POST', headers: { cookie: c.cookie, 'X-FOA-Request': '1' }, body: form });
  return { status: res.status, data: await res.json() };
}
const get = (c, url) => fetch(`${t.base}${url}`, { headers: c?.cookie ? { cookie: c.cookie } : {} });
const doc = (list, kind) => list.find((d) => d.kind === kind);
const pdfText = async (buf) => (await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true })).text;
const assertHeaders = (res, type) => {
  assert.equal(res.headers.get('content-type'), type);
  assert.match(res.headers.get('content-disposition'), /^inline; filename="/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
};

let pdfInvoice;
let pastedId;
let cleanId;

test('an uploaded PDF is kept, and comes back byte for byte (same SHA-256), inline, for every role', async () => {
  const res = await upload(reviewer, PDF, 'INV-000003-po.pdf', 'application/pdf');
  assert.equal(res.status, 201, JSON.stringify(res.data));
  pdfInvoice = res.data.invoice._id;
  assert.deepEqual(
    res.data.documents.map((d) => [d.kind, d.available]),
    [
      ['invoice', true],
      ['purchase_order', false],
      ['delivery_slip', false],
    ],
  );
  assert.equal(doc(res.data.documents, 'invoice').source, 'original');
  const stored = await InvoiceDocument.findOne({ invoiceId: pdfInvoice }).lean();
  assert.equal(stored.sha256, sha(PDF));
  assert.equal(stored.contentType, 'application/pdf');
  assert.ok(!JSON.stringify(await Invoice.findById(pdfInvoice).lean()).includes('%PDF-'), 'the invoice record does not carry the file');
  for (const role of ['reviewer', 'approver', 'payer', 'admin']) {
    const c = await t.signIn(role);
    const r = await get(c, `/api/invoices/${pdfInvoice}/documents/invoice`);
    assert.equal(r.status, 200, role);
    assertHeaders(r, 'application/pdf');
    assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(PDF), `${role}: byte-identical`);
  }
});

test('signed out gets 401; an account with no role gets 403', async () => {
  for (const url of [`/api/invoices/${pdfInvoice}/documents`, `/api/invoices/${pdfInvoice}/documents/invoice`, `/api/invoices/${pdfInvoice}/documents/purchase_order`]) {
    assert.equal((await get(null, url)).status, 401, url);
  }
  await createUser({ email: 'norole-docs@test.example', name: 'No Role', password: PASSWORD, roles: [] }, TEST_SETUP);
  const c = t.client();
  await c.post('/api/auth/login', { email: 'norole-docs@test.example', password: PASSWORD });
  assert.equal((await get(c, `/api/invoices/${pdfInvoice}/documents/invoice`)).status, 403);
});

test('a missing document gets 404 with the reason; an unknown kind or invoice is 404 too', async () => {
  const noPo = await get(reviewer, `/api/invoices/${pdfInvoice}/documents/purchase_order`);
  assert.equal(noPo.status, 404);
  assert.match((await noPo.json()).error, /No purchase order linked/);
  assert.equal((await get(reviewer, `/api/invoices/${pdfInvoice}/documents/delivery_slip`)).status, 404);
  assert.equal((await get(reviewer, `/api/invoices/${pdfInvoice}/documents/contract`)).status, 404);
  assert.equal((await get(reviewer, '/api/invoices/0123456789abcdef01234567/documents/invoice')).status, 404);
  assert.equal((await get(reviewer, '/api/invoices/not-an-id/documents')).status, 404);
});

test('a text-only invoice is shown as its text; the purchase order and delivery slip are PDFs with the PO number', async () => {
  const pasted = await reviewer.post('/api/invoices', { text: fs.readFileSync(new URL('../../samples/clean.txt', import.meta.url), 'utf8') });
  assert.equal(pasted.status, 201);
  pastedId = pasted.data.invoice._id;
  const sample = await reviewer.post('/api/invoices', { sampleId: 'clean' });
  cleanId = sample.data.invoice._id;
  assert.equal(sample.data.invoice.matchedPo, 'PO-2041');
  const list = (await reviewer.get(`/api/invoices/${cleanId}/documents`)).data.items;
  assert.equal(doc(list, 'invoice').source, 'text');
  assert.match(doc(list, 'invoice').reason, /added as text/);
  assert.equal(doc(list, 'purchase_order').available, true);
  assert.equal(doc(list, 'delivery_slip').available, true);

  const text = await get(reviewer, `/api/invoices/${cleanId}/documents/invoice`);
  assert.equal(text.status, 200);
  assertHeaders(text, 'text/plain; charset=utf-8');
  assert.equal(await text.text(), (await Invoice.findById(cleanId).lean()).rawText);

  for (const kind of ['purchase_order', 'delivery_slip']) {
    const r = await get(reviewer, `/api/invoices/${cleanId}/documents/${kind}`);
    assert.equal(r.status, 200, kind);
    assertHeaders(r, 'application/pdf');
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.subarray(0, 5).toString('latin1'), '%PDF-', `${kind} starts with %PDF`);
    const words = await pdfText(body);
    assert.match(words, /PO-2041/, `${kind} names the purchase order`);
    assert.match(words, /Harbour Office Supplies/);
    assert.match(words, /not the original\s+document/);
  }
  assert.match(await pdfText(Buffer.from(await (await get(reviewer, `/api/invoices/${cleanId}/documents/purchase_order`)).arrayBuffer())), /Total/);
});

test('an HTML or SVG upload is never served as HTML or SVG', async () => {
  // An SVG file is refused at upload, and nothing is kept.
  const before = await InvoiceDocument.countDocuments();
  assert.equal((await upload(reviewer, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'invoice.svg', 'image/svg+xml')).status, 400);
  assert.equal(await InvoiceDocument.countDocuments(), before);

  // An HTML file is read as text (as any text/* upload is), kept as plain text and sent back as plain text.
  const page = await upload(reviewer, Buffer.from('<html><body>Invoice number: INV-HTML-0 Total 10.00<script>alert(1)</script></body></html>'), 'invoice.html', 'text/html');
  assert.equal(page.status, 201, JSON.stringify(page.data));
  assert.equal((await InvoiceDocument.findOne({ invoiceId: page.data.invoice._id }).lean()).contentType, 'text/plain');
  assertHeaders(await get(reviewer, `/api/invoices/${page.data.invoice._id}/documents/invoice`), 'text/plain; charset=utf-8');

  // HTML sent as a text file is kept and sent back as plain text, never as HTML.
  const html = 'Invoice number: INV-HTML-1\nTotal: 10.00\n<html><body><script>alert(document.cookie)</script></body></html>\n'.repeat(2);
  const res = await upload(reviewer, Buffer.from(html), 'invoice.txt', 'text/html');
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal((await InvoiceDocument.findOne({ invoiceId: res.data.invoice._id }).lean()).contentType, 'text/plain');
  const r = await get(reviewer, `/api/invoices/${res.data.invoice._id}/documents/invoice`);
  assertHeaders(r, 'text/plain; charset=utf-8');

  // A stored record claiming to be HTML or SVG (written behind the app's back) is refused, not served.
  for (const contentType of ['text/html', 'image/svg+xml']) {
    const inv = await Invoice.create({ source: { kind: 'upload', filename: 'x.html' }, rawText: 'An invoice with a forged stored file. '.repeat(3) });
    await InvoiceDocument.collection.insertOne({ invoiceId: inv._id, filename: 'x.html', contentType, size: 20, sha256: 'x', data: Buffer.from('<svg onload="alert(1)"/>') });
    const forged = await get(reviewer, `/api/invoices/${inv._id}/documents/invoice`);
    assert.notEqual(forged.headers.get('content-type'), contentType, contentType);
    assert.ok(!/html|svg/.test(forged.headers.get('content-type') || ''), contentType);
  }
  // A stored "PDF" whose bytes are not a PDF: 415.
  const inv = await Invoice.create({ source: { kind: 'upload', filename: 'fake.pdf' }, rawText: 'An invoice whose stored file was replaced. '.repeat(3) });
  await InvoiceDocument.create({ invoiceId: inv._id, filename: 'fake.pdf', contentType: 'application/pdf', size: 15, sha256: 'x', data: Buffer.from('<html>hi</html>') });
  const fake = await get(reviewer, `/api/invoices/${inv._id}/documents/invoice`);
  assert.equal(fake.status, 415);
  assert.match(fake.headers.get('content-type'), /application\/json/);
});

test('the bytes decide the type; only PDF, PNG, JPEG or (for text uploads) plain text is kept, at most 4 MB', async () => {
  assert.equal(sniffContentType(PDF), 'application/pdf');
  assert.equal(sniffContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'image/png');
  assert.equal(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  assert.equal(sniffContentType(Buffer.from('<svg/> plain words')), null, 'text only when the upload was a text file');
  assert.equal(sniffContentType(Buffer.from('<svg/> plain words'), { text: true }), 'text/plain');
  assert.equal(sniffContentType(Buffer.from([0x41, 0x00, 0x42, 0x43, 0x44]), { text: true }), null, 'binary is not text');
  const id = (await Invoice.create({ source: { kind: 'upload', filename: 'big.pdf' }, rawText: 'x'.repeat(60) }))._id;
  const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(MAX_DOCUMENT_BYTES, 32)]);
  assert.equal(await saveInvoiceDocument(id, { buffer: big, filename: 'big.pdf' }), null, 'over 4 MB');
  assert.equal(await InvoiceDocument.exists({ invoiceId: id }), null);
  const list = (await reviewer.get(`/api/invoices/${id}/documents`)).data.items;
  assert.equal(doc(list, 'invoice').source, 'text');
  assert.match(doc(list, 'invoice').reason, /not kept/);
});

test('the file name in the header cannot break out of it', () => {
  assert.equal(inlineDisposition('a"b;c\r\nd.pdf'), `inline; filename="a_b_c__d.pdf"; filename*=UTF-8''${encodeURIComponent('a"b;c\r\nd.pdf')}`);
  assert.match(inlineDisposition('Rechnung März.pdf'), /^inline; filename="Rechnung M_rz\.pdf"; filename\*=UTF-8''Rechnung%20M%C3%A4rz\.pdf$/);
});

test('the invoice detail lists the documents, so the screen needs no extra request', async () => {
  const detail = (await reviewer.get(`/api/invoices/${pastedId}`)).data;
  assert.deepEqual(
    detail.documents.map((d) => d.kind),
    ['invoice', 'purchase_order', 'delivery_slip'],
  );
  assert.equal(detail.document, undefined, 'the single-PDF field is gone');
});
