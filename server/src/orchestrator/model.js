// One model call for the assistant (docs/phase2-design.md §3.2, §3.7, §13).
// Both calls (classify and compose) go through callModel:
//   - no retries: a rate limit or a slow answer falls back at once, it never
//     adds more requests (decision 6);
//   - a cap on output tokens and a timeout per call;
//   - after a 429, no call at all for Groq's Retry-After (5 s to 60 s), in
//     memory per warm instance: every question in that window gets its
//     fallback at once;
//   - the outcome is a reason code, the same codes as the invoice reader's
//     fallback (llm/groq.js GroqError), and never an exception.

import { performance } from 'node:perf_hooks';
import { groqJson, GroqError } from '../llm/groq.js';

const MIN_PAUSE_MS = 5000;
const DEFAULT_PAUSE_MS = 20000;
const MAX_PAUSE_MS = 60000;
let pausedUntil = 0;

/** Is the model paused (after a rate limit) at `now`? */
export const modelPaused = (now = Date.now()) => now < pausedUntil;

/** Pause after a rate limit, for Groq's Retry-After if it gave one (5 s to 60 s). */
export function pauseModel(retryAfterMs, now = Date.now()) {
  const ms = Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, Number.isFinite(retryAfterMs) ? retryAfterMs : DEFAULT_PAUSE_MS));
  pausedUntil = Math.max(pausedUntil, now + ms);
  return ms;
}

/** For tests. */
export function resetModelPause() {
  pausedUntil = 0;
}

/**
 * Ask the model for a JSON object. Returns { ok: true, value, call } or
 * { ok: false, code, call }, where call is what the audit log records:
 * { purpose, model, ms, promptTokens, completionTokens, outcome }.
 */
export async function callModel({ purpose, apiKey, model, system, user, maxTokens, timeoutMs, reasoningEffort = null, fetchImpl = undefined, now = Date.now }) {
  const call = { purpose, model, ms: 0, promptTokens: null, completionTokens: null, outcome: 'ok' };
  if (!apiKey) return { ok: false, code: (call.outcome = 'not_configured'), call };
  if (modelPaused(now())) return { ok: false, code: (call.outcome = 'rate_limit'), call };
  const started = performance.now();
  try {
    const value = await groqJson({
      apiKey,
      model,
      system,
      user,
      maxTokens,
      reasoningEffort,
      retries: 0,
      timeoutMs,
      budgetMs: timeoutMs,
      purpose,
      ...(fetchImpl ? { fetchImpl } : {}),
      onUsage: (usage) => {
        call.promptTokens = usage?.prompt_tokens ?? null;
        call.completionTokens = usage?.completion_tokens ?? null;
      },
    });
    return { ok: true, value, call };
  } catch (err) {
    const code = err instanceof GroqError ? err.code : 'network';
    if (code === 'rate_limit') pauseModel(err.retryAfterMs, now());
    call.outcome = code;
    return { ok: false, code, call };
  } finally {
    call.ms = Math.round(performance.now() - started);
  }
}
