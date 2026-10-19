// The Express app, without app.listen, so the same app runs locally
// (src/index.js) and as one Vercel serverless function (api/index.js at the
// repository root).

import cors from 'cors';
import dns from 'node:dns';
import express from 'express';
import mongoose from 'mongoose';

import { config } from './config.js';
import { safeUri, redactSecrets } from './safeUri.js';
import { api } from './routes/api.js';
import { seedIfEmpty } from './seed/seed.js';

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

export const ensureDatabase = createDatabaseGate({
  connect: () => mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 }),
  seed: seedIfEmpty,
  isConnected: () => mongoose.connection.readyState === 1,
});

export const app = express();

app.disable('x-powered-by');

// Only needed when the dashboard is served from a different site than the API.
// On Vercel (one project) and locally (the Vite proxy) it is the same site.
if (config.corsOrigins.length) {
  app.use(cors({ origin: config.corsOrigins }));
}

app.use(express.json({ limit: '1mb' }));

app.use('/api', async (req, res, next) => {
  try {
    await ensureDatabase();
    next();
  } catch (err) {
    console.error(`\nCould not connect to MongoDB at ${safeUri(config.mongoUri)}: ${redactSecrets(err?.message)}`);
    res.status(503).json({ error: DATABASE_UNAVAILABLE });
  }
});

app.use('/api', api);
