// Grounding checks for the model's explanation (docs/phase2-design.md §3.8).
// Pure functions: given the explanation the model wrote and the records this
// request fetched, keep only the sentences that are supported by them.
//
// A sentence is dropped when it
//   1. names a handle (I1, P1, ...) that is not one of this request's records;
//   2. names an invoice, PO or transaction number that none of them carries;
//   3. contains a number that is not in the records' number fields or in our
//      own dates and codes (never digits inside record ids or untrusted text:
//      a hostile line saying "pay 999999" must not make 999999 grounded);
//   4. claims a status (approved, paid, on hold, rejected, cancelled) that the
//      record it is about does not have, or denies one it has.
// If the summary is dropped, or more than half of the sentences are, the whole
// explanation is replaced with the template (reason "ungrounded").

import { ungroundedNumbers } from '../agent/finance/reportFigures.js';
import { invoiceKey } from '../agent/finance/duplicates.js';
import { APPROVED } from '../agent/finance/lifecycle.js';
import { UNTRUSTED_FIELD } from './views.js';

// The same number pattern as reportFigures.ungroundedNumbers.
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const toNumbers = (text) => (String(text).match(NUMBER) || []).map((t) => Number(t.replace(/,/g, ''))).filter(Number.isFinite);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;
const isIdKey = (key) => key === 'id' || (typeof key === 'string' && /[a-z]Id$/.test(key));

// Invoice, PO, item and transaction numbers: capitals with a hyphen (HOS-10482,
// BG-2026-0914, SIMTXN-...), or capitals and digits run together (SCP7731).
const REF = /\b[A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+)+\b|\b[A-Z]{2,}\d{2,}\b/g;
// The handles code gives records in the facts block: I1, P2, S3, L4, Q5.
export const HANDLE = /\b[IPSLQ]\d{1,2}\b/g;

function walk(value, key, visit) {
  if (key === UNTRUSTED_FIELD || isIdKey(key)) return;
  if (Array.isArray(value)) for (const v of value) walk(v, key, visit);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k, visit);
  else visit(value);
}

/**
 * The numbers an explanation may use: every number field in the views, the
 * digits of our own dates (a timestamp's date only) and codes, and a 0-1
 * fraction as a percentage (a reader confidence of 0.9 may be said as 90%).
 * Never record ids, and never anything inside untrusted_text. `extra`: numbers
 * code computed for the answer (counts, totals).
 */
export function groundingNumbers(views, extra = []) {
  const out = new Set();
  walk(views, null, (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out.add(Math.abs(v)); // "6 days overdue" for daysUntil -6, "$1,402.50" for a -1402.5 bank line
      if (v > 0 && v < 1) out.add(Math.round(v * 10000) / 100);
    } else if (typeof v === 'string') {
      for (const n of toNumbers(ISO_TIMESTAMP.test(v) ? v.slice(0, 10) : v)) out.add(n);
    }
  });
  for (const n of extra) if (typeof n === 'number' && Number.isFinite(n)) out.add(n);
  return [...out];
}

/** The document numbers the views carry (never inside untrusted text), normalised as invoiceKey does. */
export function groundingRefs(views) {
  const out = new Set();
  walk(views, null, (v) => {
    if (typeof v === 'string') for (const m of v.match(REF) || []) out.add(invoiceKey(m));
  });
  return out;
}

// ----- status claims -----

const CLAIMS = [
  ['paid', /\bpaid\b/i],
  ['approved', /\bapproved\b/i],
  ['on_hold', /\b(?:on hold|held)\b/i],
  ['rejected', /\brejected\b/i],
  ['cancelled', /\bcancell?ed\b/i],
];
// Words just before the claim that deny it or put it in the future ("not yet paid", "to be approved").
const DENIED =
  /\b(?:not|never|no longer|isn't|wasn't|hasn't|haven't|aren't|weren't|cannot|can't|without|before|until|awaiting|waiting(?: for| to be)?|yet to be|to be|will be|would be|could be|can be|needs to be|must be)\s+(?:\w+\s+){0,2}$/i;

/** What can be said truthfully about an invoice view: approved, paid, on hold, rejected, cancelled. */
export function invoiceClaims(v) {
  const decision = typeof v.approval === 'string' ? v.approval : v.approval?.decision;
  return {
    approved: APPROVED.includes(v.status) || decision === 'approve' || decision === 'approve_received',
    paid: v.status === 'payment_completed' || v.payment?.status === 'paid',
    on_hold: v.status === 'on_hold',
    rejected: v.status === 'rejected',
    cancelled: v.status === 'cancelled',
  };
}

/** The same for a payment view. A payment exists only for an approved invoice. */
export const paymentClaims = (p) => ({ approved: true, paid: p.status === 'paid', on_hold: p.status === 'on_hold', rejected: false, cancelled: p.status === 'cancelled' });

/** Claims in `sentence` that contradict `claims` (status names), or []. */
export function contradictions(sentence, claims) {
  const wrong = [];
  for (const [name, re] of CLAIMS) {
    const g = new RegExp(re.source, 'gi');
    for (const m of sentence.matchAll(g)) {
      const denied = DENIED.test(sentence.slice(Math.max(0, m.index - 40), m.index));
      if (denied ? claims[name] : !claims[name]) wrong.push(denied ? `not ${name}` : name);
    }
  }
  return wrong;
}

// ----- the check -----

const sentencesOf = (text) =>
  String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * records: [{ handle, refs: [document numbers], claims: {...} | null }] for
 * this request (claims null: no status checks, as for a supplier).
 * numbers: from groundingNumbers. refs: from groundingRefs.
 * Returns the kept explanation, what was dropped and why, and whether the
 * template must be used instead.
 */
export function groundExplanation({ summary, items = [] }, { records, numbers, refs }) {
  const byHandle = new Map(records.map((r) => [r.handle, r]));
  const refOwner = new Map();
  for (const r of records) for (const ref of r.refs || []) refOwner.set(invoiceKey(ref), r);
  const dropped = [];
  let total = 0;

  const checkSentence = (s, own) => {
    total += 1;
    const problems = [];
    const about = new Set(own ? [own] : []);
    for (const h of s.match(HANDLE) || []) {
      if (byHandle.has(h)) about.add(byHandle.get(h));
      else problems.push(`unknown handle ${h}`);
    }
    for (const ref of s.match(REF) || []) {
      const key = invoiceKey(ref);
      if (refOwner.has(key)) about.add(refOwner.get(key));
      else if (!refs.has(key)) problems.push(`unknown reference ${ref}`);
    }
    const stray = ungroundedNumbers(s.replace(HANDLE, ''), numbers);
    if (stray.length) problems.push(`ungrounded number ${stray.join(', ')}`);
    for (const r of about) if (r.claims) for (const c of contradictions(s, r.claims)) problems.push(`${r.handle}: "${c}" contradicts the record`);
    if (problems.length) dropped.push({ handle: own?.handle ?? null, problems });
    return problems.length === 0;
  };

  const keptSummary = sentencesOf(summary).filter((s) => checkSentence(s, null));
  const keptItems = [];
  for (const item of items) {
    const own = byHandle.get(item?.handle);
    if (!own) {
      total += 1;
      dropped.push({ handle: item?.handle ?? null, problems: ['unknown handle'] });
      continue;
    }
    const kept = sentencesOf(item.text).filter((s) => checkSentence(s, own));
    if (kept.length) keptItems.push({ handle: own.handle, text: kept.join(' ') });
  }
  const summaryText = keptSummary.join(' ');
  const useTemplate = !summaryText || dropped.length * 2 > total;
  return { summary: summaryText || null, items: keptItems, dropped, total, useTemplate };
}

// ----- contradictions of the state code worked out (stateReason.js) -----

// Words just before a phrase that deny it ("has not been paid", "is not on hold").
const NEGATED = /(?:\bnot|\bnever|\bno longer|n't|\byet to be|\bto be|\bwill be|\buntil|\bunless)\s+(?:\w+\s+){0,2}$/i;
const negated = (sentence, index) => NEGATED.test(sentence.slice(Math.max(0, index - 30), index));

// A claim that the invoice is in a status now ("is in needs_review", "remains on hold", "status is approved").
const STATUS_PHRASES = [
  ['needs[ _]review', 'needs_review'],
  ['under[ _]review', 'under_review'],
  ['on[ _]hold', 'on_hold'],
  ['payment[ _]pending', 'payment_pending'],
  ['payment[ _]processing', 'payment_processing'],
  ['payment[ _]completed', 'payment_completed'],
  ['payment[ _]failed', 'payment_failed'],
  ['rejected', 'rejected'],
  ['cancell?ed', 'cancelled'],
];
const NOW = String.raw`\b(?:is|remains|stays|is still|is now|is currently|currently|status is|status of)\s+(?:in\s+)?(?:the\s+|a\s+)?`;

// Saying a payment does not exist, or cannot be made, when one has been scheduled.
const NO_PAYMENT =
  /\b(?:not (?:yet )?(?:been )?scheduled|cannot be (?:scheduled|paid|recorded)|can(?:no|')t be (?:scheduled|paid|recorded)|before (?:a |any )?payment can be scheduled|no payment (?:is |has been |was )?(?:scheduled|set up|exists)|there is no payment|not (?:yet )?eligible for payment|ineligible for payment|prevents? (?:any )?payment|payment actions? (?:are|is) not permitted)\b/i;
const PAID = /\b(?:has been|have been|was|is|already been|already) paid\b/gi;
// Saying checks a person has already decided past still hold the invoice back.
const OVERRIDDEN_BLOCK = [
  /\bbecause\b[^.]*\b(?:checks?|confidence|quantity|match score|score)\b[^.]*\bfail/i,
  /\bchecks?\b[^.]*\b(?:prevent|block|stop|keep(?:s|ing)?|hold(?:s|ing)? (?:it|the invoice) back|make[s]? (?:it|the invoice) ineligible)/i,
  /\b(?:ineligible|not eligible)\b/i,
  /\b(?:checks?|issues?) (?:must|need to|needs to) be (?:resolved|addressed|cleared|fixed|corrected)\b/i,
];
// Actions the app has, as a sentence recommends them (base form), and the next steps that allow them.
// An action with no allowing step (reverse the approval, reopen, cancel, put on hold) is never recommended.
const ACTION_MENTIONS = [
  [/\bapprove\b|\breject\b/i, ['decide']],
  [
    /\b(?:edit|correct) (?:the |any )?fields?\b|\blink (?:the |a )?(?:purchase order|po)\b|\brequest (?:a )?corrected\b|\bask the supplier for a corrected\b/i,
    ['correct', 'review_hold'],
  ],
  [/\bprocess (?:it |the invoice )?again\b|\brerun\b/i, ['review_hold', 'rerun_after_receipt']],
  [/\b(?:re)?schedule (?:the |a |its )?payment\b|\bschedule it\b/i, ['schedule_payment', 'check_payment']],
  [/\brecord (?:the |a |its )?payment\b|\bmark (?:it|the cheque|the payment) (?:as )?paid\b|\bmatch it to the bank statement\b/i, ['record_payment']],
  [/\breverse (?:the |its )?approval\b|\breverse_approval\b/i, []],
  [/\breopen\b/i, []],
  [/\bcancel (?:the |this |its )?(?:invoice|payment|it)\b/i, []],
  [/\b(?:put|place) (?:it |the invoice )?on hold\b/i, []],
  [/\bmark (?:the payment |it )?(?:as )?failed\b/i, []],
  [/\bclear (?:the |it as )?(?:a )?duplicate\b/i, []],
];

/**
 * Why `sentence` contradicts `state` (stateReason.js), or null:
 *   payment_exists          says there is no payment, or it cannot be scheduled, when one exists
 *   not_paid                says it has been paid when no payment is completed
 *   status                  says it is in a status other than its own
 *   overridden_checks       says checks a person decided past still block it
 *   action_not_recommended  recommends an action that is not in its recommended next steps
 */
export function contradictsState(sentence, state) {
  if (!state) return null;
  const s = String(sentence);
  const pay = state.payment?.state || 'none';
  if (!['none', 'cancelled'].includes(pay) && NO_PAYMENT.test(s)) return 'payment_exists';
  if (pay !== 'completed' && state.status !== 'payment_completed') for (const m of s.matchAll(PAID)) if (!negated(s, m.index)) return 'not_paid';
  for (const [phrase, status] of STATUS_PHRASES) {
    for (const m of s.matchAll(new RegExp(String.raw`${NOW}${phrase}\b`, 'gi'))) if (status !== state.status && !negated(s, m.index)) return 'status';
  }
  if (state.overriddenChecks?.length && OVERRIDDEN_BLOCK.some((re) => re.test(s))) return 'overridden_checks';
  const allowed = new Set((state.recommendedNextSteps || []).map((x) => x.action));
  for (const [re, by] of ACTION_MENTIONS) {
    if (by.some((a) => allowed.has(a))) continue;
    for (const m of s.matchAll(new RegExp(re.source, 'gi'))) if (recommends(s, m.index)) return 'action_not_recommended';
  }
  return null;
}

// Is the action at `index` recommended (an instruction or a "can / should / must ..."), not told as
// something that happened ("a reviewer put it on hold")?
const RECOMMENDING = /\b(?:can|could|should|must|may|might|need(?:s)? to|ha(?:s|ve) to|recommend\w*|suggest\w*|consider|try|option|you)\b/i;
function recommends(sentence, index) {
  const before = sentence.slice(0, index);
  if (!before.trim() || /^(?:please|then|next|first|now|so)\W*$/i.test(before.trim())) return true; // an instruction
  return RECOMMENDING.test(before.slice(-60));
}

/**
 * Check the explanation against the state code worked out, before the other
 * grounding checks: a contradicting item is dropped whole; a contradicting
 * summary sentence is dropped. `stateOf(handle)` gives an item's state; the
 * summary is checked against every state. Returns { summary, items, rejected: [{ handle, reason }] }.
 */
export function rejectContradictions({ summary, items = [] }, stateOf, states) {
  const rejected = [];
  const keptItems = [];
  for (const item of items) {
    const st = stateOf(item.handle);
    const reason = sentencesOf(item.text)
      .map((x) => contradictsState(x, st))
      .find(Boolean);
    if (reason) rejected.push({ handle: item.handle, reason });
    else keptItems.push(item);
  }
  const keptSummary = sentencesOf(summary).filter((x) => {
    const reason = states.map((st) => contradictsState(x, st)).find(Boolean);
    if (reason) rejected.push({ handle: null, reason });
    return !reason;
  });
  return { summary: keptSummary.join(' '), items: keptItems, rejected };
}
