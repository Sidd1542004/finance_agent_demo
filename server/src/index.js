import cors from 'cors';
import dns from 'node:dns';
import express from 'express';
import mongoose from 'mongoose';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { api } from './routes/api.js';
import { seedIfEmpty } from './seed/seed.js';
import { extractor } from './services/invoices.js';

// Node's bundled DNS resolver (not Windows') is used for mongodb+srv://
// lookups and can detect the wrong DNS server on some Windows machines even
// though normal hostname lookups (and Windows itself) work fine, causing
// "querySrv ECONNREFUSED" when nothing is listening on the server it picked.
// Only takes effect if DNS_SERVERS is set in server/.env; empty by default.
if (config.dnsServers.length) {
  dns.setServers(config.dnsServers);
}

// A failure that escapes every try/catch in the app (for example Mongoose
// building an index in the background and finding a conflict, which it
// reports through an unlistened event emitter) would otherwise crash the
// whole process with no clear message. Log it instead of dying, so one bad
// background event cannot drop every in-flight request.
process.on('unhandledRejection', (reason) => {
  console.error('\nUnhandled promise rejection (would otherwise have crashed the server):');
  console.error(reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('\nUncaught exception (would otherwise have crashed the server):');
  console.error(err instanceof Error ? err.stack : err);
});

const app = express();

app.disable('x-powered-by');

const allowedOrigins = [
  'https://finance-agent-demo-re1g.vercel.app',
  'http://localhost:5173',
];

app.use(cors({
  origin: allowedOrigins,
}));

app.use(express.json({ limit: '1mb' }));
app.use('/api', api);
// After `npm run build`, the server also serves the dashboard, so one port is enough.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

try {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
} catch (err) {
  console.error(`\nCould not connect to MongoDB at ${config.mongoUri}\n${err.message}\n\nStart MongoDB, or set MONGODB_URI in server/.env (a free MongoDB Atlas cluster works).\n`);
  process.exit(1);
}

// mongoose.connection is an EventEmitter: an 'error' with no listener throws
// and crashes the process, even after the connection above succeeded (for
// example a dropped network blip while a request is in flight).
mongoose.connection.on('error', (err) => {
  console.error('\nMongoDB connection error:', err.message);
});

if (await seedIfEmpty()) console.log('Loaded the sample suppliers, purchase orders and goods receipts.');

app.listen(config.port, () => {
  console.log(`Finance Operations Agent API on http://localhost:${config.port}`);
  console.log(
    extractor.mode === 'groq'
      ? `Invoice reader: Groq (${extractor.model})`
      : 'Invoice reader: basic pattern reader. Set GROQ_API_KEY in server/.env to use the AI reader.',
  );
});
