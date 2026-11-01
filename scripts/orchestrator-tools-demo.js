// "What is waiting and why", from the orchestrator's read-only tools alone
// (server/src/orchestrator/tools.js, docs/agentic-analysis.md §12 Phase 1).
// No AI model is called: this shows what a model would be given to work with.
//
//   node scripts/orchestrator-tools-demo.js
//
// The demo month (services/demo.js) is loaded into a THROWAWAY test database
// exactly as the tests do (test-support/mongo.js: MONGODB_TEST_URI if set,
// otherwise an in-memory MongoDB), read by the rules reader, so loading it
// calls no AI either. Your own database is never touched. The tools run as an
// approver, so you see what an approver may see and do.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromServer = (p) => import(pathToFileURL(path.join(root, 'server', p)).href);

const { startTestDatabase, testEnv } = await fromServer('test-support/mongo.js');
const db = await startTestDatabase();
// The rules reader (GROQ_API_KEY '') and this database only: set before any
// server module reads its configuration.
testEnv(db.uri);

// Outside text (supplier names, reasons) is printed for a person to read.
const txt = (v) => (v && typeof v === 'object' ? v.untrusted_text : v) ?? '—';
const money = (n, currency) => (typeof n === 'number' ? new Intl.NumberFormat('en-AU', { style: 'currency', currency: currency || 'AUD' }).format(n) : '—');
const dueText = (due) => {
  if (!due?.date) return 'no due date';
  if (due.state === 'overdue') return `due ${due.date}, overdue by ${-due.daysUntil} day(s)`;
  return `due ${due.date}${typeof due.daysUntil === 'number' ? ` (in ${due.daysUntil} day(s))` : ''}`;
};

let exitCode = 0;
try {
  const { config } = await fromServer('src/config.js');
  if (config.mongoUri !== db.uri || !/\/foa_test_[^/]*$/.test(db.uri.split('?')[0])) throw new Error('Refusing to run: not connected to a throwaway test database.');
  const { ensureDatabase } = await fromServer('src/app.js');
  await ensureDatabase();
  const { loadDemoMonth } = await fromServer('src/services/demo.js');
  const { systemActor } = await fromServer('src/auth/roles.js');
  const { createToolContext } = await fromServer('src/orchestrator/context.js');
  const { callTool } = await fromServer('src/orchestrator/tools.js');
  const { AuditEvent } = await fromServer('src/models/index.js');

  await loadDemoMonth();
  const approver = systemActor({ id: 'script:orchestrator-tools-demo', name: 'Tools demo (approver)', roles: ['approver'] });
  const ctx = createToolContext({ actor: approver, runId: `tools-demo-${Date.now()}` });
  let calls = 0;
  const use = (name, args = {}) => {
    calls += 1;
    return callTool(ctx, name, args);
  };

  const page = await use('list_invoices', { filter: 'waiting', limit: 50 });
  console.log(`\nWHAT IS WAITING AND WHY (as an approver; ${page.items.length} of ${page.counts.all} invoices need a person)\n`);
  for (const item of page.items) {
    const inv = await use('get_invoice', { invoiceId: item.id });
    console.log(`${txt(inv.invoiceNumber)}  ${txt(inv.supplier)}  ${money(inv.total, inv.currency)}  ${inv.status.replace(/_/g, ' ')}, ${dueText(inv.due)}`);
    const why = inv.reasons.length ? inv.reasons.map(txt) : inv.checks.filter((c) => c.status === 'fail').map((c) => txt(c.detail));
    for (const reason of why) console.log(`    why: ${reason}`);
    if (inv.duplicates.length) console.log(`    possible duplicate of: ${inv.duplicates.map((d) => `${txt(d.invoiceNumber)} (${d.status})`).join(', ')}`);
    const open = inv.actions.filter((a) => a.enabled);
    const mine = open.filter((a) => a.permitted).map((a) => a.id);
    const others = open.filter((a) => !a.permitted).map((a) => `${a.id} (${a.role})`);
    console.log(`    you can: ${mine.join(', ') || 'nothing yet'}`);
    if (others.length) console.log(`    someone else can: ${others.join(', ')}`);
  }

  const payments = await use('list_payments', { status: ['queued', 'processing', 'failed', 'on_hold'] });
  console.log(`\nPAYMENTS NOT FINISHED (${payments.items.length})`);
  for (const p of payments.items)
    console.log(
      `${txt(p.invoiceNumber)}  ${txt(p.supplier)}  ${money(p.amount, p.currency)}  ${p.status}, ${p.method}, scheduled ${p.scheduledFor || '—'}${p.failure ? `, failed: ${txt(p.failure.reason)}` : ''}`,
    );
  if (!payments.items.length) console.log('none');

  const statements = await use('list_statements', {});
  const openStatements = statements.items.filter((s) => s.openCount > 0);
  console.log(`\nBANK LINES TO CHECK (${openStatements.reduce((n, s) => n + s.openCount, 0)})`);
  for (const s of openStatements) {
    const detail = await use('get_statement', { statementId: s.id });
    for (const l of detail.lines.filter((x) => ['suggested', 'exception', 'unmatched'].includes(x.status)))
      console.log(`line ${l.n}  ${l.date}  ${money(l.amount)}  ${l.status}: ${txt(l.reason)}`);
  }
  if (!openStatements.length) console.log('none');

  const queries = (await use('list_queries', {})).items.filter((q) => !['answered', 'closed'].includes(q.status));
  console.log(`\nSUPPLIER EMAILS WAITING (${queries.length})`);
  for (const q of queries) console.log(`${txt(q.supplier)}: "${txt(q.subject)}" (${q.status})`);
  if (!queries.length) console.log('none');

  const due = await use('get_payables', {});
  const account = await use('sim_bank_account', {});
  console.log(`\nCASH (simulated bank, ${due.today})`);
  console.log(`overdue: ${due.overdue.length} invoice(s), due within 7 days: ${due.dueSoon.length}`);
  console.log(`approved and due within 7 days: ${money(due.cash.approvedDue7)}; waiting for a decision and due within 7 days: ${money(due.cash.awaitingDecisionDue7)}`);
  console.log(account.opened ? `available in the simulated account: ${money(account.available, account.currency)}` : 'the simulated account has not been used yet');

  const audited = await AuditEvent.countDocuments({ subjectKind: 'orchestrator', subjectId: ctx.runId });
  console.log(`\n${calls} tool calls, ${audited} audit entries (run ${ctx.runId}), ${ctx.seenIds().length} record ids seen. No AI model was called.`);
} catch (err) {
  console.error(err?.message || err);
  exitCode = 1;
} finally {
  await db.stop();
}
process.exit(exitCode);
