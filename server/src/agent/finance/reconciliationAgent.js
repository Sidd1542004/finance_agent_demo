// Finance Operations agent: bank reconciliation.
//
// Takes a bank statement (CSV), matches each payment line to an approved
// supplier payment, marks those payments as paid, and hands every line it
// cannot place to a person.

import { requestEscalation } from '../core/loop.js';
import { money, cents, day } from './rules.js';
import { parseStatement, matchLines, needsPerson } from './reconcileRules.js';

const sum = (list, pick) => list.reduce((total, item) => total + cents(pick(item)), 0) / 100;

export function createReconciliationAgent({ ledger, explain, save }) {
  const store = async (statement, state) => {
    statement.lines = state.lines.map((l) => ({ ...l }));
    await save(statement);
  };

  return {
    name: 'finance.bank-reconciliation',

    stages: {
      // 1. Receive.
      async receive(state) {
        const { statement } = state.input;
        // Undo anything an earlier, failed attempt on this statement marked as paid.
        await ledger.revertStatement(statement.id);
        Object.assign(statement, { status: 'processing', lines: [], unpaid: [], decision: null });
        await save(statement);
        const text = (statement.rawText || '').trim();
        if (!text) throw new Error('The statement is empty.');
        const file = statement.source?.filename ? ` (${statement.source.filename})` : '';
        return { summary: `Bank statement received${file}.` };
      },

      // 2. Understand: read the lines.
      async understand(state) {
        const { statement } = state.input;
        state.lines = parseStatement(statement.rawText);
        await store(statement, state);
        const out = state.lines.filter((l) => l.amount < 0);
        const dates = state.lines.map((l) => l.date).filter(Boolean).sort();
        return {
          summary: `Read ${state.lines.length} line${state.lines.length === 1 ? '' : 's'}: ${out.length} money out (${money(sum(out, (l) => Math.abs(l.amount)))}) and ${state.lines.length - out.length} money in${dates.length ? `, dated ${day(dates[0])} to ${day(dates[dates.length - 1])}` : ''}.`,
        };
      },

      // 3. Decide: match lines to payments by fixed rules.
      async decide(state) {
        const { statement } = state.input;
        const [payments, invoices] = await Promise.all([ledger.listPayments(), ledger.listInvoices()]);
        const { lines, unpaid } = matchLines(state.lines, payments, invoices.filter((i) => i.status !== 'failed' && i.invoiceNumber));
        state.lines = lines;

        // Optional: an AI note on each line a person will have to look at.
        let aiSummary = '';
        const open = lines.filter(needsPerson);
        if (explain && open.length) {
          try {
            const notes = await explain(open);
            for (const line of open) line.aiNote = notes[line.n] || null;
            aiSummary = ' Added AI notes to the lines a person needs to check.';
          } catch (err) {
            aiSummary = ` AI notes were not available (${err.message})`;
          }
        }

        statement.unpaid = unpaid;
        await store(statement, state);
        for (const line of open) {
          requestEscalation(state, `Line ${line.n} (${line.description}, ${money(Math.abs(line.amount))}): ${line.reason}`);
        }
        const matched = lines.filter((l) => l.status === 'matched').length;
        const skipped = lines.filter((l) => l.status === 'skipped').length;
        return { summary: `${matched} matched to approved payments, ${open.length} ${open.length === 1 ? 'needs' : 'need'} a person, ${skipped} skipped as money in.${aiSummary}` };
      },

      // 4. Act: mark the matched payments as paid.
      async act(state) {
        const { statement } = state.input;
        let done = 0;
        for (const line of state.lines.filter((l) => l.status === 'matched')) {
          const paid = await ledger.markPaid(line.paymentId, { statementId: statement.id, line: line.n, date: line.date, description: line.description });
          if (paid) done += 1;
          else {
            Object.assign(line, { status: 'exception', kind: 'changed', paymentId: null, reason: `The payment for invoice ${line.invoiceNumber} changed while the statement was being reconciled, so it was not marked as paid.` });
            requestEscalation(state, `Line ${line.n} (${line.description}, ${money(Math.abs(line.amount))}): ${line.reason}`);
          }
        }
        await store(statement, state);
        const total = sum(state.lines.filter((l) => l.status === 'matched'), (l) => Math.abs(l.amount));
        return { summary: done ? `Marked ${done} payment${done === 1 ? '' : 's'} as paid, ${money(total)} in total.` : 'No payments were marked as paid.' };
      },

      // 5. Verify: the payments marked as paid must be exactly the matched lines.
      async verify(state) {
        const { statement } = state.input;
        const matched = state.lines.filter((l) => l.status === 'matched');
        const paid = (await ledger.listPayments()).filter((p) => p.status === 'paid' && p.bank?.statementId === statement.id);
        const lineTotal = sum(matched, (l) => Math.abs(l.amount));
        const paidTotal = sum(paid, (p) => p.amount);
        const ok = paid.length === matched.length && cents(lineTotal) === cents(paidTotal) && matched.every((l) => paid.some((p) => p.id === l.paymentId && p.bank.line === l.n));
        if (!ok) {
          await ledger.revertStatement(statement.id);
          throw new Error(`The payments marked as paid (${paid.length}, ${money(paidTotal)}) do not agree with the matched lines (${matched.length}, ${money(lineTotal)}). Nothing was left marked as paid.`);
        }
        return { summary: `Confirmed ${paid.length} payment${paid.length === 1 ? ' is' : 's are'} marked as paid and the total agrees with the statement (${money(paidTotal)}).` };
      },

      // 6. Escalate.
      async escalate(state) {
        const { statement } = state.input;

        if (state.error) {
          try {
            await ledger.revertStatement(statement.id);
          } catch {
            /* best effort */
          }
          statement.status = 'failed';
          statement.decision = { outcome: 'failed', reasons: [`The agent stopped at the "${state.error.stage}" step: ${state.error.message}`] };
          await save(statement);
          state.outcome = 'failed';
          return { summary: 'Flagged for a person because the agent could not finish. No payments were left marked as paid.' };
        }

        if (state.escalation) {
          const reasons = state.escalation.reasons;
          statement.status = 'needs_person';
          statement.decision = { outcome: 'needs_person', reasons };
          await save(statement);
          state.outcome = 'needs_person';
          return { summary: `Sent ${reasons.length} line${reasons.length === 1 ? '' : 's'} to a person.`, detail: { reasons } };
        }

        statement.status = 'reconciled';
        statement.decision = { outcome: 'reconciled', reasons: [] };
        await save(statement);
        state.outcome = 'reconciled';
        return { status: 'skipped', summary: 'Not needed. Every payment line was matched.' };
      },
    },
  };
}
