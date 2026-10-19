// The append-only audit log: one entry for every status change of an
// invoice, payment, supplier email, bank line or report. Entries are only
// ever added: nothing updates or deletes them (see AuditEvent in
// models/index.js, which refuses both).

export const SUBJECT_KINDS = ['invoice', 'payment', 'query', 'statement', 'bank_line', 'report', 'system'];

/** One audit entry, in a fixed shape. */
export function auditEntry({ subjectKind, subjectId, actor, action, from = null, to = null, reason = null, detail = null, at = new Date() }) {
  if (!SUBJECT_KINDS.includes(subjectKind)) throw new Error(`Unknown audit subject: ${subjectKind}`);
  return {
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
