// The fixed tool plan for each intent (docs/phase2-design.md §3.4 and §7).
// The model never names a tool: the plan is chosen by the validated intent,
// every step names a registered Phase 1 tool (checked when this module loads),
// and its arguments come from resolved record ids and earlier results, never
// from the model's text.
//
// A step: { name, tool, args(state) => args | args[] (many) | null (skip),
//           required, many }. A step the person's role cannot run is skipped
// before it is called: a required one makes the answer "not permitted", an
// optional one becomes a note.

import { TOOLS } from './tools.js';
import { hasRole } from '../auth/roles.js';

const step = (name, tool, args, { required = true, many = false } = {}) => Object.freeze({ name, tool, args, required, many });

export const PLANS = Object.freeze({
  list_pending_invoices: [
    step('waiting', 'list_invoices', () => ({ filter: 'waiting', limit: 50 })),
    step('waitingMore', 'list_invoices', (s) => (s.waiting?.nextCursor ? { filter: 'waiting', limit: 50, before: s.waiting.nextCursor } : null), { required: false }),
  ],
  find_invoice: [step('invoice', 'get_invoice', (s) => ({ invoiceId: s.invoiceId }))],
  explain_invoice_status: [
    step('invoice', 'get_invoice', (s) => ({ invoiceId: s.invoiceId })),
    step('history', 'get_history', (s) => ({ subjectId: s.invoiceId, limit: 20 }), { required: false }),
  ],
  supplier_summary: [step('suppliers', 'list_suppliers', () => ({})), step('open', 'list_open_invoices', (s) => (s.abn ? { abn: s.abn } : {}))],
  list_unpaid_invoices: [step('open', 'list_open_invoices', () => ({})), step('payables', 'get_payables', () => ({}), { required: false })],
  // payment_status: about one invoice, or (no invoice named) what blocks payments.
  payment_status_invoice: [
    step('invoice', 'get_invoice', (s) => ({ invoiceId: s.invoiceId })),
    step('payment', 'get_payment', (s) => (s.invoice?.payment?.id ? { paymentId: s.invoice.payment.id } : null), { required: false }),
  ],
  payment_status_blockers: [
    step('toPay', 'list_invoices', () => ({ filter: 'pay', limit: 50 })),
    step('payments', 'list_payments', () => ({ status: ['queued', 'processing', 'failed', 'on_hold'] })),
    step('suppliers', 'list_suppliers', () => ({}), { required: false }),
    step('account', 'sim_bank_account', () => ({}), { required: false }),
  ],
  reconciliation_exceptions: [
    step('statements', 'list_statements', () => ({ limit: 20 })),
    step(
      'open',
      'get_statement',
      (s) =>
        (s.statements?.items || [])
          .filter((x) => x.openCount > 0)
          .slice(0, 3)
          .map((x) => ({ statementId: x.id })),
      { required: false, many: true },
    ),
  ],
  ingestion_status: [step('ingestion', 'ingestion_status', () => ({}))],
  record_history: [step('history', 'get_history', (s) => ({ subjectId: s.subjectId, limit: 50 }))],
  unknown: [],
});

// Every tool a plan names is a registered read-only tool.
for (const [name, steps] of Object.entries(PLANS)) {
  for (const s of steps) if (!Object.hasOwn(TOOLS, s.tool)) throw new Error(`Plan ${name} names an unknown tool: ${s.tool}`);
}

/** The most tool calls a plan can make (a "many" step makes at most 3). */
export const planCalls = (steps) => steps.reduce((n, s) => n + (s.many ? 3 : 1), 0);

/** The plan for an intent and its resolved request ({ invoiceId?, abn?, subjectId? }). */
export function planFor(intent, resolved = {}) {
  if (intent === 'payment_status') return resolved.invoiceId ? PLANS.payment_status_invoice : PLANS.payment_status_blockers;
  return Object.hasOwn(PLANS, intent) ? PLANS[intent] : PLANS.unknown;
}

/**
 * Run `steps` with `exec` (execute.js) for `actor`. `state` starts with the
 * resolved ids; each step's result is stored under its name.
 * Returns { status: 'answered' | 'partial' | 'not_permitted', state, failures, notes, roles? }.
 */
export async function runPlan(exec, steps, actor, resolved = {}) {
  const state = { ...resolved };
  const failures = [];
  const notes = [];
  for (const s of steps) {
    const roles = TOOLS[s.tool].roles;
    if (!hasRole(actor, ...roles)) {
      if (s.required) return { status: 'not_permitted', state, failures, notes, roles: [...roles] };
      notes.push({ step: s.name, code: 'role', roles: [...roles] });
      continue;
    }
    const args = s.args(state);
    if (args === null || args === undefined) continue;
    if (s.many) {
      state[s.name] = [];
      for (const one of args) {
        const r = await exec.run(s.tool, one);
        if (r.ok) state[s.name].push(r.value);
        else failures.push({ step: s.name, tool: s.tool, code: r.code, required: s.required });
      }
      continue;
    }
    const r = await exec.run(s.tool, args);
    if (r.ok) {
      state[s.name] = r.value;
      continue;
    }
    failures.push({ step: s.name, tool: s.tool, code: r.code, required: s.required });
    if (s.required) break;
  }
  return { status: failures.some((f) => f.required) ? 'partial' : 'answered', state, failures, notes };
}
