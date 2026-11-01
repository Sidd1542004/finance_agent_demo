// Runs the tool calls of one question (docs/phase2-design.md §3.5). Every call
// goes through the Phase 1 callTool with the request's context, so roles,
// masking, redaction and the per-call audit entry apply. On top of that:
//   - at most MAX_CALLS tool calls per question, resolution included;
//   - the same tool with the same arguments runs once: a repeat gets the
//     first result (no second call, no second audit entry);
//   - each call has at most STEP_MS, and none starts with less than
//     MIN_LEFT_MS of the question's budget left;
//   - a failure is a result ({ ok: false, code }), never an exception, so a
//     plan can give a partial answer.

import { callTool } from './tools.js';
import { timeLeftMs } from '../llm/deadline.js';

export const LIMITS = Object.freeze({ maxCalls: 8, stepMs: 5000, minLeftMs: 4000 });

// What a refusal from callTool means, in the words the answer uses.
const CODES = { 400: 'invalid', 401: 'not_signed_in', 403: 'not_permitted', 404: 'not_found' };
const codeOf = (status) => CODES[status] || 'unavailable';

// Arguments with sorted keys, so { a, b } and { b, a } are the same call.
const canonical = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
        .join(',')}}`
    : JSON.stringify(value);

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, code: 'timeout' }), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * An executor for one question. `run(tool, args)` returns { ok: true, value }
 * or { ok: false, code } with code one of invalid, not_permitted, not_found,
 * unavailable, timeout, limit. A call abandoned after STEP_MS still finishes
 * and writes its own audit entry: it ran.
 */
export function createExecutor(ctx, limits = LIMITS) {
  const done = new Map();
  let calls = 0;
  const log = [];

  async function run(tool, args = {}) {
    const key = `${tool} ${canonical(args)}`;
    if (done.has(key)) return done.get(key);
    if (calls >= limits.maxCalls) return { ok: false, code: 'limit' };
    if (timeLeftMs() < limits.minLeftMs) return { ok: false, code: 'timeout' };
    calls += 1;
    const started = Date.now();
    const result = withTimeout(
      callTool(ctx, tool, args).then(
        (value) => ({ ok: true, value }),
        (err) => ({ ok: false, code: codeOf(err?.status) }),
      ),
      limits.stepMs,
    ).then((r) => {
      log.push({ tool, ok: r.ok, ms: Date.now() - started, ...(r.ok ? {} : { code: r.code }) });
      return r;
    });
    done.set(key, result);
    return result;
  }

  return {
    run,
    ctx,
    get calls() {
      return calls;
    },
    /** What the response's trace shows: each call, in order, with its time. */
    trace: () => [...log],
  };
}
