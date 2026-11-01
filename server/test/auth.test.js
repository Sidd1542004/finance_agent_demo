// Authentication building blocks, without a database: password hashing,
// cookies, the CSRF check, and role checks on invoice actions using the
// signed-in user instead of a typed name.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword, passwordProblem } from '../src/auth/passwords.js';
import { parseCookies, serializeCookie, hashToken } from '../src/auth/sessions.js';
import { csrfProblem, hasRole, actorOf } from '../src/auth/middleware.js';
import { trustActor, systemActor, isTrustedActor, actorProblem } from '../src/auth/roles.js';
import { runAgent } from '../src/agent/core/loop.js';
import { createInvoiceAgent } from '../src/agent/finance/invoiceAgent.js';
import { extractWithRules } from '../src/agent/finance/extract.js';
import { ActionError, allowedActions } from '../src/agent/finance/lifecycle.js';
import { createInvoiceActions } from '../src/services/invoiceActions.js';
import { createMemoryLedger } from '../src/integrations/memoryLedger.js';
import { vendors, purchaseOrders, goodsReceipts, sampleInvoices, renderInvoiceText } from '../src/seed/data.js';

test('passwords are salted scrypt hashes and verify only with the right password', async () => {
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.match(a, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(a, b, 'a fresh salt every time');
  assert.ok(!a.includes('correct horse'), 'the password itself is never stored');
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('correct horse batterY', a), false);
  assert.equal(await verifyPassword('', a), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false, 'a malformed hash never matches');
  assert.equal(await verifyPassword('anything', ''), false);
});

test('password rules: at least 12 characters', () => {
  assert.match(passwordProblem('short'), /too short/);
  assert.equal(passwordProblem('twelve chars'), null);
  assert.match(passwordProblem('x'.repeat(201)), /too long/);
});

test('session cookies are http-only and SameSite=Lax; Secure when asked', () => {
  const c = serializeCookie('foa_session', 'abc', { maxAgeSeconds: 3600, secure: true });
  assert.match(c, /^foa_session=abc; /);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.match(c, /Max-Age=3600/);
  assert.doesNotMatch(serializeCookie('foa_session', 'abc', { secure: false }), /Secure/);
  assert.match(serializeCookie('foa_session', '', { maxAgeSeconds: 0 }), /Max-Age=0; Expires=Thu, 01 Jan 1970/);
  assert.deepEqual(parseCookies('a=1; foa_session=tok%2Fen; bad; a=2'), { a: '1', foa_session: 'tok/en' });
  assert.equal(hashToken('x').length, 64);
  assert.notEqual(hashToken('x'), 'x');
});

test('CSRF: state-changing requests need the dashboard header and the same origin', () => {
  const ok = { method: 'POST', host: 'app.example', protocol: 'https', headers: { 'x-foa-request': '1', origin: 'https://app.example', 'sec-fetch-site': 'same-origin' } };
  assert.equal(csrfProblem(ok), null);
  assert.equal(csrfProblem({ ...ok, method: 'GET', headers: {} }), null, 'reads are not checked');
  assert.equal(csrfProblem({ ...ok, headers: { origin: 'https://app.example' } }), 'missing header');
  assert.equal(csrfProblem({ ...ok, headers: { ...ok.headers, origin: 'https://evil.example', 'sec-fetch-site': undefined } }), 'cross-origin');
  assert.equal(csrfProblem({ ...ok, headers: { ...ok.headers, 'sec-fetch-site': 'cross-site' } }), 'cross-site');
  assert.equal(csrfProblem({ ...ok, headers: { ...ok.headers, origin: 'http://app.example' } }), 'cross-origin', 'the scheme must match too');
  assert.equal(csrfProblem({ ...ok, headers: { ...ok.headers, origin: 'null' } }), 'opaque origin');
  assert.equal(csrfProblem({ ...ok, headers: { ...ok.headers, origin: 'https://dash.example', 'sec-fetch-site': 'same-site' }, allowedOrigins: ['https://dash.example'] }), null);
  assert.equal(csrfProblem({ ...ok, headers: { 'x-foa-request': '1' } }), null, 'non-browser clients without Origin still need the header');
});

test('hasRole', () => {
  assert.equal(hasRole({ roles: ['payer'] }, 'payer'), true);
  assert.equal(hasRole({ roles: ['payer'] }, 'approver', 'admin'), false);
  assert.equal(hasRole(null, 'payer'), false);
});

// ----- invoice actions with a signed-in user -----

const policy = { matchThreshold: 85, missingAbn: 'review', segregateDuties: true, priceTolerancePct: 2, minConfidence: 0.8, gstRatePct: 10, roundingTolerance: 0.05 };

async function setup() {
  const invoices = [];
  const ledger = createMemoryLedger({ vendors, purchaseOrders, goodsReceipts, invoices });
  const agent = createInvoiceAgent({ ledger, extract: async (t) => extractWithRules(t), policy, save: async () => {}, today: () => '2026-10-12' });
  const actions = createInvoiceActions({ store: ledger, policy, rerun: async () => {} });
  const invoice = {
    id: 'inv-1',
    createdAt: new Date(2026, 9, 1),
    source: { kind: 'sample' },
    rawText: renderInvoiceText(sampleInvoices.find((s) => s.id === 'clean')),
    status: 'received',
  };
  invoices.push(invoice);
  await runAgent(agent, { invoice });
  return { ledger, invoice, actions };
}

// As the server builds them from a signed-in session (auth/middleware.js).
const signedIn = (u) => trustActor({ ...u, sessionId: `s-${u.id}` });
const reviewer = signedIn({ id: 'u-rev', name: 'Rita Reviewer', roles: ['reviewer'] });
const approver = signedIn({ id: 'u-app', name: 'Priya N', roles: ['approver'] });
const approverAndPayer = signedIn({ id: 'u-both', name: 'Alex Both', roles: ['approver', 'payer'] });

test('a signed-in user acts under their own name and roles; a typed name changes nothing', async () => {
  const { invoice, actions, ledger } = await setup();
  assert.equal(invoice.status, 'under_review');

  // Typing an approver's name does not make a reviewer an approver.
  await assert.rejects(actions.perform(invoice.id, 'approve', { decidedBy: 'Priya N' }, reviewer), (err) => err instanceof ActionError && err.status === 403);
  assert.equal(invoice.status, 'under_review');

  await actions.perform(invoice.id, 'approve', { decidedBy: 'Someone Else' }, approver);
  assert.equal(invoice.approval.decidedBy, 'Priya N', 'the session user, not the typed name');
  assert.equal(invoice.approval.decidedById, 'u-app');
  const audit = ledger.auditEvents.find((e) => e.action === 'approve');
  assert.equal(audit.actor, 'Priya N');
  assert.equal(audit.actorId, 'u-app');
});

test('segregation of duties compares accounts, not names', async () => {
  const { invoice, actions } = await setup();
  await actions.perform(invoice.id, 'approve', {}, approverAndPayer);
  await assert.rejects(
    actions.perform(invoice.id, 'schedule_payment', { method: 'Cheque' }, approverAndPayer),
    (err) => err.status === 403 && /cannot also schedule/.test(err.message),
  );
  // Same display name, different account: allowed.
  const namesake = signedIn({ id: 'u-other', name: 'Alex Both', roles: ['payer'] });
  await actions.perform(invoice.id, 'schedule_payment', { method: 'Cheque' }, namesake);
  assert.equal(invoice.status, 'payment_pending');
});

test('allowed actions say whether the signed-in user holds the role', async () => {
  const { invoice } = await setup();
  const list = allowedActions(invoice, { actor: reviewer });
  assert.equal(list.find((a) => a.id === 'approve').permitted, false);
  assert.equal(list.find((a) => a.id === 'hold').permitted, true);
});

test('only an actor the server built is an actor: no actor, a typed name or a look-alike object is refused', async () => {
  const { invoice, actions, ledger } = await setup();
  const lookAlike = { id: 'u-app', name: 'Priya N', roles: ['approver', 'admin'], sessionId: 's-u-app' };
  for (const actor of [null, undefined, lookAlike, JSON.parse(JSON.stringify(approver)), { ...approver }]) {
    await assert.rejects(actions.perform(invoice.id, 'approve', { decidedBy: 'Priya N' }, actor), (err) => err instanceof ActionError && err.status === 401);
  }
  assert.equal(invoice.status, 'under_review', 'nothing changed');
  assert.equal(invoice.approval, undefined);
  assert.equal(ledger.auditEvents.filter((e) => e.action === 'approve').length, 0, 'nothing logged as a decision');
  // The dashboard is never told an action is permitted without an actor.
  assert.ok(allowedActions(invoice, {}).every((a) => a.permitted === false));
  assert.ok(allowedActions(invoice, { actor: lookAlike }).every((a) => a.permitted === false));
});

test('roles are denied by default: no roles, empty or unknown roles hold nothing', () => {
  for (const roles of [undefined, null, [], [''], ['superuser'], 'admin', [{}]]) {
    const actor = trustActor({ id: 'u-x', name: 'X', roles });
    assert.equal(hasRole(actor, 'reviewer', 'approver', 'payer', 'admin'), false, JSON.stringify(roles));
    assert.equal(actorProblem(actor, 'reviewer')?.status, 403, JSON.stringify(roles));
  }
  assert.equal(hasRole({ roles: ['admin'] }), false, 'asking for no role grants nothing');
  // An authenticated actor with no particular role needed: allowed; an actor without a name or id: not an actor.
  assert.equal(actorProblem(trustActor({ id: 'u-x', name: 'X', roles: [] })), null);
  assert.equal(actorProblem(trustActor({ id: '', name: 'X', roles: ['admin'] }))?.status, 401);
  assert.equal(actorProblem(trustActor({ id: 'u-x', name: '  ', roles: ['admin'] }))?.status, 401);
});

test('actorOf builds the actor from the session only; system actors are frozen and named', () => {
  assert.equal(actorOf({ user: null }), null);
  const user = trustActor({ id: 'u-1', name: 'Rita', roles: ['reviewer'], sessionId: 's-1', email: 'r@x' });
  const a = actorOf({ user, body: { decidedBy: 'Priya N', actorId: 'u-2' } });
  assert.deepEqual({ ...a }, { id: 'u-1', name: 'Rita', roles: ['reviewer'], sessionId: 's-1' });
  assert.equal(isTrustedActor(a), true);
  const sys = systemActor({ id: 'system:x', name: 'Some job', roles: ['approver'] });
  assert.equal(isTrustedActor(sys), true);
  assert.ok(Object.isFrozen(sys) && Object.isFrozen(sys.roles));
  assert.throws(() => sys.roles.push('admin'));
});
