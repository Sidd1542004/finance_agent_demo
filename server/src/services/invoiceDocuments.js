// The original PDF of an invoice: kept when it is uploaded or imported from a
// mailbox, and served back so a person can view it inside the app.
//
// Only PDFs are kept (the first bytes must say %PDF-). Images and text files
// are not: their text is already on the invoice. The file is served with the
// same sign-in and role rules as the invoice itself (GET /api/invoices/:id),
// inline, never as a download, and never from another site.

import { createHash } from 'node:crypto';
import { Invoice, InvoiceDocument } from '../models/index.js';
import { HttpError } from './runs.js';

export const PDF_TYPE = 'application/pdf';
// Under MongoDB's 16 MB document limit. Uploads stop at 4 MB anyway; mailbox attachments at INGESTION_MAX_ATTACHMENT_MB.
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
// Vercel refuses a function response over 4.5 MB, headers included.
export const MAX_RESPONSE_BYTES_ON_VERCEL = 4.4 * 1024 * 1024;

/** A Buffer from whatever the driver returned (Buffer, BSON Binary or Uint8Array). */
export function toBuffer(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data.value === 'function' && data.buffer) return Buffer.from(data.buffer); // BSON Binary
  return Buffer.from(data);
}

/** Does this look like a PDF? The header must be in the first 1 KB (as PDF readers allow). */
export function looksLikePdf(buffer) {
  const b = toBuffer(buffer);
  return b.length > 8 && b.subarray(0, 1024).toString('latin1').includes('%PDF-');
}

/**
 * Whether an invoice has a PDF that can be viewed, and if not, why, in words
 * the dashboard shows as they are. `meta`: the stored document without its bytes, or null.
 */
export function documentStatus(invoice, meta) {
  if (meta) return { available: true, filename: meta.filename, size: meta.size, mimeType: PDF_TYPE };
  const source = invoice?.source || {};
  if (source.kind === 'paste' || source.kind === 'sample') {
    return { available: false, code: 'no_file', reason: 'There is no original file: this invoice was added as pasted text or from the sample set.' };
  }
  const pdf = /\.pdf$/i.test(source.filename || '') || source.scan?.from === 'pdf';
  if (!pdf) {
    return {
      available: false,
      code: 'not_pdf',
      reason: 'Only PDF invoices can be viewed here. This one was added as an image or a text file; the text read from it is shown under "Original invoice text".',
    };
  }
  return {
    available: false,
    code: 'not_stored',
    reason: 'The original PDF was not kept for this invoice (it was added before PDFs were stored, or could not be saved). Its text is shown under "Original invoice text".',
  };
}

const metaOf = (invoiceId) => InvoiceDocument.findOne({ invoiceId }).select('filename size createdAt').lean();

/** For the invoice detail: the document's status, without loading the file. */
export async function invoiceDocumentStatus(invoice) {
  return documentStatus(invoice, await metaOf(invoice._id));
}

/**
 * Keep the original file of an invoice, if it is a PDF. Returns what was
 * stored ({ filename, size }) or null (not a PDF, empty or too large).
 */
export async function saveInvoiceDocument(invoiceId, { buffer, filename, mimetype } = {}) {
  const data = toBuffer(buffer);
  if (!looksLikePdf(data) || data.length > MAX_DOCUMENT_BYTES) return null;
  if (mimetype && !/^application\/(pdf|octet-stream)$/i.test(mimetype) && !/\.pdf$/i.test(filename || '')) return null;
  const name =
    String(filename || 'invoice.pdf')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 200) || 'invoice.pdf';
  const set = { filename: name, mimeType: PDF_TYPE, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data };
  await InvoiceDocument.updateOne({ invoiceId }, { $set: set }, { upsert: true });
  return { filename: name, size: data.length };
}

/**
 * The same, for callers that must carry on whatever happens (the upload route,
 * mailbox ingestion): a failure is logged and the invoice is processed as before.
 */
export async function keepInvoiceDocument(invoiceId, file, { log = console } = {}) {
  try {
    return await saveInvoiceDocument(invoiceId, file);
  } catch (err) {
    log.error?.(`The original PDF of invoice ${invoiceId} could not be stored: ${err?.message}`);
    return null;
  }
}

/**
 * The PDF to send back, or an HttpError with a message for the person:
 * 404 no such invoice, or no PDF for it (with the reason and a `code`);
 * 415 the stored file is not a valid PDF; 413 too large for this host.
 */
export async function openInvoiceDocument(invoiceId, { onVercel = Boolean(process.env.VERCEL) } = {}) {
  const invoice = await Invoice.findById(invoiceId).select('source').lean();
  if (!invoice) throw new HttpError(404, 'That invoice no longer exists.');
  const doc = await InvoiceDocument.findOne({ invoiceId }).lean();
  if (!doc) {
    const status = documentStatus(invoice, null);
    throw new HttpError(404, status.reason, { code: status.code });
  }
  const buffer = toBuffer(doc.data);
  if (!looksLikePdf(buffer))
    throw new HttpError(415, 'The stored file is not a valid PDF, so it cannot be shown. Its text is shown under "Original invoice text".', { code: 'invalid_pdf' });
  if (onVercel && buffer.length > MAX_RESPONSE_BYTES_ON_VERCEL) {
    throw new HttpError(413, 'This PDF is larger than this server can send (4.5 MB on Vercel), so it cannot be shown here. Its text is shown under "Original invoice text".', {
      code: 'too_large',
    });
  }
  return { buffer, filename: doc.filename || 'invoice.pdf' };
}

/** Content-Disposition for showing a file inline, with a safe file name. */
export function inlineDisposition(filename) {
  const name = /\.pdf$/i.test(filename) ? filename : `${filename}.pdf`;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Shown inline, only to this site, never sniffed as anything but a PDF, never cached by a shared cache.
export const DOCUMENT_HEADERS = Object.freeze({
  'Content-Type': PDF_TYPE,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "frame-ancestors 'self'",
  'Cross-Origin-Resource-Policy': 'same-origin',
});
