// Every scheduler endpoint, behind ONE guard. Mounted at /api/cron before
// sign-in is required: a scheduler has no session, it sends
//   Authorization: Bearer <CRON_SECRET>
// (Vercel Cron sends it itself). Any path under /api/cron, including one added
// later or one that does not exist, passes this guard first, so a new cron
// route is protected by construction. (The site password and the CSRF check
// skip /api/cron/*, which is why the guard must cover every path here.)
//
//   GET       /api/cron/daily-summary   the daily summary email (?preview=1: not sent)
//   GET|POST  /api/cron/tick            the payment scheduler's tick
//   GET|POST  /api/cron/ingest          mailbox ingestion, for each enabled mailbox when due
//
// Refused: no CRON_SECRET, or one shorter than MIN_CRON_SECRET_LENGTH (503);
// a missing or wrong secret (401). The secret is only read from the
// Authorization header, never from the URL. Repeated failures from one
// address are slowed down (429). Responses are never cached.

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

import { config } from '../config.js';
import { cronAuthorized, createDailySummaryHandler } from '../services/dailySummary.js';
import { createMailer } from '../services/mailer.js';
import { registerPaymentCron } from './payments.js';
import { registerIngestionCron } from './ingestion.js';

export const MIN_CRON_SECRET_LENGTH = 32;

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/** Why a scheduler's request is refused, as { status, error }, or null. */
export function cronProblem({ secret, authorization }) {
  if (!secret) return { status: 503, error: 'The scheduler is not set up: set CRON_SECRET.' };
  if (secret.length < MIN_CRON_SECRET_LENGTH) {
    return {
      status: 503,
      error: `CRON_SECRET is too short: use at least ${MIN_CRON_SECRET_LENGTH} random characters, for example the output of: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    };
  }
  if (!cronAuthorized(authorization, secret)) return { status: 401, error: 'Not authorised.' };
  return null;
}

export function createCronRouter({
  secret = config.alerts.cronSecret,
  failureLimit = config.cron.failureLimit,
  failureWindowMinutes = config.cron.failureWindowMinutes,
  log = console,
} = {}) {
  const router = Router();
  let warned = false;

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Only failed requests count (a scheduler that sends the right secret is never slowed down).
  if (failureLimit > 0) {
    router.use(
      rateLimit({
        windowMs: Math.max(1, failureWindowMinutes) * 60 * 1000,
        limit: failureLimit,
        skipSuccessfulRequests: true,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Too many refused scheduler requests from this address. Wait and try again.' },
      }),
    );
  }

  router.use((req, res, next) => {
    const problem = cronProblem({ secret, authorization: req.headers.authorization });
    if (!problem) return next();
    if (problem.status === 503 && !warned) {
      warned = true;
      log.error?.(`Scheduler request refused: ${problem.error.split(':')[0]}.`);
    }
    return res.status(problem.status).json({ error: problem.error });
  });

  router.get(
    '/daily-summary',
    wrap(
      createDailySummaryHandler({
        secret,
        recipients: config.alerts.recipients,
        appUrl: config.alerts.appUrl,
        companyName: config.companyName,
        mailer: createMailer(config.alerts),
      }),
    ),
  );
  registerPaymentCron(router);
  registerIngestionCron(router);

  router.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  return router;
}
