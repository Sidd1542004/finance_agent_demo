// The one-time migration: the outbox index on an older database, old payments
// marked manual, and the typed-name role lists moved onto accounts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { startTestDatabase } from '../test-support/mongo.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const db = await startTestDatabase();
await mongoose.connect(db.uri);
test.after(() => db.stop());

test('migrate: replaces the old outbox index, marks old payments manual, and moves role lists to accounts', async () => {
  const conn = mongoose.connection.db;
  // An older database: a plain unique index on queryId, a payment without a route, and accounts.
  await conn.collection('outboxmessages').createIndex({ queryId: 1 }, { unique: true });
  await conn.collection('payments').insertOne({ invoiceId: new mongoose.Types.ObjectId(), amount: 10, status: 'paid' });
  await conn.collection('users').insertOne({ email: 'priya@test.example', name: 'Priya N', passwordHash: 'x', roles: [], active: true });

  const env = { ...process.env, MONGODB_URI: db.uri, APPROVERS: 'Priya N, Nobody Here', PAYERS: 'priya@test.example', REVIEWERS: '' };
  const { stdout } = await run(process.execPath, [path.join(here, '../src/scripts/migrate.js')], { env, cwd: path.join(here, '..') });
  assert.match(stdout, /Outbox: replaced queryId_1/);
  assert.match(stdout, /1 existing payment\(s\) marked as manual/);
  assert.match(stdout, /No account for: Nobody Here \(approver\)/);

  const indexes = await conn.collection('outboxmessages').indexes();
  assert.ok(indexes.find((i) => i.key.queryId === 1).partialFilterExpression, 'the queryId index is partial now');
  assert.equal((await conn.collection('payments').findOne({})).route, 'manual');
  assert.deepEqual((await conn.collection('users').findOne({})).roles.sort(), ['approver', 'payer']);

  // Twice is fine.
  const again = await run(process.execPath, [path.join(here, '../src/scripts/migrate.js')], { env, cwd: path.join(here, '..') });
  assert.match(again.stdout, /Outbox indexes already up to date/);
});
