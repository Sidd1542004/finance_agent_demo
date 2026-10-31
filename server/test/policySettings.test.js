// The agent's adjustable policy (the Admin screen's sliders): limits, who may
// change it, that saved values persist and are loaded again by a fresh
// instance, that the agent uses them, and that every change is audited.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../test-support/app.js';

const t = await startApp();
test.after(t.stop);

const { config } = await import('../src/config.js');
const { Setting, AuditEvent } = await import('../src/models/index.js');
const { POLICY_SLIDERS, POLICY_SETTING_ID, REFRESH_MS, validatePolicyInput, applyPolicy, loadPolicy, refreshPolicy, policyDefaults } =
  await import('../src/services/policySettings.js');

const admin = await t.signIn('admin');
const value = (view, key) => view.settings.find((s) => s.key === key).value;

test('the sliders: four numeric settings, each with limits and a step; the defaults are the environment values', async () => {
  assert.deepEqual(
    POLICY_SLIDERS.map((s) => s.key),
    ['matchThreshold', 'minConfidence', 'priceTolerancePct', 'emailMinConfidence'],
  );
  for (const s of POLICY_SLIDERS) assert.ok(s.min < s.max && s.step > 0, s.key);
  const res = await admin.get('/api/admin/policy');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.fromEntries(res.data.settings.map((s) => [s.key, [s.value, s.default, s.saved]])), {
    matchThreshold: [99, 99, false],
    minConfidence: [0.99, 0.99, false],
    priceTolerancePct: [2, 2, false],
    emailMinConfidence: [0.8, 0.8, false],
  });
});

test('validation: below the minimum, above the maximum, off-step, not a number or unknown are refused', () => {
  const problems = (input) => validatePolicyInput(input).problems;
  assert.equal(problems({ matchThreshold: 49 }).length, 1);
  assert.equal(problems({ matchThreshold: 101 }).length, 1);
  assert.equal(problems({ matchThreshold: 90.5 }).length, 1, 'whole percentages only');
  assert.equal(problems({ minConfidence: 0.49 }).length, 1);
  assert.equal(problems({ minConfidence: 1.01 }).length, 1);
  assert.equal(problems({ priceTolerancePct: -1 }).length, 1);
  assert.equal(problems({ priceTolerancePct: 10.5 }).length, 1);
  assert.equal(problems({ priceTolerancePct: 0.3 }).length, 1, 'steps of 0.5%');
  assert.equal(problems({ matchThreshold: '90' }).length, 1, 'a string is not a number');
  assert.equal(problems({ matchThreshold: Number.NaN }).length, 1);
  assert.equal(problems({ gstRatePct: 15 }).length, 1, 'GST is not adjustable');
  assert.equal(problems({ segregateDuties: false }).length, 1, 'only the slider settings');
  assert.equal(problems({}).length, 1);
  assert.equal(problems(null).length, 1);
  // The limits themselves are accepted, and float noise is rounded to the step.
  assert.deepEqual(validatePolicyInput({ matchThreshold: 50, minConfidence: 1, priceTolerancePct: 0, emailMinConfidence: 0.5 }).problems, []);
  assert.deepEqual(validatePolicyInput({ minConfidence: 0.1 + 0.8 }).values, { minConfidence: 0.9 });
});

test('only administrators read or change the policy; a change needs the dashboard header', async () => {
  for (const role of ['reviewer', 'approver', 'payer']) {
    const c = await t.signIn(role);
    assert.equal((await c.get('/api/admin/policy')).status, 403, role);
    assert.equal((await c.put('/api/admin/policy', { values: { matchThreshold: 90 } })).status, 403, role);
    assert.equal((await c.post('/api/admin/policy/reset')).status, 403, role);
  }
  assert.equal((await t.client().get('/api/admin/policy')).status, 401);
  assert.equal((await admin.put('/api/admin/policy', { values: { matchThreshold: 90 } }, { csrf: false })).status, 403);
  assert.equal(await Setting.exists({ _id: POLICY_SETTING_ID }), null, 'nothing was saved');
  assert.equal(config.policy.matchThreshold, 99);
});

test('an out-of-bounds value is refused as a whole: nothing is saved, not even the valid values', async () => {
  const res = await admin.put('/api/admin/policy', { values: { matchThreshold: 90, minConfidence: 1.5 } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /between 50% and 100%/);
  assert.equal(await Setting.exists({ _id: POLICY_SETTING_ID }), null);
  assert.equal(config.policy.matchThreshold, 99);
  assert.equal(config.policy.minConfidence, 0.99);
});

test('saved values persist, are used by the agent at once, show in /api/status and are audited', async () => {
  const reviewer = await t.signIn('reviewer');
  // With the defaults (99% reading confidence), the basic reader's 90% sends the clean sample to a person.
  const created = await reviewer.post('/api/invoices', { sampleId: 'clean' });
  assert.equal(created.status, 201);
  const id = created.data.invoice._id;
  assert.equal(created.data.invoice.status, 'needs_review');
  assert.equal(created.data.invoice.checks.find((c) => c.id === 'reader_confidence').status, 'fail');

  const saved = await admin.put('/api/admin/policy', { values: { minConfidence: 0.85, matchThreshold: 95 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(value(saved.data, 'minConfidence'), 0.85);
  assert.equal(value(saved.data, 'matchThreshold'), 95);
  assert.equal(value(saved.data, 'priceTolerancePct'), 2, 'values not sent are unchanged');
  assert.equal(saved.data.updatedBy, 'Ada Admin');

  const doc = await Setting.findById(POLICY_SETTING_ID).lean();
  assert.deepEqual(doc.value.values, { minConfidence: 0.85, matchThreshold: 95 });
  const health = await reviewer.get('/api/status');
  assert.equal(health.data.policy.minConfidence, 0.85);
  assert.equal(health.data.policy.matchThreshold, 95);

  // Processing again uses the new values: the same invoice is now only eligible for approval review.
  const rerun = await reviewer.post(`/api/invoices/${id}/rerun`, {});
  assert.equal(rerun.status, 200, JSON.stringify(rerun.data));
  assert.equal(rerun.data.invoice.status, 'under_review');
  assert.equal(rerun.data.invoice.approval, null, 'never approved by the policy');
  assert.equal(rerun.data.invoice.match.score.threshold, 95);

  const entry = await AuditEvent.findOne({ subjectKind: 'system', subjectId: POLICY_SETTING_ID, action: 'policy_changed' }).lean();
  assert.equal(entry.actor, 'Ada Admin');
  assert.ok(entry.actorId);
  assert.match(entry.detail, /Match score for approval review: 99% to 95%/);
  assert.match(entry.detail, /Minimum invoice reading confidence: 99% to 85%/);
});

test('a fresh instance loads the saved values; another instance sees a change after the refresh interval', async () => {
  // A new serverless instance starts with the environment's values only.
  applyPolicy({});
  assert.equal(config.policy.matchThreshold, 99);
  await loadPolicy();
  assert.equal(config.policy.matchThreshold, 95);
  assert.equal(config.policy.minConfidence, 0.85);

  // Changed by another instance: not re-read before REFRESH_MS, re-read after it.
  await Setting.updateOne({ _id: POLICY_SETTING_ID }, { $set: { 'value.values.matchThreshold': 90 } });
  await refreshPolicy({ now: Date.now() });
  assert.equal(config.policy.matchThreshold, 95);
  await refreshPolicy({ now: Date.now() + REFRESH_MS + 1 });
  assert.equal(config.policy.matchThreshold, 90);
});

test('a saved value outside the current limits is ignored on load: the default applies', async () => {
  await Setting.updateOne({ _id: POLICY_SETTING_ID }, { $set: { 'value.values.matchThreshold': 20, 'value.values.priceTolerancePct': 'lots' } });
  await loadPolicy();
  assert.equal(config.policy.matchThreshold, policyDefaults().matchThreshold);
  assert.equal(config.policy.priceTolerancePct, policyDefaults().priceTolerancePct);
  assert.equal(config.policy.minConfidence, 0.85, 'the valid saved value is kept');
});

test('reset to defaults removes every saved value, and is audited', async () => {
  const res = await admin.post('/api/admin/policy/reset');
  assert.equal(res.status, 200);
  assert.ok(res.data.settings.every((s) => !s.saved && s.value === s.default));
  assert.equal(config.policy.minConfidence, 0.99);
  await loadPolicy();
  assert.equal(config.policy.minConfidence, 0.99, 'still the default after a reload');
  assert.ok(await AuditEvent.exists({ subjectId: POLICY_SETTING_ID, action: 'policy_reset' }));
});
