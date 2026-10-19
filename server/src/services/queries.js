// Vendor queries: run the agent on a supplier email, and apply the human
// decision when the agent hands one over.

import { createVendorQueryAgent } from '../agent/finance/vendorQueryAgent.js';
import { createQueryReader } from '../agent/finance/readQuery.js';
import { emailAddress } from '../agent/finance/queryRules.js';
import { sampleLedger } from '../integrations/sampleLedger.js';
import { VendorQuery, OutboxMessage } from '../models/index.js';
import { config } from '../config.js';
import { HttpError, runAndRecord, latestRun, addHumanStep, whoAndWhy, failedDecision } from './runs.js';

const agent = createVendorQueryAgent({
  ledger: sampleLedger,
  read: createQueryReader(config),
  policy: config.policy,
  companyName: config.companyName,
  save: (query) => query.save(),
});

export async function processQuery(query) {
  const result = await runAndRecord(agent, { query }, { kind: 'query', id: query._id });
  if (!result.outcome) await VendorQuery.updateOne({ _id: query._id }, { $set: { status: 'failed', decision: failedDecision(result) } });
  return result;
}

export async function getQueryDetail(id) {
  const query = await VendorQuery.findById(id).lean();
  if (!query) throw new HttpError(404, 'That email no longer exists.');
  const [run, message] = await Promise.all([latestRun(id), OutboxMessage.findOne({ queryId: id }).lean()]);
  return { query, run, message };
}

/**
 * A person sends a reply to, or closes, an email the agent handed over.
 * Only emails waiting for a person can be decided, and only once.
 */
export async function resolveQuery(id, input) {
  const { action } = input;
  if (!['send', 'close'].includes(action)) throw new HttpError(400, 'Choose to send a reply or close the email.');
  const { who, why } = whoAndWhy(input);
  const body = String(input.body || '')
    .trim()
    .slice(0, 8000);
  if (action === 'send' && !body) throw new HttpError(400, 'Write the reply before sending it.');
  if (action === 'close' && !why) throw new HttpError(400, 'Add a note saying why no reply is being sent.');

  const resolution = { action, decidedBy: who, note: why, decidedAt: new Date().toISOString() };
  const query = await VendorQuery.findOneAndUpdate({ _id: id, status: 'needs_person' }, { $set: { status: action === 'send' ? 'answered' : 'closed', resolution } }, { new: true });
  if (!query) {
    if (!(await VendorQuery.exists({ _id: id }))) throw new HttpError(404, 'That email no longer exists.');
    throw new HttpError(409, 'This email is not waiting for a person. It may already have been handled.');
  }

  if (action === 'send') {
    const subject = /^re:/i.test(query.subject) ? query.subject : `Re: ${query.subject || 'Your invoice query'}`;
    try {
      // The agent's own reply, if any, was held. Replace it with the person's.
      await OutboxMessage.deleteMany({ queryId: query._id, status: { $ne: 'sent' } });
      await OutboxMessage.create({
        queryId: query._id,
        to: emailAddress(query.from),
        subject: query.draft?.subject || subject,
        body,
        sentBy: who,
        status: 'sent',
        sentAt: new Date(),
      });
    } catch (err) {
      await VendorQuery.updateOne({ _id: id }, { $set: { status: 'needs_person', resolution: null } });
      throw new HttpError(422, `The reply could not be placed in the outbox (${err.message}). The email is still waiting.`);
    }
    await addHumanStep(id, `Reply sent by ${who}.${why ? ` Note: ${why}` : ''}`, 'answered');
  } else {
    await addHumanStep(id, `Closed without a reply by ${who}. Note: ${why}`, 'closed');
  }
  return getQueryDetail(id);
}
