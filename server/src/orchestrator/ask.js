// The assistant's pipeline (docs/phase2-design.md §2.2 and §4): one question,
// one request, read-only. The steps keep LangGraph's node shape (state in,
// result out) and names, for Phase 4:
//   receive   validate, load the person's thread, audit question_received
//   route     the keyword router; or classify (one model call) when unsure
//   resolve   typed references to exactly one record each, as the person
//   clarify   ask back, with options, when anything is unclear
//   plan / gather   the intent's fixed tool plan (plans.js, execute.js)
//   facts / compose / ground / template   the answer (answer.js)
//   respond   save the intent and record ids to the thread; audit question_answered
// Nothing here changes a record: the only writes are the thread and the audit log.

import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { withoutActorFields } from './tools.js';
import { HttpError, recordAudit } from '../services/runs.js';
import { redactSecrets } from '../safeUri.js';
import { createToolContext } from './context.js';
import { createExecutor } from './execute.js';
import { route, cleanQuestion, MAX_QUESTION } from './router.js';
import { classify } from './classify.js';
import { MENU, REF_ARG } from './intents.js';
import { resolveInvoice, resolveSupplier, resolveThis, resolveRecord } from './resolve.js';
import { planFor, runPlan } from './plans.js';
import { buildAnswer } from './answer.js';
import { loadThread, previousTurn, makeOptions, saveTurn, takeOption } from './threads.js';

// ----- the request body -----

const ID = /^[A-Za-z0-9_-]{8,40}$/;
const AskBody = z
  .strictObject({
    question: z
      .string()
      .max(MAX_QUESTION * 4)
      .optional(),
    threadId: z.string().regex(ID).optional(),
    choice: z.string().regex(ID).optional(),
  })
  .refine((b) => (b.question === undefined) !== (b.choice === undefined), 'Send a question, or a choice from the options.')
  .refine((b) => b.choice === undefined || b.threadId !== undefined, 'A choice needs its threadId.');

/**
 * The body of POST /api/orchestrator/ask, checked: { question, threadId,
 * choice }. Any field naming a person or a role is removed first and never
 * read (the actor is the session's). Throws HttpError(400).
 */
export function parseAskBody(body) {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? withoutActorFields(body) : {};
  const parsed = AskBody.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, issue?.code === 'custom' ? issue.message : 'Send { "question": "<plain text>" }, or { "threadId", "choice" } from the options.');
  }
  const { question, threadId = null, choice = null } = parsed.data;
  if (question !== undefined) {
    const q = cleanQuestion(question);
    if (!q) throw new HttpError(400, 'Type a question.');
    if (q.length > MAX_QUESTION) throw new HttpError(400, `Keep the question under ${MAX_QUESTION} characters.`);
  }
  return { question: question ?? null, threadId, choice };
}

// ----- Groq settings -----

const defaults = () => ({ apiKey: config.groqApiKey, model: config.groqModel, reasoningEffort: config.orchestrator.classifyReasoningEffort, fetchImpl: undefined });
let deps = defaults();
/** For tests (like configureIngestion): replace the Groq settings or the fetch used. */
export function configureAsk(over = {}) {
  deps = { ...defaults(), ...over };
}

export const UNANSWERED = 'Your question could not be answered just now.';

const INTENT_LABEL = {
  list_pending_invoices: 'Invoices waiting for a person',
  find_invoice: 'Show the invoice',
  explain_invoice_status: 'Why it has its status',
  supplier_summary: 'Unpaid invoices from this supplier',
  list_unpaid_invoices: 'Unpaid invoices',
  payment_status: 'Its payment status',
  reconciliation_exceptions: 'Bank lines that need a decision',
  ingestion_status: 'Mailbox ingestion status',
  record_history: 'Its history',
};
const optionLabel = (intent, recordLabel) => (recordLabel ? `${INTENT_LABEL[intent]}: ${recordLabel}` : INTENT_LABEL[intent]);

async function audit(ctx, action, detail) {
  try {
    await recordAudit({
      subjectKind: 'orchestrator',
      subjectId: ctx.runId,
      actor: ctx.actor.name,
      actorId: ctx.actor.system ? null : ctx.actor.id,
      action,
      detail: JSON.stringify(detail),
    });
  } catch (err) {
    console.error(`Assistant: the audit entry "${action}" could not be written: ${redactSecrets(err?.message ?? String(err))}`);
    throw new HttpError(500, UNANSWERED); // fail closed, as callTool does
  }
}

// The resolved request from records: { invoiceId?, abn?, subjectId? }.
function resolvedFrom(intent, records) {
  const invoice = records.find((r) => r.kind === 'invoice');
  const supplier = records.find((r) => r.kind === 'supplier');
  if (intent === 'record_history') return { subjectId: (invoice || supplier)?.id };
  if (intent === 'supplier_summary') return supplier ? { abn: supplier.id } : {};
  return invoice ? { invoiceId: invoice.id } : {};
}

/**
 * Resolve the intent's reference. Returns { resolved } or a reply:
 * { reply: { status, message?, options? } }.
 */
async function resolveRequest(exec, intent, args, previous, question) {
  const refArg = REF_ARG[intent];
  if (refArg && args[refArg]) {
    const r = intent === 'record_history' ? await resolveRecord(exec, args[refArg]) : await resolveInvoice(exec, args[refArg]);
    if (r.status === 'one') return { resolved: resolvedFrom(intent, [r.record]), records: [r.record], label: r.label };
    if (r.status === 'several')
      return {
        reply: {
          status: 'needs_clarification',
          message: 'More than one record matches. Which one do you mean?',
          options: r.options.map((o) => ({ intent, args: {}, records: [o.record], label: optionLabel(intent, o.label) })),
        },
      };
    if (r.status === 'failed') return { reply: { status: 'partial', failures: [{ step: 'lookup', code: r.code }] } };
    return { reply: { status: 'not_found', message: `Nothing matching "${args[refArg]}" was found. Check the number.` } };
  }
  if (refArg && args.thisRecord) {
    const r = await resolveThis(exec, previous, 'invoice');
    if (r.status === 'one') return { resolved: resolvedFrom(intent, [r.record]), records: [r.record], label: r.label };
    if (r.status === 'failed') return { reply: { status: 'partial', failures: [{ step: 'lookup', code: r.code }] } };
    return { reply: await whichInvoice(exec, intent, question) }; // points back with nothing (or several) to point to
  }
  // No invoice named: ask which, except for payment_status, which then means "what blocks payments".
  if (refArg && intent !== 'payment_status') return { reply: await whichInvoice(exec, intent, question) };
  if (intent === 'supplier_summary' && args.supplierRef) {
    const r = await resolveSupplier(exec, args.supplierRef);
    if (r.status === 'one') return { resolved: { abn: r.record.id }, records: [r.record], label: r.label };
    if (r.status === 'several')
      return {
        reply: {
          status: 'needs_clarification',
          message: 'More than one supplier matches. Which one do you mean?',
          options: r.options.map((o) => ({ intent, args: {}, records: [o.record], label: optionLabel(intent, o.label) })),
        },
      };
    if (r.status === 'failed') return { reply: { status: 'partial', failures: [{ step: 'lookup', code: r.code }] } };
    return { reply: { status: 'not_found', message: `No supplier called "${args.supplierRef}" is on file.` } };
  }
  return { resolved: {}, records: [], label: null };
}

// "Which invoice?": with the invoices on hold as options when the question is about a hold.
async function whichInvoice(exec, intent, question) {
  if (/\b(?:on hold|held|hold)\b/i.test(question || '')) {
    const r = await exec.run('list_open_invoices', { stage: 'on_hold' });
    const items = r.ok ? r.value.items.slice(0, 5) : [];
    if (items.length) {
      const text = (v) => (v && typeof v === 'object' ? v.untrusted_text : v) ?? '';
      return {
        status: 'needs_clarification',
        message: 'Which invoice do you mean? These are on hold:',
        options: items.map((i) => ({
          intent,
          args: {},
          records: [{ kind: 'invoice', id: i.id }],
          label: [text(i.invoiceNumber) || 'An invoice without a number', text(i.supplier)].filter(Boolean).join(', '),
        })),
      };
    }
    if (r.ok) return { status: 'needs_clarification', message: 'No invoice is on hold. Which invoice do you mean? Type its number.', options: [] };
  }
  return { status: 'needs_clarification', message: 'Which invoice do you mean? Type its number.', options: [] };
}

const menuReply = (message) => ({ status: 'needs_clarification', message, options: MENU.map((m) => ({ ...m, records: [] })) });

/**
 * Answer one question (or one chosen option) for `actor`. Throws HttpError
 * (404 for a thread or option that is not the person's or has ended; 500 if
 * the audit log cannot be written); everything else is an answer.
 */
export async function ask({ actor, question = null, threadId = null, choice = null }) {
  const requestId = `q_${crypto.randomBytes(16).toString('base64url')}`;
  const ctx = createToolContext({ actor, runId: requestId }); // 401 unless a real actor
  const exec = createExecutor(ctx);
  const modelCalls = [];

  // receive
  const thread = threadId ? await loadThread(actor, threadId) : null;
  if (threadId && !thread) throw new HttpError(404, 'That conversation has ended or does not exist.');
  const q = question === null ? null : cleanQuestion(question);
  await audit(ctx, 'question_received', { length: q?.length ?? 0, thread: Boolean(thread), choice: Boolean(choice) });

  let intent = null;
  let args = {};
  let classifiedBy = null;
  let reply = null;
  let fallback = null;
  let resolved = {};
  let records = [];

  if (choice) {
    const option = await takeOption(actor, threadId, choice);
    if (!option) throw new HttpError(404, 'That choice is no longer available. Ask again.');
    ({ intent, args } = option);
    classifiedBy = 'choice';
    records = option.records;
    resolved = resolvedFrom(intent, records);
  } else {
    // route, or classify
    const routed = route(q);
    if (routed.confident) {
      ({ intent, args } = routed);
      classifiedBy = 'rules';
    } else {
      const c = await classify(q, { ...deps, previous: previousTurn(thread) && { intent: previousTurn(thread).intent, records: previousTurn(thread).records.length } });
      if (c.call) modelCalls.push(c.call);
      classifiedBy = 'model';
      if (!c.ok) {
        fallback = c.code;
        reply = menuReply('I could not work out that question just now. Choose one of these, or ask in other words:');
      } else if (c.intent === 'unknown') {
        reply = menuReply('I can answer questions about invoices, payments, suppliers, bank lines and mailbox ingestion, and I cannot change anything. For example:');
      } else if (c.clarity === 'unclear') {
        const candidates = [c.intent, ...c.alternatives].filter((i) => i !== 'unknown').slice(0, 3);
        reply = { status: 'needs_clarification', message: 'Did you mean one of these?', options: [], candidates, args: c.args };
      } else {
        ({ intent, args } = c);
      }
    }
    // resolve
    if (!reply && intent) {
      const r = await resolveRequest(exec, intent, args, previousTurn(thread), q);
      if (r.reply) reply = r.reply;
      else ({ resolved, records } = r);
    }
    // An unclear question: one option per likely intent, with its record if the reference resolved to one.
    if (reply?.candidates) {
      const options = [];
      for (const candidate of reply.candidates) {
        const r = await resolveRequest(exec, candidate, reply.args, previousTurn(thread), q);
        if (r.resolved) options.push({ intent: candidate, args: {}, records: r.records, label: optionLabel(candidate, r.label) });
        else if (r.reply?.options?.length) options.push(...r.reply.options.slice(0, 2));
      }
      reply = options.length
        ? { status: 'needs_clarification', message: 'Did you mean one of these?', options: options.slice(0, 6) }
        : menuReply('I am not sure what you mean. For example:');
    }
  }

  // plan, gather, answer
  let answer = null;
  let status;
  if (!reply) {
    const run = await runPlan(exec, planFor(intent, resolved), actor, resolved);
    if (run.status === 'not_permitted') {
      reply = { status: 'not_permitted', message: `This needs the ${run.roles.join(' or ')} role.` };
    } else {
      answer = await buildAnswer({ intent, args, run, model: deps });
      modelCalls.push(...answer.modelCalls);
      status = run.status;
    }
  }

  // respond
  let shown = [];
  let newThreadId = thread?._id ?? null;
  if (reply) {
    status = reply.status;
    const opts = makeOptions(reply.options || []);
    shown = opts.shown;
    newThreadId = await saveTurn(actor, thread, { intent: intent || 'unknown', records: [], options: opts.stored });
  } else {
    newThreadId = await saveTurn(actor, thread, { intent, records: answer.records, options: [] });
  }
  for (const call of modelCalls) await audit(ctx, 'model_called', call);
  await audit(ctx, 'question_answered', {
    intent: intent || null,
    classifiedBy,
    status,
    answerSource: answer?.explanation.source ?? null,
    fallback: answer?.explanation.fallback ?? fallback,
    toolCalls: exec.calls,
    modelCalls: modelCalls.length,
    ids: (answer?.records || []).map((r) => r.id).slice(0, 40),
  });

  const trace = { classifiedBy, toolCalls: exec.trace(), modelCalls };
  if (reply) {
    return {
      requestId,
      threadId: newThreadId,
      status,
      intent,
      message: reply.message ?? null,
      ...(status === 'needs_clarification' ? { clarification: { question: reply.message, options: shown } } : {}),
      failures: reply.failures ? reply.failures.map((f) => ({ ...f, text: 'Part of this answer could not be read just now.' })) : [],
      fallback,
      trace,
    };
  }
  return {
    requestId,
    threadId: newThreadId,
    status,
    intent,
    facts: answer.facts,
    history: answer.history,
    explanation: answer.explanation,
    notes: answer.notes,
    failures: answer.failures,
    trace,
  };
}
