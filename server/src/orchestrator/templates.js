// Answers written from the records alone (docs/phase2-design.md §3.7): the
// answer for list intents, and the fallback for the explaining ones when the
// model is unavailable or its text does not match the records. Every figure
// here comes from the facts (facts.js); nothing is invented.

const words = (s) => String(s ?? '').replace(/_/g, ' ');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (n, currency = 'AUD') =>
  typeof n === 'number' ? new Intl.NumberFormat('en-AU', { style: 'currency', currency: /^[A-Z]{3}$/.test(currency || '') ? currency : 'AUD' }).format(n) : 'an unknown amount';
const text = (v) => (v && typeof v === 'object' ? (v.untrusted_text ?? null) : (v ?? null));
const sentence = (s) => (s && !/[.!?]$/.test(s) ? `${s}.` : s);
const join = (parts) => parts.filter(Boolean).join(' ');

const ref = (f) => f.invoiceNumber || 'An invoice without a number';
const dueText = (d) => (!d?.date ? '' : d.state === 'overdue' ? `overdue since ${d.date}` : `due ${d.date}`);

function invoiceLine(f) {
  const checks = f.failedChecks?.length ? ` Checks to look at: ${f.failedChecks.map(words).join(', ')}.` : '';
  return `${ref(f)}${f.supplier ? ` from ${f.supplier}` : ''}: ${words(f.status)}, ${money(f.total, f.currency)}${dueText(f.due) ? `, ${dueText(f.due)}` : ''}.${checks}`;
}

// The invoice detail's own explanation: reasons, failed checks, who can act, recent history.
function invoiceStory(view, history) {
  const reasons = (view.reasons || []).map(text).filter(Boolean);
  const failed = (view.checks || [])
    .filter((c) => c.status === 'fail')
    .map((c) => text(c.detail))
    .filter(Boolean);
  const why = [...new Set([...reasons, ...failed])].slice(0, 5);
  const open = (view.actions || []).filter((a) => a.enabled);
  const mine = open.filter((a) => a.permitted).map((a) => words(a.id));
  const others = open.filter((a) => !a.permitted).map((a) => `${words(a.id)} (${a.role})`);
  const last = history.slice(-3).map((e) => `${(e.at || '').slice(0, 10)}: ${e.summary}`);
  return join([
    why.length ? `Why: ${why.map(sentence).join(' ')}` : '',
    mine.length ? `You can: ${mine.join(', ')}.` : '',
    others.length ? `Others can: ${others.join(', ')}.` : '',
    last.length ? `Recent history: ${last.join(' ')}` : '',
  ]);
}

function paymentLine(p) {
  const parts = [
    money(p.amount, p.currency),
    p.scheduledFor && `scheduled for ${p.scheduledFor}`,
    p.txnRef && `bank reference ${p.txnRef}`,
    p.failure && `failure: ${words(p.failure)}`,
  ];
  return `Payment ${words(p.status)}${p.method ? ` by ${p.method}` : ''}: ${parts.filter(Boolean).join(', ')}.`;
}

const STAGE_WORDS = { approval: 'waiting for approval', review: 'waiting for review', on_hold: 'on hold', any: 'waiting for a person' };

/** { summary, items: [{ handle, text }] } for the intent, from the facts and the plan's views. */
export function templateAnswer(intent, args, facts, state) {
  const invoices = facts.records.filter((r) => r.kind === 'invoice');
  const payments = facts.records.filter((r) => r.kind === 'payment');
  const suppliers = facts.records.filter((r) => r.kind === 'supplier');
  const lines = facts.records.filter((r) => r.kind === 'bank_line');
  const itemsFor = (list, fn) => list.map((f) => ({ handle: f.handle, text: fn(f) }));

  switch (intent) {
    case 'list_pending_invoices': {
      const what = STAGE_WORDS[args.stage || 'any'];
      return {
        summary: invoices.length ? `${plural(invoices.length, 'invoice is', 'invoices are')} ${what}.` : `No invoices are ${what}.`,
        items: itemsFor(invoices, invoiceLine),
      };
    }
    case 'list_unpaid_invoices': {
      const total = state.open?.total ?? invoices.length;
      const cash = state.payables?.cash;
      return {
        summary: join([
          total
            ? `${plural(total, 'invoice is', 'invoices are')} unpaid${total > invoices.length ? ` (the newest ${invoices.length} are listed)` : ''}.`
            : 'No invoices are unpaid.',
          cash ? `Approved and due within 7 days: ${money(cash.approvedDue7)}. Waiting for a decision and due within 7 days: ${money(cash.awaitingDecisionDue7)}.` : '',
        ]),
        items: itemsFor(invoices, invoiceLine),
      };
    }
    case 'find_invoice':
    case 'explain_invoice_status': {
      const f = invoices[0];
      if (!f) return { summary: 'That invoice could not be read.', items: [] };
      return {
        summary: `${ref(f)} from ${f.supplier || 'an unknown supplier'} is ${words(f.status)}${dueText(f.due) ? `, ${dueText(f.due)}` : ''}.`,
        items: [{ handle: f.handle, text: invoiceStory(state.invoice || {}, facts.history) || invoiceLine(f) }, ...itemsFor(payments, paymentLine)],
      };
    }
    case 'payment_status': {
      if (state.invoiceId) {
        const f = invoices[0];
        const p = payments[0];
        if (!f) return { summary: 'That invoice could not be read.', items: [] };
        const summary = p
          ? `${ref(f)}: ${paymentLine(p)}`
          : f.status === 'approved'
            ? `${ref(f)} is approved, but no payment is scheduled yet.`
            : `${ref(f)} is not approved for payment yet: it is ${words(f.status)}.`;
        return { summary, items: [{ handle: f.handle, text: invoiceStory(state.invoice || {}, []) || invoiceLine(f) }] };
      }
      const approved = invoices.filter((i) => i.status === 'approved').length;
      const failedInvoices = invoices.filter((i) => i.status === 'payment_failed').length;
      const held = payments.length;
      const changes = suppliers.length;
      const account = facts.records.find((r) => r.kind === 'account');
      const blockers = [
        approved ? `${plural(approved, 'approved invoice has', 'approved invoices have')} no scheduled payment` : '',
        failedInvoices ? `${plural(failedInvoices, 'invoice has', 'invoices have')} a failed payment` : '',
        held ? `${plural(held, 'payment is', 'payments are')} failed or on hold` : '',
        changes ? `${plural(changes, 'supplier has', 'suppliers have')} a bank-details change waiting for approval (their payments are held)` : '',
      ].filter(Boolean);
      return {
        summary: join([
          blockers.length ? `${sentence(blockers.join('; '))}` : 'Nothing is blocking payments.',
          account ? `Available in the simulated account: ${money(account.available, account.currency)}.` : '',
        ]),
        items: [
          ...itemsFor(invoices, invoiceLine),
          ...itemsFor(payments, paymentLine),
          ...itemsFor(suppliers, (s) => `${s.name}: a change to their bank details is waiting for approval.`),
        ],
      };
    }
    case 'supplier_summary': {
      const unmatched = facts.records.find((r) => r.kind === 'unmatched_supplier');
      const one = state.abn ? suppliers[0] : null;
      const summary = state.abn
        ? one
          ? one.openCount
            ? `${one.name} has ${plural(one.openCount, 'unpaid invoice')}, ${money(one.openTotal)} in all.`
            : `${one.name} has no unpaid invoices.`
          : 'That supplier is not on file.'
        : suppliers.length
          ? `${plural(suppliers.length, 'supplier has', 'suppliers have')} unpaid invoices.${unmatched ? ` ${plural(unmatched.openCount, 'unpaid invoice is', 'unpaid invoices are')} from a supplier not on file.` : ''}`
          : 'No supplier has unpaid invoices.';
      return {
        summary,
        items: itemsFor(suppliers, (s) =>
          join([
            sentence(
              `${plural(s.openCount, 'unpaid invoice')}, ${money(s.openTotal)}${s.overdue ? `, ${s.overdue} overdue` : ''}${s.oldestDue ? `, oldest due ${s.oldestDue}` : ''}`,
            ),
            s.pendingChange ? 'A change to their bank details is waiting for approval, so payments to them are held.' : '',
          ]),
        ),
      };
    }
    case 'reconciliation_exceptions':
      return {
        summary: lines.length
          ? `${plural(lines.length, 'bank line needs', 'bank lines need')} a decision. Review them on the Bank screen.`
          : 'No bank lines are waiting for a decision.',
        items: itemsFor(lines, (l) => sentence(join([`${l.date}, ${money(l.amount)}: ${words(l.status)}.`, l.reason || '']))),
      };
    case 'ingestion_status': {
      const boxes = facts.records.filter((r) => r.kind === 'mailbox');
      if (!boxes.length) return { summary: 'Mailbox ingestion is not set up on this server.', items: [] };
      return {
        summary: boxes
          .map(
            (b) =>
              `${b.provider}: ${words(b.state)}, polling ${b.enabled ? 'on' : 'off'}${b.lastPollAt ? `, last checked ${b.lastPollAt.slice(0, 16).replace('T', ' ')} UTC` : ''}${b.counts ? `, ${plural(b.counts.imported ?? 0, 'invoice')} imported` : ''}.`,
          )
          .join(' '),
        items: [],
      };
    }
    case 'record_history':
      return { summary: facts.history.length ? `${plural(facts.history.length, 'entry', 'entries')} in the history.` : 'Nothing is recorded for that yet.', items: [] };
    default:
      return { summary: '', items: [] };
  }
}
