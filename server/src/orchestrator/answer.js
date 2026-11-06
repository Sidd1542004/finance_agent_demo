// An answer from a plan's results (docs/phase2-design.md §3.7): the facts
// from the records, and an explanation that is either the model's (labelled
// "AI explanation", checked by ground.js) or the template's (labelled "From
// records"). When the template stands in for the model, the reason is kept
// (the invoice reader's codes, plus "ungrounded") and a short note says so.

import { buildFacts } from './facts.js';
import { templateAnswer } from './templates.js';
import { compose } from './compose.js';
import { EXPLAINED } from './intents.js';

export const LABELS = Object.freeze({ model: 'AI explanation', template: 'From records' });

// What the person is told when the template stood in for the model. Never an internal error.
export function fallbackNote(code) {
  if (!code) return null;
  if (code === 'not_configured') return 'AI explanations are not set up on this server, so this answer comes from the records.';
  if (code === 'ungrounded') return 'The AI explanation did not match the records, so this answer comes from the records.';
  return 'The AI explanation was not available just now, so this answer comes from the records.';
}

const FAILURE_TEXT = {
  not_found: 'A record this answer needed no longer exists.',
  not_permitted: 'Part of this answer needs a role you do not have.',
  invalid: 'Part of this answer could not be read.',
  unavailable: 'Part of this answer could not be read just now.',
  timeout: 'Part of this answer took too long to read.',
  limit: 'This question needed more lookups than one question may make.',
};
const STEP_LABEL = {
  account: 'The simulated bank balance',
  payables: 'The due-date summary',
  history: 'The history',
  payment: 'The payment details',
  suppliers: 'The supplier list',
};

/** Plain lines for the plan's failures and role notes (plans.js runPlan). */
export function planMessages(run) {
  const failures = run.failures.map((f) => ({ step: f.step, code: f.code, text: FAILURE_TEXT[f.code] || FAILURE_TEXT.unavailable }));
  const notes = run.notes.map((n) => `${STEP_LABEL[n.step] || 'Part of this answer'} needs the ${n.roles.join(', ').replace(/, ([^,]*)$/, ' or $1')} role.`);
  return { failures, notes };
}

/**
 * { facts, history, explanation, notes, failures, modelCalls, records }.
 * records: the { kind, id } of every record the answer shows (for the thread).
 */
// viewer: the person asking (for the recommended next steps); premises: statuses the question assumed
// (stateReason.js premisesIn), so a wrong assumption is corrected first. The question itself is not used.
export async function buildAnswer({ intent, args, run, model = {}, viewer = null, premises = [] }) {
  const facts = buildFacts(intent, args, run.state, { viewer, premises });
  const template = templateAnswer(intent, args, facts, run.state);
  const modelCalls = [];
  let explanation = { source: 'template', label: LABELS.template, summary: template.summary, items: template.items, fallback: null, note: null };
  if (EXPLAINED.includes(intent) && run.status === 'answered') {
    const c = await compose(intent, facts, run.state, model);
    if (c.call) modelCalls.push(c.call);
    if (c.source === 'model') explanation = { source: 'model', label: LABELS.model, summary: c.summary, items: c.items, fallback: null, note: null };
    else if (c.fallback) explanation = { ...explanation, fallback: c.fallback, note: fallbackNote(c.fallback) };
  }
  const { failures, notes } = planMessages(run);
  const records = facts.records.filter((r) => r.id && ['invoice', 'payment', 'supplier', 'bank_line'].includes(r.kind)).map((r) => ({ kind: r.kind, id: r.id }));
  return { facts: facts.records, history: facts.history, explanation, notes, failures, modelCalls, records };
}
