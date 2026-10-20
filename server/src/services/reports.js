// Month-end reporting: run the agent for a month and keep the result.

import { createReportAgent, createWriter } from '../agent/finance/reportAgent.js';
import { sampleLedger } from '../integrations/sampleLedger.js';
import { Report } from '../models/index.js';
import { config } from '../config.js';
import { HttpError, runAndRecord, latestRun, failedDecision, auditFailed } from './runs.js';

const agent = createReportAgent({
  ledger: sampleLedger,
  writer: createWriter(config),
  save: (report) => report.save(),
});

export async function writeReport(month) {
  const report = await Report.create({ month });
  const result = await runAndRecord(agent, { report }, { kind: 'report', id: report._id });
  if (!result.outcome) {
    const from = report.status;
    await Report.updateOne({ _id: report._id }, { $set: { status: 'failed', decision: failedDecision(result) } });
    await auditFailed('report', report._id, from, result);
  }
  return getReportDetail(report._id);
}

export async function getReportDetail(id) {
  const report = await Report.findById(id).lean();
  if (!report) throw new HttpError(404, 'That report no longer exists.');
  return { report, run: await latestRun(id) };
}
