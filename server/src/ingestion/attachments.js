// Which email attachments are invoices worth reading, and whether a downloaded
// file is what it claims to be. Everything here treats the email as untrusted:
// names, types and sizes from the provider are only hints until the bytes are checked.

import crypto from 'node:crypto';

const MIN_IMAGE_BYTES = 8 * 1024; // smaller images are logos, signatures and tracking pixels

/** The address in a From header: "Name <a@b.com>" -> "a@b.com". Lower case. */
export function addressOf(from) {
  const s = String(from || '');
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/) || s.match(/([^\s<>"']+@[^\s<>"']+)/);
  return m ? m[1].toLowerCase() : '';
}

/** Is this sender allowed? `allowed`: addresses or @domains; empty allows everyone. */
export function senderAllowed(address, allowed = []) {
  if (!allowed.length) return true;
  const a = String(address || '').toLowerCase();
  const domain = a.split('@')[1] || '';
  return allowed.some((rule) => (rule.startsWith('@') ? domain === rule.slice(1) || domain.endsWith(`.${rule.slice(1)}`) : a === rule));
}

/** A file name safe to store and show: no paths, control characters or odd lengths. */
export function safeFilename(name) {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return base || 'attachment';
}

/** pdf | jpeg | png from the declared type and name, or null when unsupported. */
export function declaredKind(att) {
  const type = String(att.mimeType || '').toLowerCase();
  const name = String(att.filename || '').toLowerCase();
  if (type === 'application/pdf' || /\.pdf$/.test(name)) return 'pdf';
  if (type === 'image/png' || /\.png$/.test(name)) return 'png';
  if (type === 'image/jpeg' || type === 'image/jpg' || type === 'image/pjpeg' || /\.jpe?g$/.test(name)) return 'jpeg';
  return null;
}

const MIME = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg' };

/**
 * Sort a message's attachments: `eligible` to read, `rejected` (recorded, with
 * the reason) and the number `ignored` (inline images, tiny logos).
 */
export function triage(attachments, { maxBytes }) {
  const eligible = [];
  const rejected = [];
  let ignored = 0;
  for (const att of attachments || []) {
    const kind = declaredKind(att);
    const filename = safeFilename(att.filename);
    const isImage = kind === 'png' || kind === 'jpeg' || String(att.mimeType || '').startsWith('image/');
    // Logos and signature images: inline, or too small to be an invoice.
    if (isImage && (att.inline || (att.size > 0 && att.size < MIN_IMAGE_BYTES))) {
      ignored += 1;
      continue;
    }
    if (att.inline && kind !== 'pdf') {
      ignored += 1;
      continue;
    }
    const base = { ...att, filename, kind };
    if (!kind) rejected.push({ ...base, reason: `Not a PDF, JPG or PNG file (${String(att.mimeType || 'unknown type').slice(0, 60)}).` });
    else if (att.size === 0) rejected.push({ ...base, reason: 'The file is empty.' });
    else if (att.size > maxBytes) rejected.push({ ...base, reason: `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.` });
    else eligible.push({ ...base, mimeType: MIME[kind] });
  }
  return { eligible, rejected, ignored };
}

const isPdf = (b) => b.subarray(0, 1024).includes(Buffer.from('%PDF-'));
const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a;
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * Check the downloaded bytes. Returns null when the file is fine, or the
 * reason it is refused (never processed).
 */
export function checkFile(buffer, kind, { maxBytes }) {
  if (!buffer || !buffer.length) return 'The file is empty.';
  if (buffer.length > maxBytes) return `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`;
  if (kind === 'pdf') {
    if (!isPdf(buffer)) return 'The file is not a valid PDF, whatever its name or type says.';
    // An encrypted (password-protected) PDF names its encryption dictionary in the trailer.
    if (buffer.includes(Buffer.from('/Encrypt'))) return 'The PDF is encrypted or password protected, so it cannot be read.';
    return null;
  }
  if (kind === 'png') return isPng(buffer) ? null : 'The file is not a valid PNG image, whatever its name or type says.';
  if (kind === 'jpeg') return isJpeg(buffer) ? null : 'The file is not a valid JPG image, whatever its name or type says.';
  return 'Not a PDF, JPG or PNG file.';
}

export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
