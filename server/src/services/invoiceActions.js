// What a person can do to an invoice after the agent has prepared it:
// approve, reject, hold, link a PO, clear a duplicate, schedule and record a
// (simulated) payment, reverse an approval, open a recovery.
//
// Written against a small store interface (getInvoice, claimInvoice, ...) so
// the same rules run on MongoDB (integrations/sampleLedger.js) and in memory
// in the tests (integrations/memoryLedger.js). Every status change goes
// through claimInvoice, which only succeeds if the invoice is still in the
// status the decision was made from: two clicks cannot both succeed.

import { assertAction, ActionError, failedChecks, STATUS_LABEL } from '../agent/finance/lifecycle.js';
import { receivedOnly, cents, isNum } from '../agent/finance/rules.js';
import { fmtMoney } from '../agent/finance/validation.js';
import { todayIso } from '../agent/finance/due.js';

export const PAYMENT_METHODS = ['EFT', 'BPAY', 'Card', 'Cheque', 'Other'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CHANGED = 'This invoice changed while you were deciding. Reload it and try again.';

export function createInvoiceActions({ store, policy, roles = {}, rerun, now = () => new Date() }) {
  async function perform(id, actionId, input = {}) {
    const invoice = await store.getInvoice(id);
    if (!invoice) throw new ActionError(404, 'That invoice no longer exists.');
    const payment = await store.getPayment(invoice.id);
    const partial = receivedOnly(invoice, policy.gstRatePct);
    const { who, note } = assertAction(invoice, actionId, input, { payment, receivedOnly: partial, roles, policy });

    const at = now().toISOString();
    const from = invoice.status;
    const cur = invoice.extracted?.currency || 'AUD';
    const m = (n) => fmtMoney(n, cur);
    const ev = (to, extra = {}) => ({ actor: who, action: actionId, from, to: to ?? from, reason: note || null, ...extra });
    const claim = async (to, set = {}, extra = {}) => {
      const updated = await store.claimInvoice(invoice.id, from, { status: to, ...set }, ev(to, extra));
      if (!updated) throw new ActionError(409, CHANGED);
      return updated;
    };
    const exceptions = failedChecks(invoice).map((c) => c.id);

    switch (actionId) {
      case 'approve':
      case 'approve_received': {
        const amount = actionId === 'approve_received' ? partial.total : invoice.extracted.total;
        const approval = { decision: actionId, decidedBy: who, note, decidedAt: at, amount, invoiceTotal: invoice.extracted.total, exceptions, score: invoice.match?.score?.total ?? null };
        await claim('approved', { approval }, { detail: `Approved ${m(amount)}${actionId === 'approve_received' ? ` of ${m(invoice.extracted.total)} (received quantity only)` : ''}${exceptions.length ? ` with ${exceptions.length} exception(s)` : ''}. No payment yet.` });
        return { summary: `${actionId === 'approve_received' ? 'Approved for the received quantity only' : 'Approved'} by ${who}: ${m(amount)}.${note ? ` Note: ${note}` : ''} Payment not scheduled yet.` };
      }

      case 'reject':
        await claim('rejected', { rejection: { decidedBy: who, note, decidedAt: at } });
        return { summary: `Rejected by ${who}. Note: ${note}` };

      case 'hold':
        await claim('on_hold', { hold: { decidedBy: who, note, decidedAt: at } });
        return { summary: `Placed on hold by ${who}. Note: ${note}` };

      case 'request_correction':
        await claim('on_hold', { correction: { decidedBy: who, note, requestedAt: at } }, { detail: 'Corrected invoice requested from the supplier.' });
        return { summary: `Corrected invoice requested by ${who}: ${note}` };

      case 'link_po': {
        const poNumber = String(input.poNumber || '').trim().toUpperCase();
        if (!poNumber) throw new ActionError(400, 'Choose the purchase order to link.');
        const po = await store.findPurchaseOrder(poNumber);
        if (!po) throw new ActionError(400, `Purchase order ${poNumber} does not exist.`);
        await claim('processing', { poOverride: { poNumber, decidedBy: who, note, at } }, { detail: `Linked ${poNumber}. Re-checked by the agent.` });
        await rerun(invoice.id);
        return { summary: `Purchase order ${poNumber} linked by ${who}${note ? `: ${note}` : ''}. The agent re-checked the invoice.` };
      }

      case 'clear_duplicate':
        await claim('processing', { duplicateCleared: { decidedBy: who, note, at } }, { detail: 'Marked as not a duplicate. Re-checked by the agent.' });
        await rerun(invoice.id);
        return { summary: `Marked as not a duplicate by ${who}: ${note}. The agent re-checked the invoice.` };

      case 'rerun':
        await claim('processing', {}, { detail: 'Sent back to the agent.' });
        await rerun(invoice.id);
        return { summary: `Processed again at ${who}'s request.` };

      case 'schedule_payment': {
        const method = PAYMENT_METHODS.includes(input.method) ? input.method : 'EFT';
        const scheduledFor = ISO.test(input.scheduledFor || '') ? input.scheduledFor : invoice.due?.date || todayIso(now());
        const dupes = await store.duplicatePayments(invoice);
        if (dupes.length) throw new ActionError(409, `A payment already exists for what looks like the same invoice (${dupes[0].invoiceNumber || 'no number'}, ${m(dupes[0].amount)}). It will not be paid twice.`);
        const amount = isNum(invoice.approval?.amount) ? invoice.approval.amount : invoice.extracted.total;
        await claim('payment_pending', {}, { detail: `${m(amount)} by ${method}, scheduled for ${scheduledFor}. Simulated: no money moves.` });
        try {
          if (payment && from === 'payment_failed') {
            const retried = await store.updatePayment(payment.id, ['failed'], { status: 'queued', method, scheduledFor, scheduledBy: who, attempts: (payment.attempts || 1) + 1, failure: null }, { event: 'retried', by: who });
            if (!retried) throw Object.assign(new Error('changed'), { code: 'CHANGED' });
          } else {
            await store.createPayment({
              invoiceId: invoice.id,
              vendorName: invoice.supplier?.name || invoice.extracted.vendorName,
              vendorAbn: invoice.extracted.abn,
              invoiceNumber: invoice.extracted.invoiceNumber,
              amount,
              invoiceTotal: invoice.extracted.total,
              dueDate: invoice.due?.date || invoice.extracted.dueDate || null,
              approvedBy: invoice.approval?.decidedBy || null,
              method,
              reference: String(input.reference || '').trim().slice(0, 80) || null,
              scheduledFor,
              scheduledBy: who,
              simulated: true,
            });
          }
        } catch (err) {
          await store.claimInvoice(invoice.id, 'payment_pending', { status: from }, { actor: 'System', action: 'undo', from: 'payment_pending', to: from, reason: 'The payment could not be created, so scheduling was undone.' });
          if (err?.code === 11000 || err?.code === 'CHANGED') throw new ActionError(409, 'A payment for this invoice already exists. It will not be created twice.');
          throw err;
        }
        return { summary: `Payment of ${m(amount)} scheduled by ${who} for ${scheduledFor} (${method}). Simulated: no money moves.` };
      }

      case 'record_payment': {
        const reference = String(input.reference || '').trim().slice(0, 80);
        if (!reference) throw new ActionError(400, 'Enter the payment reference as evidence of the payment.');
        const paidOn = ISO.test(input.paidOn || '') ? input.paidOn : todayIso(now());
        const method = PAYMENT_METHODS.includes(input.method) ? input.method : payment.method || 'EFT';
        const already = payment.paidAmount || 0;
        const amount = input.amount === undefined || input.amount === '' ? payment.amount - already : Number(input.amount);
        if (!isNum(amount) || amount <= 0) throw new ActionError(400, 'Enter the amount paid.');
        const total = Math.round((already + amount) * 100) / 100;
        if (cents(total) > cents(payment.amount)) throw new ActionError(400, `That is more than the ${m(payment.amount)} payment.`);
        if (cents(total) < cents(payment.amount)) {
          // A part payment is recorded, but the invoice stays Payment Pending.
          const p = await store.updatePayment(payment.id, ['queued'], { paidAmount: total, reference, method }, { event: 'part_payment', by: who, detail: `${m(amount)} on ${paidOn}, reference ${reference}` });
          if (!p) throw new ActionError(409, CHANGED);
          await store.updateInvoice(invoice.id, {}, ev(from, { action: 'part_payment', detail: `Part payment of ${m(amount)} recorded (${m(total)} of ${m(payment.amount)}).` }));
          return { summary: `Part payment of ${m(amount)} recorded by ${who} (reference ${reference}). ${m(payment.amount - total)} is still to pay.` };
        }
        await claim('payment_completed', {}, { detail: `${m(amount)} paid on ${paidOn} by ${method}, reference ${reference}. Simulated.` });
        const p = await store.updatePayment(payment.id, ['queued'], { status: 'paid', paidOn, paidAmount: total, reference, method, recordedBy: who }, { event: 'paid', by: who, detail: `reference ${reference}` });
        if (!p) {
          await store.claimInvoice(invoice.id, 'payment_completed', { status: from }, { actor: 'System', action: 'undo', from: 'payment_completed', to: from, reason: 'The payment changed at the same time, so recording was undone.' });
          throw new ActionError(409, 'The payment changed at the same time (for example a bank match). Reload and check before recording it.');
        }
        return { summary: `Payment recorded by ${who}: ${m(amount)} on ${paidOn} (${method}, reference ${reference}).` };
      }

      case 'payment_failed': {
        await claim('payment_failed', {}, { detail: 'The payment did not go through.' });
        const p = await store.updatePayment(payment.id, ['queued'], { status: 'failed', failure: { reason: note, by: who, at } }, { event: 'failed', by: who, detail: note });
        if (!p) {
          await store.claimInvoice(invoice.id, 'payment_failed', { status: from }, { actor: 'System', action: 'undo', from: 'payment_failed', to: from, reason: 'The payment changed at the same time.' });
          throw new ActionError(409, CHANGED);
        }
        return { summary: `Payment marked as failed by ${who}: ${note}` };
      }

      case 'reverse_approval':
      case 'cancel': {
        const to = actionId === 'reverse_approval' ? 'rejected' : 'cancelled';
        let stopped = null;
        if (payment && ['queued', 'failed', 'on_hold'].includes(payment.status)) {
          stopped = await store.updatePayment(payment.id, ['queued', 'failed', 'on_hold'], { status: 'cancelled' }, { event: 'cancelled', by: who, detail: note });
          if (!stopped) throw new ActionError(409, 'The payment went out at the same time. Reload the invoice; if it was paid, start a recovery instead.');
        } else if (payment?.status === 'paid') {
          throw new ActionError(409, 'This payment has already been made. Start a recovery instead.');
        }
        try {
          await claim(to, actionId === 'reverse_approval' ? { reversal: { decidedBy: who, note, at, from, approval: invoice.approval || null } } : { cancellation: { decidedBy: who, note, at, from } }, {
            detail: stopped ? 'The scheduled payment was cancelled before it was made.' : invoice.approval ? 'No payment had been scheduled.' : null,
          });
        } catch (err) {
          if (stopped) await store.updatePayment(payment.id, ['cancelled'], { status: payment.status }, { event: 'restored', by: 'System', detail: 'The invoice changed at the same time.' });
          throw err;
        }
        return {
          summary: `${actionId === 'reverse_approval' ? 'Approval reversed' : 'Invoice cancelled'} by ${who}: ${note}.${stopped ? ' The scheduled payment was cancelled.' : ''} The original approval is kept in the history.`,
        };
      }

      case 'start_recovery': {
        const amount = payment?.paidAmount ?? payment?.amount ?? invoice.extracted?.total;
        const recovery = { status: 'open', openedBy: who, note, openedAt: at, amount };
        await store.updateInvoice(invoice.id, { recovery }, ev(from, { detail: `Recovery of ${m(amount)} opened. The payment record is kept.` }));
        if (payment) await store.updatePayment(payment.id, ['paid'], { recovery }, { event: 'recovery_opened', by: who, detail: note });
        return { summary: `Recovery of ${m(amount)} opened by ${who}: ${note}. The payment record is kept.` };
      }

      case 'close_recovery': {
        const recovery = { ...invoice.recovery, status: 'closed', closedBy: who, closeNote: note, closedAt: at };
        await store.updateInvoice(invoice.id, { recovery }, ev(from, { detail: 'Recovery closed.' }));
        if (payment) await store.updatePayment(payment.id, ['paid'], { recovery }, { event: 'recovery_closed', by: who, detail: note });
        return { summary: `Recovery closed by ${who}: ${note}` };
      }

      default:
        throw new ActionError(400, `Unknown action. Current status: ${STATUS_LABEL[from]}.`);
    }
  }

  return { perform };
}
