// "Load demo month": wipes everything, runs the seven sample invoices through
// the agent (plus one sent twice), and records what people did next: two
// approvals (one for the received quantity only) with their payments scheduled
// (simulated), and one rejection. That gives
// the supplier emails, the bank statement and the month-end report something
// realistic to work on.

import { Invoice } from '../models/index.js';
import { sampleInvoices, renderInvoiceText } from '../seed/data.js';
import { resetEverything } from '../seed/seed.js';
import { processInvoice, performInvoiceAction } from './invoices.js';
import { recordAudit } from './runs.js';
import { systemActor } from '../auth/roles.js';

// Internal demo actors, used only by this loader (they are not accounts and
// cannot sign in). Two people, so approving and paying stay separate.
const DEMO_APPROVER = systemActor({ id: 'demo:priya', name: 'Priya N (demo)', roles: ['approver'] });
const DEMO_PAYER = systemActor({ id: 'demo:sam', name: 'Sam K (demo)', roles: ['payer'] });

// `by`: the administrator who pressed Load demo month.
export async function loadDemoMonth(by = null) {
  await resetEverything();
  await recordAudit({
    subjectKind: 'system',
    subjectId: 'demo',
    actor: by?.name || 'Demo',
    ...(by?.id ? { actorId: by.id } : {}),
    action: 'demo_loaded',
    detail: 'Everything was deleted and the demo month loaded. The audit log is kept.',
  });

  const ids = {};
  const submit = async (sample) => {
    const invoice = await Invoice.create({ source: { kind: 'sample', sampleId: sample.id, filename: `${sample.invoiceNumber}.txt` }, rawText: renderInvoiceText(sample) });
    await processInvoice(invoice);
    return invoice._id;
  };
  for (const sample of sampleInvoices) ids[sample.id] = await submit(sample);
  await submit(sampleInvoices.find((s) => s.id === 'clean')); // the same invoice again, to show duplicate detection

  // What people would do next. The agent approves nothing: every approval and
  // every scheduled payment below is a person's action (simulated, no money
  // moves). Skipped quietly if the invoice is not in a state that allows it
  // (for example because the reader failed).
  // The two payments are Cheque (paid outside the system), dated early in the
  // month, so the sample bank statement can match them as before. EFT, BPAY
  // and Card now go through the simulated bank on future business days:
  // schedule one from the invoice screen to see that flow.
  const act = async (sampleId, action, input, actor = DEMO_APPROVER) => {
    try {
      await performInvoiceAction(ids[sampleId], action, input, actor);
    } catch {
      /* not in a state that allows this action */
    }
  };
  await act('clean', 'approve', { note: 'Matches PO-2041 and the delivery in full.' });
  await act('clean', 'schedule_payment', { method: 'Cheque', scheduledFor: '2026-10-02' }, DEMO_PAYER);
  await act('quantity-variance', 'approve_received', { note: 'Paying for the 10 pallets received. The other 2 will be paid once they arrive.' });
  await act('quantity-variance', 'schedule_payment', { method: 'Cheque', scheduledFor: '2026-10-03' }, DEMO_PAYER);
  await act('gst-error', 'reject', { note: 'GST is wrong. Asked the supplier to reissue.' });

  const counts = {};
  for (const invoice of await Invoice.find().select('status').lean()) counts[invoice.status] = (counts[invoice.status] || 0) + 1;
  return { invoices: counts };
}
