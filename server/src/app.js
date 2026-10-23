// The Express app, without app.listen, so the same app runs locally
// (src/index.js) and as one Vercel serverless function (api/index.js at the
// repository root).

import cors from 'cors';
import dns from 'node:dns';
import express from 'express';
import mongoose from 'mongoose';

import { config } from './config.js';
import { safeUri, redactSecrets } from './safeUri.js';
import { requireAccessPassword } from './accessAuth.js';
import { csrfGuard, loadUser } from './auth/middleware.js';
import { api } from './routes/api.js';
import { seedIfEmpty } from './seed/seed.js';
import { ensureOutboxIndexes } from './models/index.js';

// Node's bundled DNS resolver (not Windows') is used for mongodb+srv://
// lookups and can detect the wrong DNS server on some Windows machines even
// though normal hostname lookups (and Windows itself) work fine, causing
// "querySrv ECONNREFUSED" when nothing is listening on the server it picked.
// Only takes effect if DNS_SERVERS is set in server/.env; empty by default.
if (config.dnsServers.length) {
  dns.setServers(config.dnsServers);
}

export { safeUri, redactSecrets };

export const DATABASE_UNAVAILABLE = 'The database cannot be reached. Check MONGODB_URI, and that MongoDB Atlas Network Access allows this server (0.0.0.0/0 for Vercel).';

// mongoose.connection is an EventEmitter: an 'error' with no listener throws
// and crashes the process, even after the connection succeeded (for example a
// dropped network blip while a request is in flight).
mongoose.connection.on('error', (err) => {
  console.error('\nMongoDB connection error:', redactSecrets(err?.message));
});

// One connection per process (or per warm serverless instance), opened on the
// first request and reused. Concurrent callers share the same attempt; a
// failed attempt is not cached, so the next request tries again.
export function createDatabaseGate({ connect, seed, isConnected }) {
  let seeded = false;
  let pending = null;
  return function ensure() {
    if (seeded && isConnected()) return Promise.resolve();
    if (!pending) {
      pending = (async () => {
        if (!isConnected()) await connect();
        // Once per process: the sample suppliers, POs and deliveries, if the database is empty.
        if (!seeded && (await seed())) console.log('Loaded the sample suppliers, purchase orders and goods receipts.');
        seeded = true;
      })().finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}

// Once per process, before seeding: replace the outbox's old unique queryId
// index if it is still there (see ensureOutboxIndexes). A failure is logged,
// not fatal: everything except storing payment notices keeps working.
async function prepareDatabase() {
  try {
    const dropped = await ensureOutboxIndexes();
    if (dropped.length) console.log(`Outbox indexes updated (replaced ${dropped.join(', ')}).`);
  } catch (err) {
    console.error('Could not update the outbox indexes. Run `npm run migrate --prefix server`.', redactSecrets(err?.message));
  }
  return seedIfEmpty();
}

export const ensureDatabase = createDatabaseGate({
  connect: () => mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 }),
  seed: prepareDatabase,
  isConnected: () => mongoose.connection.readyState === 1,
});

export const app = express();

app.disable('x-powered-by');
// Behind Vercel's proxy the client's address is in X-Forwarded-For; the rate limits need it.
app.set('trust proxy', 1);

// Optional shared password, before anything else (the API and, locally, the dashboard).
if (config.accessPassword) app.use(requireAccessPassword(config.accessPassword));

// Only needed when the dashboard is served from a different site than the API.
// On Vercel (one project) and locally (the Vite proxy) it is the same site.
if (config.corsOrigins.length) {
  app.use(cors({ origin: config.corsOrigins }));
}

app.use(express.json({ limit: '1mb' }));

// State-changing API calls must come from the dashboard itself (CSRF). The
// cron endpoints are called by a scheduler with CRON_SECRET instead.
app.use('/api', csrfGuard({ allowedOrigins: config.corsOrigins, skip: [/^\/cron\//] }));

app.use('/api', async (req, res, next) => {
  try {
    await ensureDatabase();
    next();
  } catch (err) {
    console.error(`\nCould not connect to MongoDB at ${safeUri(config.mongoUri)}: ${redactSecrets(err?.message)}`);
    res.status(503).json({ error: DATABASE_UNAVAILABLE });
  }
});

// Who is signed in (req.user), from the session cookie.
app.use('/api', loadUser());

app.use('/api', api);
