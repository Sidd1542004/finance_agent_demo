// GET /api/health says only whether the server and its database are there.
// The dashboard's settings (GET /api/status) and the invoice summary for the
// header (GET /api/invoices/summary) need a signed-in user with a role.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PASSWORD } from '../test-support/app.js';

const t = await startApp();
test.after(t.stop);
const { createUser } = await import('../src/services/users.js');
const { TEST_SETUP } = await import('../test-support/actors.js');

test('/api/health is open and returns only ok and the database state', async () => {
  const res = await t.client().get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true, database: 'connected' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('/api/status and /api/invoices/summary need a signed-in user with a role', async () => {
  const anon = t.client();
  assert.equal((await anon.get('/api/status')).status, 401);
  assert.equal((await anon.get('/api/invoices/summary')).status, 401);
  await createUser({ email: 'norole2@test.example', name: 'No Role', password: PASSWORD, roles: [] }, TEST_SETUP);
  const none = t.client();
  assert.equal((await none.post('/api/auth/login', { email: 'norole2@test.example', password: PASSWORD })).status, 200);
  assert.equal((await none.get('/api/status')).status, 403);
  assert.equal((await none.get('/api/invoices/summary')).status, 403);
});

test('every role gets the dashboard settings and the summary', async () => {
  for (const role of ['reviewer', 'approver', 'payer', 'admin']) {
    const c = await t.signIn(role);
    const status = await c.get('/api/status');
    assert.equal(status.status, 200, role);
    assert.deepEqual(Object.keys(status.data).sort(), ['abr', 'auth', 'demoMode', 'demoReset', 'policy', 'reader', 'timeZone']);
    assert.equal(status.data.reader.mode, 'rules');
    assert.equal(status.data.policy.matchThreshold, 99);
    const summary = await c.get('/api/invoices/summary');
    assert.equal(summary.status, 200, role);
    assert.deepEqual(summary.data, { readerFallback: null }, 'no AI reader configured: nothing to fall back from');
  }
});
