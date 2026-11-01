// The time a request may still use, for the Groq client (llm/groq.js).
//
// Every /api request runs inside a deadline (app.js: REQUEST_BUDGET_SECONDS,
// under Vercel's maxDuration), and a mailbox sync sets one too when it is run
// directly. A Groq call never waits past it: its timeout and retries are cut
// to the time left, and with too little left it fails at once (code
// "timeout"), so the invoice or email reader's fallback takes over and the
// request still answers in time.

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

/** Run `fn` with a deadline (ms since the epoch). An earlier deadline already in force is kept. */
export function withDeadline(at, fn) {
  const current = store.getStore();
  const deadline = current && current.at < at ? current.at : at;
  return store.run({ at: deadline }, fn);
}

/** The deadline in force, or null. */
export const currentDeadline = () => store.getStore()?.at ?? null;

/** Milliseconds left before the deadline (Infinity without one). */
export function timeLeftMs(now = Date.now()) {
  const at = currentDeadline();
  return at === null ? Infinity : at - now;
}

/**
 * Run a route handler inside its request's deadline (req.deadlineAt, set in
 * app.js). Re-entering it in the handler keeps it in force even after a body
 * parser (multer) has run outside it.
 */
export const inRequestDeadline = (req, fn) => (req?.deadlineAt ? withDeadline(req.deadlineAt, fn) : fn());
