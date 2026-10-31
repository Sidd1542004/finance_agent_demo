// The invoice screen's Documents row, as plain functions (no React), so they
// can be tested with node --test. The server says what exists and why not
// (GET /api/invoices/:id: `documents`); this only decides how to show it and
// checks what actually arrived before it is shown.

export const DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'];
// Narrower than this (a phone): documents open in a new tab instead of a panel.
export const NARROW_SCREEN_PX = 700;

/** Why a downloaded document cannot be shown, or null. `blob`: { type, size }. */
export function documentBlobProblem(blob) {
  if (!blob || !(blob.size > 0)) return 'The document is empty, so there is nothing to show.';
  const type = String(blob.type || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!DOCUMENT_TYPES.includes(type)) return 'The server did not send a document this page can show, so it is not shown.';
  return null;
}

/** One button per document: { kind, label, enabled, reason (when disabled), note (shown under the row) }. */
export function documentButtons(documents = []) {
  return documents.map((d) => ({
    kind: d.kind,
    label: d.label,
    enabled: Boolean(d.available),
    reason: d.available ? null : d.reason || 'Not available.',
    // Disabled: say why. Available as text instead of the original: say that too.
    note: !d.available ? d.reason || 'Not available.' : d.source === 'text' ? d.reason : null,
  }));
}

/** On a phone, a document opens in a new tab. */
export const opensInNewTab = (width) => typeof width === 'number' && width < NARROW_SCREEN_PX;

/** 1536 -> "1.5 KB". */
export function fileSize(bytes) {
  if (!(bytes >= 0)) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}
