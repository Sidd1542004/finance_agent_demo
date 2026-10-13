// Shared agent core.
//
// Every agent (Finance, HR, Customer Service, Procurement, Operations, Sales
// Support) runs the same six stages. An agent is just an object with a name
// and one async handler per stage; this file knows nothing about invoices.
//
//   receive    -> take in the email, document, request or event
//   understand -> extract the information and intent
//   decide     -> apply business rules and policy
//   act        -> do the work in the connected system
//   verify     -> check the outcome really happened
//   escalate   -> hand uncertain or high-risk cases to a person
//
// Safety rules built into the loop:
//   * If any stage throws, the remaining work stages are skipped and the
//     escalate stage still runs, so a failure always ends up in front of a person.
//   * Every stage is recorded (what happened, how long it took), so each run
//     leaves an audit trail.

export const STAGES = ['receive', 'understand', 'decide', 'act', 'verify', 'escalate'];

// Stage handlers call this to say "a person needs to look at this".
export function requestEscalation(state, reason) {
  if (!state.escalation) state.escalation = { reasons: [] };
  if (reason && !state.escalation.reasons.includes(reason)) state.escalation.reasons.push(reason);
}

export function validateAgent(agent) {
  if (!agent || typeof agent.name !== 'string' || !agent.name) throw new Error('An agent needs a name.');
  for (const stage of STAGES) {
    if (typeof agent.stages?.[stage] !== 'function') {
      throw new Error(`Agent "${agent.name}" is missing the "${stage}" stage.`);
    }
  }
}

/**
 * Run one piece of work through the six stages.
 *
 * @param agent   { name, stages: { receive, understand, decide, act, verify, escalate } }
 *                Each stage is `async (state) => ({ summary, detail?, status? })`.
 * @param input   Whatever the agent works on (for Finance: the invoice record).
 * @param onStep  Optional `async (step, allSteps)` called after every stage,
 *                used to save the trail as it happens.
 * @returns       { agent, steps, outcome, escalation, error }
 */
export async function runAgent(agent, input, { onStep } = {}) {
  validateAgent(agent);

  const state = { input, outcome: null, escalation: null, error: null };
  const steps = [];

  const record = async (step) => {
    steps.push(step);
    if (onStep) await onStep(step, steps);
  };

  for (const stage of STAGES) {
    const startedAt = new Date();

    if (state.error && stage !== 'escalate') {
      await record({
        stage,
        status: 'skipped',
        summary: 'Skipped because an earlier step failed.',
        detail: null,
        ms: 0,
        at: startedAt.toISOString(),
      });
      continue;
    }

    try {
      const out = (await agent.stages[stage](state)) || {};
      await record({
        stage,
        status: out.status || 'done',
        summary: out.summary || '',
        detail: out.detail ?? null,
        ms: Date.now() - startedAt.getTime(),
        at: startedAt.toISOString(),
      });
    } catch (err) {
      // Keep the first failure: that is the one a person needs to see.
      if (!state.error) state.error = { stage, message: err?.message || String(err) };
      await record({
        stage,
        status: 'error',
        summary: err?.message || String(err),
        detail: null,
        ms: Date.now() - startedAt.getTime(),
        at: startedAt.toISOString(),
      });
    }
  }

  return {
    agent: agent.name,
    steps,
    outcome: state.outcome,
    escalation: state.escalation,
    error: state.error,
  };
}
