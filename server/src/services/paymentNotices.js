// Payment notices to suppliers, in the existing outbox (OutboxMessage).
//
// A success notice is drafted automatically when the simulated bank confirms
// a payment; processing and failure notices only when a person asks. Every
// notice is a draft until a person approves it; only then is it delivered,
// as services/emailDelivery.js allows (outside production: the test recipient
// or the simulated outbox, never the supplier).
//
// One notice per payment, kind and bank transaction (unique dedupKey), so
// repeated cron ticks or clicks never produce a second one.

import mongoose from 'mongoose';
import { OutboxMessage, Payment, Invoice, Vendor } from '../models/index.js';
import { composePaymentNotice, noticeBlock, noticeRef, NOTICE_KINDS } from '../agent/finance/paymentEmails.js';
import { HttpError, recordAudit } from './runs.js';
import { requireActor } from './actor.js';

export function createPaymentNotices({ delivery, companyName, timeZone }) {
  async function loadPayment(paymentId) {
    if (!mongoose.isValidObjectId(paymentId)) throw new HttpError(404, 'That payment does not exist.');
    const payment = await Payment.findById(paymentId).lean();
    if (!payment) throw new HttpError(404, 'That payment does not exist.');
    return payment;
  }

  /**
   * Draft a notice. Returns { message, created }. An existing notice for the
   * same payment, kind and transaction is returned instead of a second one.
   * `by`: the person who asked, or null for the automatic success notice
   * (only paymentConfirmed below drafts without a person).
   */
  async function createDraft(paymentId, kind, by) {
    if (!NOTICE_KINDS.includes(kind)) throw new HttpError(400, `Choose one of: ${NOTICE_KINDS.join(', ')}.`);
    const payment = await loadPayment(paymentId);
    const block = noticeBlock(kind, payment);
    if (block) throw new HttpError(409, block);
    const ref = noticeRef(kind, payment);
    const dedupKey = `${payment._id}:${kind}:${ref}`;
    const existing = await OutboxMessage.findOne({ dedupKey }).lean();
    if (existing) return { message: existing, created: false };

    const [invoice, vendor] = await Promise.all([Invoice.findById(payment.invoiceId).lean(), Vendor.findOne({ abn: payment.vendorAbn }).lean()]);
    const to = vendor?.email;
    if (!to) throw new HttpError(409, 'The supplier has no email address on file.');
    const { subject, body } = composePaymentNotice({ kind, payment, invoice, companyName, timeZone });
    let message;
    try {
      message = (
        await OutboxMessage.create({
          kind,
          paymentId: payment._id,
          invoiceId: payment.invoiceId,
          txnRef: ref.startsWith('SIMTXN-') ? ref : undefined,
          dedupKey,
          to,
          subject,
          body,
          status: 'draft',
          sentBy: null,
        })
      ).toObject();
    } catch (err) {
      if (err?.code === 11000) return { message: await OutboxMessage.findOne({ dedupKey }).lean(), created: false };
      throw err;
    }
    await recordAudit({
      subjectKind: 'payment_email',
      subjectId: message._id,
      actor: by?.name || 'Payment scheduler',
      ...(by?.id ? { actorId: by.id } : {}),
      action: 'drafted',
      to: 'draft',
      detail: `${kind} for invoice ${payment.invoiceNumber || ''}${message.txnRef ? `, ${message.txnRef}` : ''}. Waiting for a person to approve it.`,
    });
    return { message, created: true };
  }

  /** A person asks for a notice: an authenticated payer or reviewer. */
  async function draft(paymentId, kind, by) {
    requireActor(by, 'payer', 'reviewer');
    return createDraft(paymentId, kind, by);
  }

  /** The automatic success notice, after the bank confirmed the payment. */
  const paymentConfirmed = (paymentId) => createDraft(paymentId, 'payment_success', null);

  async function loadDraft(id) {
    if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'That message does not exist.');
    const msg = await OutboxMessage.findById(id).lean();
    // Payment notices only: replies and supplier queries have their own flows.
    if (!msg || !NOTICE_KINDS.includes(msg.kind)) throw new HttpError(404, 'That message does not exist.');
    return msg;
  }

  /** A person approves a draft: it is delivered (safely) and marked sent. Only once. */
  // Only an approver or administrator sends a notice to a supplier.
  async function approveAndSend(id, user) {
    requireActor(user, 'approver', 'admin');
    const msg = await loadDraft(id);
    if (msg.status !== 'draft') throw new HttpError(409, `This message is already ${msg.status}.`);
    // The payment must still be in the state the notice describes (a success notice for a confirmed payment only).
    const payment = await Payment.findById(msg.paymentId).lean();
    const block = noticeBlock(msg.kind, payment);
    if (block || noticeRef(msg.kind, payment) !== msg.dedupKey.split(':').slice(2).join(':')) {
      throw new HttpError(409, `The payment has changed since this notice was written, so it was not sent. ${block || ''}`.trim());
    }
    const claimed = await OutboxMessage.findOneAndUpdate({ _id: msg._id, status: 'draft' }, { $set: { status: 'sending' } }, { new: true }).lean();
    if (!claimed) throw new HttpError(409, 'Someone else is sending this message.');
    let result;
    try {
      result = await delivery.deliver({ to: msg.to, subject: msg.subject, text: msg.body });
    } catch (err) {
      await OutboxMessage.updateOne(
        { _id: msg._id, status: 'sending' },
        { $set: { status: 'draft', delivery: { error: String(err?.message || err).slice(0, 300), at: new Date().toISOString() } } },
      );
      throw new HttpError(502, `The message could not be sent: ${err?.message || 'unknown error'}. It is still a draft.`);
    }
    const sent = await OutboxMessage.findOneAndUpdate(
      { _id: msg._id, status: 'sending' },
      { $set: { status: 'sent', sentAt: new Date(), sentBy: user.name, sentById: user.id, delivery: result } },
      { new: true },
    ).lean();
    await recordAudit({
      subjectKind: 'payment_email',
      subjectId: msg._id,
      actor: user.name,
      actorId: user.id,
      action: 'approved_and_sent',
      from: 'draft',
      to: 'sent',
      detail:
        result.mode === 'live'
          ? `Emailed to ${result.deliveredTo}.`
          : result.mode === 'test_recipient'
            ? `Redirected to the test recipient instead of ${result.intendedTo}.`
            : `Kept in the simulated outbox; not emailed (intended for ${result.intendedTo}).`,
    });
    return sent;
  }

  async function discard(id, user, note) {
    requireActor(user, 'payer', 'reviewer', 'approver');
    const msg = await loadDraft(id);
    const why = String(note || '')
      .trim()
      .slice(0, 500);
    if (!why) throw new HttpError(400, 'Add a note with the reason.');
    const done = await OutboxMessage.findOneAndUpdate(
      { _id: msg._id, status: 'draft' },
      { $set: { status: 'discarded', sentBy: user.name, sentById: user.id } },
      { new: true },
    ).lean();
    if (!done) throw new HttpError(409, `This message is already ${msg.status}.`);
    await recordAudit({ subjectKind: 'payment_email', subjectId: msg._id, actor: user.name, actorId: user.id, action: 'discarded', from: 'draft', to: 'discarded', reason: why });
    return done;
  }

  const list = ({ status, paymentId, invoiceId } = {}) =>
    OutboxMessage.find({
      kind: { $in: NOTICE_KINDS },
      ...(status ? { status } : {}),
      ...(paymentId ? { paymentId } : {}),
      ...(invoiceId ? { invoiceId } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

  return { draft, paymentConfirmed, approveAndSend, discard, list, delivery };
}
