import { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';

import { config } from '../config.js';
import { Invoice, Vendor, PurchaseOrder, GoodsReceipt } from '../models/index.js';
import { sampleInvoices, findSample, renderInvoiceText, sampleTotals } from '../seed/data.js';
import { resetEverything } from '../seed/seed.js';
import { processInvoice, getInvoiceDetail, applyHumanDecision, performInvoiceAction, getPayables, extractor, abrLookup, visionReader } from '../services/invoices.js';
import { readUpload, NEEDS_OCR } from '../services/uploads.js';
import { createDailySummaryHandler } from '../services/dailySummary.js';
import { createMailer } from '../services/mailer.js';
import { HttpError } from '../services/runs.js';
import { registerFinanceRoutes } from './finance.js';
import { createWorkLimiter } from '../rateLimit.js';

const MAX_TEXT = 200_000;
// Vercel refuses request bodies over 4.5 MB before they reach the app, so uploads stop at 4 MB.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

// Requests that call Groq or process a file. See rateLimit.js.
const work = createWorkLimiter(config.rateLimit);
// Person's actions that send the invoice back through the agent.
const RERUN_ACTIONS = new Set(['rerun', 'link_po', 'clear_duplicate', 'edit_fields']);
const workIfRerun = (req, res, next) => (RERUN_ACTIONS.has(req.params.action) ? work(req, res, next) : next());

// Express 4 does not catch errors from async handlers on its own.
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const requireId = (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'That invoice no longer exists.');
  return req.params.id;
};

export const api = Router();

api.get('/health', (req, res) => {
  res.json({
    ok: true,
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    reader: { mode: extractor.mode, model: extractor.model, vision: visionReader ? visionReader.model : null },
    policy: config.policy,
    abr: Boolean(abrLookup),
    roles: { reviewers: config.roles.reviewers.length > 0, approvers: config.roles.approvers.length > 0, payers: config.roles.payers.length > 0 },
    demoMode: config.demoMode,
    timeZone: config.timeZone,
  });
});

api.get('/samples', (req, res) => {
  res.json(sampleInvoices.map((s) => ({ id: s.id, title: s.title, hint: s.hint, vendorName: s.vendor.name, total: sampleTotals(s).total })));
});

// Suppliers, purchase orders and deliveries the agent checks against.
api.get(
  '/reference',
  wrap(async (req, res) => {
    const [vendors, purchaseOrders, goodsReceipts] = await Promise.all([
      Vendor.find().sort({ name: 1 }).lean(),
      PurchaseOrder.find().sort({ poNumber: 1 }).lean(),
      GoodsReceipt.find().sort({ poNumber: 1 }).lean(),
    ]);
    res.json({ vendors, purchaseOrders, goodsReceipts });
  }),
);

api.get(
  '/invoices',
  wrap(async (req, res) => {
    const invoices = await Invoice.find()
      .select(
        'status source createdAt extracted.vendorName extracted.invoiceNumber extracted.total extracted.currency decision checks.id checks.status approval.decision due match.score.total recovery.status',
      )
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json(invoices);
  }),
);

api.get(
  '/invoices/:id',
  wrap(async (req, res) => {
    res.json(await getInvoiceDetail(requireId(req)));
  }),
);

// Add an invoice (sample, pasted text or uploaded file) and run the agent on it.
api.post(
  '/invoices',
  work,
  upload.single('file'),
  wrap(async (req, res) => {
    let source;
    let rawText;
    let reading = null; // a scan or photo already read by the vision reader

    if (req.file) {
      ({ source, rawText, reading = null } = await readUpload(req.file, { vision: visionReader }));
    } else if (req.body?.sampleId) {
      const sample = findSample(req.body.sampleId);
      if (!sample) throw new HttpError(400, 'That sample does not exist.');
      source = { kind: 'sample', sampleId: sample.id, filename: `${sample.invoiceNumber}.txt` };
      rawText = renderInvoiceText(sample);
    } else if (typeof req.body?.text === 'string') {
      source = { kind: 'paste' };
      rawText = req.body.text;
    } else {
      throw new HttpError(400, 'Send a file, some invoice text or a sample to process.');
    }

    rawText = rawText.replace(/\u0000/g, '').trim();
    if (!rawText) {
      throw new HttpError(400, req.file ? NEEDS_OCR : 'The invoice text is empty.');
    }
    if (rawText.length > MAX_TEXT) throw new HttpError(400, 'That is too much text for one invoice.');

    const invoice = await Invoice.create({ source, rawText });
    await processInvoice(invoice, { reading });
    res.status(201).json(await getInvoiceDetail(invoice._id));
  }),
);

// Run the agent again, for example after fixing the Groq key or receiving the missing goods.
api.post(
  '/invoices/:id/rerun',
  work,
  wrap(async (req, res) => {
    res.json(await performInvoiceAction(requireId(req), 'rerun', { decidedBy: 'Reviewer', ...(req.body || {}) }));
  }),
);

// Every person's action on an invoice. The backend checks the status, the
// person's role and the required note; see agent/finance/lifecycle.js.
api.post(
  '/invoices/:id/actions/:action',
  workIfRerun,
  wrap(async (req, res) => {
    res.json(await performInvoiceAction(requireId(req), req.params.action, req.body || {}));
  }),
);

// Earlier API: { decision: approve | approve_received | reject, decidedBy, note }.
api.post(
  '/invoices/:id/approval',
  wrap(async (req, res) => {
    res.json(await applyHumanDecision(requireId(req), req.body || {}));
  }),
);

// Overdue and due-soon invoices, and the cash needed.
api.get(
  '/payables',
  wrap(async (req, res) => {
    res.json(await getPayables());
  }),
);

api.post(
  '/reset',
  wrap(async (req, res) => {
    if (!config.demoMode) throw new HttpError(403, 'Reset is only available in demo mode.');
    await resetEverything();
    res.json({ ok: true });
  }),
);

registerFinanceRoutes(api, { upload, work });

// The daily summary email, called once a day by a Vercel cron job with
// Authorization: Bearer CRON_SECRET. ?preview=1 returns the email without sending it.
api.get(
  '/cron/daily-summary',
  wrap(
    createDailySummaryHandler({
      secret: config.alerts.cronSecret,
      recipients: config.alerts.recipients,
      appUrl: config.alerts.appUrl,
      companyName: config.companyName,
      mailer: createMailer(config.alerts),
    }),
  ),
);

api.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 4 MB. Upload a smaller file, or split it.' : 'The upload could not be read.';
    return res.status(400).json({ error: message });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much text.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Check the server log.' });
});
