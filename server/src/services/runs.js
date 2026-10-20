// Shared by the vendor query, reconciliation and report services: run an agent
// and keep its six-step trail.

import { runAgent } from '../agent/core/loop.js';
import { AgentRun } from '../models/index.js';
import { sampleLedger } from '../integrations/sampleLedger.js';
import { bankLineId } from '../agent/finance/audit.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Append to the audit log (see agent/finance/audit.js).
export const recordAudit = (entry) => sampleLedger.recordAudit(entry);
export const recordAudits = (entries) => sampleLedger.recordAudits(entries);

export async function runAndRecord(agent, input, { kind, id }) {
  const record = input[kind];
  const from = record?.status ?? null;
  const run = await AgentRun.create({ agent: agent.name, subjectKind: kind, subjectId: id, status: 'running', steps: [] });
  const result = await runAgent(agent, input, {
    onStep: async (_step, steps) => {
      run.steps = [...steps];
      await run.save();
    },
  });
  run.status = result.outcome || 'failed';
  run.finishedAt = new Date();
  await run.save();

  // The agent's status change, and for a statement each line's result.
  if (result.outcome && record && record.status !== from) {
    const reasons = record.decision?.reasons?.length || 0;
    await recordAudit({
      subjectKind: kind,
      subjectId: id,
      actor: 'Agent',
      action: 'processed',
      from,
      to: record.status,
      reason: reasons ? `${reasons} reason${reasons === 1 ? '' : 's'} for a person` : null,
    });
  }
  if (result.outcome && kind === 'statement') {
    await recordAudits(
      (record.lines || []).map((l) => ({
        subjectKind: 'bank_line',
        subjectId: bankLineId(id, l.n),
        actor: 'Agent',
        action: 'reconciled',
        from: null,
        to: l.status,
        detail: l.candidate?.invoiceNumber ? `Suggested invoice ${l.candidate.invoiceNumber}.` : l.invoiceNumber ? `Invoice ${l.invoiceNumber}.` : null,
      })),
    );
  }
  return result;
}

// The agent could not finish: the record is marked failed, and that is logged.
export async function auditFailed(kind, id, from, result) {
  await recordAudit({ subjectKind: kind, subjectId: id, actor: 'Agent', action: 'failed', from, to: 'failed', reason: failedDecision(result).reasons[0] });
}

export const latestRun = (id) => AgentRun.findOne({ subjectId: id }).sort({ createdAt: -1 }).lean();

// Record what a person did after the agent handed something over.
export async function addHumanStep(id, summary, status) {
  const run = await AgentRun.findOne({ subjectId: id }).sort({ createdAt: -1 });
  if (!run) return;
  run.steps = [...run.steps, { stage: 'human', status: 'done', summary, detail: null, ms: 0, at: new Date().toISOString() }];
  if (status) run.status = status;
  await run.save();
}

// Name and note typed by the person deciding.
export function whoAndWhy({ decidedBy, note }) {
  const who = String(decidedBy || '')
    .trim()
    .slice(0, 120);
  if (!who) throw new HttpError(400, 'Enter your name so the decision is on record.');
  return {
    who,
    why: String(note || '')
      .trim()
      .slice(0, 1000),
  };
}

// If even the escalate stage failed, do not leave the record looking fine.
export const failedDecision = (result) => ({ outcome: 'failed', reasons: [`The agent could not finish: ${result.error?.message || 'unknown error'}`] });
