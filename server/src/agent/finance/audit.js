// The append-only audit log: one entry for every status change of an
// invoice, payment, supplier email, bank line or report. Entries are only
// ever added: nothing updates or deletes them (see AuditEvent in
// models/index.js, which refuses both).

import { stamp } from '../../clock.js';

// supplier: beneficiary (bank detail) changes. user: accounts and roles.
// sim_bank: simulated bank settings. payment_email: payment notices to suppliers.
// settings: the agent's policy (services/policySettings.js).
// orchestrator: the orchestrator's tool calls (orchestrator/tools.js), one entry per call.
export const SUBJECT_KINDS = [
  'invoice',
  'payment',
  'query',
  'statement',
  'bank_line',
  'report',
  'system',
  'supplier',
  'user',
  'sim_bank',
  'payment_email',
  'ingestion',
  'settings',
  'orchestrator',
];

/** One audit entry, in a fixed shape. `actorId` (the signed-in user's id) is added only when known. */
export function auditEntry({ subjectKind, subjectId, actor, actorId = null, action, from = null, to = null, reason = null, detail = null, at = stamp() }) {
  if (!SUBJECT_KINDS.includes(subjectKind)) throw new Error(`Unknown audit subject: ${subjectKind}`);
  return {
    ...(actorId ? { actorId: String(actorId).slice(0, 64) } : {}),
    subjectKind,
    subjectId: String(subjectId),
    actor: String(actor || 'System').slice(0, 120),
    action: String(action || 'changed').slice(0, 60),
    from: from ?? null,
    to: to ?? null,
    reason: reason ? String(reason).slice(0, 1000) : null,
    detail: detail ? String(detail).slice(0, 2000) : null,
    at: at instanceof Date ? at : new Date(at),
  };
}

// The id of one bank line in the log: "<statement id>:<line number>".
export const bankLineId = (statementId, n) => `${statementId}:${n}`;
