// The documents behind an invoice, viewable inside the app:
//
//   invoice          the original file as it was uploaded or imported from a
//                    mailbox (PDF, PNG, JPEG or plain text, at most 4 MB), kept in
//                    InvoiceDocument; for a text-only invoice (pasted text, a
//                    sample) or one kept before files were stored, its text
//   purchase_order   a PDF made on request from the linked purchase order
//   delivery_slip    a PDF made on request from the goods receipts against it
//
// The content type is decided from the bytes, never from what the uploader or
// the email said: only application/pdf, image/png, image/jpeg and text/plain
// are ever stored or served, so a stored file can never come back as HTML or
// SVG. Served inline, never cached, never sniffed by the browser, never framed
// by another site, with the same sign-in as the invoice (any role). Document
// content is not masked: it is what the supplier sent.

import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { Invoice, InvoiceDocument, PurchaseOrder, GoodsReceipt } from '../models/index.js';
import { config } from '../config.js';
import { HttpError } from './runs.js';
import { requireActor } from './actor.js';
import { purchaseOrderPdf, deliverySlipPdf } from './documentPdfs.js';

export const KINDS = ['invoice', 'purchase_order', 'delivery_slip'];
export const LABELS = { invoice: 'Invoice', purchase_order: 'Purchase order', delivery_slip: 'Delivery slip' };
export const ALLOWED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'];
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const TEXT = 'text/plain; charset=utf-8';
const EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'text/plain': 'txt' };

/** A Buffer from whatever the driver returned (Buffer, BSON Binary or Uint8Array). */
export function toBuffer(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data.value === 'function' && data.buffer) return Buffer.from(data.buffer); // BSON Binary
  return Buffer.from(data);
}

/**
 * What a file really is, from its bytes: application/pdf, image/png,
 * image/jpeg, or (only when `text` is allowed) text/plain for valid UTF-8 with
 * no NUL byte. Anything else, HTML and SVG included unless kept as plain text: null.
 */
export function sniffContentType(data, { text = false } = {}) {
  const b = toBuffer(data);
  if (b.length < 4) return null;
  if (b.subarray(0, 1024).toString('latin1').includes('%PDF-')) return 'application/pdf';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (text && !b.includes(0) && isUtf8(b)) return 'text/plain';
  return null;
}

// "invoice.pdf", without control characters.
const cleanName = (filename, type) => {
  const name =
    String(filename || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 200) || `invoice.${EXT[type]}`;
  return name;
};

/**
 * Keep an invoice's original file. `text`: the upload was a text file (kept as
 * text/plain). Returns what was stored ({ filename, size, contentType }), or
 * null when it is not an allowed type, empty, or over 4 MB.
 */
export async function saveInvoiceDocument(invoiceId, { buffer, filename, text = false } = {}) {
  const data = toBuffer(buffer);
  if (!data.length || data.length > MAX_DOCUMENT_BYTES) return null;
  const contentType = sniffContentType(data, { text });
  if (!contentType) return null;
  const set = { filename: cleanName(filename, contentType), contentType, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data };
  await InvoiceDocument.updateOne({ invoiceId }, { $set: set, $unset: { mimeType: '' } }, { upsert: true });
  return { filename: set.filename, size: set.size, contentType };
}

/** The same, for callers that must carry on whatever happens (uploads, ingestion): a failure is logged. */
export async function keepInvoiceDocument(invoiceId, file, { log = console } = {}) {
  try {
    return await saveInvoiceDocument(invoiceId, file);
  } catch (err) {
    log.error?.(`The original file of invoice ${invoiceId} could not be stored: ${err?.message}`);
    return null;
  }
}

const storedType = (doc) => doc?.contentType || doc?.mimeType || null; // mimeType: records kept before contentType

async function context(invoice) {
  const [doc, po] = await Promise.all([
    InvoiceDocument.findOne({ invoiceId: invoice._id }).select('filename size contentType mimeType').lean(),
    invoice.matchedPo ? PurchaseOrder.findOne({ poNumber: invoice.matchedPo }).lean() : null,
  ]);
  const receipts = po ? await GoodsReceipt.find({ poNumber: po.poNumber }).sort({ receivedOn: 1 }).lean() : [];
  return { doc, po, receipts };
}

/** What can be viewed for this invoice, and why not when it cannot. */
export function describeDocuments(invoice, { doc, po, receipts }) {
  const source = invoice.source || {};
  const textOnly = source.kind === 'paste' || source.kind === 'sample';
  let inv;
  if (doc && ALLOWED_TYPES.includes(storedType(doc))) {
    inv = { available: true, source: 'original', contentType: storedType(doc), filename: doc.filename, size: doc.size, reason: null };
  } else if (invoice.rawText) {
    inv = {
      available: true,
      source: 'text',
      contentType: 'text/plain',
      filename: null,
      size: null,
      reason: textOnly
        ? 'This invoice was added as text, so its text is shown.'
        : 'The original file was not kept (it was added before files were stored, or was larger than 4 MB), so the text read from it is shown.',
    };
  } else inv = { available: false, reason: 'There is no file or text for this invoice.' };

  const noPo = invoice.matchedPo ? `Purchase order ${invoice.matchedPo} is no longer on file.` : 'No purchase order linked.';
  const purchaseOrder = po ? { available: true, source: 'generated', contentType: 'application/pdf', reason: null, poNumber: po.poNumber } : { available: false, reason: noPo };
  const slip = !po
    ? { available: false, reason: noPo }
    : receipts.length
      ? { available: true, source: 'generated', contentType: 'application/pdf', reason: null, poNumber: po.poNumber, deliveries: receipts.length }
      : { available: false, reason: `No delivery recorded against ${po.poNumber}.` };
  return [
    { kind: 'invoice', label: LABELS.invoice, ...inv },
    { kind: 'purchase_order', label: LABELS.purchase_order, ...purchaseOrder },
    { kind: 'delivery_slip', label: LABELS.delivery_slip, ...slip },
  ];
}

async function loadInvoice(invoiceId) {
  const invoice = await Invoice.findById(invoiceId).select('source rawText matchedPo extracted.invoiceNumber extracted.currency').lean();
  if (!invoice) throw new HttpError(404, 'That invoice no longer exists.');
  return invoice;
}

/** For the invoice detail (already loaded) and GET /api/invoices/:id/documents. */
export async function documentsFor(invoice) {
  return describeDocuments(invoice, await context(invoice));
}

export async function listInvoiceDocuments(invoiceId, actor) {
  requireActor(actor);
  return documentsFor(await loadInvoice(invoiceId));
}

/**
 * One document to send back: { buffer, contentType, filename }. 404 for an
 * unknown kind or one that does not exist (with the reason); 415 if a stored
 * file is not, by its bytes, the allowed type it was kept as.
 */
export async function openInvoiceDocument(invoiceId, kind, actor) {
  requireActor(actor);
  if (!KINDS.includes(kind)) throw new HttpError(404, 'Unknown document. Choose invoice, purchase_order or delivery_slip.');
  const invoice = await loadInvoice(invoiceId);
  const ctx = await context(invoice);
  const item = describeDocuments(invoice, ctx).find((d) => d.kind === kind);
  if (!item.available) throw new HttpError(404, item.reason, { code: 'not_available' });
  const number = invoice.extracted?.invoiceNumber || String(invoice._id);
  const currency = invoice.extracted?.currency || 'AUD';

  if (kind === 'invoice' && item.source === 'original') {
    const doc = await InvoiceDocument.findOne({ invoiceId: invoice._id }).lean();
    const buffer = toBuffer(doc.data);
    const type = storedType(doc);
    // Checked again on the way out: only what the bytes really are, and only an allowed type.
    if (sniffContentType(buffer, { text: type === 'text/plain' }) !== type) {
      throw new HttpError(415, 'The stored file is not the type it was kept as, so it is not shown. The text read from it is on the invoice.', { code: 'invalid_file' });
    }
    return { buffer, contentType: type === 'text/plain' ? TEXT : type, filename: doc.filename || `invoice-${number}.${EXT[type]}` };
  }
  if (kind === 'invoice') return { buffer: Buffer.from(invoice.rawText, 'utf8'), contentType: TEXT, filename: `invoice-${number}.txt` };

  const opts = { companyName: config.companyName, gstRatePct: config.policy.gstRatePct, currency };
  if (kind === 'purchase_order') return { buffer: await purchaseOrderPdf(ctx.po, opts), contentType: 'application/pdf', filename: `${ctx.po.poNumber}.pdf` };
  return { buffer: await deliverySlipPdf(ctx.po, ctx.receipts, opts), contentType: 'application/pdf', filename: `${ctx.po.poNumber}-delivery-slip.pdf` };
}

/** Content-Disposition for showing a file inline, with a safe file name. */
export function inlineDisposition(filename) {
  const name = String(filename || 'document');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Inline, never cached, never sniffed as anything else, only framed by this site.
export const DOCUMENT_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "frame-ancestors 'self'",
  'Cross-Origin-Resource-Policy': 'same-origin',
});
