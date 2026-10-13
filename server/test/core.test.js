import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, requestEscalation, STAGES } from '../src/agent/core/loop.js';

const agentWith = (overrides = {}) => {
  const calls = [];
  const stages = {};
  for (const stage of STAGES) {
    stages[stage] = async (state) => {
      calls.push(stage);
      if (overrides[stage]) return overrides[stage](state);
      return { summary: `${stage} ok` };
    };
  }
  return { agent: { name: 'test.agent', stages }, calls };
};

test('runs the six stages in order and records each one', async () => {
  const { agent, calls } = agentWith({ escalate: (state) => { state.outcome = 'done'; return { status: 'skipped', summary: 'nothing to escalate' }; } });
  const seen = [];
  const result = await runAgent(agent, { id: 1 }, { onStep: (step) => seen.push(step.stage) });

  assert.deepEqual(calls, STAGES);
  assert.deepEqual(seen, STAGES);
  assert.deepEqual(result.steps.map((s) => s.status), ['done', 'done', 'done', 'done', 'done', 'skipped']);
  assert.equal(result.outcome, 'done');
  assert.equal(result.error, null);
});

test('a failure skips the remaining work but still escalates', async () => {
  const { agent, calls } = agentWith({
    understand: () => { throw new Error('could not read it'); },
    escalate: (state) => { state.outcome = state.error ? 'failed' : 'done'; return { summary: 'flagged' }; },
  });
  const result = await runAgent(agent, {});

  assert.deepEqual(calls, ['receive', 'understand', 'escalate'], 'decide, act and verify must not run');
  assert.deepEqual(result.steps.map((s) => s.status), ['done', 'error', 'skipped', 'skipped', 'skipped', 'done']);
  assert.deepEqual(result.error, { stage: 'understand', message: 'could not read it' });
  assert.equal(result.outcome, 'failed');
});

test('escalation reasons collect without repeats', async () => {
  const { agent } = agentWith({
    decide: (state) => { requestEscalation(state, 'too big'); requestEscalation(state, 'too big'); requestEscalation(state, 'unknown supplier'); return {}; },
  });
  const result = await runAgent(agent, {});
  assert.deepEqual(result.escalation.reasons, ['too big', 'unknown supplier']);
});

test('an agent with a missing stage is refused before anything runs', async () => {
  const { agent, calls } = agentWith();
  delete agent.stages.verify;
  await assert.rejects(() => runAgent(agent, {}), /missing the "verify" stage/);
  assert.deepEqual(calls, []);
});

test('if escalate itself fails there is no outcome, so the caller can flag it', async () => {
  const { agent } = agentWith({ escalate: () => { throw new Error('queue is down'); } });
  const result = await runAgent(agent, {});
  assert.equal(result.outcome, null);
  assert.equal(result.error.stage, 'escalate');
});
