// Executes scheduled bank payments. Called by GET/POST /api/cron/tick (an
// external scheduler or Vercel Cron, with CRON_SECRET) and by the admin's
// "Run due payments now". There is no always-running worker and no timer:
// each tick does a bounded amount of work and returns.

// One tick:
//   1. The simulated bank settles the transactions that are due.
//   2. Payments the bank is processing are checked: SUCCESS completes the
//      payment and the invoice (and drafts the supplier's confirmation);
//      FAILED fails them. Nothing is paid on anything but a confirmed SUCCESS.
//   3. Due jobs are claimed one at a time, atomically, with a lease. A job
//      whose lease has expired (its tick died) can be claimed again. At most
//      TICK_MAX_JOBS per tick, within TICK_BUDGET_SECONDS.

// Safe to run twice at once and safe to retry:
//   - claiming a job, a payment and an invoice is compare-and-set in MongoDB;
//   - a job only runs for the payment's current schedule version, so a
//     rescheduled or cancelled payment's old job does nothing;
//   - the bank instruction's idempotency key is fixed per payment and schedule
//     version, so resubmitting after a crash or a timeout cannot pay twice,
//     and after a timeout the bank is asked first ("unknown" is never success).

import { randomBytes } from 'node:crypto';
import { Payment, PaymentJob } from '../models/index.js';
import { remainingToPay, idempotencyKey } from '../agent/finance/paymentRules.js';
import { beneficiaryBlock } from '../agent/finance/beneficiary.js';
import { isoDateIn } from '../agent/finance/timeZone.js';
import { fmtMoney } from '../agent/finance/validation.js';

const SCHEDULER = 'Payment scheduler';
const BANK = 'Simulated bank';
const round2 = (n) => Math.round(n * 100) / 100;
const asId = (p) => String(p._id || p.id);

export function createPaymentExecutor({
  store,
  adapter,
  calendar,
  notices = null,
  now = () => new Date(),
  tickMaxJobs = 10,
  tickBudgetSeconds = 40,
  leaseSeconds = 120,
  maxAttempts = 5,
  retryDelaysSeconds = [60, 300, 900, 1800],
  log = console,
}) {
  const dueFilter = (at) => ({
    active: true,
    $or: [
      { status: 'pending', runAt: { $lte: at } },
      { status: 'running', leaseUntil: { $lt: at } },
    ],
  });

  async function claimJob(tickId) {
    const at = now();
    return PaymentJob.findOneAndUpdate(
      dueFilter(at),
      {
        $set: { status: 'running', leaseOwner: tickId, leaseUntil: new Date(at.getTime() + leaseSeconds * 1000) },
        $inc: { attempts: 1 },
        $push: { history: { at: at.toISOString(), event: 'claimed', by: tickId } },
      },
      { sort: { runAt: 1 }, new: true },
    ).lean();
  }

  /** End (or reschedule) a job this tick holds. Does nothing if the lease was lost or the job was cancelled meanwhile. */
  async function finishJob(job, tickId, status, result, { runAt = null, error = null, attemptsBack = false } = {}) {
    const active = status === 'pending';
    const r = await PaymentJob.updateOne(
      { _id: job._id, leaseOwner: tickId, status: 'running' },
      {
        $set: {
          status,
          active,
          result: String(result || '').slice(0, 500),
          leaseOwner: null,
          leaseUntil: null,
          ...(runAt ? { runAt } : {}),
          ...(error ? { lastError: String(error).slice(0, 500) } : {}),
        },
        ...(attemptsBack ? { $inc: { attempts: -1 } } : {}),
        $push: { history: { at: now().toISOString(), event: status, by: tickId, result: String(result || '').slice(0, 300) } },
      },
    );
    return r.modifiedCount === 1;
  }

  const invoiceEvent = (actor, action, from, to, reason, detail) => ({ actor, action, from, to, reason, detail });

  // Move the invoice; tries each `from` in turn (a tick that died between the
  // payment and the invoice update can leave the invoice one step behind).
  async function moveInvoice(invoiceId, froms, to, set, { actor, action, reason, detail }) {
    for (const from of froms) {
      const moved = await store.claimInvoice(String(invoiceId), from, { status: to, ...set }, invoiceEvent(actor, action, from, to, reason, detail));
      if (moved) return moved;
    }
    return null;
  }

  /** The bank confirmed SUCCESS: the payment is paid, the invoice completed, a confirmation drafted. */
  async function completePayment(p, bank) {
    const confirmedAt = bank.settledAt ? new Date(bank.settledAt) : now();
    const amount = p.submission?.amount ?? p.amount;
    const confirmation = { txnRef: bank.ref, confirmedAt: confirmedAt.toISOString(), amount, simulated: true };
    const cur = p.currency || 'AUD';
    const done = await store.updatePayment(
      asId(p),
      { status: ['processing'], scheduleVersion: p.scheduleVersion || 1 },
      {
        status: 'paid',
        paidAmount: round2((p.paidAmount || 0) + amount),
        paidOn: isoDateIn(confirmedAt, calendar.timeZone),
        reference: bank.ref,
        recordedBy: BANK,
        confirmation,
        submission: { ...p.submission, txnRef: bank.ref, state: 'settled', bankStatus: 'SUCCESS', lastCheckedAt: now().toISOString() },
      },
      { event: 'paid', by: BANK, detail: `Confirmed by the simulated bank: ${bank.ref}, ${fmtMoney(amount, cur)}. SIMULATED: no money moved.` },
    );
    if (!done) return false; // another tick got there first
    await moveInvoice(
      p.invoiceId,
      ['payment_processing', 'payment_pending'],
      'payment_completed',
      { paymentConfirmation: confirmation },
      {
        actor: BANK,
        action: 'payment_confirmed',
        reason: `The simulated bank confirmed ${bank.ref}.`,
        detail: `${fmtMoney(amount, cur)} paid, confirmed ${confirmation.confirmedAt}. SIMULATED: no money moved.`,
      },
    );
    if (notices) {
      try {
        await notices.paymentConfirmed(asId(p));
      } catch (err) {
        log.error?.(`Payment confirmation notice could not be drafted for ${asId(p)}: ${err?.message}`);
      }
    }
    return true;
  }

  /** The bank failed or rejected it (or it never reached the bank). */
  async function failPayment(p, { from = ['processing'], code, message, ref = null, by = BANK }) {
    const failed = await store.updatePayment(
      asId(p),
      { status: from, scheduleVersion: p.scheduleVersion || 1 },
      {
        status: 'failed',
        failure: { reason: message, code, by, at: now().toISOString(), txnRef: ref },
        ...(p.submission ? { submission: { ...p.submission, txnRef: ref || p.submission.txnRef || null, state: 'failed', bankStatus: code } } : {}),
      },
      { event: 'failed', by, detail: `${message}${ref ? ` (${ref})` : ''}` },
    );
    if (!failed) return false;
    await moveInvoice(
      p.invoiceId,
      ['payment_processing', 'payment_pending'],
      'payment_failed',
      {},
      { actor: by, action: 'payment_failed', reason: message, detail: ref ? `Bank transaction ${ref}.` : null },
    );
    return true;
  }

  async function markAccepted(p, r) {
    return store.updatePayment(
      asId(p),
      { status: ['processing'], scheduleVersion: p.scheduleVersion || 1 },
      {
        submission: {
          ...p.submission,
          txnRef: r.ref,
          state: 'accepted',
          bankStatus: r.status,
          completesAt: r.completesAt ? new Date(r.completesAt).toISOString() : null,
          error: null,
        },
      },
      {
        event: 'accepted_by_bank',
        by: BANK,
        detail: `Accepted as ${r.ref}${r.duplicate ? ' (a repeat of the same instruction: not paid twice)' : ''}. Not paid until the bank confirms it.`,
      },
    );
  }

  // What the bank already knows about this instruction (after a crash or a timeout).
  async function askBank(key) {
    try {
      return await adapter.getPayment({ idempotencyKey: key });
    } catch {
      return null; // could not ask: treat as unknown, try again later
    }
  }

  // Act on what the bank said about an instruction we sent.
  async function adopt(p, known, metrics) {
    if (known.status === 'REJECTED' || known.status === 'FAILED') {
      if (await failPayment(p, { code: known.code || known.status, message: known.message || 'The simulated bank did not complete the payment.', ref: known.ref }))
        metrics.payments.failed += 1;
      return 'failed';
    }
    const accepted = await markAccepted(p, known);
    if (known.status === 'SUCCESS' && accepted && (await completePayment(accepted, known))) metrics.payments.completed += 1;
    return 'accepted';
  }

  // Before submitting: the invoice still waits for this payment, the amount is
  // within what is left to pay, and the bank details are the verified ones the
  // payment was scheduled against. Returns a problem, or { invoice, vendor }.
  async function preflight(p) {
    const invoice = await store.getInvoice(String(p.invoiceId));
    if (!invoice) return { stop: 'The invoice no longer exists.' };
    if (invoice.status !== 'payment_pending') return { stop: `The invoice is ${invoice.status}, not waiting for payment.` };
    const remaining = remainingToPay(invoice, p);
    if (!(remaining > 0)) return { problem: 'Nothing is left to pay on this invoice.' };
    if ((p.currency || 'AUD') !== 'AUD') return { problem: 'The simulated bank pays AUD only.' };
    const { vendor, pending } = await store.beneficiaryFor(p.vendorAbn);
    const block = beneficiaryBlock(vendor, pending, p.method);
    if (block) return { problem: block };
    if (vendor.beneficiary.version !== p.beneficiary?.version) {
      return {
        problem: `The supplier's bank details changed after this payment was scheduled (version ${p.beneficiary?.version ?? 'none'} to ${vendor.beneficiary.version}). Schedule it again to pay the new details.`,
      };
    }
    return { invoice, vendor, remaining };
  }

  async function submit(p, job, tickId, metrics, vendor) {
    const key = idempotencyKey(asId(p), p.scheduleVersion);
    // A retry, or a payment left "submitting" by a tick that died: ask the bank first.
    if (job.attempts > 1 || p.submission?.state !== 'submitting') {
      const known = await askBank(key);
      if (known?.found) {
        const outcome = await adopt(p, known, metrics);
        if (outcome === 'accepted') metrics.jobs.submitted += 1;
        return finishJob(job, tickId, 'done', `Bank already had ${known.ref} (${known.status}).`);
      }
    }
    const v = vendor || (await store.beneficiaryFor(p.vendorAbn)).vendor;
    const b = v.beneficiary;
    const instruction = {
      idempotencyKey: key,
      amount: p.submission.amount,
      currency: p.currency || 'AUD',
      method: p.method,
      beneficiary: { accountName: b.accountName, bsb: b.bsb, accountNumber: b.accountNumber, billerCode: b.billerCode, crn: b.crn, cardToken: b.cardToken },
      reference: p.invoiceNumber || '',
      payee: { abn: p.vendorAbn, name: p.vendorName },
    };
    try {
      const r = await adapter.submitPayment(instruction, { now: now() });
      if (r.outcome === 'accepted') {
        await markAccepted(p, r);
        metrics.jobs.submitted += 1;
        return finishJob(job, tickId, 'done', `Accepted by the simulated bank as ${r.ref}.`);
      }
      await failPayment(p, { code: r.code, message: r.message || 'The simulated bank rejected the payment.', ref: r.ref });
      metrics.jobs.rejected += 1;
      return finishJob(job, tickId, 'done', `Rejected by the simulated bank: ${r.code}.`);
    } catch (err) {
      if (!err?.retryable) {
        await failPayment(p, { code: err?.code || 'bank_error', message: err?.message || 'The bank refused the instruction.' });
        metrics.jobs.rejected += 1;
        return finishJob(job, tickId, 'failed', err?.message, { error: err?.message });
      }
      // Temporarily unavailable, or no answer in time ("unknown"). Never success.
      const state = err.timeout ? 'unknown' : 'retry';
      await store.updatePayment(
        asId(p),
        { status: ['processing'], scheduleVersion: p.scheduleVersion || 1 },
        { submission: { ...p.submission, state, error: err.message } },
        { event: err.timeout ? 'bank_no_answer' : 'bank_unavailable', by: SCHEDULER, detail: `${err.message} Not paid; the same instruction will be tried again.` },
      );
      if (job.attempts >= maxAttempts) {
        const known = await askBank(key);
        if (known?.found) {
          await adopt(p, known, metrics);
          return finishJob(job, tickId, 'done', `Bank had ${known.ref} (${known.status}) after ${job.attempts} attempts.`);
        }
        if (known && !known.found) {
          await failPayment(p, { code: 'bank_unavailable', message: `The simulated bank could not be reached after ${job.attempts} attempts. Nothing was paid.` });
          metrics.jobs.rejected += 1;
          return finishJob(job, tickId, 'failed', 'Gave up: the bank never accepted the instruction.', { error: err.message });
        }
        // Could not even ask: keep it processing and try again later rather than guess.
      }
      metrics.jobs.retried += 1;
      const delay = retryDelaysSeconds[Math.min(job.attempts - 1, retryDelaysSeconds.length - 1)];
      return finishJob(job, tickId, 'pending', `Will retry: ${err.message}`, { runAt: new Date(now().getTime() + delay * 1000), error: err.message });
    }
  }

  async function runJob(job, tickId, metrics, depth = 0) {
    let p = await Payment.findById(job.paymentId).lean();
    if (!p) return finishJob(job, tickId, 'failed', 'The payment no longer exists.');
    if ((p.scheduleVersion || 1) !== job.scheduleVersion || p.route !== 'bank') {
      metrics.jobs.superseded += 1;
      return finishJob(job, tickId, 'superseded', 'The payment was rescheduled or changed; this job is obsolete and did nothing.');
    }
    if (p.status === 'cancelled') {
      metrics.jobs.cancelled += 1;
      return finishJob(job, tickId, 'cancelled', 'The payment was cancelled before it ran.');
    }
    if (p.status === 'paid' || p.status === 'failed') return finishJob(job, tickId, 'done', `The payment is already ${p.status}.`);
    if (p.status === 'on_hold') return finishJob(job, tickId, 'pending', 'The payment is on hold.', { runAt: new Date(now().getTime() + 15 * 60000), attemptsBack: true });

    let vendor = null;
    if (p.status === 'queued') {
      const window = calendar.executionWindow(now());
      if (!window.ok) {
        metrics.jobs.deferred += 1;
        return finishJob(job, tickId, 'pending', `${window.reason} Waits until ${window.nextAt.toISOString()}.`, { runAt: window.nextAt, attemptsBack: true });
      }
      const check = await preflight(p);
      if (check.stop) {
        metrics.jobs.cancelled += 1;
        return finishJob(job, tickId, 'cancelled', check.stop);
      }
      if (check.problem) {
        await failPayment(p, { from: ['queued'], code: 'not_submitted', message: `Not sent to the bank: ${check.problem}`, by: SCHEDULER });
        metrics.jobs.blocked += 1;
        return finishJob(job, tickId, 'done', `Not submitted: ${check.problem}`);
      }
      vendor = check.vendor;
      // Claim the payment for this schedule version, then move the invoice.
      const key = idempotencyKey(asId(p), p.scheduleVersion);
      const claimed = await store.updatePayment(
        asId(p),
        { status: ['queued'], scheduleVersion: job.scheduleVersion },
        { status: 'processing', submission: { idempotencyKey: key, amount: check.remaining, state: 'submitting', submittedAt: now().toISOString(), txnRef: null } },
        { event: 'submitting', by: SCHEDULER, detail: `Sending ${fmtMoney(check.remaining, p.currency || 'AUD')} to the simulated bank (${p.method}).` },
      );
      if (!claimed) {
        // Rescheduled or cancelled in the meantime: look again (once).
        return depth < 1
          ? runJob(job, tickId, metrics, depth + 1)
          : finishJob(job, tickId, 'pending', 'The payment changed while starting; will look again.', { runAt: now(), attemptsBack: true });
      }
      const moved = await store.claimInvoice(
        String(p.invoiceId),
        'payment_pending',
        { status: 'payment_processing' },
        invoiceEvent(
          SCHEDULER,
          'payment_submitted',
          'payment_pending',
          'payment_processing',
          'Sent to the simulated bank.',
          `${p.method}, ${fmtMoney(check.remaining, p.currency || 'AUD')}. Not paid until the bank confirms it.`,
        ),
      );
      if (!moved) {
        // The invoice changed at the same moment: do not submit; put the payment back.
        await store.updatePayment(
          asId(p),
          { status: ['processing'], scheduleVersion: job.scheduleVersion },
          { status: 'queued', submission: null },
          { event: 'undo', by: SCHEDULER, detail: 'The invoice changed at the same time; nothing was sent.' },
        );
        metrics.jobs.cancelled += 1;
        return finishJob(job, tickId, 'pending', 'The invoice changed while starting; will look again.', { runAt: new Date(now().getTime() + 60000), attemptsBack: true });
      }
      p = await Payment.findById(job.paymentId).lean();
    }

    // processing, for this schedule version
    if (p.submission?.txnRef) return finishJob(job, tickId, 'done', `Already accepted as ${p.submission.txnRef}.`);
    return submit(p, job, tickId, metrics, vendor);
  }

  /** Check the payments the bank is processing. Bounded. */
  async function syncProcessing(metrics, limit = 50) {
    const list = await Payment.find({ route: 'bank', status: 'processing' }).sort({ updatedAt: 1 }).limit(limit).lean();
    for (const p of list) {
      let s;
      if (p.submission?.txnRef) {
        try {
          s = await adapter.getPayment({ ref: p.submission.txnRef });
        } catch {
          continue; // ask again next tick
        }
      } else {
        // Sent, but no reference recorded (the tick died or timed out). Its job retries it;
        // if the bank already has it, adopt it now.
        const known = await askBank(idempotencyKey(asId(p), p.scheduleVersion));
        if (!known?.found) {
          await ensureJob(p);
          continue;
        }
        metrics.payments.resolvedUnknown += 1;
        await adopt(p, known, metrics);
        continue;
      }
      if (!s?.found) continue;
      if (s.status === 'SUCCESS') {
        if (await completePayment(p, s)) metrics.payments.completed += 1;
      } else if (s.status === 'FAILED' || s.status === 'REJECTED') {
        if (await failPayment(p, { code: s.code || s.status, message: s.message || 'The simulated bank did not complete the payment.', ref: s.ref })) metrics.payments.failed += 1;
      } else {
        metrics.payments.stillProcessing += 1;
      }
    }
  }

  // A processing payment with no reference and no active job (its job ended
  // without reaching the bank): give it a job, so it is retried, not forgotten.
  async function ensureJob(p) {
    if (await PaymentJob.exists({ paymentId: p._id, active: true })) return;
    try {
      await PaymentJob.create({
        paymentId: p._id,
        invoiceId: p.invoiceId,
        scheduleVersion: p.scheduleVersion || 1,
        runAt: now(),
        history: [{ at: now().toISOString(), event: 'created', by: SCHEDULER, reason: 'Resubmit after an unknown outcome.' }],
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }

  /** One tick. Returns counts only: no secrets, no bank details. */
  async function tick({ trigger = 'cron' } = {}) {
    const tickId = `tick-${randomBytes(6).toString('hex')}`;
    const started = Date.now();
    const metrics = {
      tickId,
      trigger,
      startedAt: now().toISOString(),
      simulated: true,
      bankSettled: 0,
      payments: { completed: 0, failed: 0, stillProcessing: 0, resolvedUnknown: 0 },
      jobs: { claimed: 0, submitted: 0, rejected: 0, retried: 0, deferred: 0, superseded: 0, cancelled: 0, blocked: 0, errors: 0 },
      budgetExhausted: false,
      dueRemaining: 0,
      durationMs: 0,
    };
    if (adapter.advance) metrics.bankSettled = await adapter.advance({ now: now() });
    await syncProcessing(metrics);
    while (metrics.jobs.claimed < tickMaxJobs) {
      if (Date.now() - started > tickBudgetSeconds * 1000) {
        metrics.budgetExhausted = true;
        break;
      }
      const job = await claimJob(tickId);
      if (!job) break;
      metrics.jobs.claimed += 1;
      try {
        await runJob(job, tickId, metrics);
      } catch (err) {
        metrics.jobs.errors += 1;
        log.error?.(`Payment job ${job._id} failed: ${err?.message}`);
        // Released for a later tick; the lease would expire anyway.
        await finishJob(job, tickId, 'pending', 'Error; will retry.', { runAt: new Date(now().getTime() + 60000), error: err?.message });
      }
    }
    // Payments the bank completed during this tick (zero-delay scenarios) are picked up now, not next time.
    if (metrics.jobs.submitted && adapter.advance) {
      const more = await adapter.advance({ now: now() });
      if (more) {
        metrics.bankSettled += more;
        await syncProcessing(metrics);
      }
    }
    metrics.dueRemaining = await PaymentJob.countDocuments(dueFilter(now()));
    metrics.durationMs = Date.now() - started;
    return metrics;
  }

  return { tick };
}
