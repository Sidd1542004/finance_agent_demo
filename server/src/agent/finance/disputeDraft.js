// The email to a supplier about an invoice's variance. Code owns its
// structure: the subject, the greeting, the sign-off and the signature (the
// person who sends it, then the company). The model writes only the body
// paragraphs, from the dispute facts only (disputeFacts.js); code checks them,
// and uses paragraphs written from the same facts (the template) when the
// model is unavailable or its text fails a check. A person always reviews,
// edits and sends it; nothing here sends anything.
//
// The model gets the facts and a task sentence written by code. It never sees
// the invoice text, an email body, or anything a supplier wrote. Its
// paragraphs are rejected (template instead, with the reason) when they
//   - use a number that is not in the facts (ungroundedNumbers, strict),
//   - name a document number or email address that is not in the facts,
//   - mention bank details,
//   - mention payment at all (so they can never promise one, or a date),
//   - accuse the supplier (fraud, deliberate, misleading, legal action, ...),
//   - make a comparison or claim the facts do not support,
//   - use our internal terms (check, variance, credit calculation, match score, ...),
//   - ask for something other than the requests in the facts (a refund, a discount, ...),
//   - carry their own greeting or sign-off (code adds those).
//
// The closing request ("Could you please issue a credit note for AUD 84.70, or
// ...?") is code's too, from the stored requests. The model is told not to ask
// for anything; a request sentence in its text ("could you", "please send",
// "kindly", ...) is dropped, and when nothing meaningful is left the template is
// used (reason request_in_body).

import { callModel } from '../../orchestrator/model.js';
import { COMPOSE } from '../../orchestrator/compose.js';
import { groundingRefs } from '../../orchestrator/ground.js';
import { ungroundedNumbers } from './reportFigures.js';

// The same caps and reasoning effort as the explanation call (compose.js).
export const DISPUTE_DRAFT = Object.freeze({ maxTokens: COMPOSE.maxTokens, reasoningEffort: COMPOSE.reasoningEffort, timeoutMs: COMPOSE.timeoutMs });
export const SUBJECT_MAX = 150;
export const BODY_MAX = 3000;
export const SIGN_OFF = 'Kind regards,';

export const DISPUTE_SYSTEM = [
  'You write the body of a short, polite, specific email from one business to another: our accounts payable team to a supplier, about one of their invoices.',
  'The user message is JSON: a task, and the facts. Use only the facts.',
  'Answer with ONE JSON object and nothing else: {"body": "<two to four plain-text paragraphs, separated by a blank line>"}.',
  'The greeting, the sign-off and the signature are added for you: do not write "Dear ...", "Kind regards", a name or a signature.',
  'Rules:',
  '- Every number, amount, date, quantity and document number you write must appear in the facts. Write amounts and dates exactly as the facts write them (for example "AUD 84.70", "18 Sep 2026"). Do not add, round or work out new numbers.',
  '- For each line in the facts, say what was found and show its working exactly as given (for example "2 × AUD 38.50 = AUD 77.00 ex GST").',
  '- Do not ask for anything and do not write a question: the closing request (outcomeText) is added after your paragraphs. Explain only what was found.',
  '- Write as one business to another, in plain words. Never use our internal terms: "check", "checked", "variance", "credit calculation", "match score", "threshold", "flagged", "system".',
  '- Never mention payment, paying, payment dates or remittance in any way. Never mention bank details or account numbers.',
  '- Be courteous and neutral. Never suggest the supplier acted on purpose, dishonestly or fraudulently, and never threaten.',
  '- No comparisons or claims beyond the facts: no "largest", "significantly", "again", "repeatedly", "previous invoices", "market price" and the like.',
  '- No names, emails, phone numbers or links. At most 1,200 characters in all.',
].join('\n');

/** The task sentence, written by code. */
export function disputeTask(facts) {
  const kinds = [
    ...new Set(
      facts.variances.map(
        (v) => ({ quantity: 'quantities invoiced but not received or not ordered', price: 'unit prices above the purchase order', gst: 'the GST shown' })[v.type],
      ),
    ),
  ];
  return `Write the body paragraphs about invoice ${facts.invoiceNumber || '(no number)'} from ${facts.supplierName || 'the supplier'}: ${kinds.join('; ')}. Explain what was found only; the request is added after your paragraphs.`;
}

// ----- the structure code owns -----

export const greetingFor = (facts) => `Dear ${facts.supplierName || 'Supplier'} accounts team,`;

export function subjectFor(facts) {
  const inv = facts.invoiceNumber || 'without a number';
  return facts.outcome === 'credit_note' ? `Invoice ${inv}: credit note requested (${facts.credit.totalText})` : `Invoice ${inv}: corrected tax invoice requested`;
}

/** The closing request, from the stored requests: "Could you please issue a credit note for AUD 84.70, or ...?" */
export const requestSentence = (facts) => `Could you please ${facts.outcomeText}?`;

// A sentence that asks the supplier for something: the request is code's, so it is dropped.
const REQUEST =
  /\b(?:could you|can you|would you|will you|please (?:issue|send|provide|confirm|let|advise|arrange|supply|forward|re-?issue|correct|amend|update|review|note)|kindly|we (?:request|ask|would (?:appreciate|be grateful|like))|we would be grateful|we look forward to)\b/i;
const MEANINGFUL = 60; // characters left after dropping requests, below which the template is used

/** The model's paragraphs without request sentences: { paragraphs, dropped }. */
export function dropRequests(paragraphs) {
  let dropped = 0;
  const kept = (paragraphs || [])
    .map((p) =>
      String(p)
        .split(/(?<=[.!?])[ \t]+/)
        .filter((sentence) => {
          if (!REQUEST.test(sentence)) return true;
          dropped += 1;
          return false;
        })
        .join(' ')
        .trim(),
    )
    .filter(Boolean);
  return { paragraphs: kept, dropped };
}

/** The whole email: greeting, the body paragraphs, sign-off, the sender's name and the company. */
export function assembleEmail({ greeting, body }, { name, company }) {
  return [greeting, '', String(body).trim(), '', SIGN_OFF, name, company].filter((x) => x !== null && x !== undefined).join('\n');
}

// ----- the code checks -----

const BANK = /\b(?:bsb|account\s+(?:number|name|no\.?|details)|bank\s+(?:details|account|account\s+details)|iban|swift|bic|routing\s+number|sort\s+code|biller\s+code|crn)\b/i;
const PAYMENT = /\b(?:pay|pays|paid|paying|payment|payments|repay\w*|prepa\w*|remit\w*|remittance|settle|settled|settles|settlement|transfer|transferred)\b/i;
const ACCUSATION =
  /\b(?:fraud\w*|scam\w*|deceiv\w*|decept\w*|dishonest\w*|deliberate(?:ly)?|intentional(?:ly)?|on purpose|mislead\w*|cheat\w*|illegal\w*|unlawful\w*|criminal\w*|legal action|lawyers?|solicitors?|police|sue|court|report (?:you|this) to)\b/i;
const COMPARISON =
  /\b(?:most|least|largest|biggest|highest|lowest|smallest|best|worst|significant(?:ly)?|substantial(?:ly)?|considerabl[ey]|grossly|excessive(?:ly)?|hugely|massively|repeated(?:ly)?|again and again|once again|yet again|as usual|every time|always|frequently|consistently|habitually|previous (?:invoices?|occasions?|orders?)|past invoices?|other (?:customers|suppliers|clients)|industry (?:rate|standard|price)s?|market (?:rate|price|value)s?|far (?:more|less|higher|lower)|much (?:more|less|higher|lower))\b/i;
// Our own words for the agent's work: a supplier should not read them.
const INTERNAL =
  /\b(?:checks?|checked|checking|variances?|credit calculation|match(?:ing)? score|threshold|flagged|our system|the system|the agent|quantity_match|price_match|tax_charged|exceptions?)\b/i;
// Anything asked for that is not one of the facts' requests.
const OTHER_ASK = /\b(?:refund\w*|reimburs\w*|discount\w*|rebate\w*|write[- ]?off|replacement|replace the|return (?:the )?goods|cancel\w*|void(?:ed)?|compensat\w*)\b/i;
// A greeting or sign-off of its own: code adds those.
const STRUCTURE = /^\s*(?:dear|hi|hello|to whom)\b|\b(?:kind regards|best regards|regards|sincerely|yours (?:faithfully|truly|sincerely))\b|^\s*accounts payable\s*$/im;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const LINK = /\b(?:https?:\/\/|www\.)\S+/i;

/**
 * Why body paragraphs fail the checks against the facts: [] when they pass.
 * Codes: bad_output, ungrounded_number, unknown_reference, unknown_email, link,
 * bank_details, payment, accusation, unsupported_comparison, internal_term,
 * unsupported_outcome, structure.
 */
export function draftProblems(paragraphs, facts) {
  const list = Array.isArray(paragraphs) ? paragraphs : null;
  if (!list || !list.length || list.length > 6 || list.some((p) => typeof p !== 'string' || !p.trim())) return ['bad_output'];
  const text = list.map((p) => p.trim()).join('\n\n');
  if (text.length > BODY_MAX) return ['bad_output'];
  const problems = [];
  if (ungroundedNumbers(text, facts).length) problems.push('ungrounded_number');
  const known = groundingRefs(facts);
  if ([...groundingRefs([text])].some((ref) => !known.has(ref))) problems.push('unknown_reference');
  const emails = (text.match(EMAIL) || []).map((x) => x.toLowerCase());
  if (emails.some((x) => x !== String(facts.supplierEmail || '').toLowerCase())) problems.push('unknown_email');
  if (LINK.test(text)) problems.push('link');
  if (BANK.test(text)) problems.push('bank_details');
  if (PAYMENT.test(text)) problems.push('payment');
  if (ACCUSATION.test(text)) problems.push('accusation');
  if (COMPARISON.test(text)) problems.push('unsupported_comparison');
  if (INTERNAL.test(text)) problems.push('internal_term');
  if (OTHER_ASK.test(text)) problems.push('unsupported_outcome');
  if (STRUCTURE.test(text)) problems.push('structure');
  return problems;
}

// ----- the template paragraphs -----

function varianceLine(v) {
  if (v.type === 'quantity') {
    const got = v.received === null || v.received === undefined ? 'no delivery recorded' : `${v.received} received`;
    const before = v.alreadyInvoiced ? `, ${v.alreadyInvoiced} already invoiced` : '';
    const which = v.reason === 'not_received' ? 'not received' : 'beyond the quantity ordered';
    return `- ${v.item}: ${v.invoiced} invoiced, ${v.ordered} ordered, ${got}${before}. The ${v.excessText} ${which}: ${v.working}.`;
  }
  if (v.type === 'price') return `- ${v.item}: invoiced at ${v.invoicedUnitPriceText} each; our purchase order price is ${v.poUnitPriceText}. ${v.working}.`;
  if (v.missing) return `- GST: the invoice does not show ${v.missing === 'gst' ? 'a GST amount' : 'a subtotal before GST'}.`;
  return `- GST: the invoice shows ${v.chargedText}; ${v.working}.`;
}

/** The body paragraphs written from the facts alone. */
export function templateParagraphs(facts) {
  const inv = facts.invoiceNumber || 'without a number';
  const against = facts.deliveryDate ? `the purchase order and the delivery received on ${facts.deliveryDate}` : 'the purchase order';
  return [
    `Thank you for invoice ${inv}${facts.invoiceDate ? ` dated ${facts.invoiceDate}` : ''}${facts.poNumber ? ` for purchase order ${facts.poNumber}` : ''}. Comparing it with ${against}, we found the following:`,
    [...facts.variances.map(varianceLine), ...(facts.outcome === 'credit_note' && facts.credit.working ? [`In total: ${facts.credit.working}.`] : [])].join('\n'),
    requestSentence(facts),
    'If we have misread anything, please reply to this email with the details.',
  ];
}

/** The template draft: the code-owned subject and greeting, and the template paragraphs. */
export function templateDraft(facts) {
  return { subject: subjectFor(facts), greeting: greetingFor(facts), body: templateParagraphs(facts).join('\n\n') };
}

// ----- drafting -----

/**
 * Draft the email. Returns { subject, greeting, body, aiDrafted, fallbackReason, problems, call }.
 * The subject and greeting are always code's; `body` is the model's paragraphs
 * when they pass every check, otherwise the template's. fallbackReason: null, or
 * the model's failure code (rate_limit, timeout, bad_output, not_configured, ...)
 * or the first check that failed.
 */
export async function draftDispute(facts, { apiKey, model, fetchImpl } = {}) {
  const r = await callModel({
    purpose: 'dispute_draft',
    apiKey,
    model,
    system: DISPUTE_SYSTEM,
    user: JSON.stringify({ task: disputeTask(facts), facts }),
    maxTokens: DISPUTE_DRAFT.maxTokens,
    reasoningEffort: DISPUTE_DRAFT.reasoningEffort,
    timeoutMs: DISPUTE_DRAFT.timeoutMs,
    fetchImpl,
  });
  const fallback = (reason, problems = []) => ({ ...templateDraft(facts), aiDrafted: false, fallbackReason: reason, problems, call: r.call });
  if (!r.ok) return fallback(r.code);
  // One string, split by code: a JSON array of paragraphs was often malformed at low reasoning effort
  // (Groq's json_validate_failed), a single string was not.
  const split = typeof r.value?.body === 'string' ? r.value.body.split(/\n\s*\n/).filter((p) => p.trim()) : null;
  if (!split?.length) {
    r.call.outcome = 'bad_output';
    return fallback('bad_output', ['bad_output']);
  }
  // The request is code's: any request sentence the model wrote is dropped; too little left, the template.
  const { paragraphs, dropped } = dropRequests(split);
  r.call.requestsDropped = dropped;
  if (paragraphs.join(' ').length < MEANINGFUL) {
    r.call.outcome = 'request_in_body';
    return fallback('request_in_body', ['request_in_body']);
  }
  const problems = draftProblems(paragraphs, facts);
  if (problems.length) {
    r.call.outcome = problems[0];
    return fallback(problems[0], problems);
  }
  return {
    subject: subjectFor(facts),
    greeting: greetingFor(facts),
    // The model's paragraphs, then the closing request code wrote from the stored requests.
    body: [...paragraphs, requestSentence(facts)].join('\n\n'),
    aiDrafted: true,
    fallbackReason: null,
    problems: [],
    call: r.call,
  };
}
