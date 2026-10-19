// Bank reconciliation: run the agent on a statement, and apply a person's
// decision on each line the agent could not place.

import { createReconciliationAgent } from '../agent/finance/reconciliationAgent.js';
import { createExplainer } from '../agent/finance/reconcileNotes.js';
import { needsPerson } from '../agent/finance/reconcileRules.js';
import { money } from '../agent/finance/rules.js';
import { bankLineId } from '../agent/finance/audit.js';
import { sampleLedger } from '../integrations/sampleLedger.js';
import { BankStatement } from '../models/index.js';
import { config } from '../config.js';
import { HttpError, runAndRecord, latestRun, addHumanStep, whoAndWhy, failedDecision, auditFailed, recordAudit } from './runs.js';

const agent = createReconciliationAgent({
  ledger: sampleLedger,
  explain: createExplainer(config),
  save: (statement) => statement.save(),
});

export async function processStatement(statement) {
  const result = await runAndRecord(agent, { statement }, { kind: 'statement', id: statement._id });
  if (!result.outcome) {
    await sampleLedger.revertStatement(String(statement._id));
    const from = statement.status;
    await BankStatement.updateOne({ _id: statement._id }, { $set: { status: 'failed', decision: failedDecision(result) } });
    await auditFailed('statement', statement._id, from, result);
  }
  return result;
}

export async function getStatementDetail(id) {
  const statement = await BankStatement.findById(id).lean();
  if (!statement) throw new HttpError(404, 'That statement no longer exists.');
  return { statement, run: await latestRun(id) };
}

/**
 * A person decides one statement line.
 *   confirm - accept the payment the agent suggested, and mark it as paid
 *   dismiss - this line is not a supplier payment, or is being dealt with elsewhere
 */
export async function resolveLine(id, lineNumber, input) {
  const { action } = input;
  if (!['confirm', 'dismiss'].includes(action)) throw new HttpError(400, 'Choose to confirm the match or dismiss the line.');
  const { who, why } = whoAndWhy(input);

  const statement = await BankStatement.findById(id);
  if (!statement) throw new HttpError(404, 'That statement no longer exists.');
  if (statement.status !== 'needs_person') throw new HttpError(409, 'This statement is not waiting for a person.');
  const lines = statement.lines.map((l) => ({ ...l }));
  const line = lines.find((l) => l.n === Number(lineNumber));
  if (!line) throw new HttpError(404, 'That line is not on this statement.');
  if (!needsPerson(line)) throw new HttpError(409, 'This line has already been decided.');

  const lineFrom = line.status;
  const label = `Line ${line.n} (${line.description}, ${money(Math.abs(line.amount))})`;
  let summary;
  let paidId = null;

  if (action === 'confirm') {
    if (!line.candidate?.paymentId) throw new HttpError(400, 'The agent has no payment to suggest for this line, so it can only be dismissed.');
    if (line.kind === 'amount_differs' && !why) throw new HttpError(400, 'Add a note explaining why the amounts differ.');
    const paid = await sampleLedger.markPaid(line.candidate.paymentId, { statementId: String(statement._id), line: line.n, date: line.date, description: line.description });
    if (!paid) throw new HttpError(409, `The payment for invoice ${line.candidate.invoiceNumber} is no longer waiting to be paid, so it cannot be matched to this line.`);
    paidId = line.candidate.paymentId;
    Object.assign(line, { status: 'confirmed', paymentId: paidId, invoiceNumber: line.candidate.invoiceNumber, vendorName: line.candidate.vendorName });
    summary = `${label} matched to invoice ${line.candidate.invoiceNumber} by ${who}.${why ? ` Note: ${why}` : ''}`;
  } else {
    if (!why) throw new HttpError(400, 'Add a note saying what this line is.');
    line.status = 'dismissed';
    summary = `${label} dismissed by ${who}. Note: ${why}`;
  }
  line.resolution = { action, decidedBy: who, note: why, decidedAt: new Date().toISOString() };

  const done = !lines.some(needsPerson);
  statement.lines = lines;
  if (done) statement.status = 'reconciled';

  try {
    await statement.save();
  } catch (err) {
    // Someone else changed the statement first. Undo the payment and ask them to reload.
    if (paidId) await sampleLedger.unmarkPaid(paidId, String(statement._id));
    if (err?.name === 'VersionError') throw new HttpError(409, 'Someone else just changed this statement. Reload it and try again.');
    throw err;
  }

  await recordAudit({
    subjectKind: 'bank_line',
    subjectId: bankLineId(String(statement._id), line.n),
    actor: who,
    action,
    from: lineFrom,
    to: line.status,
    reason: why || null,
    detail: line.invoiceNumber ? `Invoice ${line.invoiceNumber}.` : null,
  });
  if (done)
    await recordAudit({
      subjectKind: 'statement',
      subjectId: statement._id,
      actor: who,
      action: 'reconciled',
      from: 'needs_person',
      to: 'reconciled',
      reason: 'Every line has been decided.',
    });
  await addHumanStep(id, summary, done ? 'reconciled' : undefined);
  return getStatementDetail(id);
}
