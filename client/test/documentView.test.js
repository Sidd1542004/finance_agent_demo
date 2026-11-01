// The invoice screen's Documents row: buttons and their reasons, what the
// viewer accepts before showing a document, and when it opens in a new tab.

import test from 'node:test';
import assert from 'node:assert/strict';
import { documentBlobProblem, documentButtons, opensInNewTab, fileSize } from '../src/documentView.js';

test('only a non-empty PDF, PNG, JPEG or plain-text document is shown; never HTML or SVG', () => {
  for (const type of ['application/pdf', 'image/png', 'image/jpeg', 'text/plain; charset=utf-8']) assert.equal(documentBlobProblem({ type, size: 10 }), null, type);
  for (const type of ['text/html', 'image/svg+xml', 'application/json', '']) assert.match(documentBlobProblem({ type, size: 10 }), /not shown/, type);
  assert.match(documentBlobProblem({ type: 'application/pdf', size: 0 }), /empty/);
  assert.match(documentBlobProblem(null), /empty/);
});

test('three buttons: disabled ones say why; an invoice shown as text says so', () => {
  const buttons = documentButtons([
    { kind: 'invoice', label: 'Invoice', available: true, source: 'text', reason: 'This invoice was added as text, so its text is shown.' },
    { kind: 'purchase_order', label: 'Purchase order', available: false, reason: 'No purchase order linked.' },
    { kind: 'delivery_slip', label: 'Delivery slip', available: false, reason: 'No purchase order linked.' },
  ]);
  assert.deepEqual(
    buttons.map((b) => [b.kind, b.enabled, b.reason]),
    [
      ['invoice', true, null],
      ['purchase_order', false, 'No purchase order linked.'],
      ['delivery_slip', false, 'No purchase order linked.'],
    ],
  );
  assert.equal(buttons[0].note, 'This invoice was added as text, so its text is shown.');
  assert.equal(documentButtons([{ kind: 'invoice', label: 'Invoice', available: true, source: 'original' }])[0].note, null);
  assert.deepEqual(documentButtons(), []);
});

test('on a phone a document opens in a new tab; on a wider screen in the panel', () => {
  assert.equal(opensInNewTab(390), true);
  assert.equal(opensInNewTab(699), true);
  assert.equal(opensInNewTab(700), false);
  assert.equal(opensInNewTab(1280), false);
  assert.equal(opensInNewTab(undefined), false);
});

test('file sizes are written for people', () => {
  assert.equal(fileSize(512), '512 bytes');
  assert.equal(fileSize(1536), '1.5 KB');
  assert.equal(fileSize(4 * 1024 * 1024), '4 MB');
  assert.equal(fileSize(undefined), '');
});
