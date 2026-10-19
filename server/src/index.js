// Local entry point: `npm run dev` / `npm start`. On Vercel the same app runs
// from api/index.js at the repository root instead, without app.listen.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { app, ensureDatabase, safeUri, redactSecrets } from './app.js';
import { extractor } from './services/invoices.js';

// A failure that escapes every try/catch in the app (for example Mongoose
// building an index in the background and finding a conflict, which it
// reports through an unlistened event emitter) would otherwise crash the
// whole process with no clear message. Log it instead of dying, so one bad
// background event cannot drop every in-flight request.
process.on('unhandledRejection', (reason) => {
  console.error('\nUnhandled promise rejection (would otherwise have crashed the server):');
  console.error(redactSecrets(reason instanceof Error ? reason.stack : reason));
});
process.on('uncaughtException', (err) => {
  console.error('\nUncaught exception (would otherwise have crashed the server):');
  console.error(redactSecrets(err instanceof Error ? err.stack : err));
});

// After `npm run build`, the server also serves the dashboard, so one port is enough.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

try {
  await ensureDatabase();
} catch (err) {
  console.error(`\nCould not connect to MongoDB at ${safeUri(config.mongoUri)}\n${redactSecrets(err?.message)}\n\nStart MongoDB, or set MONGODB_URI in server/.env (a free MongoDB Atlas cluster works).\n`);
  process.exit(1);
}

app.listen(config.port, () => {
  console.log(`Finance Operations Agent API on http://localhost:${config.port}`);
  console.log(
    extractor.mode === 'groq'
      ? `Invoice reader: Groq (${extractor.model})`
      : 'Invoice reader: basic pattern reader. Set GROQ_API_KEY in server/.env to use the AI reader.',
  );
});
