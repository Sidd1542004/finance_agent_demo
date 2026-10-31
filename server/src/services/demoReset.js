// The demo Reset (and Load demo month, which starts with the same wipe).
//
// What it deletes: the demo data listed in seed/seed.js (DEMO_DATA_MODELS),
// and the sample reference data, which it loads again (REFERENCE_MODELS).
// What it keeps: users, sessions, settings, the simulated bank's test
// scenarios and the audit log.
//
// Where it may run: only when DEMO_MODE=true, and never on Production:
// APP_ENV=production or a Vercel Production deployment (VERCEL_ENV=production,
// which Vercel sets itself) refuses it, whatever DEMO_MODE says.
//
// How: the route checks the administrator role and CSRF first (api.js). Then
// this refuses Production, needs the typed confirmation, takes a lock so two
// resets cannot run at once (also across serverless instances: the lock is a
// MongoDB document), and records the outcome in the audit log. A failure is
// reported as a failure, never as success.

import { config } from '../config.js';
import { Setting } from '../models/index.js';
import { redactSecrets } from '../safeUri.js';
import { HttpError } from './runs.js';

export const RESET_CONFIRMATION = 'RESET';
export const LOCK_ID = 'demo-reset-lock';
const LEASE_MS = 5 * 60 * 1000; // a crashed reset frees the lock after this

/** Why a demo wipe is refused here, or null when it is allowed. */
export function demoResetBlocked({ demoMode = config.demoMode, appEnv = config.appEnv, vercelEnv = process.env.VERCEL_ENV } = {}) {
  if (String(vercelEnv || '').toLowerCase() === 'production') return 'Reset is never available on a Production deployment.';
  if (appEnv === 'production') return 'Reset is never available when APP_ENV=production.';
  if (!demoMode) return 'Reset is only available in demo mode (DEMO_MODE=true).';
  return null;
}

/** A lock in MongoDB: one reset at a time, across every server instance. */
export const mongoLock = {
  async acquire(user, now = new Date()) {
    const token = `${user?.id || 'unknown'}:${now.getTime()}:${Math.random().toString(36).slice(2)}`;
    try {
      // Matches only a free (or expired) lock. When it is held, the upsert tries to
      // insert a second document with the same _id and fails: the lock is busy.
      await Setting.findOneAndUpdate(
        { _id: LOCK_ID, $or: [{ value: null }, { 'value.until': { $lt: now } }] },
        { $set: { value: { token, by: user?.name || null, byId: user?.id || null, until: new Date(now.getTime() + LEASE_MS) } } },
        { upsert: true, new: true },
      );
      return token;
    } catch (err) {
      if (err?.code === 11000) return null;
      throw err;
    }
  },
  async release(token) {
    if (token) await Setting.deleteOne({ _id: LOCK_ID, 'value.token': token });
  },
};

/**
 * Express handler for POST /api/reset. Dependencies are passed in so the tests
 * can check every refusal and failure without wiping anything.
 *   blocked() -> reason | null    reset() -> { collection: removed }
 *   lock: { acquire(user), release(token) }    audit(entry)
 */
export function createDemoResetHandler({ blocked = demoResetBlocked, reset, audit, lock = mongoLock, log = console }) {
  const entry = (req, action, detail) => ({ subjectKind: 'system', subjectId: 'demo', actor: req.user.name, actorId: req.user.id, action, detail });
  // Writes an audit entry; true when it was written. Never hides the outcome being reported.
  const tryAudit = async (e) => {
    try {
      await audit(e);
      return true;
    } catch (err) {
      log.error(`Could not write the audit entry "${e.action}": ${redactSecrets(err?.message || String(err))}`);
      return false;
    }
  };

  return async (req, res) => {
    const reason = blocked();
    if (reason) {
      await tryAudit(entry(req, 'reset_refused', reason));
      throw new HttpError(403, reason);
    }
    if (req.body?.confirm !== RESET_CONFIRMATION) throw new HttpError(400, `Type ${RESET_CONFIRMATION} to confirm the reset.`);

    const token = await lock.acquire(req.user);
    if (!token) throw new HttpError(409, 'A reset is already running. Wait for it to finish, then reload the page.');
    try {
      let removed;
      try {
        removed = await reset();
      } catch (err) {
        const message = redactSecrets(err?.message || String(err));
        log.error(`Demo reset failed: ${message}`);
        await tryAudit(entry(req, 'reset_failed', `The reset failed: ${message}. Some demo data may already have been removed.`));
        throw new HttpError(500, 'The reset failed. Some demo data may already have been removed. Check the server log, then try again.');
      }
      const total = Object.values(removed || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
      const audited = await tryAudit(
        entry(
          req,
          'reset',
          `Reset succeeded: ${total} demo records removed and the sample suppliers, purchase orders and deliveries loaded again. Users, settings and the audit log are kept.`,
        ),
      );
      // The data was reset either way; say so, and say if the audit entry is missing.
      res.json({
        ok: true,
        removed,
        total,
        audited,
        at: new Date().toISOString(),
        ...(audited ? {} : { warning: 'The demo data was reset, but the audit entry could not be written. Check the server log.' }),
      });
    } finally {
      await lock.release(token);
    }
  };
}

/** Load demo month starts with the same wipe: the same boundary and lock apply. */
export async function withDemoWipe(user, fn, { blocked = demoResetBlocked, lock = mongoLock } = {}) {
  const reason = blocked();
  if (reason) throw new HttpError(403, reason.replace(/^Reset/, 'Load demo month'));
  const token = await lock.acquire(user);
  if (!token) throw new HttpError(409, 'A reset is already running. Wait for it to finish, then reload the page.');
  try {
    return await fn();
  } finally {
    await lock.release(token);
  }
}
