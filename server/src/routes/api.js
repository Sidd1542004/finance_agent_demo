import { Router } from 'express';
import { inRequestDeadline } from '../llm/deadline.js';
import mongoose from 'mongoose';
import multer from 'multer';

import { config } from '../config.js';
import { Invoice } from '../models/index.js';
import { sampleInvoices, findSample, renderInvoiceText, sampleTotals } from '../seed/data.js';
import { resetEverything } from '../seed/seed.js';
import {
  processInvoice,
  getInvoiceDetail,
  applyHumanDecision,
  performInvoiceAction,
  getPayables,
  extractor,
  abrLookup,
  visionReader,
  readerFallbackStatus,
} from '../services/invoices.js';
import { readUpload, uploadKind, NEEDS_OCR } from '../services/uploads.js';
import { policySnapshot } from '../services/policySettings.js';
import { keepInvoiceDocument, listInvoiceDocuments, openInvoiceDocument, inlineDisposition, DOCUMENT_HEADERS } from '../services/invoiceDocuments.js';
import { listInvoices, getReference, listAuditEntries } from '../services/listings.js';
import { HttpError, recordAudit } from '../services/runs.js';
import { registerFinanceRoutes } from './finance.js';
import { createWorkLimiter } from '../rateLimit.js';
import { requireUser, requireRole, requireAnyRole, actorOf } from '../auth/middleware.js';
import { createDemoResetHandler, demoResetBlocked } from '../services/demoReset.js';
import { registerIngestionPublicRoutes, registerIngestionRoutes } from './ingestion.js';
import { registerOrchestratorRoutes } from './orchestrator.js';
import { registerDisputeRoutes } from './disputes.js';
import { createAuthRouter } from './auth.js';
import { createAdminRouter } from './admin.js';
import { createSettingsRouter } from './settings.js';
import { registerSupplierRoutes } from './suppliers.js';
import { registerPaymentRoutes, registerAdminPaymentRoutes } from './payments.js';
import { createCronRouter } from './cron.js';

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
// Inside the request's deadline (llm/deadline.js), even after a body parser.
const wrap = (handler) => (req, res, next) => Promise.resolve(inRequestDeadline(req, () => handler(req, res, next))).catch(next);

// The signed-in person, as the actor of an action (auth/middleware.js). Whatever
// name the request body types is ignored: the session decides who acted.
export { actorOf };
export const withoutTypedName = (body) => {
  const { decidedBy: _ignored, ...rest } = body || {};
  return rest;
};

const requireId = (req) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'That invoice no longer exists.');
  return req.params.id;
};

export const api = Router();

api.get(
  '/health',
  // Open, for uptime checks and the dashboard's "can I reach the server": nothing else.
  // The settings the dashboard needs are in GET /api/status (signed in).
  (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
  },
);

// Sign in / out. Open: these are how a person gets a session.
api.use('/auth', createAuthRouter());

// Every scheduler endpoint (daily summary, payment tick, mailbox ingestion),
// behind one CRON_SECRET guard that covers every /api/cron path. See routes/cron.js.
api.use('/cron', createCronRouter());

// The mailbox OAuth callback: checks the signed-in administrator and the one-time state itself.
registerIngestionPublicRoutes(api);

// Everything below needs a signed-in user with at least one role. Each route
// that changes something also checks the specific role it needs.
api.use(requireUser);
api.use(requireAnyRole);

// What the dashboard needs to know about this server: the reader, the policy, the
// demo controls and the time zone. Any role (it used to be part of /api/health).
api.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    reader: { mode: extractor.mode, model: extractor.model, vision: visionReader ? visionReader.model : null },
    // The live policy (the Settings screen's values), with its version.
    policy: { ...config.policy, version: policySnapshot().version },
    abr: Boolean(abrLookup),
    auth: 'accounts',
    demoMode: config.demoMode,
    // Whether Reset and Load demo month are allowed here (demo mode, not Production).
    demoReset: demoResetBlocked() === null,
    timeZone: config.timeZone,
  });
});

// The agent's policy: read by any role, changed by administrators (routes/settings.js).
api.use('/settings', createSettingsRouter());

const adminRouter = createAdminRouter();
registerAdminPaymentRoutes(adminRouter);
api.use('/admin', adminRouter);

api.get('/samples', (req, res) => {
  res.json(sampleInvoices.map((s) => ({ id: s.id, title: s.title, hint: s.hint, vendorName: s.vendor.name, total: sampleTotals(s).total })));
});

// Suppliers, purchase orders and deliveries the agent checks against.
// Never the suppliers' bank details: only whether they are verified (see services/listings.js).
api.get(
  '/reference',
  wrap(async (req, res) => {
    res.json(await getReference(actorOf(req)));
  }),
);

api.get(
  '/invoices',
  wrap(async (req, res) => {
    // ?filter=waiting (needs a person) | pay (approved, to pay) | all, plus ?before= and ?limit= (see services/paging.js).
    res.json(await listInvoices(actorOf(req), req.query));
  }),
);

// For the dashboard header: invoices read by the rules reader because the AI reader
// failed, still waiting for a person (null without an AI reader). Any role.
api.get(
  '/invoices/summary',
  wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ readerFallback: extractor.mode === 'groq' ? await readerFallbackStatus() : null });
  }),
);

api.get(
  '/invoices/:id',
  wrap(async (req, res) => {
    res.json(await getInvoiceDetail(requireId(req), actorOf(req)));
  }),
);

// The documents behind an invoice: its original (or its text), the purchase
// order and the delivery slip (services/invoiceDocuments.js). Same access as the
// invoice itself: any signed-in user with a role.
api.get(
  '/invoices/:id/documents',
  wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ items: await listInvoiceDocuments(requireId(req), req.user) });
  }),
);

// One of them, inline: kind = invoice | purchase_order | delivery_slip. Only
// application/pdf, image/png, image/jpeg or text/plain is ever sent. A clear
// JSON error (404 with the reason) when that document does not exist.
api.get(
  '/invoices/:id/documents/:kind',
  wrap(async (req, res) => {
    const { buffer, contentType, filename } = await openInvoiceDocument(requireId(req), req.params.kind, req.user);
    res.set({ ...DOCUMENT_HEADERS, 'Content-Type': contentType, 'Content-Length': String(buffer.length), 'Content-Disposition': inlineDisposition(filename) });
    res.end(buffer);
  }),
);

// Add an invoice (sample, pasted text or uploaded file) and run the agent on it.
api.post(
  '/invoices',
  requireRole('reviewer'),
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
    // The original PDF, so it can be viewed in the app (images and text are not kept).
    // The original file, so it can be viewed in the app (PDF, PNG, JPEG or plain text; the bytes decide).
    if (req.file) await keepInvoiceDocument(invoice._id, { buffer: req.file.buffer, filename: req.file.originalname, text: uploadKind(req.file) === 'text' });
    await processInvoice(invoice, { reading });
    res.status(201).json(await getInvoiceDetail(invoice._id, actorOf(req)));
  }),
);

// Run the agent again, for example after fixing the Groq key or receiving the missing goods.
api.post(
  '/invoices/:id/rerun',
  work,
  wrap(async (req, res) => {
    res.json(await performInvoiceAction(requireId(req), 'rerun', withoutTypedName(req.body), actorOf(req)));
  }),
);

// Every person's action on an invoice. The backend checks the status, the
// person's role and the required note; see agent/finance/lifecycle.js.
api.post(
  '/invoices/:id/actions/:action',
  workIfRerun,
  wrap(async (req, res) => {
    res.json(await performInvoiceAction(requireId(req), req.params.action, withoutTypedName(req.body), actorOf(req)));
  }),
);

// Earlier API: { decision: approve | approve_received | reject, decidedBy, note }.
api.post(
  '/invoices/:id/approval',
  wrap(async (req, res) => {
    res.json(await applyHumanDecision(requireId(req), withoutTypedName(req.body), actorOf(req)));
  }),
);

// The append-only audit log: every status change of an invoice, payment,
// supplier email, bank line or report. Read only: no route changes or deletes it.
// ?subjectId=<id> gives one record's history, oldest first (a bank line's id is
// "<statement id>:<line number>"); without it, the latest entries, newest first.
api.get(
  '/audit',
  wrap(async (req, res) => {
    // Bank-detail entries are masked, or hidden from reviewers.
    res.json(await listAuditEntries(actorOf(req), req.query));
  }),
);

// Overdue and due-soon invoices, and the cash needed.
api.get(
  '/payables',
  wrap(async (req, res) => {
    res.json(await getPayables());
  }),
);

// Demo Reset: administrators only (and CSRF, as every change). Refused on
// Production and outside demo mode; needs { confirm: 'RESET' }; one at a time;
// audited. Scope and rules: services/demoReset.js.
api.post('/reset', requireRole('admin'), wrap(createDemoResetHandler({ reset: resetEverything, audit: recordAudit })));

registerFinanceRoutes(api, { upload, work });
registerSupplierRoutes(api, { work });
registerPaymentRoutes(api);
// Queries to suppliers about an invoice's variance (routes/disputes.js). Nothing is sent without a person.
registerDisputeRoutes(api);
registerIngestionRoutes(api, { work });
// The assistant: read-only questions about the records (routes/orchestrator.js).
registerOrchestratorRoutes(api, { work });

api.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
api.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 4 MB. Upload a smaller file, or split it.' : 'The upload could not be read.';
    return res.status(400).json({ error: message });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ ...(err.extra || {}), error: err.message });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much text.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Check the server log.' });
});
