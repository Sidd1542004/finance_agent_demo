// Routes for vendor queries, bank reconciliation, month-end reporting and the
// demo loader. Registered on the main API router in api.js.

import mongoose from 'mongoose';

import { config } from '../config.js';
import { VendorQuery, BankStatement, Report } from '../models/index.js';
import { sampleQueries, findSampleQuery, sampleStatement } from '../seed/data.js';
import { emailAddress } from '../agent/finance/queryRules.js';
import { isMonth, monthOf, figuresToCsv } from '../agent/finance/reportFigures.js';
import { HttpError } from '../services/runs.js';
import { processQuery, getQueryDetail, resolveQuery } from '../services/queries.js';
import { processStatement, getStatementDetail, resolveLine } from '../services/statements.js';
import { writeReport, getReportDetail } from '../services/reports.js';
import { loadDemoMonth } from '../services/demo.js';

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const requireId = (req, what) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, `That ${what} no longer exists.`);
  return req.params.id;
};

export function registerFinanceRoutes(api, { upload }) {
  // ---------- Vendor queries ----------

  api.get('/query-samples', (req, res) => {
    res.json(sampleQueries.map((q) => ({ id: q.id, title: q.title, hint: q.hint, from: q.from, subject: q.subject })));
  });

  api.get('/queries', wrap(async (req, res) => {
    res.json(await VendorQuery.find().select('status from subject createdAt supplier.name decision.outcome').sort({ createdAt: -1 }).limit(200).lean());
  }));

  api.get('/queries/:id', wrap(async (req, res) => {
    res.json(await getQueryDetail(requireId(req, 'email')));
  }));

  api.post('/queries', wrap(async (req, res) => {
    let fields;
    if (req.body?.sampleId) {
      const sample = findSampleQuery(req.body.sampleId);
      if (!sample) throw new HttpError(400, 'That sample does not exist.');
      fields = { source: { kind: 'sample', sampleId: sample.id }, from: sample.from, subject: sample.subject, body: sample.body };
    } else {
      const from = String(req.body?.from || '').trim().slice(0, 200);
      const subject = String(req.body?.subject || '').trim().slice(0, 200);
      const body = String(req.body?.body || '').replace(/\u0000/g, '').trim();
      if (!emailAddress(from)) throw new HttpError(400, "Enter the sender's email address.");
      if (!body) throw new HttpError(400, 'Paste the text of the email.');
      if (body.length > 20000) throw new HttpError(400, 'That is too much text for one email.');
      fields = { source: { kind: 'manual' }, from, subject, body };
    }
    const query = await VendorQuery.create(fields);
    await processQuery(query);
    res.status(201).json(await getQueryDetail(query._id));
  }));

  api.post('/queries/:id/rerun', wrap(async (req, res) => {
    const query = await VendorQuery.findById(requireId(req, 'email'));
    if (!query) throw new HttpError(404, 'That email no longer exists.');
    if (!['failed', 'needs_person'].includes(query.status)) throw new HttpError(409, 'Only emails that failed or are waiting for a person can be processed again.');
    await processQuery(query);
    res.json(await getQueryDetail(query._id));
  }));

  api.post('/queries/:id/resolution', wrap(async (req, res) => {
    res.json(await resolveQuery(requireId(req, 'email'), req.body || {}));
  }));

  // ---------- Bank reconciliation ----------

  api.get('/statement-sample', (req, res) => {
    const { id, title, hint, filename } = sampleStatement;
    res.json({ id, title, hint, filename });
  });

  api.get('/statements', wrap(async (req, res) => {
    const docs = await BankStatement.find().select('status source createdAt lines.status lines.amount').sort({ createdAt: -1 }).limit(100).lean();
    res.json(
      docs.map((s) => ({
        _id: s._id,
        status: s.status,
        source: s.source,
        createdAt: s.createdAt,
        lineCount: s.lines.length,
        openCount: s.lines.filter((l) => ['suggested', 'exception', 'unmatched'].includes(l.status)).length,
      })),
    );
  }));

  api.get('/statements/:id', wrap(async (req, res) => {
    res.json(await getStatementDetail(requireId(req, 'statement')));
  }));

  api.post('/statements', upload.single('file'), wrap(async (req, res) => {
    let source;
    let rawText;
    if (req.file) {
      const name = req.file.originalname || 'upload';
      if (!/\.(csv|txt)$/i.test(name) && !req.file.mimetype?.startsWith('text/')) throw new HttpError(400, 'Upload the statement as a CSV file.');
      source = { kind: 'upload', filename: name };
      rawText = req.file.buffer.toString('utf8');
    } else if (req.body?.sampleId) {
      if (req.body.sampleId !== sampleStatement.id) throw new HttpError(400, 'That sample does not exist.');
      source = { kind: 'sample', filename: sampleStatement.filename };
      rawText = sampleStatement.csv;
    } else if (typeof req.body?.text === 'string') {
      source = { kind: 'paste' };
      rawText = req.body.text;
    } else {
      throw new HttpError(400, 'Send a CSV file, some statement text or the sample.');
    }
    rawText = rawText.replace(/^﻿/, '').replace(/\u0000/g, '').trim();
    if (!rawText) throw new HttpError(400, 'The statement is empty.');
    if (rawText.length > 200_000) throw new HttpError(400, 'That statement is too large. Split it into smaller files.');

    const statement = await BankStatement.create({ source, rawText });
    await processStatement(statement);
    res.status(201).json(await getStatementDetail(statement._id));
  }));

  api.post('/statements/:id/rerun', wrap(async (req, res) => {
    const statement = await BankStatement.findById(requireId(req, 'statement'));
    if (!statement) throw new HttpError(404, 'That statement no longer exists.');
    // A statement a person has started deciding is not run again, so their work is not lost.
    if (statement.status !== 'failed') throw new HttpError(409, 'Only statements that could not be reconciled can be processed again.');
    await processStatement(statement);
    res.json(await getStatementDetail(statement._id));
  }));

  api.post('/statements/:id/lines/:n/resolution', wrap(async (req, res) => {
    res.json(await resolveLine(requireId(req, 'statement'), req.params.n, req.body || {}));
  }));

  // ---------- Month-end reporting ----------

  api.get('/reports', wrap(async (req, res) => {
    res.json(await Report.find().select('month status createdAt figures.label').sort({ createdAt: -1 }).limit(100).lean());
  }));

  api.get('/reports/:id', wrap(async (req, res) => {
    res.json(await getReportDetail(requireId(req, 'report')));
  }));

  api.get('/reports/:id/csv', wrap(async (req, res) => {
    const { report } = await getReportDetail(requireId(req, 'report'));
    if (!report.figures) throw new HttpError(409, 'This report has no figures to download.');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="month-end-${report.month}.csv"`);
    res.send(figuresToCsv(report.figures));
  }));

  api.post('/reports', wrap(async (req, res) => {
    const month = req.body?.month || monthOf(new Date());
    if (!isMonth(month)) throw new HttpError(400, 'Choose a month for the report.');
    res.status(201).json(await writeReport(month));
  }));

  // ---------- Demo ----------

  api.post('/demo/load', wrap(async (req, res) => {
    if (!config.demoMode) throw new HttpError(403, 'The demo month is only available in demo mode.');
    res.json(await loadDemoMonth());
  }));
}
