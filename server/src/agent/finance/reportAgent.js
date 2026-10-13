// Finance Operations agent: month-end reporting.
//
// Gathers the month's invoices, payments, supplier emails and bank
// reconciliations, calculates the figures, writes a short commentary, and
// flags the report if anything is still open.

import { requestEscalation } from '../core/loop.js';
import { groqJson } from '../../llm/groq.js';
import { isMonth, monthRange, monthOf, previousMonth, buildFigures, checkFigures, compareMonths, templateCommentary, ungroundedNumbers } from './reportFigures.js';

export const COMMENTARY_PROMPT = `You write the short commentary at the top of a month-end accounts payable report for an Australian finance manager.

You are given the report's figures as JSON. Write one paragraph of at most 110 words in plain English.

Rules:
- Use only the figures provided. Do not add up, subtract, round, estimate or compare to anything that is not in the figures.
- Write dollar amounts exactly as given, with a dollar sign and two decimal places.
- "comparison" holds last month's figures and the change. Mention the most important changes only if comparison.hasData is true.
- Say what happened and what is still open. Do not give advice or opinions.

Return JSON: { "commentary": string }`;

export async function writeWithGroq(figures, { apiKey, model, fetchImpl } = {}) {
  const raw = await groqJson({ apiKey, model, fetchImpl, system: COMMENTARY_PROMPT, user: JSON.stringify(figures) });
  const text = String(raw.commentary ?? '').trim();
  if (!text) throw new Error('The AI writer returned no commentary.');
  return text.slice(0, 1200);
}

export function createWriter({ groqApiKey, groqModel }) {
  return groqApiKey ? { model: groqModel, write: (figures) => writeWithGroq(figures, { apiKey: groqApiKey, model: groqModel }) } : null;
}

export function createReportAgent({ ledger, writer, save, now = () => new Date() }) {
  return {
    name: 'finance.month-end-report',

    stages: {
      // 1. Receive: which month?
      async receive(state) {
        const { report } = state.input;
        Object.assign(report, { status: 'processing', figures: null, commentary: null, decision: null });
        await save(report);
        if (!isMonth(report.month)) throw new Error('Choose a month for the report.');
        if (report.month > monthOf(now())) throw new Error(`${monthRange(report.month).label} has not started yet.`);
        state.range = monthRange(report.month);
        return { summary: `Report requested for ${state.range.label}${report.month === monthOf(now()) ? ', which is still in progress' : ''}.` };
      },

      // 2. Understand: gather the month's records.
      async understand(state) {
        const { start, end, label } = state.range;
        const prev = monthRange(previousMonth(state.input.report.month));
        const [invoices, payments, queries, statements, prevInvoices, prevQueries, prevStatements] = await Promise.all([
          ledger.listInvoices({ start, end }),
          ledger.listPayments(),
          ledger.listQueries({ start, end }),
          ledger.listStatements({ start, end }),
          ledger.listInvoices(prev),
          ledger.listQueries(prev),
          ledger.listStatements(prev),
        ]);
        state.records = { invoices, payments, queries, statements };
        state.previousRecords = { invoices: prevInvoices, payments, queries: prevQueries, statements: prevStatements };
        return { summary: `Collected ${invoices.length} invoice(s), ${queries.length} supplier email(s) and ${statements.length} bank statement(s) received in ${label}.` };
      },

      // 3. Decide: calculate the figures and check they agree with each other.
      async decide(state) {
        const { report } = state.input;
        const figures = buildFigures({ month: report.month, ...state.records });
        figures.comparison = compareMonths(figures, buildFigures({ month: previousMonth(report.month), ...state.previousRecords }));
        const problems = checkFigures(figures);
        if (problems.length) throw new Error(`The figures do not agree, so no report was written. ${problems.join(' ')}`);
        state.figures = figures;
        report.figures = figures;
        await save(report);
        for (const item of figures.openItems) requestEscalation(state, item);
        return {
          summary: `Calculated the figures, compared them with ${figures.comparison.label}${figures.comparison.hasData ? '' : ' (no records that month)'}, and confirmed they agree with each other. ${figures.openItems.length} open item(s) found.`,
        };
      },

      // 4. Act: write the commentary.
      async act(state) {
        const { report } = state.input;
        let commentary = { text: templateCommentary(state.figures), method: 'standard', model: null, note: null };
        if (writer) {
          try {
            commentary = { text: await writer.write(state.figures), method: 'groq', model: writer.model, note: null };
          } catch (err) {
            commentary.note = `The AI writer was not available (${err.message}), so standard wording was used.`;
          }
        }
        report.commentary = commentary;
        await save(report);
        return { summary: commentary.method === 'groq' ? `Commentary written by the AI writer (${commentary.model}).` : `Commentary written with standard wording.${commentary.note ? ` ${commentary.note}` : ''}` };
      },

      // 5. Verify: every number in the commentary must be one of the figures.
      async verify(state) {
        const { report } = state.input;
        const stray = ungroundedNumbers(report.commentary.text, state.figures);
        if (stray.length && report.commentary.method === 'groq') {
          report.commentary = {
            text: templateCommentary(state.figures),
            method: 'standard',
            model: null,
            note: `The AI commentary used a number that is not in the figures (${stray.join(', ')}), so it was replaced with standard wording.`,
          };
          await save(report);
          return { summary: report.commentary.note };
        }
        if (stray.length) throw new Error(`The commentary contains a number that is not in the figures (${stray.join(', ')}).`);
        return { summary: 'Confirmed every number in the commentary appears in the figures.' };
      },

      // 6. Escalate: a month with open items is not ready to close.
      async escalate(state) {
        const { report } = state.input;

        if (state.error) {
          report.status = 'failed';
          report.decision = { outcome: 'failed', reasons: [`The agent stopped at the "${state.error.stage}" step: ${state.error.message}`] };
          await save(report);
          state.outcome = 'failed';
          return { summary: 'Flagged for a person because the report could not be completed.' };
        }

        if (state.escalation) {
          const reasons = state.escalation.reasons;
          report.status = 'open_items';
          report.decision = { outcome: 'open_items', reasons };
          await save(report);
          state.outcome = 'open_items';
          return { summary: `The report is written, but ${reasons.length} item${reasons.length === 1 ? ' is' : 's are'} still open, so the month is not ready to close.`, detail: { reasons } };
        }

        report.status = 'ready';
        report.decision = { outcome: 'ready', reasons: [] };
        await save(report);
        state.outcome = 'ready';
        return { status: 'skipped', summary: 'Not needed. Nothing is open for this month.' };
      },
    },
  };
}
