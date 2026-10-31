// Supplier bank details: propose, approve, reject. Two people: whoever
// proposes a change cannot approve it. Only a signed-in person's request (the
// Suppliers screen) reaches this file: nothing here is called by the supplier
// email agent, the AI reader or any automatic process.
//
// Every step is written to the audit log (subject "supplier", the ABN), with
// masked details only.

import mongoose from 'mongoose';
import { Vendor, BeneficiaryChange } from '../models/index.js';
import { normaliseDetails, mask, maskedText, beneficiaryState, methodsOf } from '../agent/finance/beneficiary.js';
import { normaliseAbn } from '../agent/finance/rules.js';
import { hasRole } from '../auth/roles.js';
import { config } from '../config.js';
import { HttpError, recordAudit } from './runs.js';

const who = (user) => ({ actor: user.name, actorId: user.id });

async function vendorByAbn(abn) {
  const vendor = await Vendor.findOne({ abn: normaliseAbn(abn) }).lean();
  if (!vendor) throw new HttpError(404, 'That supplier is not on file.');
  return vendor;
}

const changeView = (c, { full = false } = {}) => ({
  id: String(c._id),
  vendorAbn: c.vendorAbn,
  vendorName: c.vendorName,
  status: c.status,
  details: full ? c.details : mask(c.details),
  masked: mask(c.details),
  reason: c.reason,
  baseVersion: c.baseVersion,
  proposedBy: c.proposedBy,
  proposedById: c.proposedById,
  proposedAt: c.createdAt,
  decidedBy: c.decidedBy,
  decidedAt: c.decidedAt,
  decisionNote: c.decisionNote,
});

/** Every supplier with its masked details and any pending change. */
export async function listSuppliers(user) {
  const [vendors, pending] = await Promise.all([Vendor.find().sort({ name: 1 }).lean(), BeneficiaryChange.find({ status: 'pending' }).lean()]);
  // Approvers and admins see a pending proposal in full, to check it before approving.
  const canReview = hasRole(user, 'approver', 'admin');
  return vendors.map((v) => {
    const p = pending.find((c) => c.vendorAbn === v.abn) || null;
    return {
      abn: v.abn,
      name: v.name,
      email: v.email || null,
      state: beneficiaryState(v, p),
      beneficiary: v.beneficiary
        ? { ...mask(v.beneficiary), status: v.beneficiary.status, version: v.beneficiary.version, verifiedBy: v.beneficiary.verifiedBy, verifiedAt: v.beneficiary.verifiedAt }
        : null,
      pending: p ? changeView(p, { full: canReview || p.proposedById === user.id }) : null,
    };
  });
}

export async function supplierHistory(abn) {
  const vendor = await vendorByAbn(abn);
  const changes = await BeneficiaryChange.find({ vendorAbn: vendor.abn }).sort({ createdAt: -1 }).lean();
  return { abn: vendor.abn, name: vendor.name, changes: changes.map((c) => changeView(c)) };
}

/** Propose new details. One pending change per supplier. Blocks payments until decided. */
export async function proposeChange(abn, input, user) {
  const vendor = await vendorByAbn(abn);
  const { details, problems } = normaliseDetails(input, { bsbPrefix: config.simBank.bsbPrefix });
  if (problems.length) throw new HttpError(400, problems.join(' '));
  const reason = String(input.reason || '')
    .trim()
    .slice(0, 500);
  if (!reason) throw new HttpError(400, 'Say where these details came from and how they were confirmed (for example a call-back to a known number).');
  let change;
  try {
    change = await BeneficiaryChange.create({
      vendorAbn: vendor.abn,
      vendorName: vendor.name,
      details: { ...details, simulated: true },
      baseVersion: vendor.beneficiary?.version || 0,
      reason,
      proposedBy: user.name,
      proposedById: user.id,
    });
  } catch (err) {
    if (err?.code === 11000) throw new HttpError(409, `A change to ${vendor.name}'s bank details is already waiting for approval. Approve or reject it first.`);
    throw err;
  }
  await recordAudit({
    subjectKind: 'supplier',
    subjectId: vendor.abn,
    ...who(user),
    action: 'bank_details_proposed',
    from: beneficiaryState(vendor, null),
    to: 'change_pending',
    reason,
    detail: `Proposed ${maskedText(details)}; replaces ${maskedText(vendor.beneficiary)}. Payments to this supplier are blocked until a second person decides.`,
  });
  return changeView(change.toObject(), { full: true });
}

async function pendingChange(id) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'That change does not exist.');
  const change = await BeneficiaryChange.findById(id).lean();
  if (!change) throw new HttpError(404, 'That change does not exist.');
  if (change.status !== 'pending') throw new HttpError(409, `This change was already ${change.status}.`);
  return change;
}

/** A second person approves: the details become the supplier's verified details. */
export async function approveChange(id, user, note = '') {
  const change = await pendingChange(id);
  if (change.proposedById === user.id) throw new HttpError(403, 'You proposed this change, so someone else must approve it.');
  const at = new Date();
  const decided = await BeneficiaryChange.findOneAndUpdate(
    { _id: change._id, status: 'pending', proposedById: { $ne: user.id } },
    { $set: { status: 'approved', decidedBy: user.name, decidedById: user.id, decidedAt: at, decisionNote: String(note || '').slice(0, 500) || null } },
    { new: true },
  ).lean();
  if (!decided) throw new HttpError(409, 'This change was decided by someone else at the same time. Reload and check.');

  const version = change.baseVersion + 1;
  const beneficiary = {
    ...change.details,
    simulated: true,
    status: 'verified',
    version,
    changeId: String(change._id),
    proposedBy: change.proposedBy,
    proposedById: change.proposedById,
    verifiedBy: user.name,
    verifiedById: user.id,
    verifiedAt: at.toISOString(),
  };
  // Only if the details are still the version the proposal replaced.
  const base = change.baseVersion ? { 'beneficiary.version': change.baseVersion } : { $or: [{ beneficiary: null }, { beneficiary: { $exists: false } }] };
  const updated = await Vendor.findOneAndUpdate({ abn: change.vendorAbn, ...base }, { $set: { beneficiary } }, { new: true }).lean();
  if (!updated) {
    await BeneficiaryChange.updateOne({ _id: change._id }, { $set: { status: 'rejected', decisionNote: 'The supplier’s details changed in the meantime. Propose again.' } });
    throw new HttpError(409, 'The supplier’s details changed in the meantime, so this proposal was closed. Propose the change again.');
  }
  await recordAudit({
    subjectKind: 'supplier',
    subjectId: change.vendorAbn,
    ...who(user),
    action: 'bank_details_approved',
    from: 'change_pending',
    to: 'verified',
    reason: note || null,
    detail: `Verified version ${version}: ${maskedText(change.details)}. Proposed by ${change.proposedBy}. Methods: ${methodsOf(change.details).join(', ')}.`,
  });
  return changeView(decided);
}

/** Reject (a second person) or withdraw (the proposer). The current details stay. */
export async function rejectChange(id, user, note = '') {
  const change = await pendingChange(id);
  const own = change.proposedById === user.id;
  if (!own && !hasRole(user, 'approver', 'admin')) throw new HttpError(403, 'Only an approver or administrator can reject someone else’s proposal.');
  const why = String(note || '')
    .trim()
    .slice(0, 500);
  if (!why) throw new HttpError(400, 'Add a note with the reason.');
  const status = own ? 'withdrawn' : 'rejected';
  const decided = await BeneficiaryChange.findOneAndUpdate(
    { _id: change._id, status: 'pending' },
    { $set: { status, decidedBy: user.name, decidedById: user.id, decidedAt: new Date(), decisionNote: why } },
    { new: true },
  ).lean();
  if (!decided) throw new HttpError(409, 'This change was decided by someone else at the same time. Reload and check.');
  const vendor = await Vendor.findOne({ abn: change.vendorAbn }).lean();
  await recordAudit({
    subjectKind: 'supplier',
    subjectId: change.vendorAbn,
    ...who(user),
    action: own ? 'bank_details_withdrawn' : 'bank_details_rejected',
    from: 'change_pending',
    to: beneficiaryState(vendor, null),
    reason: why,
    detail: `Proposed ${maskedText(change.details)} was not applied.`,
  });
  return changeView(decided);
}
