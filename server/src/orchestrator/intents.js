// The questions the assistant answers (docs/phase2-design.md §3.2): a closed
// list of intents, each with a strict argument schema. Every string argument
// is a copy of words the person typed (a number, a supplier's name); code
// resolves it to records with a lookup tool. Nothing here is ever an id.

import { z } from 'zod';

export const INTENTS = Object.freeze([
  'list_pending_invoices',
  'find_invoice',
  'explain_invoice_status',
  'supplier_summary',
  'list_unpaid_invoices',
  'payment_status',
  'reconciliation_exceptions',
  'ingestion_status',
  'record_history',
  'unknown',
]);

// The intents whose answer gets an explanation from the model (decision 3).
// The others are answered from the records with a template.
export const EXPLAINED = Object.freeze(['explain_invoice_status', 'supplier_summary', 'payment_status']);

export const STAGES = Object.freeze(['approval', 'review', 'on_hold', 'any']);

const typed = z.string().trim().min(1).max(80);
const thisRecord = z.literal(true).optional(); // "this invoice", "it": the record from the thread

export const INTENT_ARGS = Object.freeze({
  list_pending_invoices: z.strictObject({ stage: z.enum(STAGES).optional() }),
  find_invoice: z.strictObject({ invoiceRef: typed }),
  explain_invoice_status: z.strictObject({ invoiceRef: typed.optional(), thisRecord }),
  supplier_summary: z.strictObject({ supplierRef: typed.optional(), unpaidOnly: z.boolean().optional() }),
  list_unpaid_invoices: z.strictObject({}),
  payment_status: z.strictObject({ invoiceRef: typed.optional(), thisRecord }),
  reconciliation_exceptions: z.strictObject({}),
  ingestion_status: z.strictObject({}),
  record_history: z.strictObject({ recordRef: typed.optional(), thisRecord }),
  unknown: z.strictObject({}),
});

// Arguments that must be words from the question.
export const TYPED_ARGS = Object.freeze(['invoiceRef', 'supplierRef', 'recordRef']);

/** { intent, args } if it fits the closed list and its schema, otherwise null. */
export function parseIntent(intent, args) {
  if (typeof intent !== 'string' || !Object.hasOwn(INTENT_ARGS, intent)) return null;
  const parsed = INTENT_ARGS[intent].safeParse(args ?? {});
  return parsed.success ? { intent, args: parsed.data } : null;
}

// Letters and digits only, lower case: "SCP-7731" and "scp 7731" compare equal.
const squash = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Does `value` appear in `question` (case, spaces and punctuation ignored)? */
export const appearsIn = (value, question) => {
  const v = squash(value);
  return v.length > 0 && squash(question).includes(v);
};

/**
 * Drop every typed argument that is not in the question (a model that "fixes"
 * SCP-7713 into SCP-7731 is caught here). Returns the kept arguments and the
 * names of the dropped ones.
 */
export function keepTypedArgs(args, question) {
  const kept = { ...args };
  const dropped = [];
  for (const k of TYPED_ARGS) {
    if (kept[k] !== undefined && !appearsIn(kept[k], question)) {
      delete kept[k];
      dropped.push(k);
    }
  }
  return { args: kept, dropped };
}

/**
 * The questions offered when a question cannot be classified (the model
 * failed, or it is unknown): each a complete request that needs no record, so
 * choosing one runs it with no model call.
 */
export const MENU = Object.freeze([
  { intent: 'list_pending_invoices', args: { stage: 'any' }, label: 'Invoices waiting for a person' },
  { intent: 'list_unpaid_invoices', args: {}, label: 'Unpaid invoices' },
  { intent: 'supplier_summary', args: { unpaidOnly: true }, label: 'Suppliers with unpaid invoices' },
  { intent: 'payment_status', args: {}, label: 'What is blocking payments' },
  { intent: 'reconciliation_exceptions', args: {}, label: 'Bank lines that need a decision' },
  { intent: 'ingestion_status', args: {}, label: 'Mailbox ingestion status' },
]);

/** The argument naming the record an intent is about, if it needs one. */
export const REF_ARG = Object.freeze({ find_invoice: 'invoiceRef', explain_invoice_status: 'invoiceRef', payment_status: 'invoiceRef', record_history: 'recordRef' });
