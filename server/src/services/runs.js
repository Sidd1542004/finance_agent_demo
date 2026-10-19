// Shared by the vendor query, reconciliation and report services: run an agent
// and keep its six-step trail.

import { runAgent } from '../agent/core/loop.js';
import { AgentRun } from '../models/index.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function runAndRecord(agent, input, { kind, id }) {
  const run = await AgentRun.create({ agent: agent.name, subjectKind: kind, subjectId: id, status: 'running', steps: [] });
  const result = await runAgent(agent, input, {
    onStep: async (_step, steps) => {
      run.steps = [...steps];
      await run.save();
    },
  });
  run.status = result.outcome || 'failed';
  run.finishedAt = new Date();
  await run.save();
  return result;
}

export const latestRun = (id) => AgentRun.findOne({ subjectId: id }).sort({ createdAt: -1 }).lean();

// Record what a person did after the agent handed something over.
export async function addHumanStep(id, summary, status) {
  const run = await AgentRun.findOne({ subjectId: id }).sort({ createdAt: -1 });
  if (!run) return;
  run.steps = [...run.steps, { stage: 'human', status: 'done', summary, detail: null, ms: 0, at: new Date().toISOString() }];
  if (status) run.status = status;
  await run.save();
}

// Name and note typed by the person deciding.
export function whoAndWhy({ decidedBy, note }) {
  const who = String(decidedBy || '')
    .trim()
    .slice(0, 120);
  if (!who) throw new HttpError(400, 'Enter your name so the decision is on record.');
  return {
    who,
    why: String(note || '')
      .trim()
      .slice(0, 1000),
  };
}

// If even the escalate stage failed, do not leave the record looking fine.
export const failedDecision = (result) => ({ outcome: 'failed', reasons: [`The agent could not finish: ${result.error?.message || 'unknown error'}`] });
