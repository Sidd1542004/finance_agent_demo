// The keyword router (docs/phase2-design.md §3.2, step 1). It answers the
// common questions without a model call, and abstains whenever it is not
// sure: it is confident only when exactly one rule matches and every argument
// that rule needs was found in the question. Its rule set is measured against
// test/fixtures/orchestrator-questions.json: it must never be confidently
// wrong (precision 100% on what it claims).

import { INVISIBLE } from './views.js';
import { parseIntent } from './intents.js';

export const MAX_QUESTION = 500;

// Control characters, including line and paragraph separators (as views.js).
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** The question as plain text: invisible characters removed, one line, trimmed. */
export const cleanQuestion = (value) =>
  String(value ?? '')
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ----- references the person typed -----

const HYPHENATED = /\b[A-Za-z]{2,}[A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g; // SCP-7731, bg-2026-0914
const JOINED = /\b[A-Za-z]{2,}\d{2,}[A-Za-z0-9]*\b/g; // HOS10482
const AFTER_WORD = /\b(?:invoice|invioce|inv|bill)(?:\s+(?:number|no\.?|#))?\s*#?\s*([A-Za-z]{0,6}[ -]?\d[\w-]*)/gi; // invoice scp 7731
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The invoice numbers in the question, as typed (each at most once). */
export function referencesIn(q) {
  const found = [];
  const add = (s) => {
    const v = s.trim();
    if (/\d/.test(v) && !found.some((f) => squash(f) === squash(v))) found.push(v);
  };
  for (const m of q.match(HYPHENATED) || []) add(m);
  for (const m of q.match(JOINED) || []) add(m);
  for (const m of q.matchAll(AFTER_WORD)) add(m[1]);
  // "scp 7731" found after "invoice" and "scp-7731" elsewhere are one reference; a part of another is dropped.
  return found.filter((f) => !found.some((g) => g !== f && squash(g).includes(squash(f)) && squash(g) !== squash(f)));
}

// ----- when the router never answers -----

// A request to act (Phase 2 is read-only), or an attempt to give instructions.
const COMMAND =
  /^\s*(?:please\s+)?(?:approve|reject|pay|schedule|cancel|send|email|change|update|delete|remove|reveal|ignore|forget|disregard|override)\b|\bignore (?:all |any |your |the |previous )*(?:rules|instructions)\b/i;
// Negations and comparisons change the meaning in ways the rules do not model.
const NEGATION = /\b(?:not|never|except|excluding|without|compared|versus|vs|instead|unless|other than)\b|n't\b/i;
// "not (yet) paid" is a way of saying unpaid, not a negation of the question.
const NOT_PAID = /\b(?:not|never) (?:yet |been |yet been )?paid\b/gi;

const THIS = /\b(?:this|that|the same)\s+(?:invoice|bill|one|payment)\b/i;

// ----- the rules -----

const has = (re, s) => re.test(s);
const PENDING =
  /\b(?:waiting|pending|awaiting)\b|\bneeds?\b.*\b(?:approval|approving|review|reviewing|a person|attention)\b|\b(?:approval|review) queue\b|\bto (?:approve|review)\b|\bon hold\b/;
const UNPAID = /\b(?:unpaid|outstanding|owe|owed|owing|still to (?:be )?pa(?:y|id)|not (?:yet )?paid)\b/;
const SUPPLIERS = /\b(?:suppliers|vendors|supplier list)\b|\bwhich suppliers?\b|\beach supplier\b|\bby supplier\b/;
const INVOICES = /\b(?:invoices?|bills?|queue)\b/;

function rules(q, l) {
  const refs = referencesIn(q);
  if (refs.length > 1) return null; // several records: the model and the person sort it out
  const ref = refs[0];
  const target = ref ? 'ref' : THIS.test(l) ? 'this' : null;
  const hits = [];
  const add = (intent, args) => hits.push({ intent, args });

  if (has(/\b(?:ingestion|mailbox|inbox)\b|\bemail import/, l)) add('ingestion_status', {});
  if (
    has(/\breconcil/, l) ||
    (has(/\bbank (?:lines?|statements?|transactions?)\b/, l) && has(/\b(?:unmatched|exceptions?|open|outstanding|issues?|problems?|waiting|to check|need)\b/, l))
  )
    add('reconciliation_exceptions', {});

  if (target) {
    const about = ref ? { invoiceRef: ref } : { thisRecord: true };
    if (has(/\b(?:history|audit (?:trail|log)|what happened (?:to|with))\b/, l)) add('record_history', ref ? { recordRef: ref } : { thisRecord: true });
    else if (has(/\b(?:paid|payment|pay|cheque|transfer)\b/, l)) add('payment_status', about);
    else if (has(/\b(?:why|explain|status|on hold|held up|stuck|blocked)\b/, l)) add('explain_invoice_status', about);
    else if (ref && has(/\b(?:find|show|look ?up|open|pull up|get|see)\b/, l) && has(/\binvoice\b/, l)) add('find_invoice', { invoiceRef: ref });
  } else {
    if (has(/\bpayment run\b|\bpayments?\b.*\b(?:block|stuck|fail|held|hold|waiting)|\b(?:blocking|holding up|stopping)\b.*\bpayments?\b/, l)) add('payment_status', {});
    if (
      has(SUPPLIERS, l) &&
      has(/\b(?:unpaid|outstanding|owe|owed|owing|open|due|summary|summarise|summarize)\b/, l) &&
      !has(/\b(?:from|for|with|to)\s+[A-Z]/, q.replace(/^\S+/, ''))
    ) {
      add('supplier_summary', has(UNPAID, l) || has(/\bdue\b/, l) ? { unpaidOnly: true } : {});
    } else if (has(INVOICES, l) && has(UNPAID, l) && !has(PENDING, l)) {
      add('list_unpaid_invoices', {});
    } else if (has(INVOICES, l) && has(PENDING, l) && !has(UNPAID, l)) {
      const approval = has(/\bapprov/, l);
      const review = has(/\breview/, l);
      const hold = has(/\bon hold\b|\bheld\b/, l);
      const stage = approval && !review ? 'approval' : review && !approval ? 'review' : hold && !approval && !review ? 'on_hold' : 'any';
      add('list_pending_invoices', { stage });
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * { confident: true, intent, args } when the rules are sure, otherwise
 * { confident: false, why }. Never a model call; never an id.
 */
export function route(question) {
  const q = cleanQuestion(question);
  if (!q) return { confident: false, why: 'empty' };
  if (COMMAND.test(q)) return { confident: false, why: 'command' };
  const l = q.toLowerCase();
  if (NEGATION.test(l.replace(NOT_PAID, 'unpaid'))) return { confident: false, why: 'negation' };
  const hit = rules(q, l);
  const parsed = hit && parseIntent(hit.intent, hit.args);
  return parsed ? { confident: true, ...parsed } : { confident: false, why: 'no single rule' };
}
