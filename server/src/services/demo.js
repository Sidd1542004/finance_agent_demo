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

const DEMO_APPROVER = 'Priya N (demo)';
const DEMO_PAYER = 'Sam K (demo)';

export async function loadDemoMonth() {
  await resetEverything();
  await recordAudit({
    subjectKind: 'system',
    subjectId: 'demo',
    actor: 'Demo',
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
  const act = async (sampleId, action, input) => {
    try {
      await performInvoiceAction(ids[sampleId], action, { decidedBy: DEMO_APPROVER, ...input });
    } catch {
      /* not in a state that allows this action */
    }
  };
  await act('clean', 'approve', { note: 'Matches PO-2041 and the delivery in full.' });
  await act('clean', 'schedule_payment', { decidedBy: DEMO_PAYER, method: 'EFT', scheduledFor: '2026-10-02' });
  await act('quantity-variance', 'approve_received', { note: 'Paying for the 10 pallets received. The other 2 will be paid once they arrive.' });
  await act('quantity-variance', 'schedule_payment', { decidedBy: DEMO_PAYER, method: 'EFT', scheduledFor: '2026-10-03' });
  await act('gst-error', 'reject', { note: 'GST is wrong. Asked the supplier to reissue.' });

  const counts = {};
  for (const invoice of await Invoice.find().select('status').lean()) counts[invoice.status] = (counts[invoice.status] || 0) + 1;
  return { invoices: counts };
}
