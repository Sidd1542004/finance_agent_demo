// Limits on the requests that cost something: the ones that call Groq or
// process a file (invoices, supplier emails, bank statements, reports, the
// demo month). Counted per client IP address, in memory, so on Vercel each
// warm function instance keeps its own count: a modest brake, not a quota.

import { rateLimit } from 'express-rate-limit';

export function createWorkLimiter({ windowMinutes, max }) {
  if (!(max > 0)) return (req, res, next) => next(); // RATE_LIMIT_MAX=0 turns it off
  return rateLimit({
    windowMs: Math.max(1, windowMinutes) * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: `Too many requests that run the agent: the limit is ${max} every ${windowMinutes} minute${windowMinutes === 1 ? '' : 's'}. Wait a few minutes and try again.` },
  });
}
