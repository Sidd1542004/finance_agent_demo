// Finance Operations agent: invoice processing.
//
// This is the six-stage loop filled in for one workflow. It talks to the
// outside world only through what it is given:
//   ledger  - the accounting system (suppliers, purchase orders, goods
//             received, other invoices). Sample data today, Xero/MYOB later.
//   extract - the invoice reader (Groq, or the basic pattern reader).
//   abr     - optional Australian Business Register lookup (null when not configured).
//   policy  - thresholds and tolerances.
//   save    - persists the invoice record.
//
// The agent prepares invoices for a person. It never approves an invoice and
// never creates a payment. A clean invoice scoring at or above the threshold
// goes to "Under Review": eligible for approval, still waiting for a person.

import { requestEscalation } from '../core/loop.js';
import { validateInvoice, identifyVendor, fmtMoney } from './validation.js';
import { matchToPo, suggestPurchaseOrders, resolvePurchaseOrder } from './matching.js';
import { fingerprints, duplicateCheck } from './duplicates.js';
import { statusFromChecks, STATUS_LABEL } from './lifecycle.js';
import { dueInfo } from './due.js';
import { applyCorrections } from './extract.js';

const SOURCE = { sample: 'from the sample set', upload: 'as an uploaded file', paste: 'as pasted text' };

export function pushEvent(invoice, event) {
  if (!Array.isArray(invoice.events)) invoice.events = [];
  invoice.events.push({ at: new Date().toISOString(), ...event });
}

export function createInvoiceAgent({ ledger, extract, abr = null, policy, save, today }) {
  return {
    name: 'finance.invoice-processing',

    stages: {
      // 1. Receive: take the invoice in and make sure there is something to read.
      async receive(state) {
        const { invoice } = state.input;
        const text = (invoice.rawText || '').trim();
        state.fromStatus = invoice.status || 'received';
        Object.assign(invoice, {
          status: 'processing',
          extracted: null,
          extraction: null,
          validation: null,
          match: null,
          checks: [],
          lineMatches: [],
          decision: null,
          dupKey: null,
          fingerprints: null,
          due: null,
        });
        await save(invoice);
        if (text.length < 40) {
          throw new Error('There is no readable text in this invoice. Scanned or photographed invoices need OCR, which this prototype does not include.');
        }
        const file = invoice.source?.filename ? ` (${invoice.source.filename})` : '';
        return { summary: `Invoice received ${SOURCE[invoice.source?.kind] || ''}${file}: ${text.length.toLocaleString('en-AU')} characters of text.` };
      },

      // 2. Understand: read the fields. Reviewers' hints for this supplier help
      // the reader find them; reviewers' corrections are laid over the result.
      async understand(state) {
        const { invoice } = state.input;
        const hints = ledger.supplierHintsFor ? await ledger.supplierHintsFor(invoice.rawText) : [];
        const reading = await extract(invoice.rawText, { hints });
        const { extracted, extraction } = applyCorrections(reading, invoice.corrections, invoice.rawText);
        invoice.extracted = extracted;
        invoice.extraction = extraction;
        invoice.fingerprints = fingerprints(extracted, invoice.rawText);
        invoice.dupKey = invoice.fingerprints.numberKey;
        invoice.due = dueInfo(extracted, today?.());
        await save(invoice);
        const reader = extraction.method === 'groq' ? `AI reader (${extraction.model})` : 'basic pattern reader';
        const helped = extraction.hints?.count ? ` Given ${extraction.hints.count} reviewer hint${extraction.hints.count === 1 ? '' : 's'} for ${extraction.hints.supplier || 'this supplier'}; every value was still checked against the invoice text.` : '';
        const corrected = extraction.corrected?.length ? ` ${extraction.corrected.length} field${extraction.corrected.length === 1 ? '' : 's'} corrected by a reviewer.` : '';
        return {
          summary: `Read invoice ${extracted.invoiceNumber || '(no number)'} from ${extracted.vendorName || 'an unknown supplier'}: ${(extracted.lines || []).length} line item(s), total ${fmtMoney(extracted.total, extracted.currency || 'AUD')}. Read by the ${reader}.${helped}${corrected}`,
          detail: { confidence: extraction.confidence, notes: extraction.notes },
        };
      },

      // 3. Decide: validate, find the supplier and PO, score the match, look for duplicates.
      async decide(state) {
        const { invoice } = state.input;
        const e = invoice.extracted;

        // Supplier, and an optional register lookup for a well-formed ABN.
        const { vendor, by, conflict } = identifyVendor(e, await ledger.listVendors());
        let abrResult = null;
        if (abr && e.abn) abrResult = await abr(e.abn);

        const validation = validateInvoice({ extracted: e, extraction: invoice.extraction, text: invoice.rawText, vendor, vendorBy: by, vendorConflict: conflict, abr: abrResult, policy });

        // Duplicates first: a suspected earlier copy must not also count as
        // having used up the purchase order.
        const candidates = await ledger.findDuplicateCandidates({ fingerprints: invoice.fingerprints, excludeId: invoice.id, before: invoice.createdAt });
        const dup = duplicateCheck(candidates, invoice.duplicateCleared, (n) => fmtMoney(n, e.currency || 'AUD'));

        const skip = invoice.duplicateCleared ? [] : dup.candidates.filter((c) => !['rejected', 'cancelled', 'failed'].includes(c.status)).map((c) => c.id);

        // Purchase order: one a person linked wins, exactly as chosen; otherwise
        // the one the invoice quotes, resolved by its number ("0011" is PO-0011
        // only if no other PO has that number). The printed reference is kept as is.
        const purchaseOrders = await ledger.listPurchaseOrders();
        const resolution = invoice.poOverride
          ? { po: await ledger.findPurchaseOrder(invoice.poOverride.poNumber), how: 'linked', candidates: [] }
          : resolvePurchaseOrder(e.poNumber, purchaseOrders);
        const po = resolution.po;
        const received = po ? await ledger.receivedQuantities(po.poNumber) : null;
        const invoicedBefore = po ? await ledger.invoicedQuantities({ poNumber: po.poNumber, excludeId: invoice.id, before: invoice.createdAt, skip }) : {};
        const taxCheck = validation.checks.find((c) => c.id === 'tax_charged');
        const arithmeticStatus = validation.checks.find((c) => c.id === 'arithmetic')?.status;
        const arithmeticOk = arithmeticStatus === 'pass';
        const match = matchToPo({ extracted: e, vendor, po, received, invoicedBefore, taxStatus: taxCheck?.status || 'unverified', arithmeticOk, arithmeticStatus, policy });
        const poCheck = match.checks.find((c) => c.id === 'po_found');
        if (resolution.how === 'normalised') {
          poCheck.detail += ` The invoice prints "${e.poNumber}", which is ${po.poNumber} written differently.`;
        }
        if (resolution.how === 'ambiguous') {
          poCheck.detail = `The invoice quotes "${e.poNumber}", which could be any of ${resolution.candidates.map((p) => `${p.poNumber} (${p.vendorName})`).join(', ')}. None was chosen: a person must link the right purchase order.`;
        }
        if (!po) {
          match.suggestions = suggestPurchaseOrders({ extracted: e, vendor, vendorBy: by, purchaseOrders, policy });
          const unowned = match.suggestions.some((s) => s.supplierOwnership !== 'confirmed_by_abn');
          poCheck.detail += match.suggestions.length
            ? ` ${match.suggestions.length} possible purchase order${match.suggestions.length === 1 ? '' : 's'} found: ${match.suggestions.map((s) => `${s.poNumber} (${s.vendorName}, ${s.score}%)`).join(', ')}. These are suggestions, not confirmed matches. A reviewer must confirm one; none is linked automatically.${unowned ? " The invoice's supplier is not confirmed by ABN, so check each PO belongs to this supplier before linking it." : ''}`
            : ' No likely purchase order was found.';
        } else match.suggestions = [];
        if (invoice.poOverride) match.linkedBy = invoice.poOverride;

        const checks = [...validation.checks, dup, ...match.checks];
        invoice.validation = { jurisdiction: validation.jurisdiction, identifier: validation.identifier, registration: validation.registration };
        invoice.match = {
          score: match.score,
          comparison: match.comparison,
          po: match.po,
          // How the printed reference was matched to a PO, for the audit trail.
          poResolution: { reference: e.poNumber ?? null, how: resolution.how, poNumber: po?.poNumber ?? null, candidates: resolution.candidates.map((p) => p.poNumber) },
          suggestions: match.suggestions,
          linkedBy: match.linkedBy || null,
          duplicates: dup.candidates,
        };
        invoice.checks = checks.map(({ candidates: _c, ...c }) => c);
        invoice.lineMatches = match.lineMatches;
        invoice.matchedPo = po ? po.poNumber : null;
        invoice.supplier = vendor ? { name: vendor.name, abn: vendor.abn, by } : conflict ? { name: null, by: null, conflict: { name: conflict.name, abn: conflict.abn } } : null;
        await save(invoice);

        state.target = statusFromChecks(invoice.checks);
        const failed = invoice.checks.filter((c) => c.status === 'fail');
        for (const c of failed) requestEscalation(state, c.detail);
        const passed = invoice.checks.filter((c) => c.status === 'pass').length;
        return {
          summary: `Match score ${match.score.total}% (threshold ${match.score.threshold}%). ${failed.length ? `${failed.length} of ${invoice.checks.length} checks need a person` : `All ${passed} checks passed`}. Result: ${STATUS_LABEL[state.target]}.`,
        };
      },

      // 4. Act: prepare the invoice for a person. The agent never approves and never pays.
      async act(state) {
        return {
          summary:
            state.target === 'under_review'
              ? 'Prepared the invoice for approval review. It is eligible for approval, but not approved: a person must approve it. No payment was created.'
              : `Prepared the exceptions for a person (${STATUS_LABEL[state.target]}). No payment was created.`,
        };
      },

      // 5. Verify: confirm the agent left no payment behind.
      async verify(state) {
        const { invoice } = state.input;
        const payments = await ledger.findPayments(invoice.id);
        const live = payments.filter((p) => ['queued', 'paid'].includes(p.status));
        if (live.length) {
          await ledger.holdPayments(invoice.id);
          requestEscalation(state, 'A payment existed for an invoice that has not been approved. It has been put on hold.');
          state.target = 'needs_review';
          return { summary: 'Found a payment for an unapproved invoice and put it on hold.' };
        }
        return { summary: 'Confirmed no payment exists for this invoice.' };
      },

      // 6. Escalate: set the status and hand the invoice to a person.
      async escalate(state) {
        const { invoice } = state.input;
        const from = state.fromStatus;

        if (state.error) {
          try {
            await ledger.holdPayments(invoice.id);
          } catch {
            /* best effort: the invoice is still flagged below */
          }
          invoice.status = 'failed';
          invoice.decision = { outcome: 'failed', reasons: [`The agent stopped at the "${state.error.stage}" step: ${state.error.message}`] };
          pushEvent(invoice, { actor: 'Agent', action: 'processed', from, to: 'failed', reason: state.error.message });
          await save(invoice);
          state.outcome = 'failed';
          return { summary: 'Flagged for a person because the agent could not finish.' };
        }

        const to = state.target;
        const reasons = state.escalation?.reasons || [];
        invoice.status = to;
        invoice.decision = { outcome: to, reasons };
        pushEvent(invoice, { actor: 'Agent', action: 'processed', from, to, reason: reasons.length ? `${reasons.length} exception(s)` : `Match score ${invoice.match?.score?.total}%` });
        await save(invoice);
        state.outcome = to;
        if (to === 'under_review') {
          return { summary: 'Sent to the approval queue as eligible for approval. A person must approve it.' };
        }
        return { summary: `Sent to a person as ${STATUS_LABEL[to]} with ${reasons.length} reason${reasons.length === 1 ? '' : 's'}.`, detail: { reasons } };
      },
    },
  };
}
