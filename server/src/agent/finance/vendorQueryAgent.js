// Finance Operations agent: vendor queries.
//
// A supplier emails to ask about a payment. The agent works out which invoices
// they mean, looks the status up in the records, and either sends a reply built
// from those records or hands the email to a person.
//
// The reply is never written by the AI model. The model only classifies the
// email; the wording comes from composeReply() in queryRules.js.

import { requestEscalation } from '../core/loop.js';
import { emailAddress, findVendorForSender, pickInvoice, runQueryChecks, decideQuery, composeReply, mentionsBankDetails, INTENT_LABEL } from './queryRules.js';

export function createVendorQueryAgent({ ledger, read, policy, companyName, save }) {
  return {
    name: 'finance.vendor-queries',

    stages: {
      // 1. Receive: take the email in and check there is something to answer.
      async receive(state) {
        const { query } = state.input;
        Object.assign(query, { status: 'processing', understood: null, reading: null, supplier: null, matchedInvoices: [], checks: [], decision: null, draft: null });
        await save(query);
        state.sender = emailAddress(query.from);
        if (!state.sender) throw new Error('The "from" address is not a valid email address.');
        if ((query.body || '').trim().length < 10) throw new Error('The email has no message to read.');
        return { summary: `Email received from ${state.sender}${query.subject ? `: "${query.subject}"` : ''}.` };
      },

      // 2. Understand: what are they asking, and about which invoices?
      async understand(state) {
        const { query } = state.input;
        const { understood, reading } = await read({ subject: query.subject, body: query.body });
        query.understood = understood;
        query.reading = reading;
        await save(query);
        const refs = understood.invoiceNumbers;
        const reader = reading.method === 'groq' ? `AI reader (${reading.model})` : 'keyword reader';
        return {
          summary: `Read as ${INTENT_LABEL[understood.intent]}. ${refs.length ? `Invoices mentioned: ${refs.join(', ')}.` : 'No invoice number found.'} Read by the ${reader}.`,
        };
      },

      // 3. Decide: identify the supplier, look up the invoices, apply the rules.
      async decide(state) {
        const { query } = state.input;
        const text = `${query.subject || ''}\n${query.body}`;
        const vendor = findVendorForSender(state.sender, await ledger.listVendors());

        const items = [];
        for (const invoiceNumber of query.understood.invoiceNumbers.slice(0, 5)) {
          const candidates = await ledger.findInvoicesByNumber(invoiceNumber);
          items.push({ invoiceNumber, onFile: candidates.length > 0, invoice: vendor ? pickInvoice(candidates, vendor.abn) : null });
        }

        const checks = runQueryChecks({ text, understood: query.understood, reading: query.reading, vendor, sender: state.sender, items, policy });
        const decision = decideQuery(checks);

        query.supplier = vendor ? { name: vendor.name, abn: vendor.abn } : null;
        query.checks = checks;
        // Invoice details are only attached when the invoice belongs to the sender.
        query.matchedInvoices = items.map((i) => ({
          invoiceNumber: i.invoiceNumber,
          onFile: i.onFile,
          belongsToSender: Boolean(i.invoice),
          status: i.invoice?.status ?? null,
          total: i.invoice?.total ?? null,
          dueDate: i.invoice?.dueDate ?? null,
          paymentStatus: i.invoice?.payment?.status ?? null,
          paidOn: i.invoice?.payment?.paidOn ?? null,
        }));
        await save(query);

        // A status reply is only drafted when it is safe to show one: known
        // sender, their own invoices, a status question, no bank details.
        const canDraft = vendor && items.length > 0 && items.every((i) => i.invoice) && query.understood.intent === 'payment_status' && !mentionsBankDetails(text);
        state.reply = canDraft ? composeReply({ subject: query.subject, invoices: items.map((i) => i.invoice), companyName }) : null;
        state.items = items;
        state.decision = decision;
        for (const reason of decision.reasons) requestEscalation(state, reason);

        const passed = checks.filter((c) => c.status === 'pass').length;
        const failed = checks.filter((c) => c.status === 'fail').length;
        return { summary: failed ? `${failed} of ${checks.length} checks ${failed === 1 ? 'needs' : 'need'} a person. ${passed} passed.` : `All ${passed} checks passed.` };
      },

      // 4. Act: put the reply in the outbox, or hold the email.
      async act(state) {
        const { query } = state.input;
        query.draft = state.reply;
        await save(query);
        if (state.decision.outcome !== 'auto_answer') {
          return { summary: `Held the email. No reply was sent.${state.reply ? ' A draft reply is ready for the person to check.' : ''}` };
        }
        await ledger.queueMessage({ queryId: query.id, to: state.sender, subject: state.reply.subject, body: state.reply.body, sentBy: 'Finance Operations Agent (automatic)' });
        const n = state.items.length;
        return { summary: `Wrote a reply covering ${n} invoice${n === 1 ? '' : 's'} from the accounts records and placed it in the outbox.` };
      },

      // 5. Verify: check the outbox before anything is released.
      async verify(state) {
        const { query } = state.input;
        const messages = await ledger.findMessages(query.id);

        if (state.decision.outcome === 'auto_answer') {
          const queued = messages.filter((m) => m.status === 'queued');
          const ok =
            messages.length === 1 &&
            queued.length === 1 &&
            queued[0].to === state.sender &&
            state.items.every((i) => queued[0].body.includes(i.invoiceNumber)) &&
            !mentionsBankDetails(queued[0].body);
          if (!ok) {
            await ledger.holdMessages(query.id);
            requestEscalation(state, 'The reply in the outbox did not match what was decided, so it was not sent.');
            return { summary: 'The outbox did not match the decision. The reply was held.' };
          }
          await ledger.releaseMessage(query.id);
          return { summary: `Confirmed the reply is addressed to ${state.sender} and covers every invoice asked about, then released it.` };
        }

        if (messages.some((m) => m.status === 'queued')) {
          await ledger.holdMessages(query.id);
          requestEscalation(state, 'A reply was waiting in the outbox for an email that should be held. It was not sent.');
          return { summary: 'Found a waiting reply for a held email and stopped it.' };
        }
        return { summary: 'Confirmed nothing was sent for this email.' };
      },

      // 6. Escalate.
      async escalate(state) {
        const { query } = state.input;

        if (state.error) {
          try {
            await ledger.holdMessages(query.id);
          } catch {
            /* best effort */
          }
          query.status = 'failed';
          query.decision = { outcome: 'failed', reasons: [`The agent stopped at the "${state.error.stage}" step: ${state.error.message}`] };
          await save(query);
          state.outcome = 'failed';
          return { summary: 'Flagged for a person because the agent could not finish.' };
        }

        if (state.escalation) {
          const reasons = state.escalation.reasons;
          query.status = 'needs_person';
          query.decision = { outcome: 'needs_person', reasons };
          await save(query);
          state.outcome = 'needs_person';
          return { summary: `Sent to a person with ${reasons.length} reason${reasons.length === 1 ? '' : 's'}.`, detail: { reasons } };
        }

        query.status = 'answered';
        query.decision = { outcome: 'auto_answered', reasons: [] };
        await save(query);
        state.outcome = 'auto_answered';
        return { status: 'skipped', summary: 'Not needed. Every check passed, so the reply went out without a person.' };
      },
    },
  };
}
