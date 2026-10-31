// The demo Reset: who may run it, where, and what happens when it is refused,
// busy or fails. Nothing here wipes anything: the handler is mounted on a small
// Express app behind the real CSRF and role checks, with a stand-in reset. The
// MongoDB lock is checked on its own in-memory database.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';

// Never the real database: set before anything reads config (dotenv does not override).
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/never-used';

const { csrfGuard, requireRole, CSRF_REFUSED } = await import('../src/auth/middleware.js');
const { trustActor } = await import('../src/auth/roles.js');
const { createDemoResetHandler, demoResetBlocked, withDemoWipe, mongoLock, RESET_CONFIRMATION, LOCK_ID } = await import('../src/services/demoReset.js');
const { HttpError } = await import('../src/services/runs.js');
const { DEMO_DATA_MODELS, REFERENCE_MODELS } = await import('../src/seed/seed.js');
const { serve, client, startTestDatabase } = await import('../test-support/mongo.js');

const ADMIN = trustActor({ id: 'u-admin', name: 'Ada Admin', roles: ['admin'], sessionId: 's-admin' });
const PAYER = { id: 'u-pay', name: 'Sam Payer', roles: ['payer'] };
const ALLOWED = () => null;

/** A simple in-process lock with the same contract as mongoLock. */
function memoryLock() {
  let held = null;
  return {
    acquired: 0,
    async acquire() {
      if (held) return null;
      this.acquired += 1;
      held = `t${this.acquired}`;
      return held;
    },
    async release(token) {
      if (token === held) held = null;
    },
    get held() {
      return held;
    },
  };
}

/** An app with the real CSRF and admin checks in front of the handler. The test picks the user. */
async function resetApp({ blocked = ALLOWED, reset, audit, lock = memoryLock() } = {}) {
  const calls = { reset: 0, audit: [] };
  const log = { lines: [], error: (m) => log.lines.push(m) };
  const app = express();
  app.use(express.json());
  app.use('/api', csrfGuard());
  app.use('/api', (req, res, next) => {
    // Stands in for loadUser, which marks the session's user as an authenticated actor.
    req.user = req.headers['x-test-user'] ? trustActor(JSON.parse(req.headers['x-test-user'])) : null;
    next();
  });
  const handler = createDemoResetHandler({
    blocked,
    lock,
    log,
    reset: async () => {
      calls.reset += 1;
      return reset ? reset() : { Invoice: 3, Payment: 1 };
    },
    audit: async (e) => {
      calls.audit.push(e);
      if (audit) await audit(e);
    },
  });
  app.post('/api/reset', requireRole('admin'), (req, res, next) => Promise.resolve(handler(req, res)).catch(next));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => (err instanceof HttpError ? res.status(err.status).json({ error: err.message }) : res.status(500).json({ error: 'Something went wrong.' })));
  const server = await serve(app);
  const as = (user) => {
    const c = client(server.base);
    return (body, opts = {}) => c.post('/api/reset', body, { ...opts, headers: { ...(opts.headers || {}), ...(user ? { 'x-test-user': JSON.stringify(user) } : {}) } });
  };
  return { calls, lock, log, as, close: server.close };
}

// ---------- where it may run ----------

test('Reset is refused on Production whatever DEMO_MODE says, and outside demo mode', () => {
  assert.equal(demoResetBlocked({ demoMode: true, appEnv: 'development', vercelEnv: undefined }), null, 'local demo');
  assert.equal(demoResetBlocked({ demoMode: true, appEnv: 'development', vercelEnv: 'preview' }), null, 'Vercel Preview demo');
  assert.match(demoResetBlocked({ demoMode: true, appEnv: 'development', vercelEnv: 'production' }), /Production/);
  assert.match(demoResetBlocked({ demoMode: true, appEnv: 'development', vercelEnv: 'PRODUCTION' }), /Production/);
  assert.match(demoResetBlocked({ demoMode: true, appEnv: 'production', vercelEnv: 'preview' }), /APP_ENV=production/);
  assert.match(demoResetBlocked({ demoMode: false, appEnv: 'development', vercelEnv: 'preview' }), /demo mode/);
  assert.match(demoResetBlocked({ demoMode: false, appEnv: 'production', vercelEnv: 'production' }), /Production/);
});

test('an administrator on Production is refused, nothing is reset, and the attempt is audited', async () => {
  const blocked = () => demoResetBlocked({ demoMode: true, appEnv: 'development', vercelEnv: 'production' });
  const app = await resetApp({ blocked });
  try {
    const res = await app.as(ADMIN)({ confirm: RESET_CONFIRMATION });
    assert.equal(res.status, 403);
    assert.match(res.data.error, /never available on a Production deployment/);
    assert.equal(app.calls.reset, 0);
    assert.equal(app.lock.acquired, 0);
    assert.deepEqual(
      app.calls.audit.map((e) => [e.action, e.actor, e.actorId]),
      [['reset_refused', 'Ada Admin', 'u-admin']],
    );
  } finally {
    await app.close();
  }
});

// ---------- who may run it ----------

test('signed out, non-administrators and requests without the CSRF header never reach the reset', async () => {
  const app = await resetApp();
  try {
    assert.equal((await app.as(null)({ confirm: RESET_CONFIRMATION })).status, 401);
    for (const user of [PAYER, { id: 'u', name: 'R', roles: ['reviewer', 'approver', 'payer'] }, { id: 'u', name: 'N', roles: [] }, { id: 'u', name: 'S', roles: ['superuser'] }]) {
      const res = await app.as(user)({ confirm: RESET_CONFIRMATION });
      assert.equal(res.status, 403, JSON.stringify(user.roles));
      assert.equal(res.data.error, 'This needs the admin role.');
    }
    const noCsrf = await app.as(ADMIN)({ confirm: RESET_CONFIRMATION }, { csrf: false });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.data.error, CSRF_REFUSED);
    const crossSite = await app.as(ADMIN)({ confirm: RESET_CONFIRMATION }, { headers: { Origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
    assert.equal(app.calls.reset, 0);
    assert.equal(app.calls.audit.length, 0);
  } finally {
    await app.close();
  }
});

// ---------- confirmation and duplicates ----------

test('the typed confirmation is required', async () => {
  const app = await resetApp();
  try {
    for (const body of [{}, { confirm: '' }, { confirm: 'reset' }, { confirm: 'yes' }, { confirm: true }]) {
      const res = await app.as(ADMIN)(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.data.error, /Type RESET/);
    }
    assert.equal(app.calls.reset, 0);
    assert.equal(app.lock.acquired, 0);
  } finally {
    await app.close();
  }
});

test('two resets at once: one runs, the other is refused with 409', async () => {
  let finish;
  const gate = new Promise((r) => (finish = r));
  const app = await resetApp({
    reset: async () => {
      await gate;
      return { Invoice: 2 };
    },
  });
  try {
    const first = app.as(ADMIN)({ confirm: RESET_CONFIRMATION });
    // Wait until the first holds the lock, then try again.
    while (!app.lock.held) await new Promise((r) => setTimeout(r, 5));
    const second = await app.as(ADMIN)({ confirm: RESET_CONFIRMATION });
    assert.equal(second.status, 409);
    assert.match(second.data.error, /already running/);
    finish();
    assert.equal((await first).status, 200);
    assert.equal(app.calls.reset, 1, 'the reset ran once');
    assert.equal(app.lock.held, null, 'the lock is released');
  } finally {
    await app.close();
  }
});

// ---------- outcomes ----------

test('success: the server confirms what was removed, audits it under the administrator, and frees the lock', async () => {
  const app = await resetApp({ reset: () => ({ Invoice: 9, Payment: 2, Vendor: 5 }) });
  try {
    const res = await app.as(ADMIN)({ confirm: RESET_CONFIRMATION });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.ok, true);
    assert.equal(res.data.total, 16);
    assert.equal(res.data.audited, true);
    assert.ok(!Number.isNaN(Date.parse(res.data.at)));
    assert.equal(app.calls.audit.length, 1);
    const e = app.calls.audit[0];
    assert.deepEqual([e.subjectKind, e.action, e.actor, e.actorId], ['system', 'reset', 'Ada Admin', 'u-admin']);
    assert.match(e.detail, /succeeded/);
    assert.match(e.detail, /audit log are kept/);
    assert.equal(app.lock.held, null);
  } finally {
    await app.close();
  }
});

test('failure: reported as a failure, never as success; audited; secrets kept out of the log; lock freed', async () => {
  const app = await resetApp({
    reset: () => {
      throw new Error('connection to mongodb+srv://test-user:dummy-password@example.invalid/db lost');
    },
  });
  try {
    const res = await app.as(ADMIN)({ confirm: RESET_CONFIRMATION });
    assert.equal(res.status, 500);
    assert.equal(res.data.ok, undefined);
    assert.match(res.data.error, /reset failed/i);
    assert.match(res.data.error, /may already have been removed/);
    assert.deepEqual(
      app.calls.audit.map((e) => [e.action, e.actor]),
      [['reset_failed', 'Ada Admin']],
    );
    const logged = [...app.log.lines, ...app.calls.audit.map((e) => e.detail)].join('\n');
    assert.doesNotMatch(logged, /dummy-password/);
    assert.equal(app.lock.held, null);
  } finally {
    await app.close();
  }
});

test('a failing audit write after a successful reset is reported, not hidden', async () => {
  const app = await resetApp({
    audit: () => {
      throw new Error('audit store unavailable');
    },
  });
  try {
    const res = await app.as(ADMIN)({ confirm: RESET_CONFIRMATION });
    assert.equal(res.status, 200, 'the data was reset, so the answer says so');
    assert.equal(res.data.ok, true);
    assert.equal(res.data.audited, false);
    assert.match(res.data.warning, /audit entry could not be written/);
  } finally {
    await app.close();
  }
});

test('a reset failure is still reported when the audit write fails too', async () => {
  const app = await resetApp({
    reset: () => {
      throw new Error('boom');
    },
    audit: () => {
      throw new Error('audit store unavailable');
    },
  });
  try {
    const res = await app.as(ADMIN)({ confirm: RESET_CONFIRMATION });
    assert.equal(res.status, 500);
    assert.match(res.data.error, /reset failed/i);
  } finally {
    await app.close();
  }
});

// ---------- scope ----------

test('the reset scope is the documented demo data; users, sessions, settings, scenarios and the audit log are never in it', () => {
  const names = (models) => models.map((m) => m.modelName).sort();
  assert.deepEqual(names(DEMO_DATA_MODELS), [
    'AgentRun',
    'BankStatement',
    'IngestionItem',
    'Invoice',
    'InvoiceDocument',
    'OutboxMessage',
    'Payment',
    'PaymentJob',
    'Report',
    'SimBankAccount',
    'SimBankAttempt',
    'SimBankTransaction',
    'SupplierHint',
    'VendorQuery',
  ]);
  assert.deepEqual(names(REFERENCE_MODELS), ['BeneficiaryChange', 'GoodsReceipt', 'PurchaseOrder', 'Vendor']);
  const touched = new Set([...names(DEMO_DATA_MODELS), ...names(REFERENCE_MODELS)]);
  const KEPT = ['User', 'Session', 'AuditEvent', 'Setting', 'SimBankScenario', 'IngestionSource'];
  for (const kept of KEPT) assert.ok(!touched.has(kept), `${kept} is kept`);
  // Every collection the app defines is either in the scope or explicitly kept.
  for (const name of mongoose.modelNames()) assert.ok(touched.has(name) || KEPT.includes(name), `${name} is neither reset nor listed as kept`);
});

// ---------- Load demo month: the same boundary ----------

test('Load demo month follows the same rules: never on Production, one at a time', async () => {
  let ran = 0;
  const fn = async () => {
    ran += 1;
    return { ok: true };
  };
  const production = () => demoResetBlocked({ demoMode: true, appEnv: 'development', vercelEnv: 'production' });
  await assert.rejects(withDemoWipe(ADMIN, fn, { blocked: production, lock: memoryLock() }), (err) => err.status === 403 && /Load demo month is never available/.test(err.message));
  const busy = memoryLock();
  await busy.acquire();
  await assert.rejects(withDemoWipe(ADMIN, fn, { blocked: ALLOWED, lock: busy }), (err) => err.status === 409);
  assert.equal(ran, 0);
  const free = memoryLock();
  assert.deepEqual(await withDemoWipe(ADMIN, fn, { blocked: ALLOWED, lock: free }), { ok: true });
  assert.equal(ran, 1);
  assert.equal(free.held, null);
});

// ---------- the MongoDB lock (in-memory database; nothing is reset) ----------

test('the MongoDB lock lets one reset run at a time, frees on release, and expires after a crash', async () => {
  const db = await startTestDatabase();
  await mongoose.connect(db.uri);
  try {
    const { Setting } = await import('../src/models/index.js');
    await Setting.init();
    const t0 = new Date('2026-10-24T00:00:00Z');
    const first = await mongoLock.acquire(ADMIN, t0);
    assert.ok(first);
    assert.equal(await mongoLock.acquire(ADMIN, new Date(t0.getTime() + 1000)), null, 'held');
    // Concurrent attempts: exactly one wins.
    await mongoLock.release(first);
    const racers = await Promise.all(Array.from({ length: 5 }, () => mongoLock.acquire(ADMIN, new Date(t0.getTime() + 2000))));
    assert.equal(racers.filter(Boolean).length, 1);
    // A stale holder (crashed) frees itself after the lease.
    assert.ok(await mongoLock.acquire(PAYER, new Date(t0.getTime() + 10 * 60 * 1000)), 'expired lease taken over');
    // Releasing with someone else's token does nothing.
    await mongoLock.release('not-the-token');
    assert.ok(await Setting.findById(LOCK_ID).lean());
  } finally {
    await db.stop(); // drops the temporary test database and disconnects
  }
});
