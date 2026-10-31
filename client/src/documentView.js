// Viewing an invoice's original PDF, as plain functions (no React), so they
// can be tested with node --test. The server decides what can be viewed and
// says why not (GET /api/invoices/:id: `document`); this only checks what
// actually arrived before it is shown.

export const PDF_TYPE = 'application/pdf';

/** Why a downloaded file cannot be shown as a PDF, or null. `blob`: { type, size }. */
export function pdfBlobProblem(blob) {
  if (!blob || !(blob.size > 0)) return 'The PDF is empty, so there is nothing to show.';
  if (
    String(blob.type || '')
      .split(';')[0]
      .trim()
      .toLowerCase() !== PDF_TYPE
  )
    return 'The server did not send a PDF, so it is not shown.';
  return null;
}

/** 1536 -> "1.5 KB". */
export function fileSize(bytes) {
  if (!(bytes >= 0)) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** Whether to show the original-file panel at all: not for pasted text or samples, which never had a file. */
export const showsDocumentPanel = (document) => Boolean(document) && document.code !== 'no_file';
