// Scanned and photographed invoices: read by a Groq vision model (a fake one
// here), grounded against its transcription, and always sent to a person.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules, readInvoiceImages, createVisionReader } from '../src/agent/finance/extract.js';
import { readUpload, renderPdfPages, NEEDS_OCR, NOT_SUPPORTED } from '../src/services/uploads.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, sampleInvoices, renderInvoiceText } from '../src/seed/data.js';

const policy = { matchThreshold: 85, missingAbn: 'review', priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };
const CLEAN = renderInvoiceText(sampleInvoices.find((s) => s.id === 'clean'));

// A stand-in for the Groq vision model: it "transcribes" the clean invoice and
// reads its fields, changed by `override`. Every request is recorded.
function fakeVision({ transcription = CLEAN, override = {} } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(JSON.parse(init.body));
    const { extracted } = extractWithRules(transcription);
    const content = JSON.stringify({ transcription, invoice: { ...extracted, confidence: 0.93, notes: null, ...override } });
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const reader = { model: 'vision-model', read: (images) => readInvoiceImages(images, { apiKey: 'k', model: 'vision-model', fetchImpl }) };
  return { reader, requests };
}

// An invoice drawn as a picture: a PNG or JPEG, and a PDF holding only that picture (no text layer).
async function scannedInvoice() {
  const lines = CLEAN.split('\n');
  const canvas = createCanvas(900, 24 * lines.length + 40);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000';
  g.font = '16px monospace';
  lines.forEach((l, i) => g.fillText(l, 20, 30 + i * 24));
  return { png: await canvas.encode('png'), jpeg: await canvas.encode('jpeg', 80), width: canvas.width, height: canvas.height };
}

function imageOnlyPdf(jpeg, width, height) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
    chunks.push(b);
    length += b.length;
  };
  const obj = (n, body, stream) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };
  const draw = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
  obj(5, `<< /Length ${draw.length} >>`, draw);
  const xref = length;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

const file = (originalname, mimetype, buffer) => ({ originalname, mimetype, buffer });

test('a photo is read by the vision model: one request with the image, in JSON mode', async () => {
  const { png } = await scannedInvoice();
  const v = fakeVision();
  const { rawText, reading, source } = await readUpload(file('invoice.png', 'image/png', png), { vision: v.reader });

  assert.equal(v.requests.length, 1);
  const body = v.requests[0];
  assert.equal(body.model, 'vision-model');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const image = body.messages[1].content.find((p) => p.type === 'image_url');
  assert.ok(image.image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(Buffer.from(image.image_url.url.split(',')[1], 'base64').length, png.length);
  assert.match(body.messages[0].content, /Transcribe all the text you can see/);

  assert.equal(rawText, CLEAN, 'the transcription becomes the invoice text');
  assert.deepEqual(source, { kind: 'upload', filename: 'invoice.png', scan: { from: 'image', pages: 1, model: 'vision-model' } });
  assert.equal(reading.extraction.method, 'groq-vision');
  assert.equal(reading.extraction.input, 'image');
  assert.equal(reading.extracted.total, 1402.5);
  assert.equal(reading.extraction.confidence, 0.93);
});

test('JPEG works too; anything that is not really an image is refused', async () => {
  const { jpeg } = await scannedInvoice();
  const v = fakeVision();
  const out = await readUpload(file('scan.JPG', 'image/jpeg', jpeg), { vision: v.reader });
  assert.equal(out.source.scan.from, 'image');
  assert.ok(v.requests[0].messages[1].content[1].image_url.url.startsWith('data:image/jpeg;base64,'));
  await assert.rejects(readUpload(file('fake.png', 'image/png', Buffer.from('not an image at all')), { vision: v.reader }), /not a valid JPG or PNG image/);
});

test('the fields are grounded against the transcription', async () => {
  const { png } = await scannedInvoice();
  const v = fakeVision({ override: { total: 1420.5, invoiceNumber: 'HOS-99999' } });
  const { reading } = await readUpload(file('invoice.png', 'image/png', png), { vision: v.reader });
  assert.match(reading.extraction.notes, /do not appear in the invoice text as read: invoice number, total/);
  assert.equal(reading.extraction.confidence, 0.5);
});

test('a vision answer with no readable text is a clear error', async () => {
  const { png } = await scannedInvoice();
  const v = fakeVision({ transcription: '[illegible] [illegible]' });
  await assert.rejects(readUpload(file('blurry.png', 'image/png', png), { vision: v.reader }), (err) => err.status === 422 && /could not be read by the AI vision reader: No readable text was found in the image/.test(err.message));
});

test('a scanned PDF (no text layer): its first page is rendered and read by the vision model', async () => {
  const { jpeg, width, height } = await scannedInvoice();
  const pdf = imageOnlyPdf(jpeg, width, height);

  const pages = await renderPdfPages(pdf);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].mimetype, 'image/png');
  assert.ok(pages[0].data.length > 1000, 'a real rendered page');

  const v = fakeVision();
  const out = await readUpload(file('scan.pdf', 'application/pdf', pdf), { vision: v.reader });
  assert.deepEqual(out.source.scan, { from: 'pdf', pages: 1, model: 'vision-model' });
  assert.equal(out.rawText, CLEAN);
  assert.ok(v.requests[0].messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'));

  // If the pages cannot be rendered on this server, the clear "needs OCR" message, with why.
  await assert.rejects(readUpload(file('scan.pdf', 'application/pdf', pdf), { vision: v.reader, renderPages: async () => { throw new Error('no canvas'); } }), (err) => err.status === 400 && err.message.startsWith(NEEDS_OCR) && /could not be turned into images/.test(err.message));
});

test('without a Groq key: the same clear messages as before for scans and images', async () => {
  assert.equal(createVisionReader({ groqApiKey: '', groqVisionModel: 'x' }), null);
  const { png, jpeg, width, height } = await scannedInvoice();
  await assert.rejects(readUpload(file('invoice.png', 'image/png', png), { vision: null }), (err) => err.status === 400 && err.message === NOT_SUPPORTED);
  // A scanned PDF has no text: the route then answers NEEDS_OCR, as before.
  const out = await readUpload(file('scan.pdf', 'application/pdf', imageOnlyPdf(jpeg, width, height)), { vision: null });
  assert.equal(out.rawText.trim(), '');
  assert.equal(out.reading, undefined);
});

test('an invoice read from an image always goes to Needs Review, even when every other check passes', async () => {
  const { png } = await scannedInvoice();
  const v = fakeVision();
  const { rawText, reading, source } = await readUpload(file('invoice.png', 'image/png', png), { vision: v.reader });

  const invoices = [];
  const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices });
  const agent = createInvoiceAgent({ ledger, extract: async (text) => extractWithRules(text), policy, save: async () => {}, today: () => '2026-10-12' });
  const invoice = { id: 'inv-1', createdAt: new Date('2026-10-01T00:00:00Z'), source, rawText, status: 'received' };
  invoices.push(invoice);
  await runAgent(agent, { invoice, reading });

  const failed = invoice.checks.filter((c) => c.status === 'fail');
  assert.deepEqual(failed.map((c) => c.id), ['read_from_image'], 'the same invoice as text would be clean');
  assert.equal(failed[0].label, 'Read from an image: confirm the key fields');
  assert.equal(failed[0].severity, 'review');
  assert.equal(invoice.status, 'needs_review');
  assert.equal(invoice.extraction.method, 'groq-vision');

  // Processing again reads the transcription with the text reader; the check stays.
  invoice.status = 'needs_review';
  await runAgent(agent, { invoice });
  assert.equal(invoice.extraction.method, 'rules');
  assert.equal(invoice.status, 'needs_review');
  assert.ok(invoice.checks.some((c) => c.id === 'read_from_image' && c.status === 'fail'));
});
