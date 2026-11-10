// The agent's policy settings (the Settings screen): one versioned document,
// administrators only, every value checked, compare-and-set on the version,
// a reason for every change, every change audited, and a new value applies to
// invoices processed after the save (each run keeps the values it used).

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../test-support/app.js';

const t = await startApp();
test.after(t.stop);

const { config } = await import('../src/config.js');
const { PolicySettings, AuditEvent, AgentRun } = await import('../src/models/index.js');
const { POLICY_FIELDS, validatePolicyInput, loadPolicy, refreshPolicy, REFRESH_MS } = await import('../src/services/policySettings.js');
const { renderInvoiceText, findSample } = await import('../src/seed/data.js');

const admin = await t.signIn('admin');
const reviewer = await t.signIn('reviewer');
const valueOf = (view, key) => view.fields.find((f) => f.key === key).value;
const put = (c, body) => c.put('/api/settings/policy', body);

// A clean invoice with GST-free lines: tax cannot be fully verified, so it scores 95%.
const at95 = (number, date) => {
  const s = structuredClone(findSample('clean'));
  s.gst = 0;
  s.invoiceNumber = number;
  s.invoiceDate = date;
  return renderInvoiceText(s);
};
const score = (inv) => inv.checks.find((c) => c.id === 'match_score');
const latestRun = (id) => AgentRun.findOne({ invoiceId: id }).sort({ createdAt: -1 }).lean();

test('three settings with their limits and the delivery-slip switch; the document is created from the environment values (99% default), version 1', async () => {
  assert.deepEqual(
    POLICY_FIELDS.map((f) => [f.key, f.min, f.max, f.step]),
    [
      ['matchThreshold', 85, 100, 1],
      ['priceTolerancePct', 0, 10, 0.5],
      ['confidenceFloor', 50, 100, 1],
      ['requireDeliverySlip', undefined, undefined, undefined],
    ],
  );
  const res = await reviewer.get('/api/settings/policy');
  assert.equal(res.status, 200, 'any signed-in role reads them');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.data.version, 1);
  assert.deepEqual(Object.fromEntries(res.data.fields.map((f) => [f.key, f.value])), { matchThreshold: 99, priceTolerancePct: 2, confidenceFloor: 99, requireDeliverySlip: true });
  const doc = await PolicySettings.findById('policy').lean();
  assert.deepEqual([doc.matchThreshold, doc.priceTolerancePct, doc.confidenceFloor, doc.version], [99, 2, 99, 1]);
  assert.equal(doc.updatedBy.id, 'system:defaults');
  assert.equal((await t.client().get('/api/settings/policy')).status, 401, 'signed out');
});

test('validation: out of range, off-step, unknown fields, no reason or no version are refused (400), nothing saved', () => {
  const problems = (body) => validatePolicyInput({ expectedVersion: 1, reason: 'Client request.', ...body }).problems;
  for (const bad of [
    { matchThreshold: 84 },
    { matchThreshold: 101 },
    { matchThreshold: 90.5 },
    { matchThreshold: '90' },
    { priceTolerancePct: -0.5 },
    { priceTolerancePct: 10.5 },
    { priceTolerancePct: 0.3 },
    { confidenceFloor: 49 },
    { confidenceFloor: 101 },
    { confidenceFloor: 99.5 },
    { minConfidence: 0.9 },
    { emailMinConfidence: 80 },
  ])
    assert.equal(problems(bad).length, 1, JSON.stringify(bad));
  assert.deepEqual(problems({ matchThreshold: 85, priceTolerancePct: 10, confidenceFloor: 50 }), []);
  assert.ok(validatePolicyInput({ matchThreshold: 90, expectedVersion: 1 }).problems.some((p) => /reason/.test(p)));
  assert.ok(validatePolicyInput({ matchThreshold: 90, reason: 'x y z' }).problems.some((p) => /expectedVersion/.test(p)));
  assert.ok(validatePolicyInput({ expectedVersion: 1, reason: 'Client request.' }).problems.some((p) => /at least one/.test(p)));
});

test('only administrators save; the API refuses the rest (403), signed out (401) and without the dashboard header (403)', async () => {
  for (const role of ['reviewer', 'approver', 'payer']) {
    const c = await t.signIn(role);
    assert.equal((await put(c, { matchThreshold: 95, expectedVersion: 1, reason: 'Trying.' })).status, 403, role);
  }
  assert.equal((await put(t.client(), { matchThreshold: 95, expectedVersion: 1, reason: 'Trying.' })).status, 401);
  assert.equal((await admin.put('/api/settings/policy', { matchThreshold: 95, expectedVersion: 1, reason: 'Trying.' }, { csrf: false })).status, 403);
  const bad = await put(admin, { matchThreshold: 80, expectedVersion: 1, reason: 'Trying.' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /between 85% and 100%/);
  assert.equal((await PolicySettings.findById('policy').lean()).version, 1, 'nothing was saved');
});

let existingId;

test('a new threshold applies to invoices processed after the save, not to existing ones; each run keeps its policy', async () => {
  const before = await reviewer.post('/api/invoices', { text: at95('HOS-20001', '2026-09-15') });
  assert.equal(before.status, 201, JSON.stringify(before.data));
  existingId = before.data.invoice._id;
  assert.equal(score(before.data.invoice).status, 'fail', '95% is below 99%');
  assert.deepEqual((await latestRun(existingId)).policy, { matchThreshold: 99, priceTolerancePct: 2, confidenceFloor: 99, requireDeliverySlip: true, version: 1 });

  const saved = await put(admin, { matchThreshold: 95, confidenceFloor: 90, expectedVersion: 1, reason: 'Client trial: 95% for October.' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.version, 2);
  assert.equal(valueOf(saved.data, 'matchThreshold'), 95);
  assert.equal(saved.data.updatedBy.name, 'Ada Admin');
  assert.equal(config.policy.matchThreshold, 95);
  assert.equal(config.policy.minConfidence, 0.9);

  // The existing invoice is not re-evaluated.
  const existing = (await reviewer.get(`/api/invoices/${existingId}`)).data;
  assert.equal(score(existing.invoice).status, 'fail');
  assert.equal(existing.invoice.match.score.threshold, 99);
  assert.equal(existing.run.policy.version, 1);

  // Processing it again uses the new values, and the new run says so.
  const again = await reviewer.post(`/api/invoices/${existingId}/rerun`, {});
  assert.equal(score(again.data.invoice).status, 'pass', '95% meets 95%');
  assert.equal(again.data.run.policy.version, 2);

  // A new invoice too. (The first is rejected so that it does not use up the same purchase order.)
  const approver = await t.signIn('approver');
  assert.equal((await approver.post(`/api/invoices/${existingId}/actions/reject`, { note: 'Sent again as HOS-20002.' })).status, 200);
  const after = await reviewer.post('/api/invoices', { text: at95('HOS-20002', '2026-09-16') });
  assert.equal(score(after.data.invoice).status, 'pass', '95% meets 95%');
  assert.equal(after.data.invoice.status, 'under_review', 'only eligible for approval');
  assert.equal(after.data.invoice.approval, null);
  assert.deepEqual(after.data.run.policy, { matchThreshold: 95, priceTolerancePct: 2, confidenceFloor: 90, requireDeliverySlip: true, version: 2 });

  // The dashboard's status shows the live values.
  const status = (await reviewer.get('/api/status')).data;
  assert.equal(status.policy.matchThreshold, 95);
  assert.equal(status.policy.version, 2);
});

test('a save from an older version is refused (409): someone else saved first', async () => {
  const stale = await put(admin, { priceTolerancePct: 3, expectedVersion: 1, reason: 'Late save.' });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /Someone else saved the settings first \(now version 2\)/);
  assert.equal(stale.data.version, 2);
  assert.equal((await PolicySettings.findById('policy').lean()).priceTolerancePct, 2, 'nothing was saved');
  // Two saves from the same version at once: one wins, one is refused.
  const [a, b] = await Promise.all([
    put(admin, { priceTolerancePct: 2.5, expectedVersion: 2, reason: 'Save A.' }),
    put(admin, { priceTolerancePct: 3.5, expectedVersion: 2, reason: 'Save B.' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const doc = await PolicySettings.findById('policy').lean();
  assert.equal(doc.version, 3);
  assert.equal((await put(admin, { priceTolerancePct: doc.priceTolerancePct, expectedVersion: 3, reason: 'Same.' })).status, 400, 'nothing changed');
});

test('every change is audited: who, each old and new value, the versions and the reason; shown as history', async () => {
  const entries = await AuditEvent.find({ subjectKind: 'settings', subjectId: 'policy' }).sort({ at: 1 }).lean();
  assert.equal(entries.length, 2, 'the two saves that succeeded');
  const [first] = entries;
  assert.equal(first.action, 'policy_changed');
  assert.equal(first.actor, 'Ada Admin');
  assert.ok(first.actorId);
  assert.deepEqual([first.from, first.to], ['v1', 'v2']);
  assert.equal(first.reason, 'Client trial: 95% for October.');
  assert.match(first.detail, /Match score for approval review: 99% -> 95%/);
  assert.match(first.detail, /Minimum invoice reading confidence: 99% -> 90%/);
  assert.doesNotMatch(first.detail, /Unit price/, 'unchanged values are not listed');
  const history = (await admin.get('/api/settings/policy')).data.history;
  assert.equal(history.length, 2);
  assert.equal(history[0].to, 'v3', 'newest first');
  assert.equal(history[1].reason, 'Client trial: 95% for October.');
});

test('another instance sees a save after the refresh interval; a fresh instance loads the saved values', async () => {
  await loadPolicy(); // this instance's copy is fresh
  await PolicySettings.updateOne({ _id: 'policy' }, { $set: { matchThreshold: 97 }, $inc: { version: 1 } });
  await refreshPolicy({ now: Date.now() });
  assert.notEqual(config.policy.matchThreshold, 97, 'not before the interval');
  await refreshPolicy({ now: Date.now() + REFRESH_MS + 1 });
  assert.equal(config.policy.matchThreshold, 97);
  config.policy.matchThreshold = 99; // as a new instance starts
  await loadPolicy();
  assert.equal(config.policy.matchThreshold, 97);
  // A stored value outside the limits (edited by hand) is not used: the default applies.
  await PolicySettings.updateOne({ _id: 'policy' }, { $set: { matchThreshold: 40 } });
  await loadPolicy();
  assert.equal(config.policy.matchThreshold, 99);
});
