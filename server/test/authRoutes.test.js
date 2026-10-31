// Sign-in, sessions, roles and CSRF on the real Express app and a real
// MongoDB (in-memory server; see test-support/mongo.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDatabase, serve, client, testEnv, buildIndexes } from '../test-support/mongo.js';

const db = await startTestDatabase();
testEnv(db.uri, { ADMIN_SETUP_TOKEN: 'setup-token-for-tests-only', LOGIN_MAX_FAILURES: '3' });

const { app, ensureDatabase } = await import('../src/app.js');
const { createUser } = await import('../src/services/users.js');
const { TEST_SETUP } = await import('../test-support/actors.js');
const { Session, AuditEvent, User } = await import('../src/models/index.js');
await ensureDatabase();
await buildIndexes();
const server = await serve(app);
test.after(async () => {
  await server.close();
  await db.stop();
});

const PASSWORD = 'a long test password';
async function signedIn(email) {
  const c = client(server.base);
  const res = await c.post('/api/auth/login', { email, password: PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return c;
}

test('first administrator: setup needs the token, works once, and signs the admin in', async () => {
  const anon = client(server.base);
  const me = await anon.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user, null);
  assert.equal(me.data.setupRequired, true);

  const wrong = await anon.post('/api/auth/setup', { token: 'nope', email: 'admin@test.example', name: 'Ada Admin', password: PASSWORD });
  assert.equal(wrong.status, 401);

  const ok = await anon.post('/api/auth/setup', { token: 'setup-token-for-tests-only', email: 'admin@test.example', name: 'Ada Admin', password: PASSWORD });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.user.roles, ['admin']);
  const cookie = ok.setCookies.find((c) => c.startsWith('foa_session='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/, 'plain http in the test: no Secure flag');
  assert.equal((await anon.get('/api/auth/me')).data.user.email, 'admin@test.example');

  const again = await client(server.base).post('/api/auth/setup', { token: 'setup-token-for-tests-only', email: 'b@test.example', name: 'B', password: PASSWORD });
  assert.equal(again.status, 409);
  assert.equal(await User.countDocuments({ roles: 'admin' }), 1);
});

test('signing in again replaces the session: the old cookie stops working', async () => {
  const c = await signedIn('admin@test.example');
  const old = c.cookie;
  assert.equal((await c.post('/api/auth/login', { email: 'admin@test.example', password: PASSWORD })).status, 200);
  assert.notEqual(c.cookie, old);
  const stale = client(server.base);
  stale.cookie = old;
  assert.equal((await stale.get('/api/invoices')).status, 401);
  assert.equal((await c.get('/api/invoices')).status, 200);
});

test('only the token hash is stored; the password hash is never returned', async () => {
  const c = await signedIn('admin@test.example');
  const token = c.cookie.split('=')[1];
  assert.equal(await Session.countDocuments({ tokenHash: token }), 0);
  assert.ok((await Session.countDocuments()) >= 1);
  const users = await c.get('/api/admin/users');
  assert.equal(users.status, 200);
  assert.ok(!JSON.stringify(users.data).includes('scrypt$'), 'no password hash in any response');
});

test('signing in: a wrong password and an unknown email get the same answer; repeated failures lock the account', async () => {
  await createUser({ email: 'lock@test.example', name: 'Lou Lock', password: PASSWORD, roles: ['reviewer'] }, TEST_SETUP);
  const c = client(server.base);
  const bad = await c.post('/api/auth/login', { email: 'lock@test.example', password: 'wrong password!!' });
  const unknown = await c.post('/api/auth/login', { email: 'nobody@test.example', password: 'wrong password!!' });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(bad.data.error, unknown.data.error);
  await c.post('/api/auth/login', { email: 'lock@test.example', password: 'wrong password!!' });
  await c.post('/api/auth/login', { email: 'lock@test.example', password: 'wrong password!!' });
  const locked = await c.post('/api/auth/login', { email: 'lock@test.example', password: PASSWORD });
  assert.equal(locked.status, 429, 'locked even with the right password');
  assert.ok(await AuditEvent.exists({ subjectKind: 'user', action: 'locked' }));
});

test('every data route needs a session; health and sign-in stay open', async () => {
  const anon = client(server.base);
  assert.equal((await anon.get('/api/health')).status, 200);
  for (const url of ['/api/invoices', '/api/payables', '/api/audit', '/api/queries', '/api/statements', '/api/reports', '/api/reference', '/api/samples', '/api/admin/users']) {
    assert.equal((await anon.get(url)).status, 401, url);
  }
  for (const url of ['/api/invoices', '/api/demo/load', '/api/reset', '/api/statements', '/api/queries', '/api/reports']) {
    assert.equal((await anon.post(url, {})).status, 401, url);
  }
  assert.equal((await anon.post('/api/invoices/0123456789abcdef01234567/actions/approve', { decidedBy: 'Anyone' })).status, 401);
});

test('CSRF: without the dashboard header, or from another site, a request is refused', async () => {
  const c = client(server.base);
  const noHeader = await c.post('/api/auth/login', { email: 'admin@test.example', password: PASSWORD }, { csrf: false });
  assert.equal(noHeader.status, 403);
  const crossOrigin = await c.post('/api/auth/login', { email: 'admin@test.example', password: PASSWORD }, { headers: { Origin: 'https://evil.example' } });
  assert.equal(crossOrigin.status, 403);
  const crossSite = await c.post('/api/auth/login', { email: 'admin@test.example', password: PASSWORD }, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);

  // Signed in, a forged request without the header still cannot act.
  const admin = await signedIn('admin@test.example');
  const forged = await admin.post('/api/admin/users', { email: 'x@test.example', name: 'X', password: PASSWORD, roles: ['admin'] }, { csrf: false });
  assert.equal(forged.status, 403);
  assert.equal(await User.countDocuments({ email: 'x@test.example' }), 0);
});

test('roles are enforced on the server, and the session decides who acted', async () => {
  const admin = await signedIn('admin@test.example');
  for (const [email, name, roles] of [
    ['rev@test.example', 'Rita Reviewer', ['reviewer']],
    ['app@test.example', 'Priya Approver', ['approver']],
    ['pay@test.example', 'Sam Payer', ['payer']],
  ]) {
    const r = await admin.post('/api/admin/users', { email, name, password: PASSWORD, roles });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const reviewer = await signedIn('rev@test.example');
  const approver = await signedIn('app@test.example');
  const payer = await signedIn('pay@test.example');

  // Admin-only routes.
  assert.equal((await payer.get('/api/admin/users')).status, 403);
  assert.equal((await reviewer.post('/api/demo/load')).status, 403);
  assert.equal((await approver.post('/api/reset')).status, 403);
  // Adding invoices needs the reviewer role.
  assert.equal((await payer.post('/api/invoices', { sampleId: 'clean' })).status, 403);
  const created = await reviewer.post('/api/invoices', { sampleId: 'clean' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.invoice._id;
  // Read by the basic reader (90% confident), under the 99% minimum: a person reviews it.
  assert.equal(created.data.invoice.status, 'needs_review');

  // A reviewer cannot approve, whatever name they type.
  const denied = await reviewer.post(`/api/invoices/${id}/actions/approve`, { decidedBy: 'Priya Approver', note: 'Checked.' });
  assert.equal(denied.status, 403);
  // The approver can (with a note, for the open exception); the typed name is ignored.
  const ok = await approver.post(`/api/invoices/${id}/actions/approve`, { decidedBy: 'Mallory', note: 'Checked every field against the PDF.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.invoice.approval.decidedBy, 'Priya Approver');
  assert.ok(ok.data.invoice.approval.decidedById);
  const log = await AuditEvent.findOne({ subjectId: id, action: 'approve' }).lean();
  assert.equal(log.actor, 'Priya Approver');
  assert.equal(log.actorId, ok.data.invoice.approval.decidedById);

  // Statements (which mark payments paid) need the payer role.
  assert.equal((await reviewer.post('/api/statements', { sampleId: 'october' })).status, 403);
});

test('signing out, deactivation and password resets end sessions', async () => {
  const admin = await signedIn('admin@test.example');
  const user = (await admin.post('/api/admin/users', { email: 'temp@test.example', name: 'Tess Temp', password: PASSWORD, roles: ['reviewer'] })).data;
  const temp = await signedIn('temp@test.example');
  const stolen = temp.cookie;
  assert.equal((await temp.get('/api/invoices')).status, 200);
  assert.equal((await temp.post('/api/auth/logout')).status, 200);
  const replay = client(server.base);
  replay.cookie = stolen;
  assert.equal((await replay.get('/api/invoices')).status, 401, 'a signed-out cookie is useless');

  const again = await signedIn('temp@test.example');
  assert.equal((await admin.patch(`/api/admin/users/${user.id}`, { active: false })).status, 200);
  assert.equal((await again.get('/api/invoices')).status, 401, 'deactivated: signed out at once');
  assert.equal((await client(server.base).post('/api/auth/login', { email: 'temp@test.example', password: PASSWORD })).status, 401);

  // An admin cannot remove their own admin role or deactivate themselves.
  const me = (await admin.get('/api/auth/me')).data.user;
  assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { roles: ['reviewer'] })).status, 409);
  assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { active: false })).status, 409);
});

test('role changes take effect immediately; unknown roles are refused', async () => {
  const admin = await signedIn('admin@test.example');
  const u = (await admin.post('/api/admin/users', { email: 'grow@test.example', name: 'Gus Grow', password: PASSWORD, roles: [] })).data;
  const gus = await signedIn('grow@test.example');
  assert.equal((await gus.post('/api/invoices', { sampleId: 'clean' })).status, 403);
  assert.equal((await admin.patch(`/api/admin/users/${u.id}`, { roles: ['reviewer'] })).status, 200);
  assert.equal((await gus.post('/api/invoices', { sampleId: 'no-po' })).status, 201);
  assert.equal((await admin.patch(`/api/admin/users/${u.id}`, { roles: ['superuser'] })).status, 400);
  assert.equal((await admin.post('/api/admin/users', { email: 'weak@test.example', name: 'W', password: 'short', roles: [] })).status, 400);
});

test('the cron endpoint takes CRON_SECRET, not a session', async () => {
  const admin = await signedIn('admin@test.example');
  assert.equal((await admin.get('/api/cron/daily-summary?preview=1')).status, 401, 'a session is not enough');
  const res = await client(server.base).get('/api/cron/daily-summary?preview=1', { headers: { Authorization: 'Bearer test-cron-secret-0123456789-abcdefgh' } });
  assert.equal(res.status, 200);
});
