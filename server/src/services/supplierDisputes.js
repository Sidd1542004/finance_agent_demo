// Queries to suppliers about an invoice's variance (quantity, price or GST).
//
// A person asks for a draft; code works out the facts (disputeFacts.js), the
// model drafts the email from those facts only, and code checks it (template
// otherwise, disputeDraft.js). A person reviews, edits and sends it; nothing is
// sent automatically. Sending goes through the same delivery as payment notices
// (emailDelivery.js: outside production, the test recipient or the simulated
// outbox, never the supplier) and is recorded in the outbox.
//
// A query never changes the invoice: it does not approve, reject or hold it.
//
// Roles: reviewers, approvers and administrators draft, edit, send, discard and
// resolve; anyone signed in (payers too) may view. The actor is always the
// signed-in person (requireActor), never anything in the request body.
//
// The email's structure is code's (disputeDraft.js): the subject and greeting are
// set when it is drafted; the sign-off and signature (the name of the person who
// sends it, then the company) are added when it is sent, so they are always the
// sender's. A person edits the subject and the body paragraphs only. Replies go
// to accounts payable (Reply-To: AP_REPLY_TO, or the connected invoice mailbox).
//
// The audit log (subject 'supplier_dispute') records each step without the email body.

import mongoose from 'mongoose';
import { Invoice, Vendor, GoodsReceipt, OutboxMessage, SupplierDispute, IngestionSource } from '../models/index.js';
import { disputeFacts, failedVariances } from '../agent/finance/disputeFacts.js';
import { draftDispute as writeDraft, assembleEmail, greetingFor, SIGN_OFF, SUBJECT_MAX, BODY_MAX } from '../agent/finance/disputeDraft.js';
import { normaliseAbn } from '../agent/finance/rules.js';
import { HttpError, recordAudit } from './runs.js';
import { requireActor } from './actor.js';

export const DISPUTE_ROLES = Object.freeze(['reviewer', 'approver', 'admin']);
export const RESOLUTIONS = Object.freeze({ credit_note_received: 'Credit note received', corrected_invoice_received: 'Corrected invoice received' });

const by = (actor) => ({ id: String(actor.id), name: actor.name });
const note = (value, field = 'note') => {
  const text = String(value ?? '')
    .trim()
    .slice(0, 500);
  if (!text) throw new HttpError(400, `Add a ${field} with the reason.`);
  return text;
};

/** What the dashboard shows of a query. */
export function disputeView(d) {
  if (!d) return null;
  return {
    id: String(d._id),
    invoiceId: String(d.invoiceId),
    invoiceNumber: d.invoiceNumber,
    status: d.status,
    to: d.to,
    facts: d.facts,
    draft: {
      subject: d.draft.subject,
      greeting: d.draft.greeting || greetingFor(d.facts),
      body: d.draft.body,
      signOff: SIGN_OFF,
      aiDrafted: d.draft.aiDrafted,
      fallbackReason: d.draft.fallbackReason,
      editedBy: d.draft.editedBy || null,
    },
    // The email exactly as it was sent (with the sender's signature), once sent.
    sentEmail: d.sentEmail ? { subject: d.sentEmail.subject, text: d.sentEmail.text, replyTo: d.sentEmail.replyTo || null } : null,
    label: d.draft.aiDrafted ? 'AI-drafted' : 'From template',
    version: d.version,
    createdBy: d.createdBy?.name || null,
    createdAt: d.createdAt,
    sentBy: d.sentBy?.name || null,
    sentAt: d.sentAt,
    delivery: d.delivery ? { mode: d.delivery.mode, redirected: d.delivery.redirected, deliveredTo: d.delivery.deliveredTo } : null,
    discarded: d.discarded,
    resolution: d.resolution,
  };
}

/**
 * The address a supplier's reply should go to: AP_REPLY_TO when set, otherwise
 * the connected invoice mailbox's address, otherwise none.
 */
export async function apReplyTo(configured = '') {
  if (configured) return configured;
  const box = await IngestionSource.findOne({ status: 'connected', account: { $nin: [null, ''] } })
    .sort({ connectedAt: -1 })
    .lean();
  return box?.account || null;
}

export function createSupplierDisputes({ delivery, buyer, policy, llm = () => ({}), replyTo = () => apReplyTo() }) {
  async function loadInvoice(invoiceId) {
    if (!mongoose.isValidObjectId(invoiceId)) throw new HttpError(404, 'That invoice does not exist.');
    const invoice = await Invoice.findById(invoiceId).lean();
    if (!invoice) throw new HttpError(404, 'That invoice does not exist.');
    return invoice;
  }

  async function load(id) {
    if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'That query does not exist.');
    const d = await SupplierDispute.findById(id).lean();
    if (!d) throw new HttpError(404, 'That query does not exist.');
    return d;
  }

  /** The facts for an invoice, from its records and the supplier's. */
  async function factsFor(invoice) {
    const abn = invoice.supplier?.abn ? normaliseAbn(invoice.supplier.abn) : null;
    const [vendor, receipts] = await Promise.all([abn ? Vendor.findOne({ abn }).lean() : null, invoice.matchedPo ? GoodsReceipt.find({ poNumber: invoice.matchedPo }).lean() : []]);
    return disputeFacts({ invoice, vendor, receipts, gstRatePct: policy.gstRatePct, buyer });
  }

  /** GET: the invoice's queries, newest first. Any signed-in role. */
  async function listDisputes(invoiceId, actor) {
    requireActor(actor);
    const invoice = await loadInvoice(invoiceId);
    const items = await SupplierDispute.find({ invoiceId: invoice._id }).sort({ createdAt: -1 }).limit(20).lean();
    // The company signs every query; the sender's name is added when it is sent.
    return { items: items.map(disputeView), variances: failedVariances(invoice), canDraft: failedVariances(invoice).length > 0, company: buyer };
  }

  /**
   * A person asks for a draft. Returns { dispute, created }. An open query for
   * the invoice (draft or sent) is returned instead of a second one.
   */
  async function draftDispute(invoiceId, actor) {
    requireActor(actor, ...DISPUTE_ROLES);
    const invoice = await loadInvoice(invoiceId);
    const open = await SupplierDispute.findOne({ invoiceId: invoice._id, open: true }).lean();
    if (open) return { dispute: open, created: false };
    const facts = await factsFor(invoice);
    if (!facts) throw new HttpError(409, 'No quantity, price or GST check failed on this invoice, so there is nothing to query.');
    if (!facts.variances.length) throw new HttpError(409, 'The variance on this invoice is not in the supplier’s favour, so there is nothing to ask them for.');
    if (!facts.supplierEmail) throw new HttpError(409, 'The supplier has no email address in our records.');

    const written = await writeDraft(facts, llm());
    let dispute;
    try {
      dispute = (
        await SupplierDispute.create({
          invoiceId: invoice._id,
          invoiceNumber: facts.invoiceNumber,
          facts,
          to: facts.supplierEmail,
          draft: { subject: written.subject, greeting: written.greeting, body: written.body, aiDrafted: written.aiDrafted, fallbackReason: written.fallbackReason },
          createdBy: by(actor),
        })
      ).toObject();
    } catch (err) {
      // Two people asked at once: the other draft is the one.
      if (err?.code === 11000) return { dispute: await SupplierDispute.findOne({ invoiceId: invoice._id, open: true }).lean(), created: false };
      throw err;
    }
    await recordAudit({
      subjectKind: 'supplier_dispute',
      subjectId: dispute._id,
      actor: actor.name,
      actorId: actor.id,
      action: 'dispute_drafted',
      to: 'draft',
      reason: written.fallbackReason,
      detail: `Invoice ${facts.invoiceNumber || '(no number)'}: ${written.aiDrafted ? 'AI-drafted' : `from template (${written.fallbackReason})`}. Asks for ${facts.outcomeText}.${written.call ? ` Model ${written.call.outcome}, ${written.call.ms} ms.` : ''}`,
    });
    return { dispute, created: true, call: written.call, problems: written.problems };
  }

  /** A person edits the draft's subject or body, from the version they saw. */
  async function editDispute(id, { subject, body, expectedVersion } = {}, actor) {
    requireActor(actor, ...DISPUTE_ROLES);
    const d = await load(id);
    if (d.status !== 'draft') throw new HttpError(409, `This query is already ${d.status}.`);
    const set = {};
    if (subject !== undefined) {
      const s = String(subject).trim();
      if (!s || s.length > SUBJECT_MAX) throw new HttpError(400, `The subject must be 1 to ${SUBJECT_MAX} characters.`);
      if (s !== d.draft.subject) set['draft.subject'] = s;
    }
    if (body !== undefined) {
      const b = String(body).trim();
      if (!b || b.length > BODY_MAX) throw new HttpError(400, `The email must be 1 to ${BODY_MAX} characters.`);
      if (b !== d.draft.body) set['draft.body'] = b;
    }
    if (!Object.keys(set).length) throw new HttpError(400, 'Nothing was changed.');
    if (!Number.isInteger(expectedVersion)) throw new HttpError(400, 'Send expectedVersion: the version of the draft you edited.');
    const changed = Object.keys(set).map((k) => k.replace('draft.', ''));
    const saved = await SupplierDispute.findOneAndUpdate(
      { _id: d._id, status: 'draft', version: expectedVersion },
      { $set: { ...set, 'draft.editedBy': { ...by(actor), at: new Date().toISOString() } }, $inc: { version: 1 } },
      { new: true },
    ).lean();
    if (!saved) throw new HttpError(409, 'Someone else changed this draft first. Reload it and try again.');
    await recordAudit({
      subjectKind: 'supplier_dispute',
      subjectId: d._id,
      actor: actor.name,
      actorId: actor.id,
      action: 'dispute_edited',
      from: `v${d.version}`,
      to: `v${saved.version}`,
      detail: `Invoice ${d.invoiceNumber || '(no number)'}: edited the ${changed.join(' and ')}.`,
    });
    return saved;
  }

  /** A person sends the draft. Only once: two clicks, or two people, send one email. */
  async function sendDispute(id, actor) {
    requireActor(actor, ...DISPUTE_ROLES);
    const d = await load(id);
    if (d.status !== 'draft') throw new HttpError(409, `This query is already ${d.status}.`);
    const claimed = await SupplierDispute.findOneAndUpdate({ _id: d._id, status: 'draft' }, { $set: { status: 'sending' } }, { new: true }).lean();
    if (!claimed) throw new HttpError(409, 'Someone else is sending this query.');
    // The signature is the sender's, whoever drafted it, then the company's name from the settings.
    const text = assembleEmail({ greeting: claimed.draft.greeting || greetingFor(claimed.facts), body: claimed.draft.body }, { name: actor.name, company: buyer });
    let result;
    try {
      result = await delivery.deliver({ to: claimed.to, subject: claimed.draft.subject, text, replyTo: await replyTo() });
    } catch (err) {
      await SupplierDispute.updateOne({ _id: d._id, status: 'sending' }, { $set: { status: 'draft' } });
      throw new HttpError(502, `The query could not be sent: ${err?.message || 'unknown error'}. It is still a draft.`);
    }
    const at = new Date();
    // In the outbox like every message to a supplier; the dedupKey stops a second copy.
    const message = await OutboxMessage.findOneAndUpdate(
      { dedupKey: `dispute:${d._id}` },
      {
        $setOnInsert: {
          kind: 'supplier_dispute',
          invoiceId: d.invoiceId,
          dedupKey: `dispute:${d._id}`,
          to: claimed.to,
          subject: claimed.draft.subject,
          body: text,
          status: 'sent',
          sentAt: at,
          sentBy: actor.name,
          sentById: String(actor.id),
          delivery: result,
        },
      },
      { upsert: true, new: true },
    ).lean();
    const sent = await SupplierDispute.findOneAndUpdate(
      { _id: d._id, status: 'sending' },
      {
        $set: {
          status: 'sent',
          sentAt: at,
          sentBy: by(actor),
          outboxMessageId: message._id,
          sentEmail: { subject: claimed.draft.subject, text, replyTo: result.replyTo || null },
          delivery: {
            mode: result.mode,
            intendedTo: result.intendedTo,
            deliveredTo: result.deliveredTo,
            redirected: result.redirected,
            replyTo: result.replyTo || null,
            at: result.at,
          },
        },
      },
      { new: true },
    ).lean();
    await recordAudit({
      subjectKind: 'supplier_dispute',
      subjectId: d._id,
      actor: actor.name,
      actorId: actor.id,
      action: 'dispute_sent',
      from: 'draft',
      to: 'sent',
      detail: `Invoice ${d.invoiceNumber || '(no number)'}: ${
        result.mode === 'live'
          ? `emailed to ${result.deliveredTo}`
          : result.mode === 'test_recipient'
            ? `redirected to the test recipient instead of ${result.intendedTo}`
            : `kept in the simulated outbox; not emailed (intended for ${result.intendedTo})`
      }. Asks for ${d.facts.outcomeText}.`,
    });
    return sent;
  }

  /** A person discards a draft, with a note. */
  async function discardDispute(id, reason, actor) {
    requireActor(actor, ...DISPUTE_ROLES);
    const why = note(reason);
    const d = await load(id);
    const done = await SupplierDispute.findOneAndUpdate(
      { _id: d._id, status: 'draft' },
      { $set: { status: 'discarded', open: false, discarded: { ...by(actor), at: new Date().toISOString(), note: why } } },
      { new: true },
    ).lean();
    if (!done) throw new HttpError(409, `This query is already ${d.status}.`);
    await recordAudit({
      subjectKind: 'supplier_dispute',
      subjectId: d._id,
      actor: actor.name,
      actorId: actor.id,
      action: 'dispute_discarded',
      from: 'draft',
      to: 'discarded',
      reason: why,
    });
    return done;
  }

  /** A person records the supplier's answer: a credit note or a corrected invoice received. */
  async function resolveDispute(id, { outcome, note: text } = {}, actor) {
    requireActor(actor, ...DISPUTE_ROLES);
    if (!Object.hasOwn(RESOLUTIONS, outcome)) throw new HttpError(400, `Choose one of: ${Object.keys(RESOLUTIONS).join(', ')}.`);
    const why = note(text);
    const d = await load(id);
    const done = await SupplierDispute.findOneAndUpdate(
      { _id: d._id, status: 'sent' },
      { $set: { status: 'resolved', open: false, resolution: { outcome, label: RESOLUTIONS[outcome], note: why, ...by(actor), at: new Date().toISOString() } } },
      { new: true },
    ).lean();
    if (!done) throw new HttpError(409, d.status === 'draft' ? 'Send the query before marking it resolved.' : `This query is already ${d.status}.`);
    await recordAudit({
      subjectKind: 'supplier_dispute',
      subjectId: d._id,
      actor: actor.name,
      actorId: actor.id,
      action: 'dispute_resolved',
      from: 'sent',
      to: 'resolved',
      reason: why,
      detail: `Invoice ${d.invoiceNumber || '(no number)'}: ${RESOLUTIONS[outcome]}.`,
    });
    return done;
  }

  return { listDisputes, draftDispute, editDispute, sendDispute, discardDispute, resolveDispute, factsFor };
}
