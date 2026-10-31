// Automatic invoice ingestion: the administrator's controls, the OAuth
// callback and the scheduler's endpoint. See services/ingestion.js.
//
//   registerIngestionPublicRoutes(api)   before sign-in is required:
//     GET|POST /cron/ingest                     CRON_SECRET (the scheduler)
//     GET /ingestion/oauth/:provider/callback   the provider's redirect; checks the
//                                               signed-in administrator and the one-time state
//   registerIngestionRoutes(api, { work })      after sign-in, administrators only

import mongoose from 'mongoose';
import { config } from '../config.js';
import { requireRole } from '../auth/middleware.js';
import { hasRole } from '../auth/roles.js';
import { cronAuthorized } from '../services/dailySummary.js';
import { ingestion, ConnectError } from '../services/ingestion.js';
import { HttpError } from '../services/runs.js';

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const PROVIDERS = ['gmail', 'outlook'];

function providerParam(req) {
  const p = String(req.params.provider || '').toLowerCase();
  if (!PROVIDERS.includes(p)) throw new HttpError(404, 'Unknown mail provider.');
  return p;
}

export function registerIngestionPublicRoutes(api) {
  const tick = wrap(async (req, res) => {
    const secret = config.alerts.cronSecret;
    if (!secret) return res.status(503).json({ error: 'The scheduler is not set up: set CRON_SECRET.' });
    if (!cronAuthorized(req.headers.authorization, secret)) return res.status(401).json({ error: 'Not authorised.' });
    res.set('Cache-Control', 'no-store');
    res.json(await ingestion().cronTick());
  });
  api.get('/cron/ingest', tick);
  api.post('/cron/ingest', tick);

  // The provider sends the administrator back here. A plain browser redirect
  // (GET), so it answers with a redirect to the dashboard, never with tokens.
  api.get(
    '/ingestion/oauth/:provider/callback',
    wrap(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer'); // the code must not leak to another site
      const base = ingestion().redirectBase || '';
      const back = (query) => res.redirect(303, `${base}/?${new URLSearchParams(query)}`);
      let provider;
      try {
        provider = providerParam(req);
      } catch {
        return back({ ingestion: 'error', code: 'config' });
      }
      if (!req.user || !hasRole(req.user, 'admin')) return back({ ingestion: 'error', provider, code: 'signin' });
      try {
        await ingestion().completeConnect(provider, { code: req.query.code, state: req.query.state, error: req.query.error }, req.user);
        return back({ ingestion: 'connected', provider });
      } catch (err) {
        if (!(err instanceof ConnectError)) console.error(`Mailbox connection (${provider}) failed:`, err?.message || err);
        return back({ ingestion: 'error', provider, code: err instanceof ConnectError ? err.code : 'exchange' });
      }
    }),
  );
}

export function registerIngestionRoutes(api, { work }) {
  const admin = requireRole('admin');

  api.get(
    '/ingestion',
    admin,
    wrap(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await ingestion().status());
    }),
  );

  // ?provider=&status=&before=&limit=
  api.get(
    '/ingestion/items',
    admin,
    wrap(async (req, res) => {
      res.json(await ingestion().listItems(req.query));
    }),
  );

  // Starts the provider's sign-in: returns the URL the dashboard sends the administrator to.
  api.post(
    '/ingestion/:provider/connect',
    admin,
    wrap(async (req, res) => {
      res.json(await ingestion().startConnect(providerParam(req), req.user));
    }),
  );

  api.post(
    '/ingestion/:provider/disconnect',
    admin,
    wrap(async (req, res) => {
      res.json(await ingestion().disconnect(providerParam(req), req.user));
    }),
  );

  api.put(
    '/ingestion/:provider/enabled',
    admin,
    wrap(async (req, res) => {
      if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'Send { "enabled": true } or { "enabled": false }.');
      res.json(await ingestion().setEnabled(providerParam(req), req.body.enabled, req.user));
    }),
  );

  // "Sync inbox now": one sync at a time per mailbox; rate limited like other agent work.
  api.post(
    '/ingestion/:provider/sync',
    admin,
    work,
    wrap(async (req, res) => {
      res.json(await ingestion().sync(providerParam(req), { trigger: 'manual', user: req.user }));
    }),
  );

  api.post(
    '/ingestion/items/:id/retry',
    admin,
    work,
    wrap(async (req, res) => {
      if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(404, 'That ingestion record does not exist.');
      res.json(await ingestion().retry(req.params.id, req.user));
    }),
  );
}
