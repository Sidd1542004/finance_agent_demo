// "Load demo month" stamps each step with a date inside the demo month
// (services/demo.js, clock.js), so every invoice's history reads in order:
// received after it was issued, decided after it was received, approved and
// scheduled before its payment date. The statuses and amounts are unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestDatabase, testEnv } from '../test-support/mongo.js';
import { stamp, createTimeline, withTimeline } from '../src/clock.js';

const db = await startTestDatabase();
testEnv(db.uri);
const { ensureDatabase } = await import('../src/app.js');
await ensureDatabase();
const { loadDemoMonth, DEMO_TIMELINE, receivedAfter } = await import('../src/services/demo.js');
const { Invoice, AgentRun, AuditEvent, Payment } = await import('../src/models/index.js');
const { sampleInvoices } = await import('../src/seed/data.js');

const loadStarted = Date.now();
const result = await loadDemoMonth();
const invoices = await Invoice.find().sort({ _id: 1 }).lean();
const payments = await Payment.find().lean();
test.after(() => db.stop());

const t = (v) => new Date(v).getTime();
const iso = (v) => new Date(v).toISOString();
const ascending = (label, stamps) => {
  for (let i = 1; i < stamps.length; i += 1) assert.ok(t(stamps[i - 1]) <= t(stamps[i]), `${label}: ${iso(stamps[i - 1])} is after ${iso(stamps[i])}`);
};
const sampleOf = (inv) => sampleInvoices.find((s) => s.id === inv.source?.sampleId);

test('the clock stamps the real time unless a timeline is running', async () => {
  const before = Date.now();
  assert.ok(t(stamp()) >= before);
  const timeline = createTimeline();
  await withTimeline(timeline, async () => {
    timeline.at('2026-09-15T00:30:00.000Z');
    await Promise.resolve();
    assert.equal(iso(stamp()), '2026-09-15T00:30:01.000Z');
    assert.equal(iso(stamp()), '2026-09-15T00:30:02.000Z', 'each stamp is later than the one before');
  });
  assert.ok(t(stamp()) >= before, 'outside the timeline: the real time again');
});

test('the statuses and amounts are what the demo month always produced', () => {
  assert.deepEqual(result.invoices, { payment_pending: 2, needs_review: 7, rejected: 1 });
  const bySample = invoices.map((i) => [i.source.sampleId, i.status, i.extracted?.total]);
  assert.deepEqual(bySample, [
    ['clean', 'payment_pending', 1402.5],
    ['quantity-variance', 'payment_pending', 811.8],
    ['price-variance', 'needs_review', 2890.36],
    ['gst-error', 'rejected', 840],
    ['over-limit', 'needs_review', 18029],
    ['unknown-supplier', 'needs_review', 814],
    ['no-po', 'needs_review', 924],
    // The delivery-slip samples: goods with no slip, and a service that needs none.
    ['no-delivery-slip', 'needs_review', 1815],
    ['service-no-slip', 'needs_review', 1232],
    ['clean', 'needs_review', 1402.5],
  ]);
  assert.deepEqual(payments.map((p) => [p.method, p.scheduledFor, p.amount, p.status]).sort(), [
    ['Cheque', '2026-10-02', 1402.5, 'queued'],
    ['Cheque', '2026-10-03', 727.1, 'queued'],
  ]);
});

test("each demo invoice's history is in order, received after it was issued, and before its payment date", async () => {
  let received = 0;
  for (const inv of invoices) {
    const label = `${sampleOf(inv).invoiceNumber} (${inv.source.sampleId})`;
    // Received after it was issued, and in the order the loader processed them.
    assert.ok(t(inv.createdAt) >= t(receivedAfter(sampleOf(inv).invoiceDate)), `${label} received before it was issued`);
    assert.ok(t(inv.createdAt) > received, `${label} received out of order`);
    received = t(inv.createdAt);

    const payment = payments.find((p) => String(p.invoiceId) === String(inv._id));
    const audit = await AuditEvent.find({ subjectId: { $in: [String(inv._id), ...(payment ? [String(payment._id)] : [])] } })
      .sort({ _id: 1 })
      .lean();
    const runs = await AgentRun.find({ invoiceId: inv._id }).sort({ _id: 1 }).lean();
    const steps = runs.flatMap((r) => r.steps.map((s) => s.at));
    const stamps = {
      audit: audit.map((e) => e.at),
      events: (inv.events || []).map((e) => e.at),
      steps,
      payment: payment?.history?.map((h) => h.at) || [],
    };
    // Each list in the order it was written (causes before what they caused), and none before the invoice arrived.
    for (const [kind, list] of Object.entries(stamps)) {
      assert.ok(list.length || kind === 'payment', `${label}: no ${kind}`);
      ascending(`${label} ${kind}`, list);
      for (const s of list) assert.ok(t(s) >= t(inv.createdAt), `${label} ${kind} ${iso(s)} is before it was received`);
    }
    // Every stamp is in the demo month, never at load time.
    for (const s of Object.values(stamps).flat()) assert.ok(t(s) < loadStarted && iso(s) < '2026-10-08', `${label}: ${iso(s)} is outside the demo month`);
    // Decisions come after the agent's steps.
    const agentDone = runs.flatMap((r) => r.steps.filter((x) => x.stage !== 'human').map((x) => x.at)).at(-1);
    if (inv.approval?.decidedAt) assert.ok(t(inv.approval.decidedAt) > t(agentDone), `${label}: approved before the agent finished`);
    // Approved and scheduled before the payment date.
    if (payment) {
      const due = t(`${payment.scheduledFor}T00:00:00.000Z`);
      assert.ok(t(inv.approval.decidedAt) < due, `${label}: approved ${iso(inv.approval.decidedAt)}, after the payment date ${payment.scheduledFor}`);
      for (const s of [...stamps.payment, ...stamps.audit, ...stamps.events, ...stamps.steps, payment.createdAt])
        assert.ok(t(s) < due, `${label}: ${iso(s)} is on or after the payment date ${payment.scheduledFor}`);
    }
  }
});

test('the people in the demo act on the dates of the timeline', () => {
  const clean = invoices[0];
  const pallets = invoices[1];
  const gst = invoices[3];
  assert.equal(iso(clean.approval.decidedAt).slice(0, 10), DEMO_TIMELINE.approveClean.slice(0, 10));
  assert.equal(iso(pallets.approval.decidedAt).slice(0, 10), DEMO_TIMELINE.approveQuantity.slice(0, 10));
  assert.equal(pallets.approval.decision, 'approve_received');
  const rejected = gst.events.find((e) => e.to === 'rejected');
  assert.equal(String(rejected.at).slice(0, 10), DEMO_TIMELINE.rejectGst.slice(0, 10));
  assert.equal(iso(invoices.at(-1).createdAt).slice(0, 10), DEMO_TIMELINE.duplicateReceived.slice(0, 10));
});
