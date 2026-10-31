// Viewing an invoice's original PDF: what the viewer accepts before showing a file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfBlobProblem, fileSize, showsDocumentPanel } from '../src/documentView.js';

test('only a non-empty PDF is shown', () => {
  assert.equal(pdfBlobProblem({ type: 'application/pdf', size: 1000 }), null);
  assert.equal(pdfBlobProblem({ type: 'application/pdf; charset=binary', size: 1000 }), null);
  assert.match(pdfBlobProblem({ type: 'application/json', size: 50 }), /did not send a PDF/);
  assert.match(pdfBlobProblem({ type: 'text/html', size: 50 }), /did not send a PDF/);
  assert.match(pdfBlobProblem({ type: 'application/pdf', size: 0 }), /empty/);
  assert.match(pdfBlobProblem(null), /empty/);
});

test('file sizes are written for people', () => {
  assert.equal(fileSize(512), '512 bytes');
  assert.equal(fileSize(1536), '1.5 KB');
  assert.equal(fileSize(2048), '2 KB');
  assert.equal(fileSize(4 * 1024 * 1024), '4 MB');
  assert.equal(fileSize(undefined), '');
});

test('the panel is shown for files (kept or not), never for pasted text or samples', () => {
  assert.equal(showsDocumentPanel({ available: true, filename: 'a.pdf' }), true);
  assert.equal(showsDocumentPanel({ available: false, code: 'not_stored', reason: '...' }), true);
  assert.equal(showsDocumentPanel({ available: false, code: 'not_pdf', reason: '...' }), true);
  assert.equal(showsDocumentPanel({ available: false, code: 'no_file', reason: '...' }), false);
  assert.equal(showsDocumentPanel(undefined), false);
});
