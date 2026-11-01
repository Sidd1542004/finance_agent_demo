// The orchestrator's read-only tools (docs/agentic-analysis.md §9.1, Phase 1).
// Nothing here changes a record: every tool reads through the same listings
// and services as the dashboard, as the person the run acts for.
//
//   const ctx = createToolContext({ actor: actorOf(req), runId });   // context.js
//   const view = await callTool(ctx, 'get_invoice', { invoiceId });
//
// For every call, callTool:
//   1. accepts only a context made by createToolContext (401 otherwise);
//   2. checks the tool's role for ctx.actor (403), as the routes do; the
//      services check the actor again where they can;
//   3. removes any actor, decidedBy, actorId, userId or roles field from the
//      arguments, then validates them against the tool's schema (400); the
//      actor always comes from the context, never from the arguments;
//   4. runs the tool with ctx.actor and returns a compact view (views.js);
//   5. writes ONE audit entry (subject "orchestrator", the run id, action
//      "tool_called"): the tool, ok or the refusal's status, the time taken
//      and the ids returned. Never the arguments or the result;
//   6. records the ids it returned in the context (id provenance).
// If the audit entry cannot be written, the call fails and returns nothing.
//
// What the orchestrator must never reach is listed in neverExposed.js.

import { performance } from 'node:perf_hooks';
import { z } from 'zod';

import { ROLES, SimBankAccount } from '../models/index.js';
import { ACCOUNT_ID } from '../bank/simBank.js';
import {
  listInvoices,
  listPayments,
  getPayment,
  listQueries,
  listStatements,
  listReports,
  getReference,
  listAuditEntries,
  INVOICE_FILTERS,
  PAYMENT_STATUSES,
} from '../services/listings.js';
import { getInvoiceDetail, getPayables, paymentCalendar } from '../services/invoices.js';
import { getQueryDetail } from '../services/queries.js';
import { getStatementDetail } from '../services/statements.js';
import { getReportDetail } from '../services/reports.js';
import { listSuppliers } from '../services/beneficiaries.js';
import { ingestion } from '../services/ingestion.js';
import { requireActor } from '../services/actor.js';
import { HttpError, recordAudit } from '../services/runs.js';
import { isToolContext } from './context.js';
import {
  invoiceList,
  invoiceDetail,
  payables,
  reference,
  history,
  paymentList,
  paymentDetail,
  slot,
  queryList,
  queryDetail,
  statementList,
  statementDetail,
  reportList,
  reportDetail,
  supplierList,
  simBankAccount,
  ingestionStatus,
} from './views.js';

// Fields that name a person. The model never chooses who acts.
export const ACTOR_FIELDS = Object.freeze(['actor', 'decidedBy', 'actorId', 'userId', 'roles']);

const ANY_ROLE = Object.freeze([...ROLES]);
const BANK_READERS = Object.freeze(['payer', 'approver', 'admin']); // as GET /api/sim-bank/account
const ADMIN = Object.freeze(['admin']);

// ----- argument schemas -----

const recordId = z.string().regex(/^[a-f0-9]{24}$/i, 'a record id from an earlier tool result');
const cursor = z.string().max(40); // nextCursor from an earlier page
const pageLimit = (max) => z.number().int().min(1).max(max);
const noArguments = z.strictObject({});

function tool(name, { description, roles = ANY_ROLE, input = noArguments, run }) {
  return Object.freeze({ name, description, roles, input, run });
}

const LIST = [
  tool('list_invoices', {
    description: 'Invoices, newest first. filter: waiting (needs a person), pay (approved, to pay) or all. With the tab counts.',
    input: z.strictObject({ filter: z.enum([...Object.keys(INVOICE_FILTERS), 'all']).optional(), before: cursor.optional(), limit: pageLimit(50).optional() }),
    run: async (actor, a) => invoiceList(await listInvoices(actor, { filter: a.filter, before: a.before, limit: a.limit ?? 20 })),
  }),
  tool('get_invoice', {
    description: 'One invoice: fields read from it, the checks, the score, the PO, duplicates, its payment, and the actions with whether this person may take them.',
    input: z.strictObject({ invoiceId: recordId }),
    run: async (actor, a) => invoiceDetail(await getInvoiceDetail(a.invoiceId, actor), actor),
  }),
  tool('get_payables', {
    description: 'Overdue and due-soon invoices, and the cash needed.',
    run: async () => payables(await getPayables()),
  }),
  tool('get_reference', {
    description: 'Suppliers, purchase orders and goods received, for one supplier (abn) or one purchase order (poNumber), or all.',
    input: z.strictObject({
      abn: z
        .string()
        .regex(/^\d{11}$/)
        .optional(),
      poNumber: z.string().min(1).max(40).optional(),
    }),
    run: async (actor, a) => reference(await getReference(actor), a),
  }),
  tool('get_history', {
    description: "One record's audit history, oldest first. subjectId: a record id, a supplier ABN, or a bank line id (<statement id>:<line number>).",
    input: z.strictObject({ subjectId: z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/), limit: pageLimit(100).optional() }),
    run: async (actor, a) => history(await listAuditEntries(actor, { subjectId: a.subjectId, limit: a.limit ?? 50 }), actor),
  }),
  tool('list_payments', {
    description: 'Payments (simulated bank), latest first, optionally by status, with counts per status.',
    input: z.strictObject({ status: z.array(z.enum(PAYMENT_STATUSES)).min(1).max(PAYMENT_STATUSES.length).optional() }),
    run: async (actor, a) => paymentList(await listPayments(actor, { status: a.status?.join(',') }), actor),
  }),
  tool('get_payment', {
    description: 'One payment: status, route, schedule, bank reference, failure, its jobs and its notices (status only).',
    input: z.strictObject({ paymentId: recordId }),
    run: async (actor, a) => paymentDetail(await getPayment(actor, a.paymentId), actor),
  }),
  tool('check_payment_slot', {
    description: 'Whether a payment could be scheduled for this date (and time, HH:MM), or the next slot that would work.',
    input: z.strictObject({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
    }),
    run: async (actor, a) => slot(paymentCalendar.validateSlot({ date: a.date, time: a.time })),
  }),
  tool('list_queries', {
    description: 'Supplier emails, newest first: status, supplier, subject and outcome.',
    input: z.strictObject({ before: cursor.optional(), limit: pageLimit(50).optional() }),
    run: async (actor, a) => queryList(await listQueries(actor, { before: a.before, limit: a.limit ?? 20 })),
  }),
  tool('get_query', {
    description: 'One supplier email: what it asks, the invoices it names, the checks and the outcome. Never the email text.',
    input: z.strictObject({ queryId: recordId }),
    run: async (actor, a) => queryDetail(await getQueryDetail(a.queryId)),
  }),
  tool('list_statements', {
    description: 'Bank statements, newest first, with how many lines are still open.',
    input: z.strictObject({ before: cursor.optional(), limit: pageLimit(50).optional() }),
    run: async (actor, a) => statementList(await listStatements(actor, { before: a.before, limit: a.limit ?? 20 })),
  }),
  tool('get_statement', {
    description: 'One bank statement: each line with its date, amount, status, the payment it matched or might match, and why.',
    input: z.strictObject({ statementId: recordId }),
    run: async (actor, a) => statementDetail(await getStatementDetail(a.statementId)),
  }),
  tool('list_reports', {
    description: 'Month-end reports, newest first.',
    input: z.strictObject({ before: cursor.optional(), limit: pageLimit(50).optional() }),
    run: async (actor, a) => reportList(await listReports(actor, { before: a.before, limit: a.limit ?? 20 })),
  }),
  tool('get_report', {
    description: 'One month-end report: the figures, what is still open, and the commentary.',
    input: z.strictObject({ reportId: recordId }),
    run: async (actor, a) => reportDetail(await getReportDetail(a.reportId)),
  }),
  tool('list_suppliers', {
    description: 'Suppliers: ABN, name, whether their bank details are verified. Bank details masked for payers, approvers and administrators; none for reviewers.',
    run: async (actor) => supplierList(await listSuppliers(actor), actor),
  }),
  tool('sim_bank_account', {
    description: 'The simulated operating account: balance, reserved and available.',
    roles: BANK_READERS,
    // The record itself: simBank.accountView() opens the account when it is missing, which is a write.
    run: async () => simBankAccount(await SimBankAccount.findById(ACCOUNT_ID).lean()),
  }),
  tool('ingestion_status', {
    description: 'Mailbox ingestion: each provider, whether it is connected and polling, when it last checked, and item counts.',
    roles: ADMIN,
    run: async () => ingestionStatus(await ingestion().status()),
  }),
];

export const TOOLS = Object.freeze(Object.fromEntries(LIST.map((t) => [t.name, t])));
export const TOOL_NAMES = Object.freeze(LIST.map((t) => t.name));

// ----- the call -----

/** The arguments without any field naming a person, at any depth. */
export function withoutActorFields(value, depth = 0) {
  if (depth > 5) return value;
  if (Array.isArray(value)) return value.map((v) => withoutActorFields(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !ACTOR_FIELDS.includes(k))
        .map(([k, v]) => [k, withoutActorFields(v, depth + 1)]),
    );
  }
  return value;
}

function parseArguments(t, args) {
  const raw = args === undefined || args === null ? {} : args;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, `The arguments for ${t.name} must be an object.`);
  const parsed = t.input.safeParse(withoutActorFields(raw));
  if (parsed.success) return parsed.data;
  // Where and what kind of problem, never the values given.
  const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(arguments)'}: ${i.code}`).slice(0, 5);
  throw new HttpError(400, `The arguments for ${t.name} do not fit its schema (${problems.join('; ')}).`);
}

// Every record id in a result: the values of fields named id or ...Id.
function idsIn(value, out = new Set(), depth = 0) {
  if (depth > 8 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) idsIn(v, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if ((k === 'id' || /^[a-z]+Id$/.test(k)) && typeof v === 'string' && v) out.add(v);
    else idsIn(v, out, depth + 1);
  }
  return out;
}

const AUDIT_IDS = 40; // keeps the entry well inside the audit log's 2000-character detail

async function auditCall(ctx, name, failure, ids, ms) {
  const detail = { tool: name, ok: !failure, ...(failure ? { status: failure.status } : {}), ms, idCount: ids.length, ids: ids.slice(0, AUDIT_IDS) };
  await recordAudit({
    subjectKind: 'orchestrator',
    subjectId: ctx.runId,
    actor: ctx.actor.name,
    actorId: ctx.actor.system ? null : ctx.actor.id,
    action: 'tool_called',
    detail: JSON.stringify(detail),
  });
}

/** Run one read-only tool for the context's actor. Throws HttpError (400, 401, 403, 404, 500). */
export async function callTool(ctx, name, args) {
  if (!isToolContext(ctx)) throw new HttpError(401, 'Sign in to continue.');
  const t = typeof name === 'string' && Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  const started = performance.now();
  let result;
  let failure = null;
  try {
    if (!t) throw new HttpError(404, 'There is no such tool.');
    requireActor(ctx.actor, ...t.roles);
    result = await t.run(ctx.actor, parseArguments(t, args));
  } catch (err) {
    failure = err instanceof HttpError ? err : new HttpError(500, 'The tool could not finish.');
    if (!(err instanceof HttpError)) failure.cause = err;
  }
  const ids = failure ? [] : [...idsIn(result)];
  // A name the model made up is recorded as "unknown", not as given.
  await auditCall(ctx, t ? t.name : 'unknown', failure, ids, Math.round(performance.now() - started));
  if (failure) throw failure;
  ctx.remember(ids);
  return result;
}
